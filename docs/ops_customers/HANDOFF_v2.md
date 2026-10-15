# 顾客资料第二版 → HomeWorks 营运系统（交接说明）

**给谁看**：把这个 ZIP 上传到「员工多部门功能开发」（营运系统 `portal/`、分支 `claude/gifted-faraday-b16op8`、Vercel 专案
`homeworks-ops`）那个 Claude 对话，跟它说：「照 HANDOFF_v2.md 把顾客资料第二版合并进来、测试、部署」。

使用者（Leslie）的原话：「这个还有什么可以优化的，你还可以怎么让我更能锁着老顾客？」。看了数据后选了三项：
**新客 30 天回访**、**首页「今天要跟进」+ 员工排行**、**登记送延长保修**。

---

## 1. 为什么是这三项（数据）

- 会回来买第二次的顾客，一半在第一次买之后 22 天内回来、81% 在 90 天内；过了 90 天就很难回来。所以新客第 7 天、第 21 天各提醒店员联络一次。
- 第一版（10/14 上线）的跟进提醒只在「顾客资料」里面，店员不点进去就看不到 → 首页加一张卡「今天要跟进 N 位」。
- 第二、三版上线后补资料、标「同意收促销」的人很少 → 「报告」加员工排行（谁登记、联络、取得同意最多）与业务员新客回头率；
  顾客扫码登记送「延长保修」当诱因。

## 2. 改了什么

| 地方 | 内容 |
|---|---|
| 首页 | 新卡片「☏ 今天要跟进 N 位」（约好联络 / 报价没成交 / 生日 / 新客回访 / 装修进度 / 潜在客 各几位）+「这个月你联络了 N 位、补资料 N 位」。点了到 `#/customers/follow`。没有顾客资料权限的人不显示（`ops_cust_home()` 回 null）。 |
| 顾客资料 → 跟进 | 跟进提醒改由资料库算（`bi_customer_followups`，首页与这页同一套规则），多「新客回访」：只买过一次的新客第 7 天、第 21 天各一次，45 天后不追，刚到第 7 / 21 天的排前面。上面多「两间门市 / HQ / JB」切换，预设员工自己的分店；读取失败有「重试」。 |
| 顾客资料 → 报告 | 最上面多「员工排行」（这个月 / 上个月：联络、补资料、取得同意，都算「几位顾客」，同一位按很多次只算一次；只补送货地址的不算，送货页的物流同事也会补地址）与「业务员新客回头率」（3～6 个月前的新客，90 天内回来买第二次的比例）。 |
| 一位顾客 | 「登记延长保修（+N 个月）」按钮（有电话、可编辑以上、设定有开才出现）；登记后显示「🛡️ 已登记延长保修 +N 个月……X 以后买的 Hemos 产品都算」，购买历史里起算日以后、**有 Hemos 产品**的单标「🛡️ +N 个月」，点开明细 Hemos 那几行也标 🛡️。 |
| 顾客资料 → 设定 | 新卡片「登记送延长保修」：送几个月（**0 = 不送，预设 0**）、登记前几天内的购买也算（预设 90）。只有管理员能改；已登记的顾客以登记当时的月数与起算日为准。 |
| BI 顾客扫码登记页 `/join.html` | 设定有开时，表单上方多「🛡️ 登记即享 Hemos 产品保修延长 N 个月 / 登记前 N 天内与之后在 HomeWorks 买的 Hemos 产品都适用」，完成页照资料库实际记下的月数显示。这部分在 BI 那边（`homeworks-bi`），由使用者在 SERVER 部署，**营运系统这边不用管**。 |

## 3. 资料库：正式环境已套

