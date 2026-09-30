# HomeWorks BI 网页（Vercel `homeworks-bi`）里的「电商月报」分页

BI 网页原始码不在 GitHub；使用者电脑上有一份（Vite + React 18 + recharts + supabase-js），
部署方式是把档案上传到 Vercel（非 git）。这里留的是本专案加进去的两个档：

- `EcomReport.tsx`：新分页，读 `public.bi_report_month_*` 五个视图（本专案每月推送的月报成品）
- `App.tsx`：加了 `{ key: 'ecom', label: '电商月报' }`，只有 owner、且看总部时显示；
  2026-09-28 再加 `{ key: 'branch', label: '实际销售' }`（店长 MANAGER_TABS 也有），只在看 JB Southern 时显示
- `BranchActual.tsx`：分行「实际销售」分页，读 `public.bi_branch_actual_month` / `_meta`（分行电脑推送）

## 2026-09-26 的部署方式（可重复）
1. Vercel 的档案树 API 会列出每个档的 `uid` = 内容 SHA1；没改的档案用 `{file, sha}` 参照即可，
   不用重新上传（26 个档全部核对过 SHA1 一致）。
2. 只把改过的档用 `{file, data, encoding:"utf-8"}` 内嵌，`create_deployment`（MCP `mcp__Vercel__*`）
   `project: homeworks-bi, target: production`，建置约 15 秒后自动接到 homeworks-bi.vercel.app。
3. 档案树 API 的顶层 `src/` 是 Vercel 的「原始码」节点，不是专案的子目录；档案路径不用加前缀。
- `AdsEditor.tsx`（2026-09-28）：老板在电商月报页填广告 / 直播数字 → RPC `bi_report_set_ads`；`EcomReport.tsx` 多了 `canEdit` prop
- `StockAnomaly.tsx`（2026-09-28）：「库存异常」分页，读 `public.bi_stock_anomaly`（migration `stock_anomaly_view`）；A 服务项目仍扣库存 / B 仓位错配→建议 Stock Transfer（CSV）/ C 真正短少→盘点表（CSV）。owner、manager、buyer 可见

## 顾客积分（2026-09-28）→ 2026-09-29 改成顾客资料

2026-09-29 使用者不要积分，同一个网址 / 档名改成「顾客资料」（记录顾客、筛选、汇出促销名单），数据库见 `customer_profiles.sql`，
已上线 dpl_FUEcJLa8hZsd9ZR41g6nADgNocYz。2026-09-30 第二版（跟进提醒、一键 WhatsApp、买了 A 没买 B、同意收促销、分级、促销活动成效、
每月顾客报告）数据库见 `customer_crm.sql`，`loyalty/overlay.json` 以第一版上线版为底。以下是积分时期的纪录：

独立页 `homeworks-bi.vercel.app/loyalty.html`（柜台只开这页，登入与主看板共用）。**2026-09-29 已由 deploy_bi_web.bat 上线（dpl_9rYXNrwx6dfW6VKT3UZgoCLQfMPV）**。以下为当时背景：Vercel 连接的帐号
这天起对 homeworks-bi 建 preview / production 都回 403（没有部署权限），要在 Vercel 团队设定把该帐号角色调回
Member（或 Owner）才能由 Claude 部署；或使用者自己部署。

- 数据库（已上线）：`loyalty_points.sql`（migration `loyalty_points` + `loyalty_points_cn_sign` + `loyalty_points_no_debt`，
  这个档是合并后的最终版）。积分从 `bi.fact_sales` 现算，不存盘；兑换 / 调整存 `bi.loyalty_txn`；RPC 全在 `public.bi_loyalty_*`。
- 前端档案在 `loyalty/`，路径就是部署路径：
  - 新增：`loyalty.html`、`src/loyalty/main.tsx`、`src/loyalty/loyalty.css`、`src/pages/Loyalty.tsx`、`src/i18n/loyalty.ts`
  - 修改：`vite.config.ts`（多一个入口 loyalty.html）、`src/i18n/index.ts`（并入 loyalty 字典，放最前面，现有翻译优先）
  - 其余档案不动；部署时用 `{file, sha}` 参照线上 dpl_2HzZjNwpUdrSg8iQTKsNQzXU9phT 的档即可。
  - **部署前先 `get_project homeworks-bi`（不带 teamId）看 latestDeployment**：若已不是 dpl_2HzZjNwpUdrSg8iQTKsNQzXU9phT，
    使用者在这之间改过网页，要改用新部署的档案树 SHA，并确认新版 `vite.config.ts`、`src/i18n/index.ts` 是否也改过
    （这两个档我们会整个替换）。部署后用 list_deployment_files 比对 7 个新档的 SHA1 与本目录一致。
- 403 的原因（2026-09-28 查明）：团队只有使用者一个成员（Owner），不是角色问题；是 claude.ai 的 Vercel 连接器授权。
  使用者在 https://claude.ai/customize/connectors 重连后，同一个 session 就认得身分了（get_auth_user 从 User not found
  变成 Owner），但建部署、列别名**仍然 403**——连接器授权不含部署权限，重连解决不了。改用下面的 deploy_bi_web.bat。
- 为什么是独立页而不是分页：`get_deployment_file_contents` 每个档只回前 1,500 bytes，拿不到完整的 `App.tsx`，
  改不了分页列。以后若使用者提供完整原始码，把 `Loyalty` 元件挂进 App.tsx 的 TABS（owner / manager / sales）即可，
  元件本身不用改（props：`lang`、`role`、`company`）。

## 部署改版：deploy_bi_web.bat（2026-09-28 起）

使用者重新授权连接器后，`get_auth_user` 认得是 Owner，但建 preview / production 部署、列别名仍回 403：
连接器授权本身不含部署权限，Claude 这边解不了。所以改用 `scripts/deploy_bi_web.py`（SERVER 上双击 `deploy_bi_web.bat`）：

1. 第一次会请使用者到 https://vercel.com/account/tokens 建一把金钥（Scope 选 leslie tee），getpass 贴上、先读一次专案验证，
   存进 `vercel_token.json`（gitignore；update_from_zip 也不会盖掉）。
2. 用别名 `homeworks-bi.vercel.app` 找出目前正式部署（找不到再看专案的 production target），读它的档案树。
3. 线上每个档用 `{file, sha}` 原样引用；改版目录的档用 `/v2/files` 上传；`overlay.json` 的 `replaces` 是要换掉的线上档
   与当初的底（SHA1），线上已不是那一版就停下来并请使用者把讯息贴给 Claude（重新以线上最新版合并）。
4. `/v13/deployments` 建正式部署、等到 READY，再核对新部署里改版档的 SHA1、等正式网址指过来。建置失败会印出建置日志最后几行，
   线上维持原版。`--check` 只看会动到哪些档；线上已是这一版就不部署（重跑安全）。

以后做新的 BI 网页改版：另开一个改版目录（路径就是部署路径 + `overlay.json`），
`python scripts/deploy_bi_web.py docs/bi_web/<目录>`。需要换掉的线上档，先确认手上的底就是线上那一版（SHA1 对得上）。
