# -*- coding: utf-8 -*-
"""资料来源抽象层。

同一组介面有两套实作：
  - mock      内建示范资料，任何机器都能跑，用来开发、测试与展示
  - autocount 连 AutoCount 的 SQL Server（只读）

网页层只认这里定义的介面，不认资料库，所以两边可以随时切换。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Optional, Protocol

ROOT = Path(__file__).resolve().parent.parent.parent

STATUS_LABEL = {
    "open": "待出货",
    "partial": "部分出货",
    "done": "已完成",
    "cancelled": "已取消",
}


@dataclass
class StockRow:
    code: str
    description: str
    group: str
    brand: str
    uom: str
    on_hand: float
    reserved: float            # 销售订单尚未出货的数量
    reorder_level: float = 0

    @property
    def available(self) -> float:
        return self.on_hand - self.reserved

    @property
    def is_low(self) -> bool:
        return self.available <= self.reorder_level


@dataclass
class LocationQty:
    location: str
    qty: float


@dataclass
class Movement:
    doc_date: date
    doc_type: str              # 进货 / 出货 / 调拨 / 调整 …
    doc_no: str
    party: str                 # 客户或供应商
    qty: float                 # 正数入库，负数出库


@dataclass
class DeliveryLine:
    item_code: str
    description: str
    qty: float
    delivered: float


@dataclass
class Delivery:
    doc_no: str
    doc_date: date
    debtor_code: str
    debtor_name: str
    channel: str
    status: str                # open / partial / done / cancelled
    remark: str = ""
    lines: list[DeliveryLine] = field(default_factory=list)

    @property
    def total_qty(self) -> float:
        return sum(l.qty for l in self.lines)

    @property
    def delivered_qty(self) -> float:
        return sum(l.delivered for l in self.lines)

    @property
    def status_label(self) -> str:
        return STATUS_LABEL.get(self.status, self.status)


class DataSource(Protocol):
    name: str

    def stock_list(self, q: str = "", group: str = "", low_only: bool = False) -> list[StockRow]: ...
    def stock_groups(self) -> list[str]: ...
    def stock_item(self, code: str) -> Optional[StockRow]: ...
    def stock_locations(self, code: str) -> list[LocationQty]: ...
    def movements(self, code: str, days: int = 30) -> list[Movement]: ...
    def deliveries(self, status: str = "", channel: str = "", q: str = "",
                   days: int = 30) -> list[Delivery]: ...
    def delivery(self, doc_no: str) -> Optional[Delivery]: ...
    def channels(self) -> list[str]: ...


_source: Optional[DataSource] = None


def get_source() -> DataSource:
    """依环境变数 HW_SOURCE 决定资料来源；没设的话，有 autocount.json 就接 AutoCount，否则用示范资料。"""
    global _source
    if _source is None:
        choice = os.environ.get("HW_SOURCE", "").lower()
        if not choice:
            choice = "autocount" if (ROOT / "autocount.json").exists() else "mock"
        if choice == "autocount":
            from .autocount import AutoCountSource
            _source = AutoCountSource()
        else:
            from .mock import MockSource
            _source = MockSource()
    return _source


def reset_source() -> None:
    global _source
    _source = None
