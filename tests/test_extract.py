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


def test_backfill_month_range_crosses_year():
    from backfill import month_range, previous_month
    from datetime import date
    assert month_range("2025-11", "2026-02") == ["2025-11", "2025-12", "2026-01", "2026-02"]
    assert month_range("2026-08", "2026-08") == ["2026-08"]
    assert previous_month(date(2026, 1, 15)) == "2025-12"


def test_set_key_dedupes_repeated_paste(tmp_path, monkeypatch):
    import supabase_push, autocount_db
    cfgfile = tmp_path / "autocount.json"; cfgfile.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(autocount_db, "CONFIG_PATH", cfgfile)
    monkeypatch.setattr("builtins.input", lambda _: "sb_secret_ABC-12" * 3)
    cfg = supabase_push.set_key({})
    assert cfg["supabase"]["service_key"] == "sb_secret_ABC-12"
    assert cfg["supabase"]["url"].startswith("https://")


def test_set_key_reuses_saved_key_when_enter_pressed(tmp_path, monkeypatch):
    import supabase_push, autocount_db
    cfgfile = tmp_path / "autocount.json"; cfgfile.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(autocount_db, "CONFIG_PATH", cfgfile)
    monkeypatch.setattr("builtins.input", lambda _: "")
    cfg = supabase_push.set_key({"supabase": {"url": "https://x.supabase.co", "service_key": "sb_secret_K1" * 3}})
    assert cfg["supabase"]["service_key"] == "sb_secret_K1"      # 沿用已存的，并顺手修掉重复


def test_branch_actual_rows_follow_user_definition():
    from branch_actual import build_rows, sql_lines
    cmap = BASE["category_map"]
    # (ItemGroup, ItemType, Amount, Extra)：SO 的 Extra = 未转发票部分；IV 的 Extra = 不是从 SO 来的部分
    so = [("SANITARY", "HEMOS", 1000.0, 400.0), ("KITCHEN", "ITTO", 500.0, 500.0)]
    iv = [("SANITARY", "HEMOS", 800.0, 200.0), ("DELIVERY", "", 50.0, 50.0)]
    cn = [("SANITARY", "HEMOS", 100.0, 0)]
    rows = build_rows(so, iv, cn, cmap, ["HEMOS", "HEMOSX"])
    by = {(r["scope"], r["category"]): r for r in rows}
    s = by[("all", "Sanitary")]
    assert (s["so_amount"], s["so_open"], s["iv_amount"], s["iv_direct"], s["cn_amount"]) == (1000, 400, 800, 200, 100)
    assert s["actual_amount"] == 1000 + 200 - 100                  # SO 全部 + 非SO发票 − 贷项
    assert by[("all", "Kitchen")]["actual_amount"] == 500
    assert ("hemos", "Kitchen") not in by                            # ITTO 不是 Hemos
    assert by[("hemos", "Sanitary")]["actual_amount"] == 1100
    assert by[("all", "DELIVERY")]["actual_amount"] == 50           # 分行独有群组照实列
    for doc in ("SO", "IV", "CN"):
        assert "SalesAgent" in sql_lines(doc) and "Cancelled = 'F'" in sql_lines(doc)


def test_setup_branch_refuses_hq_book(tmp_path, monkeypatch):
    """分行流程连到总公司账套（preferred_database）时要停下来，不能把总公司数字当分行推上去。"""
    import pytest
    import supabase_push
    monkeypatch.setattr("autocount_db.CONFIG_PATH", tmp_path / "autocount.json")
    monkeypatch.setattr(supabase_push, "book_company_name_of", lambda cfg: None)
    with pytest.raises(SystemExit) as e:
        supabase_push.setup_branch_flow({"connection": {"database": "AED_HOMEWORKSSB"}})
    assert "choose_book.bat" in str(e.value)


def test_setup_branch_trusts_company_name_over_db_name(tmp_path, monkeypatch):
    """分行账套库名可能与总公司相同（复制账套没改名）；公司名称含 SOUTHERN 就放行，反之就挡。"""
    import json
    import pytest
    import supabase_push
    target = tmp_path / "autocount.json"
    monkeypatch.setattr("autocount_db.CONFIG_PATH", target)
    monkeypatch.setattr(supabase_push, "set_key", lambda cfg: (_ for _ in ()).throw(SystemExit("stop")))
    monkeypatch.setattr(supabase_push, "book_company_name_of", lambda cfg: "HOMEWORKS (SOUTHERN) SDN. BHD.")
    with pytest.raises(SystemExit, match="stop"):
        supabase_push.setup_branch_flow({"connection": {"database": "AED_HOMEWORKSSB"}})
    assert json.loads(target.read_text(encoding="utf-8"))["supabase"]["company"] == "HOMEWORKSSOUTHERN"
    monkeypatch.setattr(supabase_push, "book_company_name_of", lambda cfg: "HOMEWORKS SDN. BHD.")
    with pytest.raises(SystemExit, match="没有 SOUTHERN"):
        supabase_push.setup_branch_flow({"connection": {"database": "AED_HOMEWORKSJB"}})


