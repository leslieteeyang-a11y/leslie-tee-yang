# -*- coding: utf-8 -*-
"""营运入口的行为测试（用内建示范资料，不需要 AutoCount）。"""

import os
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

os.environ["HW_SOURCE"] = "mock"

from webapp.main import app                       # noqa: E402
from webapp.sources import reset_source           # noqa: E402
from webapp.sources.mock import MockSource        # noqa: E402


@pytest.fixture(autouse=True)
def fresh_source():
    reset_source()
    yield
    reset_source()


@pytest.fixture
def client():
    return TestClient(app)


# ------------------------------------------------------------- 资料层
def test_mock_is_deterministic():
    a, b = MockSource(), MockSource()
    assert [r.on_hand for r in a.stock_list()] == [r.on_hand for r in b.stock_list()]
    assert [d.doc_no for d in a.deliveries()] == [d.doc_no for d in b.deliveries()]


def test_available_and_low_flag():
    src = MockSource()
    for r in src.stock_list():
        assert r.available == r.on_hand - r.reserved
        assert r.is_low == (r.available <= r.reorder_level)
    assert all(r.is_low for r in src.stock_list(low_only=True))


def test_locations_sum_to_on_hand():
    src = MockSource()
    for r in src.stock_list():
        assert sum(l.qty for l in src.stock_locations(r.code)) == r.on_hand, r.code


def test_delivery_status_matches_lines():
    src = MockSource()
    for d in src.deliveries(days=90):
        if d.status == "open":
            assert d.delivered_qty == 0
        elif d.status == "partial":
            assert 0 < d.delivered_qty < d.total_qty
        elif d.status == "done":
            assert d.delivered_qty == d.total_qty
        elif d.status == "cancelled":
            assert d.delivered_qty == 0


def test_deliveries_window():
    src = MockSource()
    cutoff = date.today() - timedelta(days=7)
    assert all(d.doc_date >= cutoff for d in src.deliveries(days=7))
    assert len(src.deliveries(days=7)) <= len(src.deliveries(days=90))


def test_search_matches_code_description_and_sku_in_lines():
    src = MockSource()
    assert all("yks" in r.code.lower() for r in src.stock_list(q="YKS"))
    assert any("mirror" in r.description.lower() for r in src.stock_list(q="mirror"))
    hits = src.deliveries(q="HM-YKS5070-MB", days=90)
    assert hits and all(any(l.item_code == "HM-YKS5070-MB" for l in d.lines) for d in hits)


# ------------------------------------------------------------- 网页层
def test_home_redirects_to_inventory(client):
    r = client.get("/", follow_redirects=False)
    assert r.status_code in (302, 307) and r.headers["location"] == "/inventory"


def test_health_reports_source(client):
    assert client.get("/health").json()["source"].startswith("示范资料")


def test_inventory_page_lists_items_and_filters(client):
    r = client.get("/inventory")
    assert r.status_code == 200 and "HM-YKS5070-MB" in r.text and "低于安全库存" in r.text
    r = client.get("/inventory", params={"group": "Lock"})
    assert "HM-YKR05-MB" in r.text and "HM-101-MS" not in r.text
    r = client.get("/inventory", params={"q": "不存在的东西"})
    assert "没有符合的项目" in r.text


def test_inventory_low_only(client):
    src = MockSource()
    low = {r.code for r in src.stock_list(low_only=True)}
    ok = {r.code for r in src.stock_list() if not r.is_low}
    html = client.get("/inventory", params={"low": "1"}).text
    assert all(c in html for c in low)
    assert not any(f'href="/inventory/{c}"' in html for c in ok)


def test_item_detail_and_404(client):
    r = client.get("/inventory/HM-YKS5070-MB")
    assert r.status_code == 200 and "各仓库存" in r.text and "异动" in r.text
    assert client.get("/inventory/NOPE").status_code == 404


def test_deliveries_page_and_status_filter(client):
    r = client.get("/deliveries")
    assert r.status_code == 200 and "待出货" in r.text
    r = client.get("/deliveries", params={"status": "open", "days": 90})
    assert "st-done" not in r.text and "st-partial" not in r.text
    r = client.get("/deliveries", params={"channel": "Shopee", "days": 90})
    assert "LAZADA MALAYSIA" not in r.text


def test_delivery_detail_and_404(client):
    doc = MockSource().deliveries(days=90)[0].doc_no
    r = client.get(f"/deliveries/{doc}")
    assert r.status_code == 200 and doc in r.text and "未出货" in r.text
    assert client.get("/deliveries/DO-0000-0000").status_code == 404


def test_json_api(client):
    inv = client.get("/api/inventory", params={"low": "1"}).json()
    assert inv and all(row["is_low"] for row in inv)
    dos = client.get("/api/deliveries", params={"status": "partial", "days": 90}).json()
    assert dos and all(0 < d["delivered_qty"] < d["total_qty"] for d in dos)
