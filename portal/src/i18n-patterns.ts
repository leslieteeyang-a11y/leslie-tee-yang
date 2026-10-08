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
  // PO 修改纪录：「状态→已出货，ETA→2026-10-15，备注：…」
  [/^(状态→|ETA→|清掉 ETA|挂上货柜|拿掉货柜|备注：)/, (m, t) =>
    (m.input ?? "").split("，").map((part) => {
      if (part.startsWith("状态→")) return `status → ${t(part.slice(3))}`;
      if (part.startsWith("ETA→")) return `ETA → ${part.slice(4)}`;
      if (part.startsWith("备注：")) return `remark: ${part.slice(3)}`;
      return ({ "清掉 ETA": "ETA cleared", 挂上货柜: "added to container", 拿掉货柜: "removed from container" } as Record<string, string>)[part] ?? part;
    }).join(", ")],
];
