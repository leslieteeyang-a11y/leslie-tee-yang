# 顾客资料模块 → HomeWorks 营运系统（交接说明）

**给谁看**：把这个 ZIP 上传到「员工多部门功能开发」（营运系统 `portal/`、分支 `claude/gifted-faraday-b16op8`、Vercel 专案
`homeworks-ops`）那个 Claude 对话，跟它说：「照 HANDOFF.md 把顾客资料模块合并进来、测试、部署」。

使用者（Leslie）的原话：「我要把这个系统连接在员工多部门里面，我该怎么做？」。要接的系统选「顾客资料」，权限选「照部门权限」。

---

## 1. 这个模块做什么

BI 网站的顾客资料页（`homeworks-bi` 的 `/loyalty.html`）整页搬进营运系统，侧栏多一个「☏ 顾客资料」，路由 `#/customers/<分页>`：

| 分页 | 谁看得到 | 内容 |
|---|---|---|
| 跟进 | 只看以上 | 快速登记（可编辑以上）、跟进提醒（生日、约好的联络日、潜在客、报价没成交、装修进度太久没更新；一键 WhatsApp 范本、「已联络」）、最近 14 天扫码登记的顾客 |
| 顾客 | 只看以上 | 顾客名单（总部 + JB 合并，约 8,000 位）、分级（VIP / 常客 / 一般 / 流失 / 潜在客）、各种筛选；可审批：汇出「同意收促销」名单 CSV、用名单建促销活动；可编辑以上：新增顾客 |
| 促销活动 | 可审批 | 每次活动的 30 / 60 天成效、汇出名单；管理员可删 |
| 报告 | 只看以上 | 每月新客 / 回头客 / 流失、各业务员；没抓到电话的门市单据（照员工的分店） |
| 设定 | 可审批 | WhatsApp 范本；分级门槛与提醒天数（只有管理员能改）；顾客扫码登记的 QR 网址 |

一位顾客：`#/customers/c/<顾客编号>`（电话 `60…` / `65…`，或账号型 `A:公司:代号`，网址里 `encodeURIComponent`）：基本资料、生日、类型、
同意收促销、地区 / 地址、备注、下次联络日、装修进度 5 段 + 推荐类别、报价单、购买历史（点开看明细）、合并重复号码（可审批）、修改纪录。

这一页**自己带中英文**：整页 `translate="no"`，介面文字用 `cust-api.ts` 的 `t()` 查 `src/cust/dict.ts`（大部分照抄 BI 的英文字典，
用语跟 BI 一致），字典没有的退回营运系统的字典（资料库错误讯息）。**新增这页的文字要加进 `cust/dict.ts`，不是 `i18n-dict-*.ts`。**

## 2. 资料：不搬家、两边共用

- 顾客资料、购买历史（`bi.fact_sales` 现算）、扫码登记、活动、范本都在 **BI 的 `bi.customer_*`**。前端直接呼叫 BI 原本的
  `public.bi_customer*` / `bi_campaign*` / `bi_wa_template*` 函数——跟 BI 网页同一份资料，两边改的互相看得到。
- 这些函数开头原本是 `bi.customer_require(角色)`，只认 BI 名单。migration `20261016_ops_customers.sql` 把它们换成 **`bi.crm_require`**：
  BI 名单的人照旧；另外认营运系统员工的「顾客资料」模块权限：

  | 营运系统 | 等于 BI 的 | 能做 |
  |---|---|---|
  | 管理员（admin） | owner | 全部，含分级门槛、删活动 |
  | 可审批（管理层；门市主管 manager 自动从可编辑升上来） | manager | + 汇出 CSV、合并顾客、促销活动、WhatsApp 范本 |
  | 可编辑（销售 / 门市部门预设） | sales | 看、改资料、快速登记、联络、装修进度 |
  | 只看（只能用个人例外开） | viewer | 只能叫读取的函数（`STABLE`，改写时第二个参数给 `true`） |

  其他部门（送货、物流、仓库、采购、开单、财务、人事、电商）预设看不到；送货部在「送货」本来就看得到那张 DO 的顾客名字、电话、地址。
- 改写方式：DO 段用 `pg_get_functiondef` 读出每个顾客资料函数，只把 `bi.customer_require(array[…])` 换成 `bi.crm_require(array[…][, true])`，
  其他一个字都不动（`create or replace`，拥有者、security definer、授权都保留）。**送货的 `bi_delivery_*` 不改**（营运系统走 `ops_dlv_*`）。
  `bi_customer_missing_phone` 另外改用 `bi.crm_company()`（营运系统员工照自己的分店，全部分店 = 不限）。
