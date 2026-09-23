# -*- coding: utf-8 -*-
"""HomeWorks 营运入口 — 网页层。

启动（开发）：  python -m uvicorn webapp.main:app --reload
启动（办公室）：run_web.bat   → 浏览器开 http://<那台电脑>:8000
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from .charts import bar_chart, line_chart
from .sources import STATUS_LABEL, get_source

HERE = Path(__file__).resolve().parent
app = FastAPI(title="HomeWorks 营运入口", version="0.1")
app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")
templates = Jinja2Templates(directory=HERE / "templates")


def render(request: Request, name: str, nav: str, **ctx):
    ctx.update(request=request, nav=nav, source_name=get_source().name)
    return templates.TemplateResponse(request, name, ctx)


@app.get("/")
def home():
    return RedirectResponse("/dashboard")


# ---------------------------------------------------------------- 仪表板
@app.get("/dashboard")
def dashboard(request: Request, days: int = 30):
    days = days if days in (7, 30, 90) else 30
    src = get_source()
    daily = src.sales_daily(days)
    prev = src.sales_daily(days * 2)[:days]          # 前一个同长度区间
    amount = sum(p.amount for p in daily)
    prev_amount = sum(p.amount for p in prev)
    orders = sum(p.orders for p in daily)
    channels = src.sales_by_channel(days)
    groups = src.sales_by_group(days)
    skus = src.top_skus(days, 10)
    low = src.stock_list(low_only=True)
    open_do = sorted(src.deliveries(status="open", days=365), key=lambda d: d.doc_date)
    kpi = dict(amount=amount, orders=orders,
               avg_order=amount / orders if orders else 0.0,
               delta=(amount - prev_amount) / prev_amount if prev_amount else 0.0,
               open_do=len(open_do), low_stock=len(low))
    return render(request, "dashboard.html", "dashboard", days=days, kpi=kpi, daily=daily,
                  channels=channels, skus=skus, low=low[:10], open_do=open_do[:10],
                  daily_svg=line_chart(daily, title=f"近 {days} 天每日销售额"),
                  channel_svg=bar_chart([(c.channel, c.amount, f"{c.channel} · RM {c.amount:,.0f} · {c.orders} 张单")
                                         for c in channels], title="各渠道销售额"),
                  group_svg=bar_chart([(g, v, f"{g} · RM {v:,.0f}") for g, v in groups], title="各类别销售额"),
                  sku_svg=bar_chart([(s.code, s.qty, f"{s.code} {s.description} · {s.qty:.0f} 件 · RM {s.amount:,.0f}")
                                     for s in skus], value_fmt=lambda v: f"{v:.0f} 件", title="Top 10 SKU"))


@app.get("/health")
def health():
    return {"status": "ok", "source": get_source().name}


# ------------------------------------------------------------------ 库存
@app.get("/inventory")
def inventory(request: Request, q: str = "", group: str = "", low: str = ""):
    src = get_source()
    low_only = low == "1"
    rows = src.stock_list(q=q, group=group, low_only=low_only)
    return render(request, "inventory.html", "inventory",
                  rows=rows, groups=src.stock_groups(), q=q, group=group, low_only=low_only,
                  low_count=sum(1 for r in rows if r.is_low),
                  total_reserved=sum(r.reserved for r in rows))


@app.get("/inventory/{code}")
def inventory_item(request: Request, code: str, days: int = 30):
    src = get_source()
    item = src.stock_item(code)
    if item is None:
        raise HTTPException(404, f"找不到 SKU {code}")
    return render(request, "item.html", "inventory",
                  item=item, locations=src.stock_locations(code),
                  moves=src.movements(code, days=days), days=days)


# ------------------------------------------------------------------ 出货
@app.get("/deliveries")
def deliveries(request: Request, status: str = "", channel: str = "", q: str = "", days: int = 30):
    src = get_source()
    rows = src.deliveries(status=status, channel=channel, q=q, days=days)
    everything = src.deliveries(days=days)
    counts = {k: sum(1 for d in everything if d.status == k) for k in STATUS_LABEL}
    return render(request, "deliveries.html", "deliveries",
                  rows=rows, counts=counts, channels=src.channels(), status_labels=STATUS_LABEL,
                  status=status, channel=channel, q=q, days=days)


@app.get("/deliveries/{doc_no}")
def delivery(request: Request, doc_no: str):
    d = get_source().delivery(doc_no)
    if d is None:
        raise HTTPException(404, f"找不到出货单 {doc_no}")
    return render(request, "delivery.html", "deliveries", d=d)


# ------------------------------------------------------------------ JSON API（给之后的手机版 / 其他系统用）
@app.get("/api/inventory")
def api_inventory(q: str = "", group: str = "", low: str = ""):
    return [r.__dict__ | {"available": r.available, "is_low": r.is_low}
            for r in get_source().stock_list(q=q, group=group, low_only=low == "1")]


@app.get("/api/deliveries")
def api_deliveries(status: str = "", channel: str = "", q: str = "", days: int = 30):
    out = []
    for d in get_source().deliveries(status=status, channel=channel, q=q, days=days):
        out.append({"doc_no": d.doc_no, "doc_date": d.doc_date.isoformat(), "debtor_code": d.debtor_code,
                    "debtor_name": d.debtor_name, "channel": d.channel, "status": d.status,
                    "total_qty": d.total_qty, "delivered_qty": d.delivered_qty,
                    "lines": [l.__dict__ for l in d.lines]})
    return out
