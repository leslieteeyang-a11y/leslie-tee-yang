// 仓库地图的画布（SVG）：区的底色、货架方块、平移 / 缩放（滑鼠、触控双指）、编辑排版时拖方块与改大小。
// 一个方块 = 同一区同一货架（所有层）；位置存在 layout.shelves["区::货架"]，没存的自动排（照员工 WMS 的排法）。
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { MapRect, MapShelf } from "../wh-bin-api";
import { getLang, tr } from "../i18n";

export const BOX_W = 80, BOX_H = 54, GAP = 16, MIN_W = 60, MIN_H = 40;
const Z_MIN = 0.2, Z_MAX = 3;
const clampZ = (z: number) => Math.min(Z_MAX, Math.max(Z_MIN, z));
/** 方块上的字：英文模式先翻好（SVG 里要照字的长度排徽章） */
const say = (s: string) => (getLang() === "en" ? tr(s) : s);

/** 照存的排；没存的自动排：同一区最多 6 栏，区由左到右（太宽换一排）；已有排版时新货架排在下方 */
export function autoLayout(shelves: MapShelf[], saved?: Record<string, MapRect>): Record<string, MapRect> {
  const out: Record<string, MapRect> = {};
  let bottom = -1;
  for (const s of shelves) {
    const r = saved?.[s.key];
    if (!r || !Number.isFinite(r.x) || !Number.isFinite(r.y)) continue;
    const box = {
      x: Math.max(0, Math.round(r.x)), y: Math.max(0, Math.round(r.y)),
      w: Math.max(MIN_W, Math.round(Number(r.w) || BOX_W)), h: Math.max(MIN_H, Math.round(Number(r.h) || BOX_H)),
    };
    out[s.key] = box;
    bottom = Math.max(bottom, box.y + box.h);
  }
  const zones = new Map<string, MapShelf[]>();
  for (const s of shelves) {
    if (out[s.key]) continue;
    const list = zones.get(s.zone);
    if (list) list.push(s);
    else zones.set(s.zone, [s]);
  }
  let y = bottom >= 0 ? bottom + GAP + 40 : 20;
  let x = 20, rowH = 0;
  for (const list of zones.values()) {
    const cols = Math.min(list.length, 6), rows = Math.ceil(list.length / cols);
    const zw = cols * (BOX_W + GAP) + 20, zh = rows * (BOX_H + GAP) + 28;
    if (x > 20 && x + zw > 1300) { x = 20; y += rowH + 50; rowH = 0; }
    list.forEach((s, i) => {
      out[s.key] = { x: x + (i % cols) * (BOX_W + GAP), y: y + Math.floor(i / cols) * (BOX_H + GAP) + 28, w: BOX_W, h: BOX_H };
    });
    x += zw + 30;
    rowH = Math.max(rowH, zh);
  }
  return out;
}

interface Frame { zone: string; x: number; y: number; w: number; h: number }
function zoneFrames(shelves: MapShelf[], rects: Record<string, MapRect>): Frame[] {
  const m = new Map<string, { a: number; b: number; c: number; d: number }>();
  for (const s of shelves) {
    const r = rects[s.key];
    if (!r) continue;
    const f = m.get(s.zone) ?? { a: Infinity, b: Infinity, c: -Infinity, d: -Infinity };
    f.a = Math.min(f.a, r.x - 8); f.b = Math.min(f.b, r.y - 22);
    f.c = Math.max(f.c, r.x + r.w + 8); f.d = Math.max(f.d, r.y + r.h + 8);
    m.set(s.zone, f);
  }
  return [...m].map(([zone, f]) => ({ zone, x: f.a, y: f.b, w: f.c - f.a, h: f.d - f.b }));
}

/** 字大概多宽（中文 1 个字 = 字级，英数约 0.6） */
function textW(s: string, size: number): number {
  let w = 0;
  for (const ch of s) w += /[　-鿿＀-￯]/.test(ch) ? size : size * 0.6;
  return w;
}

export interface CanvasApi {
  fit: () => void;
  /** 放大到 zoom、把这个方块放在中间（手机放在上面一点；right = 右边等一下会被面板盖住的宽度） */
  focus: (key: string, zoom: number, right?: number) => void;
  /** 方块被手机抽屉盖住（coverTop = 抽屉上缘在视窗的位置）→ 往上移到看得到 */
  reveal: (key: string, coverTop: number) => void;
  zoomStep: (d: number) => void;
}

interface View { x: number; y: number; z: number }
type Gesture =
  | { kind: "pan"; sx: number; sy: number; v: View; key: string | null; moved: boolean }
  | { kind: "pinch"; d0: number; z0: number; wx: number; wy: number }
  | { kind: "drag" | "resize"; key: string; sx: number; sy: number; r0: MapRect; moved: boolean; last: Record<string, MapRect> };

