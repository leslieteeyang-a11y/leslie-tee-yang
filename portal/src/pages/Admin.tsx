import { FormEvent, useCallback, useEffect, useState } from "react";
import { api, BRANCH_LABEL, DeptModule, Level, LEVEL_LABEL, Me, ROLE_LABEL, StaffAdmin } from "../api";
import { ErrorBox, Modal, Tabs } from "../ui";

export default function Admin({ me, onChanged }: { me: Me; onChanged: () => void }) {
  const [tab, setTab] = useState<"staff" | "matrix">("staff");
  return (
    <>
      <h1>员工与权限</h1>
      <div className="filters">
        <Tabs value={tab} onChange={setTab} options={[["staff", "员工名单"], ["matrix", "部门权限"]]} />
      </div>
      {tab === "staff" ? <StaffTab me={me} onChanged={onChanged} /> : <MatrixTab me={me} onChanged={onChanged} />}
    </>
  );
}

const deptName = (me: Me, code: string) => me.departments.find((d) => d.code === code)?.name ?? code;

function StaffTab({ me, onChanged }: { me: Me; onChanged: () => void }) {
  const [rows, setRows] = useState<StaffAdmin[] | null>(null);
  const [error, setError] = useState("");
  const [edit, setEdit] = useState<StaffAdmin | "new" | null>(null);
  const [pwFor, setPwFor] = useState<StaffAdmin | null>(null);

  const load = useCallback(() => {
    api.staffList().then(setRows).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  return (
    <>
      <div className="page-head">
        <p className="muted">员工要先在这里加入名单，再设定登入密码，才能进营运系统。营运系统的名单与 HomeWorks BI 分开：加进来的人看不到 BI 的财务数据。</p>
        <button onClick={() => setEdit("new")}>＋ 新增员工</button>
      </div>
      <ErrorBox error={error} />
      {rows && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>姓名</th><th className="hide-sm">Email</th><th>部门</th><th className="hide-sm">分店</th><th>角色</th><th>登入</th><th></th></tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} className={s.active ? "" : "inactive"}>
                  <td><b>{s.name}</b>{s.title && <span className="muted"> · {s.title}</span>}{!s.active && <span className="tag">已停用</span>}</td>
                  <td className="hide-sm">{s.email}</td>
                  <td>{deptName(me, s.department)}</td>
                  <td className="hide-sm">{BRANCH_LABEL[s.branch]}</td>
                  <td>{ROLE_LABEL[s.role]}{Object.keys(s.overrides).length > 0 && <span className="tag">个人例外 {Object.keys(s.overrides).length}</span>}</td>
                  <td>{s.has_login ? "✓ 有账号" : <span className="muted">未开通</span>}</td>
                  <td className="nowrap">
                    <button className="small ghost" onClick={() => setEdit(s)}>修改</button>{" "}
                    {s.id !== me.staff.id && s.active && (
                      <button className="small ghost" onClick={() => setPwFor(s)}>{s.has_login ? "重设密码" : "开通登入"}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && (
        <StaffForm me={me} staff={edit === "new" ? undefined : edit} onClose={() => setEdit(null)}
                   onSaved={(s, isNew) => { setEdit(null); load(); onChanged(); if (isNew) setPwFor(s); }} />
      )}
      {pwFor && <PasswordForm staff={pwFor} onClose={() => setPwFor(null)} onDone={() => { setPwFor(null); load(); }} />}
    </>
  );
}

function StaffForm({ me, staff, onClose, onSaved }: {
  me: Me; staff?: StaffAdmin; onClose: () => void; onSaved: (s: StaffAdmin, isNew: boolean) => void;
}) {
  const [f, setF] = useState({
    email: staff?.email ?? "", name: staff?.name ?? "", department: staff?.department ?? "sales",
    branch: staff?.branch ?? "HOMEWORKSSB", role: staff?.role ?? "staff", title: staff?.title ?? "",
    phone: staff?.phone ?? "", active: staff?.active ?? true,
  });
  const [overrides, setOverrides] = useState<Record<string, string>>({ ...(staff?.overrides ?? {}) });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const modules = me.modules.filter((m) => m.key !== "admin");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    // 原本有、现在清掉的例外要送空字串，资料库才会删掉
    const ov: Record<string, string> = {};
    for (const k of new Set([...Object.keys(staff?.overrides ?? {}), ...Object.keys(overrides)])) ov[k] = overrides[k] ?? "";
    try {
      const saved = await api.saveStaff({ ...f, id: staff?.id, overrides: ov });
      onSaved({ ...(saved as StaffAdmin), has_login: staff?.has_login ?? false, overrides: {} }, !staff);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title={staff ? `修改：${staff.name}` : "新增员工"} onClose={onClose} wide>
      <form onSubmit={submit} className="form">
        <div className="row">
          <label>姓名<input value={f.name} onChange={set("name")} required autoFocus /></label>
          <label>Email（登入用）<input type="email" value={f.email} onChange={set("email")} required /></label>
        </div>
        <div className="row">
          <label>部门
            <select value={f.department} onChange={set("department")}>
              {me.departments.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
            </select>
          </label>
          <label>分店
            <select value={f.branch} onChange={set("branch")}>
              {Object.entries(BRANCH_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label>角色
            <select value={f.role} onChange={set("role")}>
              <option value="staff">员工</option>
              <option value="manager">主管（可审批自己部门）</option>
              <option value="admin">管理员（全部权限）</option>
            </select>
          </label>
        </div>
        <div className="row">
          <label>职称<input value={f.title} onChange={set("title")} placeholder="例：仓库主管" /></label>
          <label>电话<input value={f.phone} onChange={set("phone")} /></label>
          <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> 在职（取消 = 停用，不能登入）</label>
        </div>
        <details>
          <summary>个人权限例外（一般不用设，照部门预设）</summary>
          <div className="ov-grid">
            {modules.map((m) => (
              <label key={m.key}>{m.name}
                <select value={overrides[m.key] ?? ""} onChange={(e) => {
                  const next = { ...overrides };
                  if (e.target.value) next[m.key] = e.target.value; else delete next[m.key];
                  setOverrides(next);
                }}>
                  <option value="">照部门预设</option>
                  {(["none", "view", "edit", "approve"] as Level[]).map((l) => <option key={l} value={l}>{LEVEL_LABEL[l]}</option>)}
                </select>
              </label>
            ))}
          </div>
        </details>
        <ErrorBox error={error} />
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>取消</button>
          <button disabled={busy}>{busy ? "储存中…" : "储存"}</button>
        </div>
      </form>
    </Modal>
  );
}

function PasswordForm({ staff, onClose, onDone }: { staff: StaffAdmin; onClose: () => void; onDone: () => void }) {
  const [pw, setPw] = useState(() => suggestPassword());
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api.setPassword(staff.id, pw);
      setDone(r.created ? "账号已开通。" : "密码已重设。");
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  }

  return (
    <Modal title={`${staff.has_login ? "重设密码" : "开通登入"}：${staff.name}`} onClose={done ? onDone : onClose}>
      {done ? (
        <div className="form">
          <div className="ok">{done}</div>
          <p>请把以下资料交给 {staff.name}，并提醒对方登入后到「改密码」换成自己的密码：</p>
          <pre className="copy">{`网址：${window.location.origin}\nEmail：${staff.email}\n密码：${pw}`}</pre>
          <div className="actions"><button onClick={onDone}>完成</button></div>
        </div>
      ) : (
        <form onSubmit={submit} className="form">
          {staff.has_login && <p className="muted">这个 email 已经有账号（可能也在用 HomeWorks BI）。重设后 BI 也要用新密码。</p>}
          <label>密码（至少 8 个字元）<input value={pw} onChange={(e) => setPw(e.target.value)} minLength={8} required /></label>
          <ErrorBox error={error} />
          <div className="actions">
            <button type="button" className="ghost" onClick={onClose}>取消</button>
            <button disabled={busy}>{busy ? "处理中…" : "确定"}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function suggestPassword(): string {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const buf = new Uint32Array(10);
  crypto.getRandomValues(buf);
  return "Hw-" + Array.from(buf, (n) => chars[n % chars.length]).join("");
}

function MatrixTab({ me, onChanged }: { me: Me; onChanged: () => void }) {
  const [rows, setRows] = useState<DeptModule[] | null>(null);
  const [error, setError] = useState("");
  const modules = me.modules.filter((m) => m.key !== "admin");

  const load = useCallback(() => {
    api.deptModules().then(setRows).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function change(department: string, module: string, level: string) {
    setError("");
    try {
      await api.setDeptModule(department, module, level);
      load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const levelOf = (d: string, m: string) => rows?.find((r) => r.department === d && r.module === m)?.level ?? "";

  return (
    <>
      <p className="muted">每个部门的预设权限。主管（manager）在「可编辑」的模块会自动升为「可审批」；管理员永远全部可用；个别员工可以在员工资料里设例外。</p>
      <ErrorBox error={error} />
      {rows && (
        <div className="table-wrap">
          <table className="matrix">
            <thead>
              <tr><th>部门</th>{modules.map((m) => <th key={m.key}>{m.name}{!m.ready && <small className="muted"><br />规划中</small>}</th>)}</tr>
            </thead>
            <tbody>
              {me.departments.map((d) => (
                <tr key={d.code}>
                  <td><b>{d.name}</b></td>
                  {modules.map((m) => {
                    const lv = levelOf(d.code, m.key);
                    return (
                      <td key={m.key}>
                        <select className={"lv " + (lv || "none")} value={lv} onChange={(e) => change(d.code, m.key, e.target.value)}>
                          <option value="">—</option>
                          <option value="view">只看</option>
                          <option value="edit">可编辑</option>
                          <option value="approve">可审批</option>
                        </select>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
