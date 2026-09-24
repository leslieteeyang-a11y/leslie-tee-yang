"""autocount_extract 的纯函数测试（不需要 AutoCount）。"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from autocount_extract import build_forecast, build_month_doc, model_code  # noqa: E402

BASE = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
AC = json.loads((ROOT / "autocount.example.json").read_text(encoding="utf-8"))
CHANNELS = [c["key"] for c in BASE["forecast_channels"]]


def test_uncoded_lines_stay_visible_as_their_own_row():
    # 2026-08 对账：纸本没把未分类算进 Sanitary，所以要单独列出、不能并进去
    rows = [(None, "cash", 30, 11453.5), ("SANITARY", "cash", 1, 81870.19)]
    out = build_forecast(rows, CHANNELS, BASE["category_map"], BASE["category_order"])
    by = {r["category"]: r for r in out}
    assert by["Sanitary"]["cash"] == 81870.19
    assert by["(未分类)"]["cash"] == 11453.5 and by["(未分类)"]["qty"] == 30
    assert out[-1]["category"] == "(未分类)"          # 没在 category_order 里的排最后


def test_null_mapped_group_is_dropped():
    rows = [("STOCK A", "cash", 123, 0.0), ("LOCK", "shopee", 2, 100.0)]
    out = build_forecast(rows, CHANNELS, BASE["category_map"], BASE["category_order"])
    assert [r["category"] for r in out] == ["Lock"]


def test_fee_groups_merge_into_report_rows():
    rows = [("TRAN FEE", "lazada", -1, -10.0), ("PAY FEE", "lazada", -1, -5.0)]
    out = build_forecast(rows, CHANNELS, BASE["category_map"], BASE["category_order"])
    assert out == [{"category": "Transaction Fee", "qty": -2, "lazada": -15.0}]


def test_model_code_from_description():
    pat = BASE["model_code_pattern"]
    assert model_code("ST000183", "HEMOS STEEL WALL BIB TAP HM-3305", None, None, pat) == "HM-3305"
    assert model_code("ST001177", "HEMOS 12'' SHOWER HEAD", "HEMOS SHOWER HEAD HMSH-138", None, pat) == "HMSH-138"
    assert model_code("BM000017", "OUTDOOR FIBRE FILTER 1044", None, None, pat) == "BM000017"


def test_top10_ranks_by_platform_qty_only():
    # (ItemCode, Channel, Qty, Description, Desc2, GlobalCode)
    items = [
        ("ST1", "shuigong", 500, "PIPE X", None, None),          # 只在水工卖：不该进榜
        ("ST2", "shopee", 40, "HEMOS TAP HM-101-MS", None, None),
        ("ST3", "lazada", 5, "HEMOS TAP HM-101-MS", None, None),  # 同型号不同代号：合并
        ("ST4", "shopee", 7, "HEMOS TAP HM-0012", None, None),
        ("ST5", "shopee", 1, "HEMOS TAP HM-115", None, None),
    ] + [(f"F{i}", "shopee", 10 + i, f"HEMOS FILLER HM-9{i:02d}", None, None) for i in range(12)]
    doc = build_month_doc(AC, BASE, "2026-08", [], [], items, {})
    up = doc["top10_up"]
    assert up[0] == {"sku": "HM-101-MS", "lazada": 5, "shopee": 40}
    assert all(r["sku"] != "ST1" for r in up + doc["top10_down"])
    assert doc["top10_down"][0]["sku"] == "HM-115"


def test_sku_trend_uses_model_code():
    items = [("ST9", "shopee", 3, "HEMOS LOCK HM-YKR05-MB BLACK", None, None)]
    doc = build_month_doc(AC, BASE, "2026-08", [], [], items, {"ads": {"x": 1}})
    assert doc["sku_qty"]["SHOPEE"]["HM-YKR05-MB"] == 3
    assert doc["ads"] == {"x": 1}                       # 手填的段落要保留
