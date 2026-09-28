#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""分行（JB Southern 账套）当月「实际销售额」→ 推进 HomeWorks BI，给电商月报 Southern 旁边那一栏用。

    python scripts/branch_actual.py 2026-08            # 抓 2026-08 并推送
    python scripts/branch_actual.py                    # 预设上个月
    python scripts/branch_actual.py --backfill 2026-01 # 2026-01 到本月逐月（含本月至今）
    python scripts/branch_actual.py --scheduled        # 排程用：上个月 + 本月至今，每天跑
    python scripts/branch_actual.py 2026-08 --dry-run  # 只印 SQL 与结果，不推送

口径（使用者 2026-09-28 定）：Sales Order 全部 + 不是从 SO 转来的 Invoice − Credit Note，
三种单据都**排除 SalesAgent 空白**的单。按报表类别（config.json 的 category_map）与品牌范围
（全品牌 / Hemos & Hemos X）汇总。这支程式要在分行那台连得到分行 AutoCount 的电脑上跑。
"""

import argparse
import json
import sys
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from autocount_db import connect, fetch, load_autocount_config          # noqa: E402
from autocount_extract import month_range as month_bounds               # noqa: E402
from backfill import month_range                                        # noqa: E402
from supabase_push import _request, company_of, supabase_config         # noqa: E402

VERSION = "branch-2026-09-28b"
AGENT_OK = "LTRIM(RTRIM(ISNULL(h.SalesAgent, ''))) <> ''"     # 排除 agent 空白的单


def sql_lines(doc: str) -> str:
    """一种单据的当月明细，按 ItemGroup / ItemType 汇总。SO 另算未转发票部分，IV 另算不是从 SO 来的部分。"""
    extra = {
        "SO": "SUM(CASE WHEN d.Qty <> 0 THEN d.SubTotal * (d.Qty - ISNULL(d.TransferedQty, 0)) / d.Qty ELSE 0 END)",
        "IV": "SUM(CASE WHEN ISNULL(d.FromDocType, '') <> 'SO' THEN d.SubTotal ELSE 0 END)",
        "CN": "0",
    }[doc]
    return f"""
SELECT ISNULL(i.ItemGroup, '') AS ItemGroup, ISNULL(i.ItemType, '') AS ItemType,
       SUM(d.SubTotal) AS Amount, {extra} AS Extra
FROM [{doc}] h JOIN [{doc}DTL] d ON d.DocKey = h.DocKey
LEFT JOIN [Item] i ON i.ItemCode = d.ItemCode
WHERE h.Cancelled = 'F' AND h.DocDate >= ? AND h.DocDate <= ? AND {AGENT_OK}
GROUP BY ISNULL(i.ItemGroup, ''), ISNULL(i.ItemType, '')
"""


SQL_AGENTS = """
SELECT '{doc}' AS Doc, LTRIM(RTRIM(ISNULL(h.SalesAgent, ''))) AS Agent, COUNT(*) AS Docs, SUM(h.NetTotal) AS Amount
FROM [{doc}] h WHERE h.Cancelled = 'F' AND h.DocDate >= ? AND h.DocDate <= ?
GROUP BY LTRIM(RTRIM(ISNULL(h.SalesAgent, '')))
"""

# 各 agent 不是从 SO 转来的发票金额（明细行 FromDocType），BI 的分行页要靠它算每位 agent 的实际销售额
SQL_AGENT_IV_DIRECT = """
SELECT LTRIM(RTRIM(ISNULL(h.SalesAgent, ''))) AS Agent,
       SUM(CASE WHEN ISNULL(d.FromDocType, '') <> 'SO' THEN d.SubTotal ELSE 0 END) AS Direct
