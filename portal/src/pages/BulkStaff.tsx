// 员工与权限 · 从 Excel 一次开齐账号：HR 在 Excel 填好，整块复制贴上，系统逐笔加入名单、填到职日 / 性别、开登入。
// 不需要新的资料库函数：依序呼叫 ops_staff_save → ops_att_staff_set → ops-account（与单笔新增相同的权限检查）。
import { useMemo, useState } from "react";
import { api, Me } from "../api";
import { att } from "../att-api";
import { Modal } from "../ui";

const ALIAS: Record<string, string> = { hr: "hr", 人事部: "hr", 管理: "mgmt", 老板: "mgmt", 采购: "purchasing", 订货: "purchasing",
  送货: "delivery", 安装: "delivery", 司机: "delivery", 物流: "logistics", logistics: "logistics", 会计: "finance", 网店: "ecommerce", 门市: "sales", store: "sales" };
const HEAD = ["姓名", "Email", "部门", "分店", "职位", "手机", "到职日", "性别"];
const SAMPLE = ["TAN AH KOW", "ahkow@gmail.com", "仓库", "总行", "仓务员", "012-3456789", "2024-03-01", "男"];

interface Row { line: number; name: string; email: string; department: string; branch: string; title: string; phone: string;
  join_date: string; gender: string; errors: string[] }

function ymd(y: string, mo: string, d: string): string | null {
  const dt = new Date(Date.UTC(+y, +mo - 1, +d));
  if (dt.getUTCFullYear() !== +y || dt.getUTCMonth() !== +mo - 1 || dt.getUTCDate() !== +d) return null;   // 例：13 月、2 月 30 日
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}
function parseDate(s: string): string | null {
  const t = s.trim();
  if (!t) return "";
  let m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return ymd(m[1], m[2], m[3]);
  m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);                  // 马来西亚习惯 日/月/年
  if (m) return ymd(m[3], m[2], m[1]);
  return null;
}
function parseGender(s: string): string | null {
  const t = s.trim().toUpperCase();
  if (!t) return "";
  if (["男", "M", "MALE", "L", "LELAKI"].includes(t)) return "M";
  if (["女", "F", "FEMALE", "P", "PEREMPUAN"].includes(t)) return "F";
  return null;
}
function parseBranch(s: string): string | null {
  const t = s.trim().toUpperCase();
  if (!t || ["总行", "总部", "HQ", "SB", "HOMEWORKSSB", "BATU PAHAT", "BP"].includes(t)) return "HOMEWORKSSB";
  if (["JB", "SOUTHERN", "HOMEWORKSSOUTHERN", "新山"].includes(t)) return "HOMEWORKSSOUTHERN";
  return null;
}

export function BulkStaff({ me, onClose, onDone }: { me: Me; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<[string, boolean][]>([]);

  const rows = useMemo<Row[]>(() => text.split(/\r?\n/).map((l, i) => ({ l, i })).filter(({ l }) => l.trim())
    .map(({ l, i }) => ({ c: (l.includes("\t") ? l.split("\t") : l.split(",")).map((x) => x.trim()), i }))
    .filter(({ c }) => !["姓名", "NAME"].includes((c[0] || "").toUpperCase()))
    .map(({ c, i }) => {
      const [name = "", email = "", dept = "", br = "", title = "", phone = "", jd = "", g = ""] = c;
      const errors: string[] = [];
      const key = dept.replace(/部$/, "").trim(), low = key.toLowerCase();
      const d = !key ? undefined : me.departments.find((x) => x.code === low || x.name === key || (ALIAS[low] ?? "") === x.code)
        ?? me.departments.find((x) => x.name.split(/\s*\/\s*/).includes(key) || (key.length >= 2 && x.name.includes(key)));
      const b = parseBranch(br), j = parseDate(jd), gg = parseGender(g);
      if (!name) errors.push("没有姓名");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.push("email 不对");
      if (!d) errors.push(`没有「${dept}」这个部门`);
      if (b === null) errors.push(`分店「${br}」看不懂（写 总行 或 JB）`);
      if (j === null) errors.push(`到职日「${jd}」看不懂（写 2024-03-01 或 1/3/2024）`);
      if (gg === null) errors.push(`性别「${g}」看不懂（写 男 或 女）`);
      return { line: i + 1, name, email: email.toLowerCase(), department: d?.code ?? "", branch: b ?? "", title, phone,
               join_date: j ?? "", gender: gg ?? "", errors };
    }), [text, me.departments]);
  const ok = rows.filter((r) => !r.errors.length);
  const pwOk = !pw || pw.length >= 8;

  async function run() {
    setBusy(true);
    const out: [string, boolean][] = [];
    for (const r of ok) {
      try {
        const s = await api.saveStaff({ email: r.email, name: r.name, department: r.department, branch: r.branch,
                                        role: "staff", title: r.title, phone: r.phone, active: true });
        if (r.join_date || r.gender) await att.setStaff({ id: s.id, join_date: r.join_date, gender: r.gender });
        if (pw) await api.setPassword(s.id, pw);
        out.push([`✓ ${r.name}`, true]);
      } catch (e) { out.push([`✗ ${r.name}：${(e as Error).message}`, false]); }
      setLog([...out]);
    }
    setBusy(false);
    onDone();
  }
  function template() {
    const csv = "﻿" + [HEAD, SAMPLE].map((l) => l.join(",")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = "员工名单范本.csv";
    a.click();
  }

  return (
    <Modal title="从 Excel 一次开账号" onClose={onClose} wide>
      <ol className="small">
        <li>{"先下载范本，用 Excel 填好：姓名、Email、部门、分店、职位、手机、到职日、性别（职位、手机、到职日、性别可以空着）。"}</li>
        <li>在 Excel 选起整块（可以连表头）→ 复制 → 贴在下面。</li>
        <li>填一个开账号用的初始密码，员工第一次登入后自己改。</li>
      </ol>
      <div className="actions left"><button className="ghost" onClick={template}>下载范本</button></div>
      <label>从 Excel 贴上<textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} disabled={busy}
                                  placeholder={HEAD.join("\t")} /></label>
      {rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>姓名</th><th>Email</th><th>部门</th><th>分店</th><th>到职日</th><th>性别</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.line}>
                  <td>{r.name}</td><td className="small">{r.email}</td>
                  <td>{me.departments.find((d) => d.code === r.department)?.name ?? ""}</td>
                  <td>{r.branch === "HOMEWORKSSOUTHERN" ? "JB" : r.branch ? "总行" : ""}</td>
                  <td className="nowrap">{r.join_date}</td><td>{r.gender === "M" ? "男" : r.gender === "F" ? "女" : ""}</td>
                  <td className="small">{r.errors.length ? <span className="late">{r.errors.join(" · ")}</span> : "✓"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <label>初始密码（至少 8 个字；空着 = 只加名单，之后再一个一个开通登入）
        <input type="text" value={pw} onChange={(e) => setPw(e.target.value)} disabled={busy} autoComplete="off" /></label>
      {log.length > 0 && <ul className="list small">{log.map(([t, good], i) => <li key={i} className={good ? "" : "late"}>{t}</li>)}</ul>}
      <div className="actions">
        <button className="ghost" onClick={onClose}>{log.length ? "关闭" : "取消"}</button>
        <button disabled={busy || !ok.length || !pwOk || log.length > 0} onClick={run}>
          {busy ? "处理中…" : `开 ${ok.length} 个账号`}</button>
      </div>
      {rows.length > ok.length && <p className="small late">{`有 ${rows.length - ok.length} 行有问题，不会处理；改好再贴一次。`}</p>}
    </Modal>
  );
}