- `portal/supabase/migrations/20261018_ops_customers_v2.sql` —— **已套用**（Supabase migration `ops_customers_v2` + `ops_customers_v2_new_order`
  + `ops_customers_v2_registers_no_address`，后两个是审查后的小修正，内容已并进这个档；
  里面 `bi_customer_merge` 那段含删除语句，Supabase 连接器会卡在确认，由使用者在 Supabase SQL Editor 贴上执行）。可重复套用；资料仍在 BI 的
  `bi.customer_*`（不搬家）。**营运系统这边不用再套任何 migration。**
  - `bi.customer_profile` 加 `warranty_at / warranty_months / warranty_by / warranty_from`（第一次登记时记下；之后改设定不影响）；
    `bi.customer_settings` 加 `warranty_months`（0 = 不送）/ `warranty_back_days`。
  - 重建、跟正式环境原本一字不差只多一点的：`bi.customer_signup_apply`（送保修期间第一次登记就记下保修）、`bi_customer_signup` 9 参数版（多回传实际记下的
    `warranty_months`）、`bi_customer_merge`（电邮与保修一起搬过去，两边都有保修留比较早的）、`bi_customer`（购买明细每行多 `brand` = AutoCount ItemType）。
  - 新函数（开头一律 `bi.crm_require`，读取的第二个参数 `true`，所以「只看」的人也能叫）：
    `bi_customer_followups(p_store)`（读）、`bi_customer_staff_board(p_from, p_to)`（读）、`ops_cust_home()`（首页卡片；没权限回 null）、
    `bi_customer_warranty_register(p_member)`（可编辑）、`bi_customer_set_warranty(p_months, p_back_days)`（管理员）、
    `bi_customer_signup_offer()`（anon 也能读，给扫码登记页）、`bi.customer_log_registers(changes)`（内部用）。
  - 因为预设 0 个月，套用后旧前端的行为完全不变；新前端部署后才看得到新东西。
- 跟进提醒在正式资料库约 2 秒（8,000 位顾客现算），前端是先显示页面再载入提醒；员工排行约 0.8 秒、一位顾客约 0.8 秒。

## 4. 合并步骤（给营运系统那边的 Claude）

ZIP 里有：`customers-v2.patch`（`git am` 用，以 `91dfc0f 登记搬动：扫码框移出登记表单，Enter 不会整页重新载入` 为底）、`files/`（同样的改动、
完整档案，路径照 repo 根目录；改到的旧档是以 `91dfc0f` 为底的完整版，你那边若已经改过，**不要直接覆盖**，照下面补那几行）。

1. 在 `claude/gifted-faraday-b16op8` 最新版上：`git am customers-v2.patch`。冲突时以你那边为准，照 `files/` 里的完整档手动补。
2. 资料库测试：`PGHOST=… PGPORT=… PGUSER=postgres sh portal/supabase/tests/run.sh`（最后印 `cust_test ok`、`cust2_test ok`）。
3. 前端：`cd portal && npm run build`。
4. 部署到 `homeworks-ops`（照 `portal/README.md` 的「部署」）。新档：`src/cust/HomeCard.tsx`；改到的档：`src/App.tsx`、`src/pages/Home.tsx`、
   `src/pages/Customers.tsx`、`src/cust-api.ts`、`src/cust.css`、`src/cust/Follow.tsx`、`src/cust/Panel.tsx`、`src/cust/Reports.tsx`、
   `src/cust/SettingsTab.tsx`、`src/cust/dict.ts`。每个档都 ≤ 35 KB（最大 `cust/dict.ts` 22 KB）。
5. 部署后验证：门市员工首页看到「今天要跟进」卡片；顾客资料 → 跟进 有 HQ / JB 切换与「新客第 N 天」；报告最上面有员工排行；
   设定分页有「登记送延长保修」卡片（显示 0）。**不要为了测试去改延长保修的月数**：一改，BI 的公开扫码登记页马上会对顾客写「登记即享保修延长」，
   扫码的真顾客也会被记下保修。送不送、送几个月由使用者自己决定（保修按钮与 🛡️ 标记已用模拟资料测过，见第 6 节）。

### 改到的旧档（patch 冲突时手动补）

