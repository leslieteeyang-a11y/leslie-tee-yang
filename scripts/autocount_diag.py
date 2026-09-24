#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""诊断：抓出来的数字跟纸本对不上时，把需要看的明细一次列出来。

    python scripts/autocount_diag.py 2026-08

产生 diag_YYYY-MM.txt（不含密码；含少量单据明细，勿提交）。
"""

import calendar
import json
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from autocount_db import connect, fetch, load_autocount_config, require_report_book   # noqa: E402
from autocount_extract import VERSION, channel_case, line_source, model_code, sql_summary  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def main():
    month = sys.argv[1] if len(sys.argv) > 1 else date.today().strftime("%Y-%m")
    y, m = (int(x) for x in month.split("-"))
    start, end = date(y, m, 1), date(y, m, calendar.monthrange(y, m)[1])
    cfg = load_autocount_config()
    require_report_book(cfg)
    base = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
    conn = connect(cfg)
    L = [f"HomeWorks 诊断 — {month}  账套 {cfg['connection']['database']}", "=" * 70, ""]

    # ---- 0. 版本与设定 ---------------------------------------------------
    L += ["[0] 版本与设定",
          f"  autocount_extract 版本：{VERSION}",
          f"  config.json 有 category_map：{'有' if 'category_map' in base else '没有（旧版）'}",
          f"  channel_rules.map：{json.dumps({k: v for k, v in cfg['channel_rules']['map'].items() if not k.startswith('_')}, ensure_ascii=False)}",
          f"  default_channel：{cfg['channel_rules'].get('default_channel')}",
          f"  brand_filter：{cfg['brand_filter']['field']} IN {cfg['brand_filter']['values']}", ""]

    lines = line_source(cfg)

    # ---- 1. 各渠道 × 单据类型 ------------------------------------------
    parts = []
    for doc in cfg["schema"]["sales_documents"]:
        parts.append(f"""SELECT '{doc['header']}' AS DT, ({channel_case(cfg)}) AS Ch,
                                COUNT(*) AS N, SUM(({doc['sign']}) * d.SubTotal) AS Amt
                         FROM [{doc['header']}] h JOIN [{doc['detail']}] d ON d.DocKey = h.DocKey
                         LEFT JOIN [Debtor] dbt ON dbt.AccNo = h.DebtorCode
                         WHERE h.Cancelled = 'F' AND h.DocDate >= ? AND h.DocDate <= ?
                         GROUP BY ({channel_case(cfg)})""")
    sql = " UNION ALL ".join(parts)
    _, rows = fetch(conn, sql, (start, end) * len(parts))
    L += ["[1] 各渠道 × 单据类型（行数 / 金额）"]
    for dt, ch, n, amt in sorted(rows, key=lambda r: (r[1], r[0])):
        L.append(f"  {ch:<10} {dt:<3} {n:>7} 行  RM {float(amt or 0):>14,.2f}")
    L.append("")

    # ---- 2. ONLINE 手续费明细 --------------------------------------------
    L += ["[2] ItemGroup = ONLINE / TRAN FEE / PAY FEE 的明细（金额最大的 25 行）"]
    _, rows = fetch(conn, f"""
        WITH lines AS ({lines})
        SELECT TOP 25 l.DocDate, l.Channel, l.ItemCode, i.ItemGroup, l.Qty, l.Amount
        FROM lines l LEFT JOIN [Item] i ON i.ItemCode = l.ItemCode
        WHERE l.DocDate >= ? AND l.DocDate <= ?
          AND i.ItemGroup IN ('ONLINE', 'TRAN FEE', 'PAY FEE')
        ORDER BY ABS(l.Amount) DESC""", (start, end))
    for r in rows:
        L.append(f"  {str(r[0])[:10]}  {r[1]:<9} {r[2]:<16} {r[3]:<9} qty {float(r[4]):>8,.0f}  RM {float(r[5]):>12,.2f}")
    _, rows = fetch(conn, f"""
        WITH lines AS ({lines})
        SELECT i.ItemGroup, l.Channel, COUNT(*), SUM(l.Qty), SUM(l.Amount),
               MIN(l.Amount), MAX(l.Amount), AVG(l.Amount)
        FROM lines l LEFT JOIN [Item] i ON i.ItemCode = l.ItemCode
        WHERE l.DocDate >= ? AND l.DocDate <= ? AND i.ItemGroup IN ('ONLINE', 'TRAN FEE', 'PAY FEE')
        GROUP BY i.ItemGroup, l.Channel""", (start, end))
    L.append("  --- 汇总（组 / 渠道 / 行数 / 数量 / 金额 / 最小 / 最大 / 平均）")
    for r in rows:
        L.append(f"  {r[0]:<9} {r[1]:<9} {r[2]:>6} 行  qty {float(r[3]):>8,.0f}  RM {float(r[4]):>12,.2f}"
                 f"  min {float(r[5]):>10,.2f}  max {float(r[6]):>10,.2f}  avg {float(r[7]):>9,.2f}")
    L.append("")

    # ---- 2b. 同一张单里手续费行 vs 商品行（看单据长什么样）----------------
    L += ["[2b] 一张有 ONLINE 手续费的 Shopee 发票全貌（看手续费怎么开）"]
    _, rows = fetch(conn, """
        SELECT TOP 1 h.DocKey, h.DocNo, h.DocDate, h.DebtorCode, h.NetTotal
        FROM [IV] h JOIN [IVDTL] d ON d.DocKey = h.DocKey
        JOIN [Item] i ON i.ItemCode = d.ItemCode
        WHERE h.Cancelled = 'F' AND h.DocDate >= ? AND h.DocDate <= ? AND i.ItemGroup = 'ONLINE'
        ORDER BY h.DocDate DESC""", (start, end))
    if rows:
        k, no, dt, dc, net = rows[0]
        L.append(f"  {no}  {str(dt)[:10]}  {dc}  NetTotal {float(net):,.2f}")
        _, dl = fetch(conn, """SELECT d.Seq, d.ItemCode, d.Description, d.Qty, d.UnitPrice, d.Discount,
                                      d.DiscountAmt, d.SubTotal, d.DtlType
                               FROM [IVDTL] d WHERE d.DocKey = ? ORDER BY d.Seq""", (k,))
        for r in dl:
            L.append(f"    seq {r[0]:<4} {str(r[1]):<16} {str(r[2])[:34]:<34} qty {float(r[3] or 0):>6,.0f}"
                     f"  price {float(r[4] or 0):>9,.2f}  disc {str(r[5] or ''):<6} {float(r[6] or 0):>8,.2f}"
                     f"  sub {float(r[7] or 0):>10,.2f}  type {r[8]}")
    L.append("")

    # ---- 3. 没有分类的商品 ----------------------------------------------
    L += ["[3] 当月有销售、但 ItemGroup 是空的商品"]
    _, rows = fetch(conn, f"""
        WITH lines AS ({lines})
        SELECT l.ItemCode, MAX(i.Description), MAX(i.ItemType), MAX(i.StockControl), SUM(l.Qty), SUM(l.Amount)
        FROM lines l LEFT JOIN [Item] i ON i.ItemCode = l.ItemCode
        WHERE l.DocDate >= ? AND l.DocDate <= ? AND (i.ItemGroup IS NULL OR LTRIM(RTRIM(i.ItemGroup)) = '')
        GROUP BY l.ItemCode ORDER BY SUM(l.Amount) DESC""", (start, end))
    for r in rows:
        L.append(f"  {str(r[0]):<18} {str(r[1] or '')[:36]:<36} type {str(r[2] or ''):<10} stock {r[3]}"
                 f"  qty {float(r[4]):>6,.0f}  RM {float(r[5]):>10,.2f}")
    L.append("")

    # ---- 3b. 未分类的明细行（逐张单） ------------------------------------
    L += ["[3b] 未分类的明细行（ItemCode 空白、或商品没设 ItemGroup）：单号 / 渠道 / 代号 / 描述 / 数量 / 金额"]
    parts = []
    for doc in cfg["schema"]["sales_documents"]:
        parts.append(f"""SELECT '{doc['header']}' AS DT, h.DocNo, h.DocDate, ({channel_case(cfg)}) AS Ch,
                                d.ItemCode, d.Description, ({doc['sign']}) * d.Qty AS Qty,
                                ({doc['sign']}) * d.SubTotal AS Amt, i.ItemType
                         FROM [{doc['header']}] h JOIN [{doc['detail']}] d ON d.DocKey = h.DocKey
                         LEFT JOIN [Debtor] dbt ON dbt.AccNo = h.DebtorCode
                         LEFT JOIN [Item] i ON i.ItemCode = d.ItemCode
                         WHERE h.Cancelled = 'F' AND h.DocDate >= ? AND h.DocDate <= ?
                           AND (i.ItemGroup IS NULL OR LTRIM(RTRIM(i.ItemGroup)) = '')
                           AND d.SubTotal <> 0""")
    _, rows = fetch(conn, " UNION ALL ".join(parts) + " ORDER BY 3, 2", (start, end) * len(parts))
    tot = 0.0
    for r in rows[:60]:
        tot += float(r[7] or 0)
        L.append(f"  {r[0]:<2} {str(r[1]):<11} {str(r[2])[:10]} {str(r[3]):<9} {str(r[4] or '(空)'):<14}"
                 f" {str(r[5] or '')[:34]:<34} qty {float(r[6] or 0):>5,.0f}  RM {float(r[7] or 0):>10,.2f}"
                 f"  brand {str(r[8] or '')}")
    L.append(f"  共 {len(rows)} 行（只列前 60），金额合计 RM {sum(float(r[7] or 0) for r in rows):,.2f}")
    L.append("")

    # ---- 3c. 销售汇总的原始结果（对 Excel 用） ----------------------------
    for label, hemos in (("全品牌", False), ("Hemos", True)):
        L += [f"[3c] 销售汇总原始行（{label}）：Category / Channel / Qty / Amount — 只列 SANITARY、(未分类)、STOCK A"]
        _, rows = fetch(conn, sql_summary(cfg, hemos), (start, end))
        for r in rows:
            if str(r[0]).upper() in ("SANITARY", "(未分类)", "STOCK A"):
                L.append(f"  {str(r[0]):<10} {str(r[1]):<9} qty {float(r[2] or 0):>8,.0f}  RM {float(r[3] or 0):>12,.2f}")
        L.append("")

    # ---- 4. 各渠道的客户明细 --------------------------------------------
    L += ["[4] 各渠道由哪些客户构成（当月，每渠道前 12 名）"]
    _, rows = fetch(conn, f"""
        WITH lines AS ({lines})
        SELECT l.Channel, l.DebtorCode, MAX(dbt.CompanyName), MAX(dbt.DebtorType), COUNT(*), SUM(l.Amount)
        FROM lines l LEFT JOIN [Debtor] dbt ON dbt.AccNo = l.DebtorCode
        WHERE l.DocDate >= ? AND l.DocDate <= ?
        GROUP BY l.Channel, l.DebtorCode""", (start, end))
    by = defaultdict(list)
    for ch, code, name, dtype, n, amt in rows:
        by[ch].append((float(amt or 0), code, name, dtype, n))
    for ch in sorted(by):
        L.append(f"  [{ch}]  合计 RM {sum(a for a, *_ in by[ch]):,.2f}")
        for amt, code, name, dtype, n in sorted(by[ch], reverse=True)[:12]:
            L.append(f"     {str(code):<12} {str(name or '')[:34]:<34} type {str(dtype or ''):<12} {n:>5} 行  RM {amt:>12,.2f}")
    L.append("")

    # ---- 4b. 水工渠道的全部客户（找 Referral：纸本 8 月 Referral 合计 3,160.75）----
    L += ["[4b] 水工渠道（default）的全部客户与当月金额"]
    for amt, code, name, dtype, n in sorted(by.get("shuigong", []), reverse=True):
        L.append(f"     {str(code):<12} {str(name or '')[:34]:<34} type {str(dtype or ''):<12} {n:>5} 行  RM {amt:>12,.2f}")
    L.append("")

    # ---- 5. 客户类型清单 ------------------------------------------------
    L += ["[5] Debtor.DebtorType 的相异值（找 Referral 用）"]
    _, rows = fetch(conn, "SELECT ISNULL(DebtorType,''), COUNT(*) FROM [Debtor] GROUP BY DebtorType ORDER BY COUNT(*) DESC")
    for t, n in rows:
        L.append(f"  {t or '(空)':<20} {n:>5} 个客户")
    L.append("")

    # ---- 6. Top 10 会抓到的非商品项目 -----------------------------------
    L += ["[6] Shopee + Lazada 销量前 30 的 ItemCode（对纸本 Top 10 用；型号 = 依 config.json 的 model_code_pattern 抽出）"]
    laz = cfg["sku_trend"]["platform_channels"].get("LAZADA", "lazada")
    sho = cfg["sku_trend"]["platform_channels"].get("SHOPEE", "shopee")
    _, rows = fetch(conn, f"""
        WITH lines AS ({lines})
        SELECT TOP 30 l.ItemCode, MAX(i.Description), MAX(i.ItemGroup), MAX(i.StockControl),
               SUM(CASE WHEN l.Channel = '{sho}' THEN l.Qty ELSE 0 END),
               SUM(CASE WHEN l.Channel = '{laz}' THEN l.Qty ELSE 0 END),
               MAX(i.Desc2), MAX(i.GlobalCode)
        FROM lines l LEFT JOIN [Item] i ON i.ItemCode = l.ItemCode
        WHERE l.DocDate >= ? AND l.DocDate <= ? AND l.Channel IN ('{sho}', '{laz}')
        GROUP BY l.ItemCode ORDER BY SUM(l.Qty) DESC""", (start, end))
    for r in rows:
        mc = model_code(r[0], r[1], r[6], r[7], base.get("model_code_pattern"))
        L.append(f"  {str(r[0]):<14} {str(r[1] or '')[:40]:<40} {str(r[2] or ''):<9} shopee {float(r[4]):>5,.0f}"
                 f" lazada {float(r[5]):>4,.0f}  型号 {mc}  desc2 [{str(r[6] or '')[:20]}]")

    out = ROOT / f"diag_{month}.txt"
    out.write_text("\n".join(L), encoding="utf-8")
    print(f"已产生：{out}")
    import os
    if os.name == "nt":
        os.startfile(out)              # noqa: S606


if __name__ == "__main__":
    main()
