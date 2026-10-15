import { ReactNode, useEffect, useRef } from "react";

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={"modal" + (wide ? " wide" : "")} role="dialog" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon" onClick={onClose} aria-label="关闭">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ErrorBox({ error }: { error: string }) {
  return error ? <div className="error">{error}</div> : null;
}

export function Tabs<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  // 手机上分页多、横向卷：目前的分页一定卷进画面（只卷分页列本身，不动整页）
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = ref.current;
    const on = box?.querySelector<HTMLElement>("button.on");
    if (!box || !on || box.scrollWidth <= box.clientWidth) return;
    const b = box.getBoundingClientRect();
    const r = on.getBoundingClientRect();
    if (r.left < b.left) box.scrollLeft -= b.left - r.left + 12;
    else if (r.right > b.right) box.scrollLeft += r.right - b.right + 12;
  }, [value, options.length]);
  // 右边还有分页（卷得动）→ 淡出提示
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    const mark = () => box.classList.toggle("more", box.scrollLeft + box.clientWidth < box.scrollWidth - 2);
    mark();
    box.addEventListener("scroll", mark, { passive: true });
    window.addEventListener("resize", mark);
    return () => { box.removeEventListener("scroll", mark); window.removeEventListener("resize", mark); };
  }, [options.length]);
  return (
    <div className="tabs" ref={ref}>
      {options.map(([k, label]) => (
        <button key={k} type="button" className={k === value ? "on" : ""} onClick={() => onChange(k)}>{label}</button>
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
