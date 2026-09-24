# -*- coding: utf-8 -*-
"""AutoCount 资料来源（只读）。

所有 SQL 都可以在 autocount.json 的 "webapp" 段覆写。表名与主要栏名已依
discovery（AutoCount 2.2）定稿：IV/CS/CN/DO/SO/GR + DTL 明细表、Item.ItemBrand、
StockDTL 库存流水。DODTL/SODTL 的「已转出数量」栏（TransferedQty）尚待下一次
discovery 确认。

这个模组只做 SELECT，不会对 AutoCount 写入任何东西。
"""

from __future__ import annotations

import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional

from . import (ChannelSales, Delivery, DeliveryLine, LocationQty, Movement,
               SalesPoint, SkuSales, StockRow)

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from autocount_db import connect, fetch, load_autocount_config   # noqa: E402

# ---- 预设 SQL（可在 autocount.json > webapp > sql 覆写）-------------------
DEFAULT_SQL = {
    # ---- 依 discovery（AutoCount 2.2，账套 AED_*）定稿 --------------------
    # 库存清单：每个 SKU 一列；现有量 = StockDTL（库存流水）加总；安全库存 = ItemUOM.ReOLevel
    "stock_list": """
        SELECT i.ItemCode, i.Description, ISNULL(i.ItemGroup, ''), ISNULL(i.ItemBrand, ''),
               ISNULL(i.BaseUOM, ''), ISNULL(b.Bal, 0), ISNULL(u.ReOLevel, 0)
        FROM [Item] i
        LEFT JOIN (SELECT ItemCode, SUM(Qty) AS Bal FROM [StockDTL] GROUP BY ItemCode) b
               ON b.ItemCode = i.ItemCode
        LEFT JOIN [ItemUOM] u ON u.ItemCode = i.ItemCode AND u.UOM = i.BaseUOM
        WHERE i.IsActive = 'T' AND i.StockControl = 'T'
        ORDER BY i.ItemCode
    """,
    # 销售订单未出货量（reserved）。SODTL 的「已转出数量」栏名待 discovery 确认；
    # 若栏名不同，在 autocount.json > webapp > sql 覆写这条。
    "reserved": """
        SELECT d.ItemCode, SUM(d.Qty - ISNULL(d.TransferedQty, 0))
        FROM [SO] h JOIN [SODTL] d ON d.DocKey = h.DocKey
        WHERE h.Cancelled = 'F'
        GROUP BY d.ItemCode
        HAVING SUM(d.Qty - ISNULL(d.TransferedQty, 0)) > 0
    """,
    # 各仓库存：StockDTL 依仓库加总
    "stock_locations": """
        SELECT Location, SUM(Qty)
        FROM [StockDTL]
        WHERE ItemCode = ?
        GROUP BY Location
        HAVING SUM(Qty) <> 0
    """,
    # 库存异动：送货单（-）与收货单（+）
    "movements": """
        SELECT h.DocDate, N'出货', h.DocNo, ISNULL(h.DebtorName, h.DebtorCode), -d.Qty
        FROM [DO] h JOIN [DODTL] d ON d.DocKey = h.DocKey
        WHERE d.ItemCode = ? AND h.DocDate >= ? AND h.Cancelled = 'F'
        UNION ALL
        SELECT h.DocDate, N'进货', h.DocNo, ISNULL(h.CreditorName, h.CreditorCode), d.Qty
        FROM [GR] h JOIN [GRDTL] d ON d.DocKey = h.DocKey
        WHERE d.ItemCode = ? AND h.DocDate >= ? AND h.Cancelled = 'F'
        ORDER BY 1 DESC
    """,
    # 销售明细（仪表板用）：IV + CS − CN，与月报口径一致。
    # 回传：DocDate, DocKey, DebtorCode, ItemCode, Qty, Amount
    "sales_lines": """
        SELECT h.DocDate, h.DocKey, h.DebtorCode, d.ItemCode, d.Qty, d.SubTotal
        FROM [IV] h JOIN [IVDTL] d ON d.DocKey = h.DocKey
        WHERE h.DocDate >= ? AND h.Cancelled = 'F'
        UNION ALL
        SELECT h.DocDate, h.DocKey, h.DebtorCode, d.ItemCode, d.Qty, d.SubTotal
        FROM [CS] h JOIN [CSDTL] d ON d.DocKey = h.DocKey
        WHERE h.DocDate >= ? AND h.Cancelled = 'F'
        UNION ALL
        SELECT h.DocDate, h.DocKey, h.DebtorCode, d.ItemCode, -d.Qty, -d.SubTotal
        FROM [CN] h JOIN [CNDTL] d ON d.DocKey = h.DocKey
        WHERE h.DocDate >= ? AND h.Cancelled = 'F'
    """,
    # 送货单表头
    "deliveries": """
        SELECT h.DocKey, h.DocNo, h.DocDate, h.DebtorCode, ISNULL(h.DebtorName, ''),
               h.Cancelled, ISNULL(h.Note, '')
        FROM [DO] h
        WHERE h.DocDate >= ?
        ORDER BY h.DocDate DESC, h.DocNo DESC
    """,
    # 送货单明细（TransferedQty = 已转成发票的数量，视为已出货；栏名待 discovery 确认）
    "delivery_lines": """
        SELECT d.DocKey, d.ItemCode, ISNULL(d.Description, ''), d.Qty, ISNULL(d.TransferedQty, 0)
        FROM [DODTL] d
        WHERE d.DocKey IN ({keys})
        ORDER BY d.DocKey, d.Seq
    """,
}


