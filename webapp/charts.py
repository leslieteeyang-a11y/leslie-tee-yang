# -*- coding: utf-8 -*-
"""仪表板用的极简 SVG 图表（不依赖任何前端函式库）。

规格依 dataviz 惯例：单一系列不放图例、线 2px、条形末端 4px 圆角并贴齐基线、
条与条之间留 2px、格线与轴线退到背景、数值用文字色不用系列色。
"""

from __future__ import annotations

from html import escape

SERIES = "#2a78d6"          # 类别色槽 1（已通过 CVD / 对比验证的预设色板）
INK = "#1f2937"
MUTED = "#6b7280"
GRID = "#e5e7eb"


def _nice_max(v: float) -> float:
    if v <= 0:
        return 1.0
    import math
    exp = 10 ** math.floor(math.log10(v))
    for m in (1, 2, 2.5, 5, 10):
        if v <= m * exp:
            return m * exp
    return 10 * exp


def _fmt(v: float) -> str:
    if abs(v) >= 1_000_000:
        return f"{v/1_000_000:.1f}M"
    if abs(v) >= 1_000:
        return f"{v/1_000:.0f}K"
    return f"{v:.0f}"


def line_chart(points, *, width=1000, height=240, label_every=None, value_key="amount", title=""):
    """points: 有 .day 与 value_key 属性的物件列表（按日期排序）。回传 SVG 字串。"""
    if not points:
        return '<p class="empty">没有资料</p>'
    pad_l, pad_r, pad_t, pad_b = 44, 12, 10, 24
    w, h = width - pad_l - pad_r, height - pad_t - pad_b
    vals = [getattr(p, value_key) for p in points]
    vmax = _nice_max(max(vals))
    n = len(points)
    xs = [pad_l + (w * i / max(n - 1, 1)) for i in range(n)]
    ys = [pad_t + h - (h * v / vmax) for v in vals]
    label_every = label_every or max(1, n // 6)

    out = [f'<svg class="chart line" viewBox="0 0 {width} {height}" role="img" aria-label="{escape(title)}">']
    for k in range(5):                                   # 横向格线 + 轴标
        y = pad_t + h * k / 4
        v = vmax * (4 - k) / 4
        out.append(f'<line x1="{pad_l}" y1="{y:.1f}" x2="{width-pad_r}" y2="{y:.1f}" stroke="{GRID}"/>')
        out.append(f'<text x="{pad_l-6}" y="{y+4:.1f}" text-anchor="end" font-size="11" fill="{MUTED}">{_fmt(v)}</text>')
    path = " ".join(f"{'M' if i == 0 else 'L'}{x:.1f},{y:.1f}" for i, (x, y) in enumerate(zip(xs, ys)))
    out.append(f'<path d="{path}" fill="none" stroke="{SERIES}" stroke-width="2" stroke-linejoin="round"/>')
    for i, (p, x, y) in enumerate(zip(points, xs, ys)):
        if i % label_every == 0 or i == n - 1:
            out.append(f'<text x="{x:.1f}" y="{height-6}" text-anchor="middle" font-size="11" fill="{MUTED}">{p.day:%m/%d}</text>')
        tip = f"{p.day} · RM {getattr(p, value_key):,.0f} · {p.orders} 张单"
        # 命中区比点大：整条竖带都可触发
        out.append(f'<g class="pt"><rect x="{x - w/n/2:.1f}" y="{pad_t}" width="{max(w/n,6):.1f}" height="{h}" fill="transparent"/>'
                   f'<circle cx="{x:.1f}" cy="{y:.1f}" r="4" fill="{SERIES}" stroke="#fff" stroke-width="2"/>'
                   f'<title>{escape(tip)}</title></g>')
    out.append("</svg>")
    return "".join(out)


def bar_chart(rows, *, width=720, bar_h=22, gap=8, label_w=150, value_fmt=lambda v: f"RM {v:,.0f}", title=""):
    """rows: [(标签, 数值, 提示文字)]，横向条形，单一系列。"""
    if not rows:
        return '<p class="empty">没有资料</p>'
    vmax = max(v for _, v, _ in rows) or 1
    height = len(rows) * (bar_h + gap) + 4
    w = width - label_w - 90
    out = [f'<svg class="chart bars" viewBox="0 0 {width} {height}" role="img" aria-label="{escape(title)}">']
    for i, (label, v, tip) in enumerate(rows):
        y = 2 + i * (bar_h + gap)
        bw = max(w * v / vmax, 2)
        out.append(f'<g class="bar"><text x="{label_w-8}" y="{y+bar_h*0.68:.1f}" text-anchor="end" font-size="12" fill="{INK}">{escape(str(label)[:22])}</text>'
                   f'<rect x="{label_w}" y="{y}" width="{bw:.1f}" height="{bar_h}" rx="4" fill="{SERIES}"/>'
                   f'<rect x="{label_w}" y="{y}" width="4" height="{bar_h}" fill="{SERIES}"/>'   # 基线端不圆角
                   f'<text x="{label_w+bw+8:.1f}" y="{y+bar_h*0.68:.1f}" font-size="12" fill="{INK}">{escape(value_fmt(v))}</text>'
                   f'<title>{escape(tip)}</title></g>')
    out.append("</svg>")
    return "".join(out)
