// 带数字 / 名称的句子：用格式比对后组出英文。t() 可以翻格式里夹带的已知用语（例：部门名称、状态）。
type T = (s: string) => string;
export const PATTERNS: [RegExp, (m: RegExpMatchArray, t: T) => string][] = [
  [/^今天 (\d\d:\d\d)$/, (m) => `today ${m[1]}`],
  [/^昨天 (\d\d:\d\d)$/, (m) => `yesterday ${m[1]}`],
  [/^期限 (.+)$/, (m) => `Due ${m[1]}`],
  [/^第 (\d+) 阶段 · 规划中$/, (m) => `Phase ${m[1]} · planned`],
  [/^第$/, () => "Phase"],
  [/^(.+)部门$/, (m, t) => `${t(m[1])} dept.`],
  [/^修改：(.+)$/, (m) => `Edit: ${m[1]}`],
  [/^修改货柜 (.+)$/, (m) => `Edit container ${m[1]}`],
  [/^重设密码：(.+)$/, (m) => `Reset password: ${m[1]}`],
  [/^开通登入：(.+)$/, (m) => `Set up login: ${m[1]}`],
  [/^个人例外 (\d+)$/, (m) => `${m[1]} override(s)`],
  [/^批量更新 (\d+) 张 PO$/, (m) => `Bulk update ${m[1]} POs`],
  [/^更新 (.+)$/, (m) => `Update ${m[1]}`],
  [/^· 未到货金额 (.+)$/, (m) => `· open amount ${m[1]}`],
  [/^选取 (.+)$/, (m) => `Select ${m[1]}`],
  [/^· 柜 (.+)$/, (m) => `· container ${m[1]}`],
  [/^· 出货 (.+)$/, (m) => `· ships ${m[1]}`],
  [/^登入失败：(.+)$/, (m) => `Login failed: ${m[1]}`],
  [/^改密码失败：(.+)$/, (m) => `Password change failed: ${m[1]}`],
  [/^网址：(.+)\nEmail：(.+)\n密码：(.+)$/, (m) => `Website: ${m[1]}\nEmail: ${m[2]}\nPassword: ${m[3]}`],
  // 数据库错误讯息里夹带名称的
  [/^你没有「(.+)」模块的(查看|编辑|审批)权限，请找管理员开通。$/,
    (m, t) => `You don't have ${({ 查看: "view", 编辑: "edit", 审批: "approve" } as Record<string, string>)[m[2]]} access to "${t(m[1])}". Ask an admin.`],
  [/^这张申请已经处理过了（(.+)）。$/, (m) => `This request has already been decided (${m[1]}).`],
  [/^找不到 PO (.+)。$/, (m) => `PO ${m[1]} not found.`],
  [/^未知的决定：(.+)$/, (m) => `Unknown decision: ${m[1]}`],
  [/^确认身分失败，请重新整理后再试一次（(.+)）$/, (m) => `Couldn't confirm who you are — refresh and try again (${m[1]})`],
  // 2026-10-10：最后上班日、假别月数、员工档案（含 20261010_ops_profile_offboard 的错误讯息）
  [/^最后上班日（(.+)）不能早于到职日（(.+)）。$/, (m) => `The last working day (${m[1]}) can't be before the join date (${m[2]}).`],
  [/^到职满 (\d+) 个月（(.+)）后才能请(.+?)。?$/, (m, t) => `${t(m[3])} can be taken from ${m[2]} (after ${m[1]} months of service).`],
  [/^请假日期不能晚于最后上班日（(.+)）。$/, (m) => `Leave can't go past the last working day (${m[1]}).`],
  [/^补卡日期不能晚于最后上班日（(.+)）。$/, (m) => `A correction can't be for a day after the last working day (${m[1]}).`],
  [/^这位员工已停用，最后上班日不能晚于今天（(.+)）。要复职请管理员在「员工与权限」勾「在职」。$/, (m) =>
    `This staff member is inactive, so the last working day can't be later than today (${m[1]}). To re-activate, an admin ticks "Active" in Staff & Access.`],
  [/^(.+)（最后上班日 (\d{4}-\d\d-\d\d)）(\d{4}-\d\d) 的薪资还没做：复职会清掉最后上班日，那个月的薪资、出勤就不会只算到离职那天。请先在「薪资」做好那个月再复职；只是误按停用的话，先把最后上班日清空再复职。$/, (m) =>
    `${m[1]} (last working day ${m[2]}): payroll for ${m[3]} hasn't been done. Re-activating clears the last working day, so that month's pay and attendance would no longer stop at the day they left. Do that month's payroll in Payroll first, then re-activate; if they were only deactivated by mistake, clear the last working day first, then re-activate.`],
  [/^(\d{4}-\d\d-\d\d) 已经过了：存了之后 (.+) 马上进不了营运系统，今晚会自动停用（只有管理员能在「员工与权限」复职）。确定？$/, (m) =>
    `${m[1]} has already passed: once saved, ${m[2]} is locked out of the operations system immediately and deactivated tonight (only an admin can re-activate them in Staff & Access). Continue?`],
  [/^「(.+)」太长了（最多 (\d+) 个字）。$/, (m, t) => `"${t(m[1])}" is too long (max ${m[2]} characters).`],
  [/^最后上班日 (.+)$/, (m) => `Last day ${m[1]}`],
  [/^· 离职 (\d{4}-\d\d-\d\d)$/, (m) => `· left ${m[1]}`],
  [/^· 到职满 (\d+) 个月$/, (m) => `· after ${m[1]} months of service`],
  [/^还没填：(.+)$/, (m, t) => `Missing: ${m[1].split("、").map(t).join(", ")}`],
  [/^最后更新 (.+)$/, (m) => `Last updated ${m[1]}`],
  [/^(\d+) 位员工的档案没填齐$/, (m) => `${m[1]} staff record(s) incomplete`],
  [/^已储存 (.+) 的档案。$/, (m) => `Saved ${m[1]}'s record.`],
  [/^员工档案：(.+)$/, (m) => `Staff record: ${m[1]}`],
  [/^手机 (.+)$/, (m) => `Phone ${m[1]}`],
  // PO 修改纪录：「状态→已出货，ETA→2026-10-15，备注：…」
  [/^(状态→|ETA→|清掉 ETA|挂上货柜|拿掉货柜|备注：)/, (m, t) =>
    (m.input ?? "").split("，").map((part) => {
      if (part.startsWith("状态→")) return `status → ${t(part.slice(3))}`;
      if (part.startsWith("ETA→")) return `ETA → ${part.slice(4)}`;
      if (part.startsWith("备注：")) return `remark: ${part.slice(3)}`;
      return ({ "清掉 ETA": "ETA cleared", 挂上货柜: "added to container", 拿掉货柜: "removed from container" } as Record<string, string>)[part] ?? part;
    }).join(", ")],
];
