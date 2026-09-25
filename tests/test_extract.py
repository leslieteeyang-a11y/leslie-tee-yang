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


def test_every_group_is_reported_and_null_drops():
    rows = [("STOCK A", "cash", 123, 0.0), ("LOCK", "shopee", 2, 100.0)]
    out = build_forecast(rows, CHANNELS, BASE["category_map"], BASE["category_order"])
    assert [r["category"] for r in out] == ["Lock", "Stock A"]      # 以 AutoCount 为准，金额 0 也列
    dropped = build_forecast(rows, CHANNELS, {**BASE["category_map"], "STOCK A": None}, BASE["category_order"])
    assert [r["category"] for r in dropped] == ["Lock"]


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


def test_schedule_xml_runs_bat_on_chosen_day_and_catches_up():
    from pathlib import Path
    from schedule_monthly import task_xml
    xml = task_xml(Path(r"C:\HomeWorks\run_monthly.bat"), 1, "08:00", Path(r"C:\HomeWorks"))
    assert "<Day>1</Day>" in xml and "T08:00:00" in xml
    assert r"<Command>C:\HomeWorks\run_monthly.bat</Command>" in xml
    assert "<Arguments>--scheduled</Arguments>" in xml
    assert "<StartWhenAvailable>true</StartWhenAvailable>" in xml   # 1 号没开机 → 下次开机补跑


def test_run_monthly_previous_month_and_delivery(tmp_path, monkeypatch):
    import run_monthly
    from datetime import date
    class D(date):
        @classmethod
        def today(cls): return cls(2026, 1, 5)
    monkeypatch.setattr(run_monthly, "date", D)
    assert run_monthly.previous_month() == "2025-12"
    src = tmp_path / "月度报表_2025-12.xlsx"; src.write_bytes(b"x")
    run_monthly.deliver(src, str(tmp_path / "share" / "sub"))
    assert (tmp_path / "share" / "sub" / src.name).read_bytes() == b"x"
    run_monthly.deliver(src, "")                                     # 没设定就什么都不做


def test_supabase_payload_is_long_format_and_keeps_manual_sections():
    from supabase_push import build_payload, company_of
    doc = {
        "_产生方式": "v1",
        "ads": {"shopee_ads": [1]}, "live_sales": {},
        "sku_qty": {"SHOPEE": {"HM-YKR05-MB": 2}, "LAZADA": {"HM-YKR05-MB": 0}},
        "top10_up": [{"sku": "HM-101-MS", "lazada": 5, "shopee": 40}],
        "top10_down": [],
        "forecast_all": [{"category": "Sanitary", "qty": 10, "shopee": 100.5, "cash": 20.0},
                         {"category": "(未分类)", "qty": 3, "cash": 11453.5}],
        "forecast_hemos": [{"category": "Sanitary", "qty": 9, "shopee": 100.5}],
    }
    p = build_payload(doc)
    assert p["produced_by"] == "v1" and p["ads"] == {"shopee_ads": [1]}
    assert {"scope": "all", "category": "Sanitary", "qty": 10, "amount": 120.5} in p["category"]
    assert {"scope": "all", "category": "(未分类)", "qty": 3, "amount": 11453.5} in p["category"]
    assert {"scope": "hemos", "category": "Sanitary", "channel": "shopee", "amount": 100.5} in p["channel"]
    assert len(p["channel"]) == 4                       # 只送有金额的渠道
    assert p["sku"] == [{"platform": "SHOPEE", "sku": "HM-YKR05-MB", "qty": 2},
                        {"platform": "LAZADA", "sku": "HM-YKR05-MB", "qty": 0}]
    assert p["top10"] == [{"direction": "up", "rank": 1, "sku": "HM-101-MS", "lazada_qty": 5, "shopee_qty": 40}]
    assert company_of({"connection": {"database": "AED_HOMEWORKSSB"}}) == "HOMEWORKSSB"
