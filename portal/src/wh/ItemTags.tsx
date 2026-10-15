// 商品标签：系统自动的「畅销 / 滞销」+ 手动的「清货」与自订标签。
// 看 = 仓库「只看」以上；标 / 拿掉 / 建标签 = 订货「可编辑」或仓库「可审批」（资料库检查，画面照 can_edit 显示按键）。
import { useCallback, useEffect, useState } from "react";
import { ErrorBox, Modal } from "../ui";
import { Tag, TAG_COLOR_LABEL, TAG_COLORS, TagColor, TagList, whTag } from "../wh-tag-api";
import "../wh-tag.css";

// 标签清单（颜色）每间分店抓一次；改了标签就清掉
const cache = new Map<string, Promise<TagList>>();
export function loadTags(company: string, fresh = false): Promise<TagList> {
  if (fresh || !cache.has(company)) {
    const p = whTag.tags(company);
    cache.set(company, p);
    p.catch(() => cache.delete(company));
  }
  return cache.get(company)!;
}
export function forgetTags() { cache.clear(); }

export function useTagList(company: string): [TagList | null, () => void] {
  const [list, setList] = useState<TagList | null>(null);
  const reload = useCallback(() => { loadTags(company, true).then(setList).catch(() => setList(null)); }, [company]);
  useEffect(() => {
    let alive = true;
    loadTags(company).then((l) => alive && setList(l)).catch(() => alive && setList(null));
    return () => { alive = false; };
  }, [company]);
  return [list, reload];
}

/** 一个标签小块 */
export function TagChip({ name, color, onRemove }: { name: string; color?: TagColor; onRemove?: () => void }) {
  return (
    <span className={`wht-chip c-${color || "gray"}`}>
      {name}
      {onRemove && <button className="wht-x" onClick={onRemove} aria-label="拿掉这个标签" title="拿掉这个标签">×</button>}
    </span>
  );
}

/** 一排标签（颜色照标签清单；清单还没载入就灰色） */
export function TagChips({ tags, list }: { tags: string[] | undefined; list: TagList | null }) {
  if (!tags?.length) return null;
  const by = new Map((list?.tags ?? []).map((t) => [t.name, t]));
  return <span className="wht-chips">{tags.map((t) => <TagChip key={t} name={t} color={by.get(t)?.color} />)}</span>;
}

/** 查货卡片 / 批次页：这个商品的标签，可标 / 拿掉 */
export function ItemTags({ company, itemCode }: { company: string; itemCode: string }) {
  const [list, reloadList] = useTagList(company);
  const [tags, setTags] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [manage, setManage] = useState(false);
  useEffect(() => {
    let alive = true;
    setTags(null); setError("");
    whTag.itemTags(company, [itemCode]).then((m) => alive && setTags(m[itemCode] ?? [])).catch((e: Error) => alive && setError(e.message));
    return () => { alive = false; };
  }, [company, itemCode]);
  const by = new Map((list?.tags ?? []).map((t) => [t.name, t]));
  const canEdit = !!list?.can_edit;
  const addable = (list?.tags ?? []).filter((t) => t.kind === "manual" && t.active && !(tags ?? []).includes(t.name));

  async function set(tag: string, on: boolean) {
    setBusy(true); setError("");
    try {
      const r = await whTag.setItemTag(company, [itemCode], tag, on);
      setTags(r.tags[itemCode] ?? []);
      reloadList();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }

  return (
    <div className="wht-tags">
      {tags === null ? (!error && <span className="muted small">…</span>) : (
        <>
          {tags.length === 0 && !canEdit && <span className="muted small">没有标签</span>}
          {tags.map((t) => {
            const g = by.get(t);
            return <TagChip key={t} name={t} color={g?.color} onRemove={canEdit && g?.kind === "manual" && !busy ? () => set(t, false) : undefined} />;
          })}
          {canEdit && addable.length > 0 && (
            <select className="wht-add" value="" disabled={busy} aria-label="加标签" onChange={(e) => e.target.value && set(e.target.value, true)}>
              <option value="">＋ 标签</option>
              {addable.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
            </select>
          )}
          {canEdit && <button className="small ghost" onClick={() => setManage(true)}>管理标签</button>}
        </>
      )}
      <ErrorBox error={error} />
      {manage && <TagManager company={company} onClose={() => setManage(false)} onChanged={() => { reloadList(); whTag.itemTags(company, [itemCode]).then((m) => setTags(m[itemCode] ?? [])).catch(() => {}); }} />}
    </div>
  );
}

/** 建标签、改颜色、停用（订货「可编辑」或仓库「可审批」） */
export function TagManager({ company, onClose, onChanged }: { company: string; onClose: () => void; onChanged: () => void }) {
  const [list, setList] = useState<TagList | null>(null);
  const [name, setName] = useState("");
  const [color, setColor] = useState<TagColor>("blue");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => loadTags(company, true).then(setList).catch((e: Error) => setError(e.message)), [company]);
  useEffect(() => { load(); }, [load]);

  async function save(p: { name: string; color?: TagColor; active?: boolean }) {
    setBusy(true); setError("");
    try { await whTag.saveTag(p); await load(); onChanged(); if (p.name === name.trim()) setName(""); }
    catch (e) { setError((e as Error).message); }
    setBusy(false);
  }

  return (
    <Modal title="商品标签" onClose={onClose}>
      <p className="muted small">「畅销」「滞销」是系统每天照销量 / 最后进货日自动标的（只能改颜色或停用）；其他是手动标的。停用的标签不显示，也不能再标。</p>
      {!list ? (!error && <p className="muted">载入中…</p>) : (
        <div className="table-wrap flat">
          <table className="wht-manage">
            <thead><tr><th>标签</th><th>种类</th><th className="num">商品数</th><th>颜色</th><th>启用</th></tr></thead>
            <tbody>
              {list.tags.map((t: Tag) => (
                <tr key={t.name} className={t.active ? "" : "wht-off"}>
                  <td><TagChip name={t.name} color={t.color} /></td>
                  <td className="small">{t.kind === "auto" ? (t.rule === "hot" ? "自动（近 90 天销量前 5%、≥ 10 件）" : "自动（最后进货满 6 个月还有货）") : "手动"}</td>
                  <td className="num">{t.items}</td>
                  <td>
                    <select value={t.color} disabled={busy} aria-label="颜色" onChange={(e) => save({ name: t.name, color: e.target.value as TagColor })}>
                      {TAG_COLORS.map((c) => <option key={c} value={c}>{TAG_COLOR_LABEL[c]}</option>)}
                    </select>
                  </td>
                  <td><input type="checkbox" checked={t.active} disabled={busy} aria-label="启用" onChange={(e) => save({ name: t.name, active: e.target.checked })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form className="wht-new" onSubmit={(e) => { e.preventDefault(); if (name.trim()) save({ name: name.trim(), color }); }}>
        <input value={name} maxLength={10} placeholder="新标签名称（最多 10 个字）" onChange={(e) => setName(e.target.value)} />
        <select value={color} aria-label="颜色" onChange={(e) => setColor(e.target.value as TagColor)}>
          {TAG_COLORS.map((c) => <option key={c} value={c}>{TAG_COLOR_LABEL[c]}</option>)}
        </select>
        <button disabled={busy || !name.trim()}>建标签</button>
      </form>
      <ErrorBox error={error} />
    </Modal>
  );
}
