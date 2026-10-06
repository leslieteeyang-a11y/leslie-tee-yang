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

DO = {"DOCKEY", "DOCNO", "DOCDATE", "DEBTORCODE", "DEBTORNAME", "SALESAGENT", "TOTAL", "CANCELLED"}
DODTL = {"DOCKEY", "DTLKEY", "ITEMCODE", "DESCRIPTION", "QTY", "SUBTOTAL"}


def test_do_sql_keeps_cancelled_documents_but_flags_them():
    sql = build_do_sql(DO, DODTL)
    assert "FROM [DO] h LEFT JOIN [DODTL] d" in sql
    assert "CASE WHEN h.Cancelled = 'T' THEN 1 ELSE 0 END AS Cancelled" in sql
    assert "h.Cancelled = 'F'" not in sql                   # 取消的也要推，BI 才知道这张不用送
    assert "h.Total AS HdrAmount" in sql and "ORDER BY h.DocDate, h.DocNo, d.DtlKey" in sql


def test_do_docs_mark_cancelled():
    rows = [
        ("DO-1", date(2026, 10, 6), "300-C001", "MENG 0123456789", "EMILY", 500, "BASIN", 1, 500, 0),
        ("DO-2", date(2026, 10, 6), "300-C001", "LIM 0129998888", None, None, "TAP", 2, 80, 1),
    ]
    d1, d2 = build_do_docs(rows)
    assert d1["doc_no"] == "DO-1" and d1["cancelled"] is False and d1["items"] == "BASIN x1" and "transferred" not in d1
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