def test_setup_branch_needs_company_when_name_unknown(tmp_path, monkeypatch):
    """读不到公司名称、库名也不是总公司时，不能再预设成 JB Southern（现在有两家分行）：要求 --company，并把它存档。"""
    import json
    import pytest
    import supabase_push
    target = tmp_path / "autocount.json"
    monkeypatch.setattr("autocount_db.CONFIG_PATH", target)
    monkeypatch.setattr(supabase_push, "set_key", lambda cfg: (_ for _ in ()).throw(SystemExit("stop")))
    monkeypatch.setattr(supabase_push, "book_company_name_of", lambda cfg: None)
    with pytest.raises(SystemExit, match="--company"):
        supabase_push.setup_branch_flow({"connection": {"database": "AED_HOMEWORKSJB"}})
    assert not target.exists()
    with pytest.raises(SystemExit, match="stop"):
        supabase_push.setup_branch_flow({"connection": {"database": "AED_HOMEWORKSJB"}}, "homeworkskl")
    assert json.loads(target.read_text(encoding="utf-8"))["supabase"]["company"] == "HOMEWORKSKL"
    with pytest.raises(SystemExit, match="只能是"):
        supabase_push.setup_branch_flow({"connection": {"database": "AED_HOMEWORKSJB"}}, "HOMEWORKSPENANG")


def test_branch_company_detected_from_book_name():
    """KL 分行（HOMEWORKS KL SDN BHD）与 JB Southern 都要能从账套公司名称认出；总公司认不出；KL 要整词比对。"""
    import json
    import pytest
    import supabase_push
    f = supabase_push.branch_company_for
    assert f("HOMEWORKS (SOUTHERN) SDN. BHD.") == "HOMEWORKSSOUTHERN"
    assert f("HOMEWORKS KL SDN BHD") == "HOMEWORKSKL"
    assert f("Homeworks KL Sdn. Bhd.") == "HOMEWORKSKL"
    assert f("HOMEWORKS SDN. BHD.") is None
    assert f("SPARKLE HOMEWORKS SDN BHD") is None          # KL 夹在单字里不算
    assert f(None) is None


def test_setup_branch_kl_book_saves_kl_company(tmp_path, monkeypatch):
    import json
    import pytest
    import supabase_push
    target = tmp_path / "autocount.json"
    monkeypatch.setattr("autocount_db.CONFIG_PATH", target)
    monkeypatch.setattr(supabase_push, "set_key", lambda cfg: (_ for _ in ()).throw(SystemExit("stop")))
    monkeypatch.setattr(supabase_push, "book_company_name_of", lambda cfg: "HOMEWORKS KL SDN BHD")
    with pytest.raises(SystemExit, match="stop"):
        supabase_push.setup_branch_flow({"connection": {"database": "AED_HOMEWORKSSB"},
                                         "supabase": {"company": "HOMEWORKSSOUTHERN"}})   # 从 JB 复制来的旧设定要被改掉
    assert json.loads(target.read_text(encoding="utf-8"))["supabase"]["company"] == "HOMEWORKSKL"


def test_agent_detail_attaches_direct_invoice_amount():
    """各 agent 的发票列要附上「非SO发票」金额，BI 分行页才能算每位 agent 的实际销售额。"""
    import branch_actual
    agents = [["SO", "EMILY", 3, 1000.0], ["IV", "EMILY", 2, 800.0], ["IV", "", 1, 50.0], ["CN", "EMILY", 1, 30.0]]
    out = branch_actual.agent_detail(agents, {"EMILY": 300.0, "": 50.0})
    iv = [r for r in out if r["doc"] == "IV"]
    assert iv[0] == {"doc": "IV", "agent": "EMILY", "docs": 2, "amount": 800.0, "direct": 300.0}
    assert iv[1]["agent"] == "(blank)" and iv[1]["direct"] == 50.0
    assert "direct" not in out[0]                     # SO 列没有这个栏位


def test_branch_task_xml_is_daily():
    """分行排程要每天跑（本月至今才会每天更新），总公司的仍是每月一次。"""
    from pathlib import Path
    import schedule_monthly
    daily = schedule_monthly.task_xml(Path("C:/x/run_branch.bat"), 1, "07:30", Path("C:/x"), daily=True)
    monthly = schedule_monthly.task_xml(Path("C:/x/run_monthly.bat"), 1, "08:00", Path("C:/x"))
    assert "<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>" in daily and "ScheduleByMonth" not in daily
    assert "ScheduleByMonth" in monthly and "ScheduleByDay" not in monthly


def test_merge_ads_prefers_bi_values_and_reports_change():
    """BI 上填过的广告 / 直播数字要盖过本机 JSON；BI 是空的就不动本机档。"""
    import supabase_push
    doc = {"ads": {}, "live_sales": {"SHOPEE": 0, "TIKTOK": 0}}
    remote = {"ads": {"SHOPEE ADS": [{"period": "1~8", "gmv": 10.0, "expense": 1.0}]}, "live_sales": {"SHOPEE": 500, "TIKTOK": 0}}
    out, changed = supabase_push.merge_ads(dict(doc), remote)
    assert changed and out["ads"] == remote["ads"] and out["live_sales"]["SHOPEE"] == 500
    same, changed2 = supabase_push.merge_ads(dict(out), remote)
    assert not changed2
    untouched, changed3 = supabase_push.merge_ads({"ads": {"X": []}, "live_sales": {}}, {"ads": {}, "live_sales": {"SHOPEE": 0}})
    assert not changed3 and untouched["ads"] == {"X": []}
