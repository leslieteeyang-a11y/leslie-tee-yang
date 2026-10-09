// 人事 · 员工档案：同分店在职员工的证件、紧急联络人、档案齐不齐；点进去看 / 改（人事「可编辑」才能改）。
// 清单不含地址与银行；银行区块只有管理薪资的人（薪资「可编辑」）在单人档案里看得到。路由 #/hr/profiles[/<staff_id>]
import { useCallback, useEffect, useState } from "react";
import { api, BRANCH_LABEL, PROFILE_MISSING_LABEL, ProfileRow, StaffProfile } from "../api";
import { go } from "../router";
import { Empty, ErrorBox, Modal } from "../ui";
import { ProfileForm } from "./MyProfile";

export default function HrProfiles({ openId }: { openId?: number }) {
  const [d, setD] = useState<{ can_edit: boolean; can_bank: boolean; rows: ProfileRow[] } | null>(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [open, setOpen] = useState<number | null>(openId ?? null);
  const [notice, setNotice] = useState("");

  const load = useCallback(() => { api.profiles().then(setD).catch((e: Error) => setError(e.message)); }, []);
  useEffect(load, [load]);
  useEffect(() => { setOpen(openId ?? null); }, [openId]);

  const close = () => { setOpen(null); if (openId) go("/hr/profiles"); };

  if (!d) return error ? <ErrorBox error={error} /> : <p className="muted">载入中…</p>;
  const needle = q.trim().toLowerCase();
  const shown = d.rows.filter((r) => (!onlyMissing || r.missing.length > 0)
    && (!needle || (r.name + " " + (r.id_no || "") + " " + (r.phone || "")).toLowerCase().includes(needle)));
  const missingCount = d.rows.filter((r) => r.missing.length > 0).length;

  return (
    <>
      <div className="filters">
        <input className="search" placeholder="找员工" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="check"><input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} /> 只看没填齐的</label>
      </div>
      {notice && <div className="ok">{notice}</div>}
      {missingCount > 0 && <p className="small late">{`${missingCount} 位员工的档案没填齐`}</p>}
      {shown.length === 0 ? <Empty>没有员工。</Empty> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>员工</th><th className="hide-sm">证件号码</th><th className="hide-sm">手机</th><th>紧急联络人</th><th>档案</th></tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.staff_id} className="click" onClick={() => { setNotice(""); setOpen(r.staff_id); }}>
                  <td><b>{r.name}</b><div className="muted small">{`${r.department_name} · ${BRANCH_LABEL[r.branch] || r.branch}`}</div>
                    {r.last_day && <div className="small late">{`最后上班日 ${r.last_day}`}</div>}</td>
                  <td className="hide-sm nowrap">{r.id_no || <span className="muted">—</span>}
                    {r.id_no && r.id_type === "passport" && <div className="muted small">护照</div>}</td>
                  <td className="hide-sm nowrap">{r.phone || <span className="muted">—</span>}</td>
                  <td>{r.emergency_name ? <>{r.emergency_name}{r.emergency_relation && <span className="muted">{` · ${r.emergency_relation}`}</span>}
                    {r.emergency_phone && <div className="muted small nowrap">{r.emergency_phone}</div>}</> : <span className="muted">—</span>}</td>
                  <td>{r.missing.length === 0 ? <span className="dtag on">齐了</span>
                    : r.missing.map((m) => <span key={m} className="dtag late">{PROFILE_MISSING_LABEL[m] ?? m}</span>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">员工也可以在首页「我的资料」自己填。证件号码、地址、银行户口只在这里和员工自己的页面出现，不会出现在其他清单。</p>
      {!d.can_bank && <p className="muted small">银行户口只有本人和管理薪资的人看得到，这里不会显示。</p>}
      {!d.can_edit && <p className="muted small">你有人事「只看」权限：可以看，不能改。</p>}
      {open && <ProfileModal staffId={open} onClose={close}
                             onSaved={(p) => { close(); setNotice(`已储存 ${p.name} 的档案。`); load(); }} />}
    </>
  );
}

function ProfileModal({ staffId, onClose, onSaved }: { staffId: number; onClose: () => void; onSaved: (p: StaffProfile) => void }) {
  const [p, setP] = useState<StaffProfile | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { api.profile(staffId).then(setP).catch((e: Error) => setError(e.message)); }, [staffId]);
  return (
    <Modal title={p ? `员工档案：${p.name}` : "员工档案"} onClose={onClose} wide>
      {!p ? (error ? <ErrorBox error={error} /> : <p className="muted">载入中…</p>) : (
        <>
          <p className="muted small">{[p.department_name, BRANCH_LABEL[p.branch] || p.branch, p.phone && `手机 ${p.phone}`,
                                       p.join_date && `到职 ${p.join_date}`, p.last_day && `最后上班日 ${p.last_day}`].filter(Boolean).join(" · ")}</p>
          <ProfileForm p={p} onSaved={onSaved} onCancel={onClose} />
        </>
      )}
    </Modal>
  );
}
