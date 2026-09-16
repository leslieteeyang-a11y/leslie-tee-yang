# -*- coding: utf-8 -*-
"""AutoCount 资料来源（只读）。

所有 SQL 都可以在 autocount.json 的 "webapp" 段覆写；这里的预设值是 AutoCount
常见的表名栏名，**尚未在你们的账套上验证**——跑过 autocount_discover.py 之后
依 discovery 档案修正。

这个模组只做 SELECT，不会对 AutoCount 写入任何东西。
"""

from __future__ import annotations

import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional

from . import Delivery, DeliveryLine, LocationQty, Movement, StockRow

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from autocount_db import connect, fetch, load_autocount_config   # noqa: E402

# ---- 预设 SQL（可在 autocount.json > webapp > sql 覆写）-------------------
DEFAULT_SQL = {
    # 库存清单：每个 SKU 一列。BalQty 为现有量，SO 未出货量另外算。
    "stock_list": """
        SELECT i.ItemCode, i.Description, ISNULL(i.ItemGroup, ''), ISNULL(i.Brand, ''),
               ISNULL(i.BaseUOM, ''), ISNULL(i.BalQty, 0), ISNULL(i.ReorderLevel, 0)
        FROM [Item] i
        WHERE i.IsActive = 'T'
        ORDER BY i.ItemCode
    """,
    # 销售订单未出货量（reserved）
    "reserved": """
        SELECT d.ItemCode, SUM(d.Qty - ISNULL(d.TransferedQty, 0))
        FROM [SO] h JOIN [SODtl] d ON d.DocKey = h.DocKey
        WHERE h.Cancelled = 'F'
        GROUP BY d.ItemCode
        HAVING SUM(d.Qty - ISNULL(d.TransferedQty, 0)) > 0
    """,
    # 各仓库存
    "stock_locations": """
        SELECT Location, SUM(BalQty)
        FROM [ItemLocation]
        WHERE ItemCode = ?
        GROUP BY Location
        HAVING SUM(BalQty) <> 0
    """,
    # 库存异动：出货单（-）与收货单（+）
    "movements": """
        SELECT h.DocDate, N'出货', h.DocNo, ISNULL(h.DebtorName, h.DebtorCode), -d.Qty
        FROM [DO] h JOIN [DODtl] d ON d.DocKey = h.DocKey
        WHERE d.ItemCode = ? AND h.DocDate >= ? AND h.Cancelled = 'F'
        UNION ALL
        SELECT h.DocDate, N'进货', h.DocNo, ISNULL(h.CreditorName, h.CreditorCode), d.Qty
        FROM [GR] h JOIN [GRDtl] d ON d.DocKey = h.DocKey
        WHERE d.ItemCode = ? AND h.DocDate >= ? AND h.Cancelled = 'F'
        ORDER BY 1 DESC
    """,
    # 出货单表头
    "deliveries": """
        SELECT h.DocKey, h.DocNo, h.DocDate, h.DebtorCode, ISNULL(h.DebtorName, ''),
               h.Cancelled, ISNULL(h.Note, '')
        FROM [DO] h
        WHERE h.DocDate >= ?
        ORDER BY h.DocDate DESC, h.DocNo DESC
    """,
    # 出货单明细（TransferedQty = 已转成发票的数量，视为已出货）
    "delivery_lines": """
        SELECT d.DocKey, d.ItemCode, ISNULL(d.Description, ''), d.Qty, ISNULL(d.TransferedQty, 0)
        FROM [DODtl] d
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


def _base_config() -> dict:
    import json
    p = ROOT / "config.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
