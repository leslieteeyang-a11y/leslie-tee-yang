import { useEffect, useState } from "react";
import { api, can, Home, Me, moduleHref, Task } from "../api";
import { missingText } from "./MyProfile";
import { hhmm } from "../att-api";
import { ErrorBox } from "../ui";
import { DeliveryHomeCard } from "../dlv/HomeCard";
import { CustomersHomeCard } from "../cust/HomeCard";
import { whHome, WhHome } from "../wh-overview-api";
import "../extra.css";
import "../att.css";
import { canPromptInstall, dismissHint, hintDismissed, isIos, isStandalone, onInstallChange, promptInstall } from "../install";

// 首页提示：把系统加到手机主画面（已安装、已关掉提示就不显示）
function InstallHint() {
  const [, force] = useState(0);
  const [hidden, setHidden] = useState(() => isStandalone() || hintDismissed());
  useEffect(() => onInstallChange(() => force((n) => n + 1)), []);
  if (hidden) return null;
  const close = () => { dismissHint(); setHidden(true); };
  return (
    <section className="card install">
      <div>
        <b>把营运系统加到手机主画面</b>
        <p className="muted small">
          {canPromptInstall()
            ? "像 App 一样一点就开，不用记网址。"
            : isIos()
              ? "用 Safari 打开这个网页 → 点下方「分享」按钮 → 选「加入主画面」。"
              : "用 Chrome 打开 → 点右上角 ⋮ → 选「加到主画面」或「安装应用程式」。"}
        </p>
      </div>
      <div className="actions">
        {canPromptInstall() && <button onClick={() => promptInstall().then((ok) => ok && setHidden(true))}>加到主画面</button>}
        <button className="ghost" onClick={close}>不用了</button>
      </div>
    </section>
  );
}

// 首页的打卡卡片（ops_home 回传的 att；没有打卡模块的人是 null）
type HomeAtt = { clock_in: string | null; clock_out: string | null; lunch_in: string | null; workday: boolean; open_shift: boolean;
  leave?: { part: string; name: string } | null };

function AttCard({ a }: { a: HomeAtt }) {
  const text = a.open_shift ? "你之前有一天没打下班卡，请先补上。"
    : !a.clock_in && a.leave?.part === "full" ? `今天请假（${a.leave.name}）。`
    : !a.clock_in ? (a.workday ? "今天还没打上班卡。" : "今天休息。")
    : a.clock_out ? `上班 ${hhmm(a.clock_in)} · 下班 ${hhmm(a.clock_out)}`
    : `上班 ${hhmm(a.clock_in)} · 还没下班`;
  const warn = a.open_shift || (!a.clock_in && a.workday && a.leave?.part !== "full");
  return (
    <a className={"card att-home" + (warn ? " warn" : "")} href="#/attendance">
      <span><b>⏱ 今天打卡</b><br /><span className={warn ? "late" : "muted"}>{text}</span></span>
      <span className="go">{!a.clock_in || a.clock_out ? "去打卡 →" : "去打下班卡 →"}</span>
    </a>
  );
}

// 今天要做：把各模块要处理的事整理成一张清单（没有就显示「没有」）
type TodoHome = Home & { corrections_waiting?: number; leave_waiting?: number; wh_moves_pending?: number | null;
  wh_variances?: number | null; wh_counted_today?: number | null; po_arriving?: number | null; hr_gaps?: number | null;
  holidays_ahead?: number | null; join_pending?: number | null; do_to_count?: number | null; do_no_eta?: number | null;
  po_issues_todo?: number | null; do_draft_stale?: number | null; po_no_eta?: number | null; grn_pending?: number | null };