FROM [IV] h JOIN [IVDTL] d ON d.DocKey = h.DocKey
WHERE h.Cancelled = 'F' AND h.DocDate >= ? AND h.DocDate <= ?
GROUP BY LTRIM(RTRIM(ISNULL(h.SalesAgent, '')))
"""


def build_rows(so, iv, cn, category_map: dict, brand_values) -> list[dict]:
    """三种单据的 (ItemGroup, ItemType, Amount, Extra) → 按 scope × 类别的列（纯函数）。"""
    cmap = {k.upper(): v for k, v in category_map.items() if not k.startswith("_")}
    brands = {b.upper() for b in brand_values}

    def cat(group):
        g = (group or "").strip().upper() or "(未分类)"
        m = cmap.get(g, (group or "").strip() or "(未分类)")
        return m                                                    # None = 设定要拿掉的群组

    acc: dict = defaultdict(lambda: defaultdict(float))
    for scope in ("all", "hemos"):
        for src, rows in (("so", so), ("iv", iv), ("cn", cn)):
            for group, itype, amount, extra in rows:
                if scope == "hemos" and (itype or "").strip().upper() not in brands:
                    continue
                c = cat(group)
                if c is None:
                    continue
                rec = acc[(scope, c)]
                if src == "so":
                    rec["so_amount"] += float(amount or 0); rec["so_open"] += float(extra or 0)
                elif src == "iv":
                    rec["iv_amount"] += float(amount or 0); rec["iv_direct"] += float(extra or 0)
                else:
                    rec["cn_amount"] += float(amount or 0)
    out = []
    for (scope, c), rec in sorted(acc.items()):
        row = {"scope": scope, "category": c}
        for k in ("so_amount", "so_open", "iv_amount", "iv_direct", "cn_amount"):
            row[k] = round(rec[k], 2)
        row["actual_amount"] = round(rec["so_amount"] + rec["iv_direct"] - rec["cn_amount"], 2)
        out.append(row)
    return out


def agent_detail(agents, direct: dict) -> list[dict]:
    """各 agent × 单据种类的金额与单数；IV 另附「非SO发票」direct（纯函数）。"""
    out = []
    for doc, agent, docs, amount in agents:
        row = {"doc": doc, "agent": agent or "(blank)", "docs": int(docs or 0), "amount": round(float(amount or 0), 2)}
        if doc == "IV":
            row["direct"] = round(direct.get(agent or "", 0.0), 2)
        out.append(row)
    return out


def current_month() -> str:
    return date.today().strftime("%Y-%m")


def previous_month() -> str:
    t = date.today()
    y, m = (t.year, t.month - 1) if t.month > 1 else (t.year - 1, 12)
    return f"{y}-{m:02d}"


def run_month(cfg, base_cfg, month: str, dry: bool) -> dict:
    start, end = month_bounds(month)
    if dry:
        print(sql_lines("SO"), sql_lines("IV"), sql_lines("CN"), sep="\n")
    conn = connect(cfg)
    so = fetch(conn, sql_lines("SO"), (start, end))[1]
    iv = fetch(conn, sql_lines("IV"), (start, end))[1]
    cn = fetch(conn, sql_lines("CN"), (start, end))[1]
    agents = []
    for doc in ("SO", "IV", "CN"):
        agents += [list(r) for r in fetch(conn, SQL_AGENTS.format(doc=doc), (start, end))[1]]
    direct = {(r[0] or ""): float(r[1] or 0) for r in fetch(conn, SQL_AGENT_IV_DIRECT, (start, end))[1]}
    rows = build_rows(so, iv, cn, base_cfg.get("category_map", {}), cfg["brand_filter"]["values"])
    detail = {"agents": agent_detail(agents, direct),
              "excluded_blank_agent": {a[0]: round(float(a[3] or 0), 2) for a in agents if not a[1]}}
    total = sum(r["actual_amount"] for r in rows if r["scope"] == "all")
    print(f"{month}  分行实际销售额（全品牌）RM {total:,.2f}  "
          f"= SO {sum(r['so_amount'] for r in rows if r['scope']=='all'):,.2f}"
          f" + 非SO发票 {sum(r['iv_direct'] for r in rows if r['scope']=='all'):,.2f}"
          f" − 贷项 {sum(r['cn_amount'] for r in rows if r['scope']=='all'):,.2f}；"
          f"排除 agent 空白：{detail['excluded_blank_agent']}")
    doc = {"produced_by": f"由 scripts/branch_actual.py（{VERSION}）于 {date.today().isoformat()} 自账套 "
                          f"{cfg['connection']['database']} 抓取；口径 SO + 非SO发票 − 贷项，排除 agent 空白。",
           "rows": rows, "detail": detail}
    if dry:
        print(json.dumps(doc, ensure_ascii=False, indent=1)[:3000])
        return doc
    sb = supabase_config(cfg)
    if not sb:
        sys.exit("autocount.json 没有 supabase 设定，请先双击 setup_branch.bat 贴金钥。")
    company = sb.get("company") or company_of(cfg)
    res = _request(sb, "POST", "/rest/v1/rpc/bi_branch_actual_upsert",
                   {"p_company": company, "p_month": f"{month}-01", "p_doc": doc})
    print(f"已推进 BI：{res.get('company')} {month}  {res.get('rows')} 列")
    return doc


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("month", nargs="?", help="YYYY-MM，预设上个月")
    ap.add_argument("--backfill", metavar="YYYY-MM", help="从这个月到上个月逐月抓")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--scheduled", action="store_true",
                    help="排程模式：输出写 logs/，并推上个月 + 本月至今（每天跑，店长看得到当月进度）")
    a = ap.parse_args()

    if a.scheduled:
        log_dir = ROOT / "logs"; log_dir.mkdir(exist_ok=True)
        f = open(log_dir / f"branch_{datetime.now():%Y%m%d_%H%M%S}.log", "a", encoding="utf-8")
        class Tee:
            def write(self, s): sys.__stdout__.write(s); f.write(s); f.flush()
            def flush(self): sys.__stdout__.flush(); f.flush()
        sys.stdout = sys.stderr = Tee()

    cfg = load_autocount_config()
    base_cfg = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
    db = cfg["connection"]["database"]
    company = (cfg.get("supabase") or {}).get("company") or company_of(cfg)
    print(f"账套 {db} → BI 公司代码 {company}")
    if "SOUTHERN" not in company.upper():
        print("[!] 这个账套看起来不是分行（名称没有 SOUTHERN）。若确定要用，请在 autocount.json 的 supabase.company 填 BI 的公司代码。")
        if not a.dry_run:
            sys.exit(2)
    if a.backfill:
        months = month_range(a.backfill, current_month())          # 含本月至今
    elif a.month:
        months = [a.month]
    elif a.scheduled:
        months = [previous_month(), current_month()]                # 上个月定稿 + 本月进度
    else:
        months = [previous_month()]
    for m in months:
        run_month(cfg, base_cfg, m, a.dry_run)


if __name__ == "__main__":
    main()
