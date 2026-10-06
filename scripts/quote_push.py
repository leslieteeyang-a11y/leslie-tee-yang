#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""报价单（Quotation）与送货单（Delivery Order）→ HomeWorks BI。

    python scripts/quote_push.py               # 抓近 120 天报价单 + 近 60 天 DO 并推送
    python scripts/quote_push.py --dry-run     # 只印 SQL 与前几张单，不推送
    python scripts/quote_push.py --scheduled   # 排程用（每 15 分钟）：输出写 logs/quotes_YYYYMMDD.log

报价单给顾客资料页的「报价没成交提醒」；DO 给「送货排单」：店员输入 DO 单号就看到顾客资料与送货地址
（2026-10-06 使用者要的，所以排程改成营业时间每 15 分钟一次，当天开的 DO 很快就查得到）。

SERVER（总部账套）与分行电脑（JB 账套）各跑各的；推送时整批取代该公司的报价单快照，重跑不会重复。
对 AutoCount 只读。「已转单」= 报价单明细有转出数量（TransferedQty），或有 SO / DO / IV / CS 明细注明从这张报价单转来；
之后顾客有没有另外开单买，由 BI 那边对照购买纪录判断。
"""

import argparse
import sys
from collections import OrderedDict
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from autocount_db import connect, fetch, load_autocount_config          # noqa: E402
from supabase_push import _request, company_of, supabase_config         # noqa: E402

VERSION = "quotes-do-2026-10-06b"
DAYS = 120
DO_DAYS = 60
TARGETS = ("SODTL", "DODTL", "IVDTL", "CSDTL")


def table_columns(conn, table: str) -> set[str]:
    """表的栏位名（大写）；表不存在回空集合。"""
    try:
        _, rows = fetch(conn, "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ?", (table,))
    except Exception:                                  # 没权限读 INFORMATION_SCHEMA：当作不知道
        return set()
    return {str(r[0]).upper() for r in rows}


def build_sql(qt: set[str], qtdtl: set[str], targets: dict[str, set[str]]) -> str:
    """依账套实际有的栏位组 SQL（纯函数，方便测试）。没有 QT / QTDTL 就丢错说明。"""
    if not qt or not qtdtl:
        raise SystemExit("这个账套找不到报价单表（QT / QTDTL）。请确认 AutoCount 有用 Quotation，或把 discovery 档给 Claude 看。")
    hdr_amount = next((f"h.{name}" for c, name in (("NETTOTAL", "NetTotal"), ("FINALTOTAL", "FinalTotal"), ("TOTAL", "Total"))
                       if c in qt), "NULL")
    transfer = ["ISNULL(d.TransferedQty, 0)"] if "TRANSFEREDQTY" in qtdtl else []
    if "DTLKEY" in qtdtl:
        for t, cols in targets.items():
            if {"FROMDOCTYPE", "FROMDOCDTLKEY"} <= cols:
                transfer.append(f"CASE WHEN EXISTS (SELECT 1 FROM [{t}] x WHERE x.FromDocType = 'QT' "
                                f"AND x.FromDocDtlKey = d.DtlKey) THEN 1 ELSE 0 END")
    transfer_expr = " + ".join(transfer) if transfer else "0"
    agent = "h.SalesAgent" if "SALESAGENT" in qt else "NULL"
    name = "h.DebtorName" if "DEBTORNAME" in qt else "NULL"
    cancelled = "AND h.Cancelled = 'F'" if "CANCELLED" in qt else ""
    desc = "d.Description" if "DESCRIPTION" in qtdtl else "d.ItemCode"
    sub = "d.SubTotal" if "SUBTOTAL" in qtdtl else "0"
    order = "d.Seq" if "SEQ" in qtdtl else ("d.DtlKey" if "DTLKEY" in qtdtl else "h.DocKey")
    return f"""
SELECT h.DocNo, h.DocDate, h.DebtorCode, {name} AS DebtorName, {agent} AS SalesAgent, {hdr_amount} AS HdrAmount,
       {desc} AS Description, d.Qty, {sub} AS SubTotal, {transfer_expr} AS Transferred