- 营运系统的员工被挡时，错误讯息是营运系统的说法（「你没有「顾客资料」模块的编辑权限，请找管理员开通。」/「这个动作只有管理员可以做。」），
  英文在 `i18n-dict-db.ts` 与原本的 pattern。
- **以后 BI 那边改任何顾客资料函数，开头要写 `bi.crm_require(…)`（读取的函数第二个参数 `true`），不要再用 `bi.customer_require`**，
  不然营运系统的员工会被挡。重套一次 `20261016_ops_customers.sql` 也会把漏掉的改过来（可以重复套用）。
- 对 AutoCount 仍然只读。

## 3. 资料库：正式环境（见第 6 节）

- `portal/supabase/migrations/20261016_ops_customers.sql` —— 模块 `customers`（「顾客资料」，`ready = false`）、部门预设（销售 = 可编辑、
  管理层 = 可审批，`on conflict do nothing` 不盖掉之后改过的）、`bi.crm_ops_role` / `bi.crm_require` / `bi.crm_company`、
  `public.ops_cust_role()`（前端用来决定显示哪些按钮）、改写 25 个顾客资料函数。可重复套用，不含 DROP / DELETE。
- `portal/supabase/migrations/20261016b_ops_customers_ready.sql` —— `ready = true`。**等前端部署好再套**（先套的话，旧前端点侧栏会进「没有权限」页）。

## 4. 合并步骤（给营运系统那边的 Claude）

ZIP 里有：`customers-module.patch`（`git am` 用，以 `dbe274c 图示 PNG 压成 16 色、记下 BI 配色的部署编号` 为底）、`files/`（同样的改动、
完整档案，路径照 repo 根目录；「改到的旧档」是以 `dbe274c` 为底的完整版，你那边若已经改过，**不要直接覆盖**，照下面补那几行）。

1. 在 `claude/gifted-faraday-b16op8` 最新版上：`git am customers-module.patch`。冲突时以你那边为准，照「改到的旧档」手动补。
2. 资料库测试：`PGHOST=… PGPORT=… PGUSER=postgres sh portal/supabase/tests/run.sh`（最后印 `cust_test ok`）。
3. 前端：`cd portal && npm run build`。
4. 部署到 `homeworks-ops`（照 `portal/README.md` 的「部署」）。新档：`src/pages/Customers.tsx`、`src/cust/*.tsx`（6 个）、`src/cust/dict.ts`、
   `src/cust-api.ts`、`src/cust.css`；改到的档：`src/App.tsx`、`src/i18n-dict-db.ts`。每个档都 ≤ 19 KB。
5. 部署 READY 之后，用 Supabase MCP `apply_migration` 套 `20261016b_ops_customers_ready.sql`（名称 `ops_customers_ready`）。
6. 把 CLAUDE.md 加一段「顾客资料」（第 2 节的重点，特别是「BI 改顾客资料函数要用 `bi.crm_require`」）。

### 改到的旧档（patch 冲突时手动补）

- `portal/src/App.tsx`：`import Customers from "./pages/Customers";`；`ICON` 加 `customers: "☏"`；switch 加
  `case "customers": page = can(me, "customers", "view") ? <Customers sub={arg} arg={arg2} /> : <NoAccess />; break;`
- `portal/src/i18n-dict-db.ts`：模块名称「顾客资料」→ Customers、说明「门市顾客名单、跟进提醒、一键 WhatsApp、顾客扫码登记、促销活动」、
  错误讯息「这个动作只有管理员可以做。」。
- `portal/supabase/tests/run.sh`：最后加一行跑 `cust_test.sql`。
- `portal/supabase/tests/stub_supabase.sql`：最后加「顾客资料」那一段（BI 的权限函数与几个有代表性的顾客资料函数）。

## 5. 上线后请使用者做的事

1. 门市同事（销售 / 门市部门）登入营运系统 → 侧栏「顾客资料」，就是 BI 那一页的内容。
2. 要让别的部门的人也能看：「员工与权限」→ 那位员工的个人例外「顾客资料」设成「只看」或「可编辑」。
3. BI 的 `/loyalty.html` 先留着（资料相通）；大家都改用营运系统后，要不要关掉由使用者决定。
