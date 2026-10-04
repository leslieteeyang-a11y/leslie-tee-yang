// 工资单：画面 / 列印（存成 PDF）/ WhatsApp 文字。格式照原薪资系统（英文 + 中文小字）。
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { fmtRM, MON_EN, Slip, slipText, waPhone } from "../pay-api";

export function SlipView({ s, company }: { s: Slip; company: string }) {
  return (
    <div className="ps">
      <div className="ph">
        <div><div className="co">{company}</div><div className="ti">PAYSLIP 工资单</div></div>
        <div className="pd">{`${MON_EN[s.m - 1]} ${s.y}`}{s.b && <><br />{`Working days: ${s.b.workDays}`}</>}</div>
      </div>
      <div className="who">{s.name}</div>
      {s.secs.map((x, i) => (
        <table key={i}>
          <thead><tr><th>{`${x.title[0]} ${x.title[1]}`}</th><th className="n">RM</th></tr></thead>
          <tbody>
            {x.rows.filter(([, , v, force]) => force || +v).map(([en, zh, v]) => (
              <tr key={en}><td>{en}<span className="zh">{zh}</span></td><td className="n">{fmtRM(v)}</td></tr>
            ))}
            {x.total && <tr className="t"><td>{x.total[0]}<span className="zh">{x.total[1]}</span></td><td className="n">{fmtRM(x.total[2])}</td></tr>}
            {x.net && <tr className="pnet"><td>{x.net[0]}<span className="zh">{x.net[1]}</span></td><td className="n">{fmtRM(x.net[2])}</td></tr>}
          </tbody>
        </table>
      ))}
      {s.total && (
        <table><tbody><tr className="pnet"><td>{s.total[0]}<span className="zh">{s.total[1]}</span></td><td className="n">{fmtRM(s.total[2])}</td></tr></tbody></table>
      )}
      {s.b && <div className="ft">{`Employer contribution 雇主缴纳 — EPF ${fmtRM(s.b.epfEr)} · SOCSO ${fmtRM(s.b.socsoEr)} · EIS ${fmtRM(s.b.eisEr)}`}</div>}
      <div className="ft">This is a computer-generated payslip. 本工资单由电脑生成。</div>
    </div>
  );
}

/** 列印一张或多张（每张一页）；按了就开浏览器的列印，可以「存成 PDF」 */
export function PrintSlips({ slips, company, onDone }: { slips: Slip[]; company: string; onDone: () => void }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(true);
    const style = document.createElement("style");
    style.textContent = "@page { size: A4; margin: 12mm; }";
    document.head.appendChild(style);
    const done = () => onDone();
    window.addEventListener("afterprint", done);
    const t = setTimeout(() => window.print(), 300);
    return () => { clearTimeout(t); window.removeEventListener("afterprint", done); style.remove(); };
  }, [onDone]);
  if (!ready) return null;
  return createPortal(
    <div id="pay-print">{slips.map((s, i) => <SlipView key={i} s={s} company={company} />)}</div>, document.body);
}

export function sendWhatsApp(s: Slip, company: string, phone: string): string | null {
  const ph = waPhone(phone);
  if (!ph) return "这位员工没有手机号。请到「员工薪资资料」填手机号。";
  window.open("https://wa.me/" + ph + "?text=" + encodeURIComponent(slipText(s, company)), "_blank", "noopener");
  return null;
}