FROM [QT] h LEFT JOIN [QTDTL] d ON d.DocKey = h.DocKey
WHERE h.DocDate >= ? {cancelled}
ORDER BY h.DocDate, h.DocNo, {order}
"""


def build_docs(rows) -> list[dict]:
    """明细列 → 每张报价单一笔（纯函数）。金额优先用表头总额，没有就加总明细；任何一行有转出就算已转单。"""
    docs: "OrderedDict[str, dict]" = OrderedDict()
    for doc_no, doc_date, debtor, name, agent, hdr, desc, qty, sub, transferred in rows:
        d = docs.get(doc_no)
        if d is None:
            d = docs[doc_no] = {
                "doc_no": str(doc_no).strip(), "doc_date": (doc_date.date() if isinstance(doc_date, datetime) else doc_date).isoformat(),
                "debtor_code": str(debtor or "").strip(), "debtor_name": (str(name).strip() if name else None),
                "sales_agent": (str(agent).strip() if agent else None), "hdr": hdr, "sum": 0.0,
                "transferred": False, "lines": [],
            }
        d["sum"] += float(sub or 0)
        d["transferred"] = d["transferred"] or float(transferred or 0) > 0
        if desc:
            q = float(qty or 0)
            d["lines"].append(f"{str(desc).strip()} x{q:g}" if q else str(desc).strip())
    out = []
    for d in docs.values():
        lines = d.pop("lines")
        hdr, total = d.pop("hdr"), d.pop("sum")
        d["amount"] = round(float(hdr) if hdr is not None else total, 2)
        d["items"] = "; ".join(lines[:3]) + (f"; …（共 {len(lines)} 项）" if len(lines) > 3 else "")
        out.append(d)
    return out


def build_do_sql(do: set[str], dodtl: set[str]) -> str:
    """DO 表头 + 明细（纯函数）。取消的也抓，标 Cancelled，让 BI 那边知道这张不用送。"""
    if not do or not dodtl:
        raise SystemExit("这个账套找不到送货单表（DO / DODTL）。请把 discovery 档给 Claude 看。")
    hdr_amount = next((f"h.{name}" for c, name in (("NETTOTAL", "NetTotal"), ("FINALTOTAL", "FinalTotal"), ("TOTAL", "Total"))
                       if c in do), "NULL")
    agent = "h.SalesAgent" if "SALESAGENT" in do else "NULL"
    name = "h.DebtorName" if "DEBTORNAME" in do else "NULL"
    cancelled = "CASE WHEN h.Cancelled = 'T' THEN 1 ELSE 0 END" if "CANCELLED" in do else "0"
    desc = "d.Description" if "DESCRIPTION" in dodtl else "d.ItemCode"
    sub = "d.SubTotal" if "SUBTOTAL" in dodtl else "0"
    order = "d.Seq" if "SEQ" in dodtl else ("d.DtlKey" if "DTLKEY" in dodtl else "h.DocKey")
    # 送货地址：DO 表头的 Deliver Address（DeliverAddr1～4 + 邮编）；没有这些栏位就不抓（不用发票地址，承包商的发票地址是办公室）
    parts = [f"h.{c}" for c, u in (("DeliverAddr1", "DELIVERADDR1"), ("DeliverAddr2", "DELIVERADDR2"), ("DeliverAddr3", "DELIVERADDR3"),
                                   ("DeliverAddr4", "DELIVERADDR4"), ("DeliverPostCode", "DELIVERPOSTCODE")) if u in do]
    # 不用 CONCAT_WS（SQL Server 2017 才有，AutoCount 常配旧版 SQL Express）：每段前面加「, 」再用 STUFF 拿掉第一个
    address = ("NULLIF(STUFF(" + " + ".join(f"ISNULL(', ' + NULLIF(LTRIM(RTRIM({c})), ''), '')" for c in parts) + ", 1, 2, ''), '')"
               if parts else "NULL")
    return f"""
SELECT h.DocNo, h.DocDate, h.DebtorCode, {name} AS DebtorName, {agent} AS SalesAgent, {hdr_amount} AS HdrAmount,
       {desc} AS Description, d.Qty, {sub} AS SubTotal, {cancelled} AS Cancelled, {address} AS DeliverAddress
