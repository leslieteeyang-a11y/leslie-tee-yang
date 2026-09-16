# -*- coding: utf-8 -*-
"""内建示范资料：固定种子，每次产生的内容一样，方便测试与展示。"""

from __future__ import annotations

import random
from datetime import date, timedelta
from typing import Optional

from . import Delivery, DeliveryLine, LocationQty, Movement, StockRow

LOCATIONS = ["HQ", "WH2", "SHOWROOM"]
CHANNELS = ["Shopee", "Lazada", "Cash", "水工", "Southern", "Tiktok", "Shopify"]
DEBTORS = {
    "Shopee": ("300-S001", "SHOPEE MALAYSIA"),
    "Lazada": ("300-L001", "LAZADA MALAYSIA"),
    "Cash": ("300-C001", "CASH SALES"),
    "水工": ("300-W001", "水工 - 陈师傅"),
    "Southern": ("300-SO01", "SOUTHERN HARDWARE SDN BHD"),
    "Tiktok": ("300-T001", "TIKTOK SHOP"),
    "Shopify": ("300-SH01", "SHOPIFY ONLINE STORE"),
}
# (code, description, group, brand, uom)
ITEMS = [
    ("HM-101-MS", "Basin Mixer Tap 101 Matt Silver", "Sanitary", "HEMOS", "PCS"),
    ("HM-0001-MS", "Bidet Spray Set 0001 Matt Silver", "Sanitary", "HEMOS", "SET"),
    ("HM-0067-MB", "Shower Head 0067 Matt Black", "Sanitary", "HEMOS", "PCS"),
    ("HM-0012", "Angle Valve 0012 Chrome", "Valve", "HEMOS", "PCS"),
    ("HM-9105-MS", "Kitchen Sink Tap 9105 Matt Silver", "Kitchen", "HEMOS X", "PCS"),
    ("HM-88010-MS", "Rain Shower Set 88010 Matt Silver", "Sanitary", "HEMOS X", "SET"),
    ("HM-40020-MS", "Floor Trap 40020 Matt Silver", "Fitting", "HEMOS", "PCS"),
    ("HM-115", "Basin Waste 115 Chrome", "Fitting", "HEMOS", "PCS"),
    ("HM-3233-MS", "Towel Bar 3233 Matt Silver", "Sanitary", "HEMOS", "PCS"),
    ("HM-5201-MB", "Paper Holder 5201 Matt Black", "Sanitary", "HEMOS", "PCS"),
    ("HM-YKR05-MB", "Digital Door Lock YKR05 Matt Black", "Lock", "HEMOS", "SET"),
    ("HM-YKR06-MB", "Digital Door Lock YKR06 Matt Black", "Lock", "HEMOS", "SET"),
    ("HM-YKR07-MB", "Digital Door Lock YKR07 Matt Black", "Lock", "HEMOS", "SET"),
    ("HM-YKR08-MB", "Digital Door Lock YKR08 Matt Black", "Lock", "HEMOS", "SET"),
    ("HM-YKS4050-MB", "Smart Lock YKS4050 Matt Black", "Lock", "HEMOS X", "SET"),
    ("HM-YKS5070-MB", "Smart Lock YKS5070 Matt Black", "Lock", "HEMOS X", "SET"),
    ("HM-YKS7090-MB", "Smart Lock YKS7090 Matt Black", "Lock", "HEMOS X", "SET"),
    ("HML-502-501", "LED Mirror 502-501", "Sanitary", "HEMOS", "PCS"),
    ("HML-505-500", "LED Mirror 505-500", "Sanitary", "HEMOS", "PCS"),
    ("HML-560", "LED Mirror 560", "Sanitary", "HEMOS", "PCS"),
    ("HMSC-6021", "Shower Column 6021", "Sanitary", "HEMOS", "SET"),
    ("HM-613-YELLOW", "Garden Hose 613 Yellow", "Garden", "OTHER", "ROLL"),
    ("HM-88047-WD", "Kitchen Sink 88047 Wood", "Kitchen", "HEMOS X", "PCS"),
    ("HM-19044-W", "Basin 19044 White", "Sanitary", "HEMOS", "PCS"),
    ("HMBF-83808-MS", "Bath Filler 83808 Matt Silver", "Sanitary", "HEMOS X", "PCS"),
    ("HM-BV15", "Ball Valve 15mm", "Valve", "OTHER", "PCS"),
    ("HM-BV20", "Ball Valve 20mm", "Valve", "OTHER", "PCS"),
    ("HM-FLEX40", "Flexible Hose 40cm", "Fitting", "OTHER", "PCS"),
    ("HM-FLEX60", "Flexible Hose 60cm", "Fitting", "OTHER", "PCS"),
    ("HM-WC-2201", "Water Closet 2201 One-Piece", "Sanitary", "HEMOS", "SET"),
]


