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

## 顾客积分（2026-09-28）

独立页 `homeworks-bi.vercel.app/loyalty.html`（柜台只开这页，登入与主看板共用）。**还没部署**：Vercel 连接的帐号
这天起对 homeworks-bi 建 preview / production 都回 403（没有部署权限），要在 Vercel 团队设定把该帐号角色调回
Member（或 Owner）才能由 Claude 部署；或使用者自己部署。

- 数据库（已上线）：`loyalty_points.sql`（migration `loyalty_points` + `loyalty_points_cn_sign` + `loyalty_points_no_debt`，
  这个档是合并后的最终版）。积分从 `bi.fact_sales` 现算，不存盘；兑换 / 调整存 `bi.loyalty_txn`；RPC 全在 `public.bi_loyalty_*`。
- 前端档案在 `loyalty/`，路径就是部署路径：
  - 新增：`loyalty.html`、`src/loyalty/main.tsx`、`src/loyalty/loyalty.css`、`src/pages/Loyalty.tsx`、`src/i18n/loyalty.ts`
  - 修改：`vite.config.ts`（多一个入口 loyalty.html）、`src/i18n/index.ts`（并入 loyalty 字典，放最前面，现有翻译优先）
  - 其余档案不动；部署时用 `{file, sha}` 参照线上 dpl_2HzZjNwpUdrSg8iQTKsNQzXU9phT 的档即可。
- 为什么是独立页而不是分页：`get_deployment_file_contents` 每个档只回前 1,500 bytes，拿不到完整的 `App.tsx`，
  改不了分页列。以后若使用者提供完整原始码，把 `Loyalty` 元件挂进 App.tsx 的 TABS（owner / manager / sales）即可，
  元件本身不用改（props：`lang`、`role`、`company`）。