FROM [DO] h LEFT JOIN [DODTL] d ON d.DocKey = h.DocKey
WHERE h.DocDate >= ?
ORDER BY h.DocDate, h.DocNo, {order}
"""


def build_do_docs(rows) -> list[dict]:
    """DO 明细列 → 每张 DO 一笔（纯函数）。借用报价单的合并逻辑，第 10 栏当「已取消」，第 11 栏是送货地址（表头，每行都一样）。"""
    addr: dict[str, str] = {}
    base = []
    for r in rows:
        r = list(r)
        a = r[10] if len(r) > 10 else None
        if a and str(a).strip() and r[0] not in addr:
            addr[r[0]] = " ".join(str(a).split())
        base.append(r[:10])
    out = []
    for d in build_docs(base):
        d["cancelled"] = d.pop("transferred")
        d["address"] = addr.get(d["doc_no"])
        out.append(d)
    return out


def run_do(cfg: dict, conn, dry: bool = False) -> dict:
    sql = build_do_sql(table_columns(conn, "DO"), table_columns(conn, "DODTL"))
    since = date.today() - timedelta(days=DO_DAYS)
    if dry:
        print(sql)
    docs = build_do_docs(fetch(conn, sql, (since,))[1])
    print(f"送货单 DO {since} 起 {len(docs)} 张（取消的 {sum(1 for d in docs if d['cancelled'])} 张，"
          f"有送货地址的 {sum(1 for d in docs if d.get('address'))} 张）")
    if dry:
        for d in docs[:5]:
            print(" ", d)
        return {"delivery_orders": len(docs)}
    sb = supabase_config(cfg)
    company = sb.get("company") or company_of(cfg)
    res = _request(sb, "POST", "/rest/v1/rpc/bi_delivery_doc_upsert", {"p_company": company, "p_docs": docs})
    print(f"已推进 BI：{res.get('company')} DO {res.get('delivery_orders')} 张")
    return res


def run(cfg: dict, dry: bool = False) -> dict:
    conn = connect(cfg)
    targets = {t: table_columns(conn, t) for t in TARGETS}
    sql = build_sql(table_columns(conn, "QT"), table_columns(conn, "QTDTL"), targets)
    since = date.today() - timedelta(days=DAYS)
    if dry:
        print(sql)
    docs = build_docs(fetch(conn, sql, (since,))[1])
    open_n = sum(1 for d in docs if not d["transferred"])
    print(f"报价单 {since} 起 {len(docs)} 张，其中还没转单 {open_n} 张（{VERSION}）")
    if dry:
        for d in docs[:5]:
            print(" ", d)
        return {"quotes": len(docs)}
    sb = supabase_config(cfg)
    if not sb:
        sys.exit("autocount.json 没有 supabase 设定，请先双击 setup_bi.bat（分行电脑是 setup_branch.bat）贴金钥。")
    company = sb.get("company") or company_of(cfg)
    res = _request(sb, "POST", "/rest/v1/rpc/bi_quote_upsert", {"p_company": company, "p_docs": docs})
    print(f"已推进 BI：{res.get('company')} 报价单 {res.get('quotes')} 张")
    try:                                                   # DO 失败不影响报价单（反之亦然，报价单错误会先停在上面）
        res["do"] = run_do(cfg, conn)
    except (Exception, SystemExit) as e:                   # noqa: BLE001
        print(f"[!] 送货单 DO 没推成功：{e}")
    return res


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--scheduled", action="store_true", help="排程模式：输出写 logs/quotes_*.log")
    a = ap.parse_args()
    if a.scheduled:
        log_dir = ROOT / "logs"; log_dir.mkdir(exist_ok=True)
        f = open(log_dir / f"quotes_{datetime.now():%Y%m%d}.log", "a", encoding="utf-8")   # 每 15 分钟一次：一天一个档
        f.write(f"\n===== {datetime.now():%Y-%m-%d %H:%M:%S} =====\n")
        class Tee:
            def write(self, s): sys.__stdout__.write(s); f.write(s); f.flush()
            def flush(self): sys.__stdout__.flush(); f.flush()
        sys.stdout = sys.stderr = Tee()
    cfg = load_autocount_config()
    print(f"账套 {cfg['connection']['database']}")
    if a.dry_run:
        run(cfg, True)
        run_do(cfg, connect(cfg), True)
    else:
        run(cfg)


if __name__ == "__main__":
    main()