class MockSource:
    name = "示范资料 (mock)"

    def __init__(self, seed: int = 20260916, today: Optional[date] = None):
        self.today = today or date.today()
        rnd = random.Random(seed)
        self._items: dict[str, StockRow] = {}
        self._locs: dict[str, list[LocationQty]] = {}
        self._moves: dict[str, list[Movement]] = {}
        self._dos: dict[str, Delivery] = {}

        for code, desc, group, brand, uom in ITEMS:
            per_loc = [rnd.choice([0, 0, rnd.randint(1, 60)]) for _ in LOCATIONS]
            per_loc[0] = rnd.randint(0, 120)
            on_hand = float(sum(per_loc))
            reserved = float(rnd.choice([0, 0, 0, rnd.randint(1, 15)]))
            reorder = float(rnd.choice([5, 10, 20]))
            self._items[code] = StockRow(code, desc, group, brand, uom, on_hand, reserved, reorder)
            self._locs[code] = [LocationQty(l, float(q)) for l, q in zip(LOCATIONS, per_loc) if q]

        # 出货单：最近 45 天，约 45 张
        codes = list(self._items)
        for i in range(45):
            d = self.today - timedelta(days=rnd.randint(0, 44))
            channel = rnd.choice(CHANNELS)
            dcode, dname = DEBTORS[channel]
            n_lines = rnd.randint(1, 4)
            lines = []
            for code in rnd.sample(codes, n_lines):
                qty = float(rnd.randint(1, 12))
                lines.append(DeliveryLine(code, self._items[code].description, qty, qty))
            age = (self.today - d).days
            if age > 14:
                status = "done" if rnd.random() < 0.92 else "cancelled"
            elif age > 3:
                status = rnd.choice(["done", "done", "partial", "open"])
            else:
                status = rnd.choice(["open", "open", "partial"])
            if status == "open":
                for l in lines:
                    l.delivered = 0
            elif status == "partial":
                for l in lines:
                    l.delivered = float(rnd.randint(0, int(l.qty) - 1)) if l.qty > 1 else 0
                if all(l.delivered == 0 for l in lines):
                    lines[0].delivered = 1
            elif status == "cancelled":
                for l in lines:
                    l.delivered = 0
            doc_no = f"DO-{d:%y%m}-{1000 + i:04d}"
            remark = rnd.choice(["", "", "客户要求下午送", "安装师傅：阿明", "自取"])
            self._dos[doc_no] = Delivery(doc_no, d, dcode, dname, channel, status, remark, lines)

        # 库存异动：出货单已出货的部分 + 随机进货
        for do in self._dos.values():
            for l in do.lines:
                if l.delivered:
                    self._moves.setdefault(l.item_code, []).append(
                        Movement(do.doc_date, "出货", do.doc_no, do.debtor_name, -l.delivered))
        for code in codes:
            for _ in range(rnd.randint(0, 3)):
                d = self.today - timedelta(days=rnd.randint(0, 44))
                self._moves.setdefault(code, []).append(
                    Movement(d, "进货", f"GR-{d:%y%m}-{rnd.randint(100, 999)}",
                             rnd.choice(["HEMOS FACTORY", "FOSHAN SUPPLIER", "LOCAL VENDOR"]),
                             float(rnd.randint(10, 60))))

    # ---------------------------------------------------------------- 库存
    def stock_list(self, q: str = "", group: str = "", low_only: bool = False) -> list[StockRow]:
        q = q.strip().lower()
        rows = [r for r in self._items.values()
                if (not q or q in r.code.lower() or q in r.description.lower())
                and (not group or r.group == group)
                and (not low_only or r.is_low)]
        return sorted(rows, key=lambda r: r.code)

    def stock_groups(self) -> list[str]:
        return sorted({r.group for r in self._items.values()})

    def stock_item(self, code: str) -> Optional[StockRow]:
        return self._items.get(code)

    def stock_locations(self, code: str) -> list[LocationQty]:
        return list(self._locs.get(code, []))

    def movements(self, code: str, days: int = 30) -> list[Movement]:
        cutoff = self.today - timedelta(days=days)
        rows = [m for m in self._moves.get(code, []) if m.doc_date >= cutoff]
        return sorted(rows, key=lambda m: (m.doc_date, m.doc_no), reverse=True)

    # ---------------------------------------------------------------- 出货
    def deliveries(self, status: str = "", channel: str = "", q: str = "",
                   days: int = 30) -> list[Delivery]:
        q = q.strip().lower()
        cutoff = self.today - timedelta(days=days)
        rows = [d for d in self._dos.values()
                if d.doc_date >= cutoff
                and (not status or d.status == status)
                and (not channel or d.channel == channel)
                and (not q or q in d.doc_no.lower() or q in d.debtor_name.lower()
                     or any(q in l.item_code.lower() for l in d.lines))]
        return sorted(rows, key=lambda d: (d.doc_date, d.doc_no), reverse=True)

    def delivery(self, doc_no: str) -> Optional[Delivery]:
        return self._dos.get(doc_no)

    def channels(self) -> list[str]:
        return list(CHANNELS)
