// 介面用语（九）：2026-10-10 对照 AttendX 补的四项 —— 离职日（最后上班日）、补卡证明必填、年假到职满 3 个月、员工档案 / 我的资料。
// 键 = 画面上整段中文（去头尾空白）。资料库错误讯息在 i18n-dict-db.ts，带日期 / 数字 / 名字的句子在 i18n-patterns.ts。
export const DICT_PROFILE: Record<string, string> = {
  // 离职日（最后上班日）
  "最后上班日（选填，要离职才填）": "Last working day (optional; only when leaving)",
  "过了最后上班日（隔天 00:00 起）就进不了营运系统，系统也会自动停用；出勤月报、薪资照样算到这一天。和薪资资料的「离职日」是同一个日期。如果他也能看 BI 网页，要另外请管理员从 BI 名单移除。":
    "After the last working day (from 00:00 the next day) they can't get into the operations system and the account is deactivated automatically; attendance reports and payroll still count up to that day. It's the same date as \"Leaving date\" in pay details. If they can also see the BI site, ask an admin to remove them from the BI list separately.",
  "管理员的最后上班日只能由另一位管理员在「员工与权限」设定。":
    "An admin's last working day can only be set by another admin in \"Staff & Access\".",
  "已离职": "Left",
  "· 已停用": "· inactive",              // 薪资资料清单（原本漏翻）
  "过了这天（隔天 00:00 起）就进不了营运系统，系统也会自动停用；出勤、薪资照样算到这一天。":
    "After this day (from 00:00 the next day) they can't get into the operations system and are deactivated automatically; attendance and payroll still count up to that day.",
  "复职后会清掉这个最后上班日。有薪资资料的人，要先做好离职那个月的薪资才能复职；如果只是误按停用（他其实没离职），把上面的日期清空再储存。":
    "Re-activating clears this last working day. If they have pay details, the payroll for the month they left must be done before they can be re-activated; if they were only deactivated by mistake (they never left), clear the date above and save.",
  "自己的最后上班日要请另一位 HR 或管理员设定。": "Your own last working day has to be set by another HR person or an admin.",
  "（已停用的员工）": "(inactive staff member)",
  "取消在职 = 今天起停用：最后上班日会改成今天。": "Unticking \"Active\" deactivates them from today: the last working day becomes today.",
  "这个人也在 BI 名单：离职 / 停用只挡营运系统，BI 网页要另外从 BI 名单移除。":
    "This person is also on the BI list: leaving / deactivation only blocks the operations system, so remove them from the BI list separately.",
  "BI 名单要另外移除": "Remove from BI list separately",
  "取消「在职」的话，最后上班日不能晚于今天。": "If you untick \"Active\", the last working day can't be later than today.",
  "离职日 = 最后上班日（选填）": "Leaving date = last working day (optional)",
  "和「打卡 → 设定」的最后上班日是同一个日期：过了这天员工就进不了营运系统（也看不到「我的工资单」，最后一张请用 WhatsApp 发），隔天自动停用；已经停用的人只有管理员能在「员工与权限」复职。":
    "Same date as the last working day in \"Attendance → Settings\": after this day the staff member can't get into the operations system (including \"My payslips\" — send the final one by WhatsApp) and is deactivated the next day; once deactivated, only an admin can re-activate them in \"Staff & Access\".",
  // 补卡证明
  "证明（必填）": "Evidence (required)",
  "照片或 PDF，例：WhatsApp 截图、送货单、客户签收单。没有证明的补卡送不出去。":
    "Photo or PDF, e.g. a WhatsApp screenshot, delivery order or customer's signed slip. Corrections without evidence can't be sent.",
  // 假别：到职满几个月
  "到职满几个月才能请（0 = 不限）": "Months of service before it can be taken (0 = no limit)",
  "年假照样按到职月数累积，只是到职满这个月数之前不能请；没填到职日的员工先不挡。":
    "Annual leave still accrues by months of service; it just can't be taken before this many months. Staff without a join date aren't blocked for now.",
  "没满这个月数（或没填到职日）的员工不能请这个假别（例：陪产假要服务满 12 个月）。":
    "Staff with less service than this (or no join date) can't take this leave (e.g. paternity leave needs 12 months).",
  // 我的资料 / 员工档案
  "我的资料": "My details",
  "👤 我的资料": "👤 My details",
  "身份证、紧急联络人、银行户口": "IC, emergency contact, bank account",
  "去填 →": "Fill in →",
  "办 EPF / SOCSO、发薪水、有紧急状况时联络家人要用。只有你自己和 HR 看得到；银行户口只有你和管理薪资的人看得到。":
    "Used for EPF / SOCSO, salary payment and contacting your family in an emergency. Only you and HR can see it; your bank account is visible only to you and the people who manage payroll.",
  "名字、手机、到职日要改请找 HR。": "To change your name, phone or join date, ask HR.",
  "身份证": "IC",
  "证件": "ID type",
  "MyKad（身份证）": "MyKad (IC)",
  "护照（外籍员工）": "Passport (foreign staff)",
  "身份证号码": "IC number",
  "护照号码": "Passport number",
  "护照": "Passport",
  "证件号码": "IC / passport no.",
  "生日": "Date of birth",
  "生日从身份证号码自动带入，不对可以改。": "Date of birth is filled in from the IC number; change it if it's wrong.",
  "住家地址": "Home address",
  "例：No. 12, Jalan Bakawali 3, Taman Johor Jaya, 81100 Johor Bahru": "e.g. No. 12, Jalan Bakawali 3, Taman Johor Jaya, 81100 Johor Bahru",
  "紧急联络人": "Emergency contact",
  "关系": "Relationship",
  "例：太太、父亲": "e.g. wife, father",
  "银行户口": "Bank account",
  "银行": "Bank",
  "户口号码": "Account number",
  "发薪水用。只有你自己和管理薪资的人看得到。": "Used for salary payment. Only you and the people who manage payroll can see it.",
  "只有本人和管理薪资的人看得到。": "Only the staff member and the people who manage payroll can see this.",
  "你只能查看这位员工的资料，要改请找有人事「可编辑」权限的人。":
    "You can only view this staff member's details. Ask someone with HR \"edit\" access to change them.",
  "只看没填齐的": "Only incomplete",
  "档案": "Record",
  "齐了": "Complete",
  "员工也可以在首页「我的资料」自己填。证件号码、地址、银行户口只在这里和员工自己的页面出现，不会出现在其他清单。":
    "Staff can also fill this in themselves under \"My details\" on the home page. IC numbers, addresses and bank accounts only appear here and on the staff member's own page, never in other lists.",
  "银行户口只有本人和管理薪资的人看得到，这里不会显示。":
    "Bank accounts are only visible to the staff member and the people who manage payroll, so they aren't shown here.",
  "你有人事「只看」权限：可以看，不能改。": "You have HR \"view\" access: you can look but not change anything.",
  "证件号码、紧急联络人、银行户口在「员工档案」补；员工也可以在首页「我的资料」自己填。":
    "Fill in IC / passport numbers, emergency contacts and bank accounts under \"Staff records\"; staff can also fill them in themselves under \"My details\" on the home page.",
};
