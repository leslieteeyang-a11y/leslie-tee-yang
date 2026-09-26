#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把当月报表成品推进 HomeWorks BI（Supabase）。

    python scripts/supabase_push.py 2026-08        # 推送 data/2026-08.json
    python scripts/supabase_push.py --check        # 只测试连线与金钥

run_monthly.py 产生完 Excel 会自动呼叫；广告数字补填后再跑一次本程式即可覆盖。
设定在 autocount.json 的 "supabase" 段：url、service_key。没填就跳过，不影响出报表。

BI 那边只有一个写入口 public.bi_report_upsert（先删该月旧资料再整批写入，重跑不会重复），
落到 bi.report_month / _category / _channel / _sku / _top10，前端读 public.bi_report_month_*。
"""

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from autocount_db import load_autocount_config  # noqa: E402

CHANNEL_KEYS = ("shopee", "lazada", "cash", "online", "referral", "shuigong", "southern", "tiktok", "shopify")


def company_of(cfg: dict) -> str:
    """账套名去掉 AED_ 前缀 = BI 的 company（AED_HOMEWORKSSB → HOMEWORKSSB，与 BI 同步管线一致）。"""
    db = (cfg.get("connection") or {}).get("database", "")
    return db[4:] if db.upper().startswith("AED_") else db


def build_payload(doc: dict, channels=CHANNEL_KEYS) -> dict:
    """data/YYYY-MM.json → bi_report_upsert 要的 JSON（纯函数）。"""
    category, channel = [], []
    for scope, key in (("all", "forecast_all"), ("hemos", "forecast_hemos")):
        for row in doc.get(key, []):
            amounts = {c: float(row.get(c) or 0) for c in channels if row.get(c)}
            category.append({"scope": scope, "category": row["category"],
                             "qty": row.get("qty", 0), "amount": round(sum(amounts.values()), 2)})
            channel += [{"scope": scope, "category": row["category"], "channel": c, "amount": a}
                        for c, a in amounts.items()]
    sku = [{"platform": platform, "sku": s, "qty": q}
           for platform, skus in (doc.get("sku_qty") or {}).items() for s, q in skus.items()]
    top10 = []
    for direction in ("up", "down"):
        for i, r in enumerate(doc.get(f"top10_{direction}", []), 1):
            top10.append({"direction": direction, "rank": i, "sku": r["sku"],
                          "lazada_qty": r.get("lazada", 0), "shopee_qty": r.get("shopee", 0)})
    return {"produced_by": doc.get("_产生方式", ""), "ads": doc.get("ads") or {},
            "live_sales": doc.get("live_sales") or {},
            "category": category, "channel": channel, "sku": sku, "top10": top10}


def _request(sb: dict, method: str, path: str, body=None):
    url = sb["url"].rstrip("/") + path
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    key = sb["service_key"]
    headers = {"apikey": key, "Content-Type": "application/json", "Accept": "application/json"}
    if key.startswith("eyJ"):                    # 旧式 service_role JWT 要再放 Authorization；新式 sb_secret_ 只认 apikey
        headers["Authorization"] = f"Bearer {key}"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode("utf-8") or "null")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        hint = {401: "金钥不对或过期", 403: "这把金钥没有权限（要用 service_role 那把）",
                404: "找不到 bi_report_upsert，Supabase 端的表还没建"}.get(e.code, "")
        raise SystemExit(f"Supabase 回应 {e.code} {hint}\n  {detail}\n  请检查 autocount.json 的 supabase.url / service_key。")
    except urllib.error.URLError as e:
        raise SystemExit(f"连不上 Supabase：{e.reason}\n  请检查 SERVER 的网路、以及 supabase.url 是否为 https://xxxx.supabase.co")


def supabase_config(cfg: dict):
    sb = cfg.get("supabase") or {}
    if not sb.get("url") or not sb.get("service_key"):
        return None
    return sb


def check(cfg: dict) -> None:
    sb = supabase_config(cfg)
    if not sb:
        sys.exit("autocount.json 还没有 supabase 设定（url 与 service_key）。")
    rows = _request(sb, "GET", "/rest/v1/bi_report_month?select=company,month&order=month.desc&limit=3")
    print(f"连线 OK：{sb['url']}，公司 {company_of(cfg)}，BI 里已有 {len(rows)} 个月的报表{'：' + str(rows) if rows else ''}")


def push(cfg: dict, month: str) -> dict:
    sb = supabase_config(cfg)
    if not sb:
        print("（autocount.json 没有 supabase 设定，跳过推送 BI）")
        return {}
    path = ROOT / "data" / f"{month}.json"
    if not path.exists():
        sys.exit(f"找不到 {path}，请先执行 autocount_extract.py {month}")
    doc = json.loads(path.read_text(encoding="utf-8"))
    res = _request(sb, "POST", "/rest/v1/rpc/bi_report_upsert",
                   {"p_company": company_of(cfg), "p_month": f"{month}-01", "p_doc": build_payload(doc)})
    print(f"已推进 BI：{res.get('company')} {month}  类别 {res.get('category')} 行、"
          f"渠道 {res.get('channel')} 行、SKU {res.get('sku')} 行、Top10 {res.get('top10')} 行")
    return res


def set_key(cfg: dict) -> dict:
    """让使用者把 service_role 金钥贴进来，写回 autocount.json（不用手改 JSON）。"""
    from autocount_db import CONFIG_PATH
    example = json.loads((ROOT / "autocount.example.json").read_text(encoding="utf-8"))
    sb = {**(example.get("supabase") or {}), **(cfg.get("supabase") or {})}
    print("到 Supabase 后台 → Project Settings → API Keys → Secret keys 的 default（sb_secret_…）按复制；")
    print("或 Legacy 分页的 service_role（eyJ…）也可以。")
    had = sb.get("service_key", "")
    prompt = "把整串金钥贴在这里再按 Enter（贴一次就好）："
    if had:
        prompt = "已经有一把金钥；直接按 Enter 沿用，或贴新的再按 Enter："
    key = input(prompt).strip() or had
    if not key:
        sys.exit("没有输入金钥，什么都没改。请回 Supabase 后台复制 Secret keys 的 default，再跑一次。")
    for prefix in ("sb_secret_", "eyJ"):        # 右键按了好几下会贴成同一把金钥连在一起，只取第一段
        if key.count(prefix) > 1:
            key = key[:key.index(prefix, len(prefix))]
            print("（侦测到金钥被重复贴上，已只取第一段。）")
    if not (key.startswith("eyJ") or key.startswith("sb_secret_")):
        sys.exit("这看起来不是 service_role 金钥（应以 eyJ 或 sb_secret_ 开头）。请回 Supabase 后台复制 service_role 那一把。")
    sb["service_key"] = key
    cfg["supabase"] = sb
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"已写入 {CONFIG_PATH.name}（此档不会上传）。")
    return cfg


def main():
    cfg = load_autocount_config()
    if "--set-key" in sys.argv:
        cfg = set_key(cfg)
        check(cfg)
        return
    if "--check" in sys.argv:
        check(cfg)
        return
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        sys.exit("用法：python scripts/supabase_push.py 2026-08   或   --check")
    push(cfg, args[0])


if __name__ == "__main__":
    main()
