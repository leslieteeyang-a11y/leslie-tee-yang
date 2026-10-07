"""报价单推送（scripts/quote_push.py）的纯函数：依栏位组 SQL、明细列合并成每张单。不需要 AutoCount。"""
import sys
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import pytest  # noqa: E402

from quote_push import build_docs, build_sql  # noqa: E402

QT = {"DOCKEY", "DOCNO", "DOCDATE", "DEBTORCODE", "DEBTORNAME", "SALESAGENT", "NETTOTAL", "CANCELLED"}
QTDTL = {"DOCKEY", "DTLKEY", "SEQ", "ITEMCODE", "DESCRIPTION", "QTY", "SUBTOTAL", "TRANSFEREDQTY"}


def test_sql_uses_transfered_qty_and_target_links():
    sql = build_sql(QT, QTDTL, {"SODTL": {"FROMDOCTYPE", "FROMDOCDTLKEY"}, "IVDTL": {"FROMDOCTYPE"}, "DODTL": set()})
    assert "ISNULL(d.TransferedQty, 0)" in sql
    assert "FROM [SODTL] x WHERE x.FromDocType = 'QT'" in sql
    assert "[IVDTL]" not in sql                         # 没有 FromDocDtlKey 的表不拿来判断
    assert "h.Cancelled = 'F'" in sql and "h.NetTotal AS HdrAmount" in sql
    assert "ORDER BY h.DocDate, h.DocNo, d.Seq" in sql


def test_sql_falls_back_when_columns_missing():
    sql = build_sql({"DOCKEY", "DOCNO", "DOCDATE", "DEBTORCODE"}, {"DOCKEY", "ITEMCODE", "QTY"}, {})
    assert "NULL AS HdrAmount" in sql and "0 AS Transferred" in sql and "Cancelled" not in sql
    assert "d.ItemCode AS Description" in sql


def test_no_quotation_tables_says_what_to_check():
    with pytest.raises(SystemExit) as e:
        build_sql(set(), set(), {})
    assert "QT" in str(e.value)


def test_build_docs_merges_lines_and_flags_transfers():
    rows = [
        ("QT-1", datetime(2026, 9, 1), "300-C001", "AH MENG 012-3456789", "EMILY", 1500, "BASIN", 1, 1000, 0),
        ("QT-1", datetime(2026, 9, 1), "300-C001", "AH MENG 012-3456789", "EMILY", 1500, "TAP", 2, 500, 0),
        ("QT-2", date(2026, 9, 3), "300-C001", None, None, None, "LOCK", 1, 800, 0),
        ("QT-2", date(2026, 9, 3), "300-C001", None, None, None, "LOCK SET", 1, 200, 1),
        ("QT-3", date(2026, 9, 4), "300-C001", "X", "JC", None, None, None, None, None),   # 没有明细
    ]
    docs = build_docs(rows)
    assert [d["doc_no"] for d in docs] == ["QT-1", "QT-2", "QT-3"]
    q1, q2, q3 = docs
    assert q1["doc_date"] == "2026-09-01" and q1["amount"] == 1500 and not q1["transferred"]
    assert q1["items"] == "BASIN x1; TAP x2" and q1["sales_agent"] == "EMILY"
    assert q2["amount"] == 1000 and q2["transferred"] and q2["debtor_name"] is None   # 没有表头金额就加总明细
    assert q3["amount"] == 0 and q3["items"] == ""


def test_build_docs_shortens_long_item_list():
    rows = [("QT-9", date(2026, 9, 1), "C", "N", "A", 10, f"ITEM{i}", 1, 1, 0) for i in range(5)]
    assert build_docs(rows)[0]["items"] == "ITEM0 x1; ITEM1 x1; ITEM2 x1; …（共 5 项）"


def test_quotes_task_is_daily_with_its_own_description():
    import schedule_monthly
    xml = schedule_monthly.task_xml(Path("C:/x/run_quotes.bat"), 1, "12:30", Path("C:/x"), daily=True, desc="报价单")
    assert "<ScheduleByDay>" in xml and "<Description>报价单</Description>" in xml and "run_quotes.bat" in xml


# ── 送货单 DO（2026-10-06 送货排单） ─────────────────────────────────────────
from quote_push import build_do_docs, build_do_sql  # noqa: E402

DO = {"DOCKEY", "DOCNO", "DOCDATE", "DEBTORCODE", "DEBTORNAME", "SALESAGENT", "TOTAL", "CANCELLED",
      "DELIVERADDR1", "DELIVERADDR2", "DELIVERADDR3", "DELIVERADDR4", "DELIVERPOSTCODE", "INVADDR1"}
DODTL = {"DOCKEY", "DTLKEY", "ITEMCODE", "DESCRIPTION", "QTY", "SUBTOTAL"}


def test_do_sql_keeps_cancelled_documents_but_flags_them():
    sql = build_do_sql(DO, DODTL)
    assert "FROM [DO] h LEFT JOIN [DODTL] d" in sql
    assert "CASE WHEN h.Cancelled = 'T' THEN 1 ELSE 0 END AS Cancelled" in sql
    assert "h.Cancelled = 'F'" not in sql                   # 取消的也要推，BI 才知道这张不用送
    assert "h.Total AS HdrAmount" in sql and "ORDER BY h.DocDate, h.DocNo, d.DtlKey" in sql
    assert "ISNULL(', ' + NULLIF(LTRIM(RTRIM(h.DeliverAddr1)), ''), '')" in sql and "h.DeliverPostCode" in sql
    assert "CONCAT_WS" not in sql                           # SQL Server 2017 才有，旧版 AutoCount 会报错
    assert "InvAddr" not in sql                             # 不用发票地址（承包商的发票地址是办公室，不是工地）