function Todo({ h }: { h: TodoHome }) {
  const items: [boolean, string, string, boolean][] = [
    [!!h.join_pending, `${h.join_pending} 个新员工申请加入`, "#/admin/join", true],
    [!!h.approvals_waiting, `${h.approvals_waiting} 件申请等你审批`, "#/approvals", true],
    [!!h.leave_waiting, `${h.leave_waiting} 张请假等你审核`, "#/hr/todo", true],
    [!!h.corrections_waiting, `${h.corrections_waiting} 张补卡等你审核`, "#/attendance/corrections", true],
    [!!h.my_overdue, `${h.my_overdue} 个任务已逾期`, "#/tasks", true],
    [!!h.wh_variances, `${h.wh_variances} 项盘点差异等你审核`, "#/warehouse/review", true],
    [!!h.wh_moves_pending, `${h.wh_moves_pending} 笔搬动还没输入 AutoCount`, "#/warehouse/moves", false],
    // 开单部（与仓库可审批）：点完货的厂家到货，要在 AutoCount 开进货单（GRN）
    [!!h.grn_pending, `${h.grn_pending} 批厂家货待开进货单（GRN）`, "#/warehouse/grn", false],
    [h.wh_counted_today === 0, "今天还没盘点", "#/warehouse/count", false],
    [!!h.po_arriving, `${h.po_arriving} 张 PO 三天内到货，准备收货`, "#/purchasing", false],
    // 厂家已出货（确认了厂家 DO）、ETA 在三天内或已过、还没点货：订货或仓库可编辑的人才有
    [!!h.do_to_count, `${h.do_to_count} 批厂家货三天内到（含已过 ETA），到了要点货`, "#/purchasing/receive", false],
    // 订货部：厂家到货草稿开了超过 24 小时还没确认（SOP 第 5 步卡住）
    [!!h.do_draft_stale, `${h.do_draft_stale} 张厂家到货草稿超过 24 小时还没确认`, "#/purchasing/do", true],
    // 已确认的厂家到货还没填 ETA（分店看到「未填」）：订货可编辑的人（采购）补
    [!!h.do_no_eta, `${h.do_no_eta} 批厂家到货还没填 ETA`, "#/purchasing/do", false],
    // 订货部：PO 开了很久（中国货 30 天、本地货 7 天）还没有 ETA、也还没有厂家到货
    [!!h.po_no_eta, `${h.po_no_eta} 张 PO 还没 ETA，要问厂家`, "#/purchasing/noeta", false],
    // 采购 / 管理层：还没决定的少发 / 缺零件 + 7 天内新记的厂家问题（仓库点货记的会出现在这里）
    [!!h.po_issues_todo, `${h.po_issues_todo} 笔厂家问题等处理`, "#/purchasing/issues", false],
    [!!h.po_overdue, `${h.po_overdue} 张 PO 已过预计到货日，要跟进`, "#/purchasing", true],
    [!!h.hr_gaps, `${h.hr_gaps} 位员工资料没填齐`, "#/hr/gaps", false],
    [h.holidays_ahead === 0, "接下来 60 天没有设公共假日", "#/attendance/settings", true],
  ];
  const list = items.filter(([on]) => on);
  return (
    <section className="card">
      <h2>今天要做</h2>
      {list.length === 0 ? <p className="muted">没有要处理的事。</p> : (
        <ul className="list">
          {list.map(([, text, href, urgent]) => (
            <li key={text} className="click" onClick={() => { location.hash = href; }}>
              <span className={urgent ? "late" : ""}>{text}</span><span className="go">→</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function HomePage({ me }: { me: Me }) {
  const [home, setHome] = useState<(Home & { att?: HomeAtt | null; corrections_waiting?: number; leave_waiting?: number; my_pending_leave?: number;
    wh_moves_pending?: number | null; wh_variances?: number | null; wh_counted_today?: number | null;
    po_arriving?: number | null; hr_gaps?: number | null; holidays_ahead?: number | null }) | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState("");
  const [profileMissing, setProfileMissing] = useState<string[]>([]);   // 自己的档案还缺什么（我的资料卡片提醒用）
  const [wh, setWh] = useState<WhHome | null>(null);   // 仓库：今天要拣的 DO、指派给我的盘点单、货架对不上（2026-10-15）

  useEffect(() => {
    api.home().then(setHome).catch((e: Error) => setError(e.message));
    api.profile().then((p) => setProfileMissing(p.missing)).catch(() => {});
    if (can(me, "tasks", "view")) api.tasks("mine", "open").then((t) => setTasks(t.slice(0, 8))).catch(() => {});
    if (can(me, "warehouse", "view")) whHome().then(setWh).catch(() => {});
  }, [me]);

  const hour = new Date().getHours();
  const hello = hour < 12 ? "早安" : hour < 18 ? "午安" : "晚安";
  const modules = me.modules.filter((m) => m.level !== "none" && m.key !== "dashboard");

  return (
    <>
      <h1>{hello}，{me.staff.name}</h1>
      <ErrorBox error={error} />
      <InstallHint />
      {home?.att && <AttCard a={home.att} />}
      <DeliveryHomeCard me={me} />
      <CustomersHomeCard me={me} />
      {home && <Todo h={home} />}
      <a className="card att-home" href="#/mypay"><span><b>📄 我的工资单</b><br /><span className="muted">HR 发布后在这里看</span></span><span className="go">看 →</span></a>
      <a className={"card att-home" + (profileMissing.length ? " warn" : "")} href="#/profile">
        <span><b>👤 我的资料</b><br />
          {profileMissing.length ? <span className="late">{missingText(profileMissing)}</span>
            : <span className="muted">身份证、紧急联络人、银行户口</span>}</span>
        <span className="go">{profileMissing.length ? "去填 →" : "看 →"}</span>
      </a>
      {home && (
        <div className="kpis">
          <a className="kpi" href="#/tasks"><b>{home.my_open_tasks}</b><span>我的待办任务</span></a>
          <a className={"kpi" + (home.my_overdue ? " warn" : "")} href="#/tasks"><b>{home.my_overdue}</b><span>已逾期</span></a>
          <a className={"kpi" + (home.approvals_waiting ? " warn" : "")} href="#/approvals"><b>{home.approvals_waiting}</b><span>等我审批</span></a>
          <a className="kpi" href="#/approvals"><b>{home.my_pending_requests}</b><span>我的申请（待批）</span></a>
          {!!home.corrections_waiting && (
            <a className="kpi warn" href="#/attendance/corrections"><b>{home.corrections_waiting}</b><span>补卡等我审核</span></a>
          )}
          {!!home.leave_waiting && (
            <a className="kpi warn" href="#/hr/todo"><b>{home.leave_waiting}</b><span>请假等我审核</span></a>
          )}
          {!!home.my_pending_leave && (
            <a className="kpi" href="#/leave"><b>{home.my_pending_leave}</b><span>我的请假（审核中）</span></a>
          )}
          {!!home.wh_variances && (
            <a className="kpi warn" href="#/warehouse/review"><b>{home.wh_variances}</b><span>盘点差异待审核</span></a>
          )}
          {!!home.wh_moves_pending && (
            <a className="kpi warn" href="#/warehouse/moves"><b>{home.wh_moves_pending}</b><span>搬动待输入 AutoCount</span></a>
          )}
          {!!wh?.picks_left && (
            <a className="kpi warn" href="#/warehouse/pick/today"><b>{wh.picks_left}</b><span>要拣的 DO（今天 / 明天送）</span></a>
          )}
          {wh?.sheets.map((sh) => (
            <a key={sh.id} className={"kpi" + (sh.overdue ? " warn" : "")} href={`#/warehouse/count/${sh.id}`}>
              <b>{sh.left}</b><span>{`盘点单：${sh.title}（还有 ${sh.left} 项）`}</span>
            </a>
          ))}
          {!!wh?.pick_check && (
            <a className="kpi warn" href="#/warehouse/gate/check"><b>{wh.pick_check}</b><span>拣好的 DO 等核对</span></a>
          )}
          {!!wh?.recv_review && (
            <a className="kpi warn" href="#/warehouse/gate/recv"><b>{wh.recv_review}</b><span>点货差异等复核</span></a>
          )}
          {!!wh?.putaway_late && (
            <a className="kpi warn" href="#/warehouse/putaway"><b>{wh.putaway_late}</b><span>进货超过期限还没上架</span></a>
          )}
          {!!wh?.bins_over && (
            <a className="kpi warn" href="#/warehouse/bins/recon?f=over"><b>{wh.bins_over}</b><span>货架比系统多</span></a>
          )}
          {home.wh_counted_today != null && (
            <a className="kpi" href="#/warehouse/count"><b>{home.wh_counted_today}</b><span>我今天盘了几件</span></a>
          )}
          {home.po_overdue != null && (
            <a className={"kpi" + (home.po_overdue ? " warn" : "")} href="#/purchasing"><b>{home.po_overdue}</b><span>PO 已过预计到货日</span></a>
          )}
          <a className="kpi" href="#/tasks"><b>{home.dept_open_tasks}</b><span>{me.staff.department_name}部门未完成</span></a>
        </div>
      )}

      {tasks.length > 0 && (
        <section className="card">
          <h2>我的待办</h2>
          <ul className="list">
            {tasks.map((t) => (
              <li key={t.id}>
                <a href={`#/tasks/${t.id}`}>{t.title}</a>
                <span className={"due" + (t.overdue ? " late" : "")}>{t.due_date ? `期限 ${t.due_date}` : ""}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <h2 className="section-title">模块</h2>
      <div className="tiles">
        {modules.map((m) => (
          <a key={m.key} className={"tile" + (m.ready ? "" : " planned")}
             href={moduleHref(m)}>
            <b>{m.name}</b>
            <span>{m.description}</span>
            <small>{m.ready ? "已上线" : `第 ${m.phase} 阶段 · 规划中`}</small>
          </a>
        ))}
      </div>
    </>
  );
}
