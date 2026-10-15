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
| 首页 | 新卡片「☏ 今天要跟进 N 位」（约好联络 / 报价没成交 / 生日 / 新客回访 / 装修进度 / 潜在客 各几位）+「这个月我联络了 N 位、登记了 N 位」。点了到 `#/customers/follow`。没有顾客资料权限的人不显示（`ops_cust_home()` 回 null）。 |
| 顾客资料 → 跟进 | 跟进提醒改由资料库算（`bi_customer_followups`，首页与这页同一套规则），多「新客回访」：第 7 天、第 21 天，45 天后不追。上面多「两间门市 / HQ / JB」切换，预设员工自己的分店。 |
| 顾客资料 → 报告 | 最上面多「员工排行」（这个月 / 上个月：联络、新建档、取得同意）与「业务员新客回头率」（3～6 个月前的新客，90 天内回来买第二次的比例）。 |
| 一位顾客 | 「登记延长保修（+N 个月）」按钮（有电话、可编辑以上、设定有开才出现）；登记后显示「✓ 已登记延长保修 +N 个月」，购买历史里登记前 N 天内与之后的单标「保修 +N 个月」。 |
| 顾客资料 → 设定 | 新卡片「登记送延长保修」：送几个月（**0 = 不送，预设 0**）、登记前几天内的购买也算（预设 90）。只有管理员能改。 |
| BI 顾客扫码登记页 `/join.html` | 设定有开时，表单上方多一行「登记会员，购买的产品延长保修 N 个月」。这部分在 BI 那边（`homeworks-bi`），由使用者在 SERVER 部署，**营运系统这边不用管**。 |

## 3. 资料库：正式环境已套

- `portal/supabase/migrations/20261018_ops_customers_v2.sql` —— **已用 Supabase MCP 套用**（migration 名称 `ops_customers_v2`）。
  可重复套用，不含 DROP / DELETE；资料仍在 BI 的 `bi.customer_*`（不搬家）。
  - `bi.customer_profile` 加 `warranty_at / warranty_months / warranty_by`；`bi.customer_settings` 加 `warranty_months`（0 = 不送）/ `warranty_back_days`。
  - `bi.customer_signup_apply` 重建：跟正式环境原本一字不差，只多「送保修期间第一次登记就记下保修」。
  - 新函数（开头一律 `bi.crm_require`，读取的第二个参数 `true`，所以「只看」的人也能叫）：
    `bi_customer_followups(p_store)`（读）、`bi_customer_staff_board(p_from, p_to)`（读）、`ops_cust_home()`（首页卡片；没权限回 null）、
    `bi_customer_warranty_register(p_member)`（可编辑）、`bi_customer_set_warranty(p_months, p_back_days)`（管理员）、
    `bi_customer_signup_offer()`（anon 也能读，给扫码登记页）。
  - 因为预设 0 个月，套用后旧前端的行为完全不变；新前端部署后才看得到新东西。**不需要再套别的 migration。**
- 跟进提醒在正式资料库约 2～3 秒（8,000 位顾客现算），前端是先显示页面再载入提醒。

## 4. 合并步骤（给营运系统那边的 Claude）

ZIP 里有：`customers-v2.patch`（`git am` 用，以 `BASE_COMMIT` 为底）、`files/`（同样的改动、完整档案，路径照 repo 根目录）。

1. 在 `claude/gifted-faraday-b16op8` 最新版上：`git am customers-v2.patch`。冲突时以你那边为准，照 `files/` 里的完整档手动补。
2. 资料库测试：`PGHOST=… PGPORT=… PGUSER=postgres sh portal/supabase/tests/run.sh`（最后印 `cust_test ok`、`cust2_test ok`）。
3. 前端：`cd portal && npm run build`。
4. 部署到 `homeworks-ops`（照 `portal/README.md` 的「部署」）。新档：`src/cust/HomeCard.tsx`；改到的档：`src/App.tsx`、`src/pages/Home.tsx`、
   `src/pages/Customers.tsx`、`src/cust-api.ts`、`src/cust/Follow.tsx`、`src/cust/Panel.tsx`、`src/cust/Reports.tsx`、`src/cust/SettingsTab.tsx`、
   `src/cust/dict.ts`。每个档都 ≤ 35 KB。
5. 部署后验证：门市员工首页看到「今天要跟进」卡片；顾客资料 → 跟进 有 HQ / JB 切换与「新客第 N 天」；报告最上面有员工排行；
   管理员在设定把延长保修设成例如 12 个月后，一位有电话的顾客页出现「登记延长保修（+12 个月）」。**验证完把设定改回 0**（送不送、送几个月由使用者决定）。

### 改到的旧档（patch 冲突时手动补）

- `portal/src/App.tsx`：`<Customers sub={arg} arg={arg2} />` 改成 `<Customers me={me} sub={arg} arg={arg2} />`（跟进的分店预设用员工自己的分店）。
- `portal/src/pages/Home.tsx`：`import { CustomersHomeCard } from "../cust/HomeCard";`，在 `<DeliveryHomeCard … />` 后面放 `<CustomersHomeCard me={me} />`。
- `portal/supabase/tests/run.sh`：`cust_test.sql` 后面加一行跑 `cust2_test.sql`。
- `portal/supabase/tests/stub_supabase.sql`：「顾客资料」段的 `bi_customers()` 换成完整栏位版（读 `bi.stub_customer_row`），多几张 stub 表与栏位。

## 5. 上线后请使用者做的事

1. 决定送不送延长保修、送几个月：营运系统 → 顾客资料 → 设定 →「登记送延长保修」（只有管理员能改）。填了之后扫码登记页才会出现那行字。
2. 门市同事每天开营运系统首页就看到「今天要跟进 N 位」，点进去照提醒 WhatsApp / 按「已联络」。
3. 每月初在「报告」看员工排行与业务员新客回头率。

## 6. 验证纪录（交出前做过的）

（交出前补上）