- `portal/src/App.tsx`：`<Customers sub={arg} arg={arg2} />` 改成 `<Customers me={me} sub={arg} arg={arg2} />`（跟进的分店预设用员工自己的分店）。
- `portal/src/pages/Home.tsx`：`import { CustomersHomeCard } from "../cust/HomeCard";`，在 `<DeliveryHomeCard … />` 后面放 `<CustomersHomeCard me={me} />`。
- `portal/supabase/tests/run.sh`：`cust_test.sql` 后面加一行跑 `cust2_test.sql`。
- `portal/supabase/tests/stub_supabase.sql`：「顾客资料」段的 `bi_customers()` 换成完整栏位版（读 `bi.stub_customer_row`），多几张 stub 表
  （`customer_profile_log`、`customer_doc`、`customer_signup`、`customer_alias`、`customer_campaign_member`、`customer_quote`）与栏位。
- `CLAUDE.md`：「顾客资料」那段最后加「第二版」一段。

## 5. 上线后请使用者做的事

1. 决定送不送延长保修、送几个月：营运系统 → 顾客资料 → 设定 →「登记送延长保修」（只有管理员能改）。填了之后扫码登记页才会出现那行字。
2. 门市同事每天开营运系统首页就看到「今天要跟进 N 位」，点进去照提醒 WhatsApp / 按「已联络」。
3. 每月初在「报告」看员工排行与业务员新客回头率。

## 6. 验证纪录（交出前做过的）

- **两轮多人审查**。第一轮 3 个角度（资料库、前端、手机 / 英文版面），每个问题再由另一位试着推翻，确认的都修了：合并重复顾客会把保修（和电邮）
  一起删掉 → 合并时搬过去；保修起算日原本用「现在的」设定推算 → 登记当时记下 `warranty_from`；保修标在每张单 → 只标有 Hemos 产品的单；
  扫码完成页写的是页面载入时的月数 → 照资料库实际记下的；员工排行按几次算几次 → 算几位顾客，先按「已联络」后补资料的也算补资料；只有报价的顾客
  两间门市都列 → 照报价单的门市；新客清单照电话号码排 → 刚到第 7 / 21 天的在前；买一次后退货被当成回头客 → 不算；跟进清单旧回应盖掉新回应、
  切门市错误不清、没有重试；英文按钮 / 表头在手机横向超出；中文统计句意思写错。第二轮只审第一轮的修正，前端没有问题；资料库确认 2 个小问题：
  物流同事在送货页补地址被算成「补资料」→ 地址不算；第一天开两张以上的单、之后又退货的新客会被当成回来过 → **没改**（一年约 3 位，要分得出来
  得再扫一次全部单据、清单慢约 0.8 秒），写在 migration 的说明里。
- 本机 PostgreSQL：`run.sh` 全部通过（18 组，含新的 `cust2_test.sql`：跟进规则与排序、门市、首页人数、员工排行去重、保修开关 / 起算日 / 第一次为准 /
  只有管理员能改、扫码登记回传月数、合并搬保修与电邮、一位顾客的品牌、各角色与 anon 权限）。在 `91dfc0f` 上 `git am` 无冲突、`npm run build` 通过。
- Playwright（模拟资料，1280 / 390px，中文与 EN）：首页卡片、跟进（HQ / JB 切换、慢回应不盖掉新的、失败重试）、员工排行、保修按钮与 🛡️（只有 Hemos 的单、
  用登记当时的起算日）、设定卡片、只看的人没有按钮；第一版的各角色测试（管理员 / 可审批 / 可编辑 / 只看，中英文）照样通过；390px 没有横向卷动。
- 正式资料库（写入的测试都在交易里回滚）：跟进提醒 406 位、约 2.2 秒（新客 395、报价 10 只在 HQ、潜在客 1）；JB 320 位、HQ 87 位；员工排行 0.8 秒；
  一位顾客 0.8 秒、明细有 `brand`；开 12 个月 / 90 天时店员登记与扫码登记都记下起算日、扫码回传月数、再扫一次照第一次；送货部帐号 `ops_cust_home()` = null；
  函数授权与原本一致（`customer_signup_apply`、`customer_log_registers` 一般帐号叫不到，`bi_customer_signup_offer` 开给 anon）。延长保修设定仍是 0。