def _d(v) -> date:
    return v.date() if isinstance(v, datetime) else v


class AutoCountSource:
    def __init__(self):
        self.cfg = load_autocount_config()
        self.sql = {**DEFAULT_SQL, **self.cfg.get("webapp", {}).get("sql", {})}
        self.name = f"AutoCount · {self.cfg['connection']['database']}"
        self._conn = None
        # 渠道对照：Debtor Code → 报表渠道名（沿用 channel_rules.map）
        self._chan = {}
        for chan, codes in self.cfg.get("channel_rules", {}).get("map", {}).items():
            if not chan.startswith("_"):
                for c in codes:
                    self._chan[str(c)] = chan
        self._chan_label = {c["key"]: c["header"].replace(" RM", "")
                            for c in _base_config().get("forecast_channels", [])}

    def conn(self):
        if self._conn is None:
            self._conn = connect(self.cfg)
        return self._conn

    def _q(self, key, params=()):
        return fetch(self.conn(), self.sql[key], params)[1]

    def _channel(self, debtor_code: str) -> str:
        key = self._chan.get(str(debtor_code).strip(),
                             self.cfg.get("channel_rules", {}).get("default_channel", "cash"))
        return self._chan_label.get(key, key)

    # ---------------------------------------------------------------- 库存
    def _all_stock(self) -> list[StockRow]:
        reserved = {r[0].strip(): float(r[1] or 0) for r in self._q("reserved")}
        rows = []
        for code, desc, group, brand, uom, bal, reorder in self._q("stock_list"):
            code = code.strip()
            rows.append(StockRow(code, desc or "", group, brand, uom, float(bal or 0),
                                 reserved.get(code, 0.0), float(reorder or 0)))
        return rows

    def stock_list(self, q: str = "", group: str = "", low_only: bool = False) -> list[StockRow]:
        q = q.strip().lower()
        return [r for r in self._all_stock()
                if (not q or q in r.code.lower() or q in r.description.lower())
                and (not group or r.group == group)
                and (not low_only or r.is_low)]

    def stock_groups(self) -> list[str]:
        return sorted({r.group for r in self._all_stock() if r.group})

    def stock_item(self, code: str) -> Optional[StockRow]:
        return next((r for r in self._all_stock() if r.code == code), None)

    def stock_locations(self, code: str) -> list[LocationQty]:
        return [LocationQty(loc, float(q or 0)) for loc, q in self._q("stock_locations", (code,))]

    def movements(self, code: str, days: int = 30) -> list[Movement]:
        since = date.today() - timedelta(days=days)
        return [Movement(_d(dt), typ, no, party or "", float(qty or 0))
                for dt, typ, no, party, qty in self._q("movements", (code, since, code, since))]

    # ---------------------------------------------------------------- 出货
    def _load_deliveries(self, days: int) -> list[Delivery]:
        since = date.today() - timedelta(days=days)
        heads = self._q("deliveries", (since,))
        if not heads:
            return []
        keys = [h[0] for h in heads]
        lines_by_key: dict = {}
        for i in range(0, len(keys), 500):            # 避免 IN (...) 过长
            chunk = keys[i:i + 500]
            sql = self.sql["delivery_lines"].format(keys=",".join("?" * len(chunk)))
            for k, item, desc, qty, done in fetch(self.conn(), sql, tuple(chunk))[1]:
                lines_by_key.setdefault(k, []).append(
                    DeliveryLine(item.strip(), desc, float(qty or 0), float(done or 0)))
        out = []
        for k, no, dt, dcode, dname, cancelled, note in heads:
            lines = lines_by_key.get(k, [])
            if str(cancelled).upper() in ("T", "1", "TRUE"):
                status = "cancelled"
            elif not lines or all(l.delivered >= l.qty for l in lines):
                status = "done"
            elif any(l.delivered > 0 for l in lines):
                status = "partial"
            else:
                status = "open"
            out.append(Delivery(no, _d(dt), (dcode or "").strip(), dname, self._channel(dcode),
                                status, note or "", lines))
        return out

    def deliveries(self, status: str = "", channel: str = "", q: str = "",
                   days: int = 30) -> list[Delivery]:
        q = q.strip().lower()
        return [d for d in self._load_deliveries(days)
                if (not status or d.status == status)
                and (not channel or d.channel == channel)
                and (not q or q in d.doc_no.lower() or q in d.debtor_name.lower()
                     or any(q in l.item_code.lower() for l in d.lines))]

    def delivery(self, doc_no: str) -> Optional[Delivery]:
        return next((d for d in self._load_deliveries(3650) if d.doc_no == doc_no), None)

    def channels(self) -> list[str]:
        return [self._chan_label.get(k, k) for k in dict.fromkeys(self._chan.values())]

    # ---------------------------------------------------------------- 仪表板
    def _sales(self, days: int):
        since = date.today() - timedelta(days=days - 1)
        return [(_d(dt), key, (dc or "").strip(), (item or "").strip(), float(q or 0), float(a or 0))
                for dt, key, dc, item, q, a in self._q("sales_lines", (since, since, since))]

    def sales_daily(self, days: int = 30) -> list[SalesPoint]:
        from collections import defaultdict
        acc: dict = defaultdict(lambda: [0.0, 0.0, set()])
        for d, key, dc, item, q, a in self._sales(days):
            acc[d][0] += a; acc[d][1] += q; acc[d][2].add(key)
        out = []
        for back in range(days - 1, -1, -1):
            d = date.today() - timedelta(days=back)
            v = acc.get(d, [0.0, 0.0, set()])
            out.append(SalesPoint(d, round(v[0], 2), v[1], len(v[2])))
        return out

    def sales_by_channel(self, days: int = 30) -> list[ChannelSales]:
        from collections import defaultdict
        acc: dict = defaultdict(lambda: [0.0, 0.0, set()])
        for d, key, dc, item, q, a in self._sales(days):
            c = self._channel(dc)
            acc[c][0] += a; acc[c][1] += q; acc[c][2].add(key)
        return sorted((ChannelSales(c, round(v[0], 2), v[1], len(v[2])) for c, v in acc.items()),
                      key=lambda x: -x.amount)

    def sales_by_group(self, days: int = 30) -> list[tuple[str, float]]:
        from collections import defaultdict
        group = {r.code: r.group for r in self._all_stock()}
        acc: dict = defaultdict(float)
        for d, key, dc, item, q, a in self._sales(days):
            acc[group.get(item, "(未分类)")] += a
        return sorted(((g, round(v, 2)) for g, v in acc.items()), key=lambda x: -x[1])

    def top_skus(self, days: int = 30, n: int = 10) -> list[SkuSales]:
        from collections import defaultdict
        desc = {r.code: r.description for r in self._all_stock()}
        acc: dict = defaultdict(lambda: [0.0, 0.0])
        for d, key, dc, item, q, a in self._sales(days):
            acc[item][0] += q; acc[item][1] += a
        rows = [SkuSales(c, desc.get(c, ""), v[0], round(v[1], 2)) for c, v in acc.items() if v[0] > 0]
        return sorted(rows, key=lambda x: (-x.qty, x.code))[:n]


def _base_config() -> dict:
    import json
    p = ROOT / "config.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