export const MapCanvas = forwardRef<CanvasApi, {
  location: string; shelves: MapShelf[]; rects: Record<string, MapRect>; zoneIdx: Map<string, number>;
  height: number; selected: string | null; marked: Set<string>; blink: boolean; edit: boolean; mobile: boolean;
  onSelect: (key: string | null) => void;
  /** 拖拉中（每次移动） */ onRects: (r: Record<string, MapRect>) => void;
  /** 放开：要存 */ onCommit: (r: Record<string, MapRect>) => void;
}>(function MapCanvas(props, ref) {
  const { location, shelves, rects, zoneIdx, height, selected, marked, blink, edit, mobile } = props;
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, z: 0.9 });
  const live = useRef({ view, rects, props });
  live.current = { view, rects, props };
  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);
  const touched = useRef(false);

  const frames = useMemo(() => zoneFrames(shelves, rects), [shelves, rects]);

  function size() {
    const el = box.current;
    return { w: el?.clientWidth || 600, h: el?.clientHeight || 400 };
  }
  function fit() {
    if (!frames.length) return;
    const a = Math.min(...frames.map((f) => f.x)), b = Math.min(...frames.map((f) => f.y));
    const c = Math.max(...frames.map((f) => f.x + f.w)), d = Math.max(...frames.map((f) => f.y + f.h));
    const { w, h } = size();
    const z = clampZ(Math.min(0.95, Math.min(w / (c - a + 80), h / (d - b + 80))));
    setView({ x: w / 2 - ((a + c) / 2) * z, y: h / 2 - ((b + d) / 2) * z, z });
  }
  useImperativeHandle(ref, () => ({
    fit,
    focus(key, zoom, right = 0) {
      const r = live.current.rects[key];
      if (!r) return;
      touched.current = true;
      const { w, h } = size();
      const z = clampZ(zoom);
      const cy = mobile ? h * 0.3 : h / 2;
      setView({ x: (w - right) / 2 - (r.x + r.w / 2) * z, y: cy - (r.y + r.h / 2) * z, z });
    },
    reveal(key, coverTop) {
      const r = live.current.rects[key];
      const el = box.current;
      if (!r || !el) return;
      const v = live.current.view;
      const limit = Math.min(el.clientHeight, coverTop - el.getBoundingClientRect().top) - 12;
      const top = v.y + r.y * v.z, bottom = v.y + (r.y + r.h) * v.z;
      const dy = bottom > limit ? limit - bottom : top < 8 ? 8 - top : 0;
      if (!dy) return;
      touched.current = true;
      setView({ ...v, y: v.y + dy });
    },
    zoomStep(d) {
      touched.current = true;
      const { w, h } = size();
      setView((v) => zoomAt(v, w / 2, h / 2, clampZ(v.z + d)));
    },
  }));

  // 还没动过（拖、缩放、找商品）：有方块或高度变了就整张放得下
  useEffect(() => {
    if (!touched.current && frames.length && height > 0) fit();
  }, [frames.length > 0, height]); // eslint-disable-line react-hooks/exhaustive-deps

  // 滚轮缩放（要能 preventDefault，所以自己挂、不用 React 的 onWheel）
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      touched.current = true;
      const r = el.getBoundingClientRect();
      setView((v) => zoomAt(v, e.clientX - r.left, e.clientY - r.top, clampZ(v.z * (e.deltaY < 0 ? 1.12 : 0.89))));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  function local(e: { clientX: number; clientY: number }) {
    const r = box.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function pinchStart() {
    const [p, q] = [...ptrs.current.values()];
    const v = live.current.view;
    const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
    gesture.current = { kind: "pinch", d0: Math.hypot(p.x - q.x, p.y - q.y) || 1, z0: v.z, wx: (mx - v.x) / v.z, wy: (my - v.y) / v.z };
  }

  function down(e: React.PointerEvent) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const t = e.target as Element;
    const key = t.closest("[data-key]")?.getAttribute("data-key") ?? null;
    const handle = !!t.closest("[data-handle]");
    box.current?.setPointerCapture?.(e.pointerId);
    ptrs.current.set(e.pointerId, local(e));
    if (ptrs.current.size === 2) { pinchStart(); return; }
    if (ptrs.current.size > 2) return;
    const p = local(e);
    if (edit && key && live.current.rects[key]) {
      gesture.current = { kind: handle ? "resize" : "drag", key, sx: p.x, sy: p.y, r0: live.current.rects[key], moved: false, last: live.current.rects };
      return;
    }
    gesture.current = { kind: "pan", sx: p.x, sy: p.y, v: live.current.view, key, moved: false };
  }

  function move(e: React.PointerEvent) {
    if (!ptrs.current.has(e.pointerId)) return;
    const p = local(e);
    ptrs.current.set(e.pointerId, p);
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "pinch") {
      if (ptrs.current.size < 2) return;
      const [a, b] = [...ptrs.current.values()];
      touched.current = true;
      const z = clampZ(g.z0 * (Math.hypot(a.x - b.x, a.y - b.y) / g.d0));
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      setView({ x: mx - g.wx * z, y: my - g.wy * z, z });
      return;
    }
    const dx = p.x - g.sx, dy = p.y - g.sy;
    if (!g.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
    g.moved = true;
    touched.current = true;
    if (g.kind === "pan") {
      setView({ x: g.v.x + dx, y: g.v.y + dy, z: g.v.z });
      return;
    }
    const z = live.current.view.z;
    const r = g.kind === "drag"
      ? { ...g.r0, x: Math.max(0, Math.round(g.r0.x + dx / z)), y: Math.max(0, Math.round(g.r0.y + dy / z)) }
      : { ...g.r0, w: Math.max(MIN_W, Math.round(g.r0.w + dx / z)), h: Math.max(MIN_H, Math.round(g.r0.h + dy / z)) };
    g.last = { ...live.current.rects, [g.key]: r };
    props.onRects(g.last);
  }

  function up(e: React.PointerEvent) {
    if (!ptrs.current.has(e.pointerId)) return;
    ptrs.current.delete(e.pointerId);
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "pinch") {
      // 放开一指：剩下那指接着拖（不算点方块）
      const rest = [...ptrs.current.values()][0];
      gesture.current = rest ? { kind: "pan", sx: rest.x, sy: rest.y, v: live.current.view, key: null, moved: true } : null;
      return;
    }
    gesture.current = null;
    const cancel = e.type === "pointercancel";
    const toggle = (key: string) => props.onSelect(key === live.current.props.selected ? null : key);
    if (g.kind === "pan") {
      if (!cancel && !g.moved && g.key) toggle(g.key);
      return;
    }
    if (g.moved) props.onCommit(g.last);   // 被打断也存：画面上已经移过去了
    else if (!cancel) toggle(g.key);
  }

  const blocks = useMemo(() => shelves.map((s) => {
    const r = rects[s.key];
    if (!r) return null;
    const has = s.items > 0;
    const hit = marked.has(s.key);
    const cls = ["wm-block", `wm-z${zoneIdx.get(s.zone) ?? 0}`, has ? "has" : "", selected === s.key ? "sel" : "", hit ? "hit" : "",
                 hit && blink ? "blink" : ""].filter(Boolean).join(" ");
    const nameSize = Math.max(10, Math.min(24, r.w * 0.3, r.h * 0.42));
    const lv = say(`${s.levels.length} 层`);
    const badge = has ? say(`${s.items} 种`) : "";
    const bw = badge ? textW(badge, 9.5) + 12 : 0;
    const hw = edit ? 16 : 0;   // 编辑时右下角有改大小的把手
    const showLv = r.h >= 46 && textW(lv, 10) + bw + hw + 14 <= r.w;
    const title = s.zone ? `货架 ${s.shelf} · ${s.zone}区` : `货架 ${s.shelf}`;
    return (
      <g key={s.key} data-key={s.key} className={cls} transform={`translate(${r.x} ${r.y})`}
         role="button" tabIndex={0} aria-label={title}
         onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); live.current.props.onSelect(s.key); } }}>
        <rect className="body" width={r.w} height={r.h} rx={6} />
        <text className="name" x={r.w / 2} y={r.h * (showLv ? 0.42 : 0.5)} fontSize={nameSize} textAnchor="middle" dominantBaseline="central">
          {s.shelf}
        </text>
        {showLv && <text className="lv" x={7} y={r.h - 7} fontSize={10}>{lv}</text>}
        {badge && (
          <g className="badge" transform={`translate(${r.w - bw - 3 - hw} ${r.h - 17})`}>
            <rect width={bw} height={14} rx={7} />
            <text x={bw / 2} y={10.5} fontSize={9.5} textAnchor="middle">{badge}</text>
          </g>
        )}
        {edit && (
          <g data-handle="1" className="wm-handle" transform={`translate(${r.w - 14} ${r.h - 14})`}>
            <rect width={14} height={14} rx={3} />
            <path d="M4 11 L11 4 M8 11 L11 8" />
          </g>
        )}
      </g>
    );
  }), [shelves, rects, zoneIdx, selected, marked, blink, edit]); // eslint-disable-line react-hooks/exhaustive-deps

  const zones = useMemo(() => frames.map((f) => (
    <g key={f.zone} className={`wm-zone wm-z${zoneIdx.get(f.zone) ?? 0}`}>
      <rect x={f.x} y={f.y} width={f.w} height={f.h} rx={8} />
      <text x={f.x + 8} y={f.y + 15} fontSize={11}>{f.zone ? `${location} — ${f.zone}区` : location}</text>
    </g>
  )), [frames, zoneIdx, location]);

  return (
    <div ref={box} className={"wm-canvas" + (edit ? " editing" : "")} style={{ height }}
         onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <svg width="100%" height="100%">
        <g transform={`translate(${view.x} ${view.y}) scale(${view.z})`}>
          {zones}
          {blocks}
        </g>
      </svg>
      <span className="wm-hint">{edit ? "拖方块改位置 · 拖右下角改大小 · 放开就存" : mobile ? "单指拖动 · 双指缩放 · 点货架看商品" : "按住拖动地图 · 滚轮缩放 · 点货架看商品"}</span>
      <span className="wm-zoom">{`${Math.round(view.z * 100)}%`}</span>
    </div>
  );
});

function zoomAt(v: View, cx: number, cy: number, z: number): View {
  const wx = (cx - v.x) / v.z, wy = (cy - v.y) / v.z;
  return { x: cx - wx * z, y: cy - wy * z, z };
}
