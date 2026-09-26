# HomeWorks BI 网页（Vercel `homeworks-bi`）里的「电商月报」分页

BI 网页原始码不在 GitHub；使用者电脑上有一份（Vite + React 18 + recharts + supabase-js），
部署方式是把档案上传到 Vercel（非 git）。这里留的是本专案加进去的两个档：

- `EcomReport.tsx`：新分页，读 `public.bi_report_month_*` 五个视图（本专案每月推送的月报成品）
- `App.tsx`：加了 `{ key: 'ecom', label: '电商月报' }`，只有 owner、且看总部时显示

## 2026-09-26 的部署方式（可重复）
1. Vercel 的档案树 API 会列出每个档的 `uid` = 内容 SHA1；没改的档案用 `{file, sha}` 参照即可，
   不用重新上传（26 个档全部核对过 SHA1 一致）。
2. 只把改过的档用 `{file, data, encoding:"utf-8"}` 内嵌，`create_deployment`（MCP `mcp__Vercel__*`）
   `project: homeworks-bi, target: production`，建置约 15 秒后自动接到 homeworks-bi.vercel.app。
3. 档案树 API 的顶层 `src/` 是 Vercel 的「原始码」节点，不是专案的子目录；档案路径不用加前缀。