def test_do_sql_without_deliver_address_columns():
    sql = build_do_sql({"DOCKEY", "DOCNO", "DOCDATE", "DEBTORCODE"}, DODTL)
    assert "NULL AS DeliverAddress" in sql


def test_do_docs_mark_cancelled():
    rows = [
        ("DO-1", date(2026, 10, 6), "300-C001", "MENG 0123456789", "EMILY", 500, "BASIN", 1, 500, 0, "12, Jalan  A,  81300"),
        ("DO-1", date(2026, 10, 6), "300-C001", "MENG 0123456789", "EMILY", 500, "TAP", 1, 0, 0, "12, Jalan  A,  81300"),
        ("DO-2", date(2026, 10, 6), "300-C001", "LIM 0129998888", None, None, "TAP", 2, 80, 1, ""),
    ]
    d1, d2 = build_do_docs(rows)
    assert d1["address"] == "12, Jalan A, 81300" and d2["address"] is None
    assert d1["doc_no"] == "DO-1" and d1["cancelled"] is False and d1["items"] == "BASIN x1; TAP x1" and "transferred" not in d1
    assert d2["cancelled"] is True and d2["amount"] == 80


def test_no_do_tables_says_what_to_check():
    with pytest.raises(SystemExit) as e:
        build_do_sql(set(), set())
    assert "DO" in str(e.value)


def test_quotes_task_repeats_every_15_minutes_during_the_day():
    import schedule_monthly
    xml = schedule_monthly.task_xml(Path("C:/x/run_quotes.bat"), 1, "07:00", Path("C:/x"), daily=True, repeat_minutes=15)
    assert "<Interval>PT15M</Interval>" in xml and "<Duration>PT14H</Duration>" in xml
    assert xml.index("<Repetition>") < xml.index("<StartBoundary>")   # 排程器的 XML 规定 Repetition 在前
    plain = schedule_monthly.task_xml(Path("C:/x/run_branch.bat"), 1, "07:30", Path("C:/x"), daily=True)
    assert "<Repetition>" not in plain


def test_install_task_xml_is_self_contained():
    """setup_quotes.bat 改叫 quote_push.py --install：SERVER 上旧的 schedule_monthly.py 不认识 --quotes（2026-10-06）。"""
    import xml.dom.minidom
    from quote_push import quotes_task_xml
    xml_text = quotes_task_xml(Path("C:/x"))
    xml.dom.minidom.parseString(xml_text.replace('encoding="UTF-16"', 'encoding="UTF-8"').encode())
    assert "<Interval>PT15M</Interval>" in xml_text and "<Duration>PT14H</Duration>" in xml_text
    assert xml_text.index("<Repetition>") < xml_text.index("<StartBoundary>")
    assert "T07:00:00</StartBoundary>" in xml_text and "<ScheduleByDay>" in xml_text
    assert "run_quotes.bat</Command>" in xml_text and "<Arguments>--scheduled</Arguments>" in xml_text


def test_setup_quotes_bat_does_not_need_schedule_monthly():
    bat = (ROOT / "setup_quotes.bat").read_text(encoding="ascii")
    assert "quote_push.py --install" in bat and "schedule_monthly" not in bat


def test_updater_runs_from_temp_and_verifies_files():
    bat = (ROOT / "update_from_zip.bat").read_text(encoding="ascii")
    assert "--from-temp" in bat and "/R" in bat and "Get-FileHash" in bat
    assert "/Q >nul" not in bat                       # 复制错误要看得到


def test_do_sql_reads_uom_and_remarks():
    sql = build_do_sql(DO | {"REMARK1", "REMARK2"}, DODTL | {"UOM"})
    assert "d.UOM AS UOM" in sql
    assert "ISNULL(' / ' + NULLIF(LTRIM(RTRIM(h.Remark1)), ''), '')" in sql and "h.Remark2" in sql and "Remark3" not in sql
    assert "STUFF(" in sql and ", 1, 3, '')" in sql          # 拿掉开头的「 / 」（3 个字元）
    plain = build_do_sql(DO, DODTL)
    assert "NULL AS UOM" in plain and "NULL AS Remark" in plain


def test_do_docs_keep_every_line_for_the_driver():
    """2026-10-07：司机要看完整货品清单对货（items 只留前 3 项），还有 DO 的备注。"""
    rows = [("DO-9", date(2026, 10, 7), "300-K001", "KAI", None, 0, f"ITEM {i}", i, 0, 0, "Site 5", "UNIT" if i % 2 else None,
             "  Call  before 10am ") for i in range(1, 6)]
    (d,) = build_do_docs(rows)
    assert len(d["lines"]) == 5 and d["lines"][0] == {"d": "ITEM 1", "q": 1.0, "u": "UNIT"} and d["lines"][1]["u"] is None
    assert d["items"].endswith("（共 5 项）") and d["remark"] == "Call before 10am"
