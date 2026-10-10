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

## 2026-09-28 晚：整个 BI 改成中 / 英双语（使用者要求「做成整个bi换成中英文」）

**做法**（不改资料库、不改任何查询）：
- `src/lib/i18n.tsx`：`LangProvider`（`main.tsx` 包住整个 App）、`useT()` 回传 `t(中文原文, 变数?)`、
  `tr(lang, 中文, 变数?)` 给非 React 的地方、`<LangToggle />`（右上角「中 / EN」按钮，记在 localStorage `bi_lang`）。
- **字典键 = 程式码里的中文原文**，所以中文模式零成本、英文找不到键时也只是退回中文，不会出现空白。
  占位符用 `{name}`，例如 `t('{n} 行未交', { n })`。
- 字典按页面分档放在 `src/i18n/`（core / manager / finance / ecom / pages1 / pages2 / purchasing，共约 650 条），
  `index.ts` 把它们 spread 合并（后面的盖前面的，共用词如「载入中…」各档都有、内容一致）。
- 所有 `src/pages/*.tsx`、`src/components/*.tsx`、`App.tsx` 里显示给人看的字串都包成 `t('…')`；
  从资料库来的渠道名（现金 / 门市现金 / B2B客户 / 其他平台 / 水工…）在显示时才经 `t()`，资料本身不动。
- 这里的 `src/` 就是 Vercel 上现在跑的完整原始码（`package.json`、`styles.css`、`lib/format.ts`、`lib/supabase.ts`
  没改，不在这里）。

**分批部署法**（一次内嵌全部档案太大，改成七批；`mkpayload.py` + `deploy_manifest.json` 就是这个用途）：
1. `deploy_manifest.json` = Vercel 端已存在的 `{路径: SHA1}`；`python3 mkpayload.py <批名>` 印出 `create_deployment`
   的 `files` 阵列：该批档案内嵌（`data`），其余全用 `{file, sha}` 参照。批名与档案清单在脚本顶部 `BATCH`。
2. 贴进 `mcp__Vercel__create_deployment`（`project: homeworks-bi, target: production`，**不要带 teamId**，带了会 403）。
3. 等 `get_deployment` 变 READY，再用 `list_deployment_files` 核对每个内嵌档的 `uid` 是否等于本机 `sha1sum`
   ——内嵌时抄错一个字元 SHA 就不同，下一批参照会报 `missing_files`。全对后 `python3 mkpayload.py --commit <批名>` 记进 manifest。
4. 若某档 Vercel 端就是没有那个 SHA：用 `mcp__Vercel__upload_file`（base64 + `xVercelDigest` = SHA1）单独上传，
   伺服器会校验内容，比重新内嵌可靠。
- 顺序：infra（i18n 骨架 + App + 空字典）→ manager → finance → ecom → pages1 → pages2 → purchasing。中途每批都是可用状态
  （还没翻的页面就显示中文）。
- 使用者看到旧版时按 Ctrl+F5 强制重新载入。

## 2026-10-01：第二家分行 HOMEWORKS KL（公司代码 HOMEWORKSKL）
- `src/lib/supabase.ts` 现在也在这里了（之前仓库里没有；从 Vercel 档案树抓回、尾段依 App.tsx 的用法重建）。`COMPANIES` 加
  `HOMEWORKSKL: 'KL'`，`HQ` 常数；非老板角色登入后固定切到 `allowed_users.company`。
- `App.tsx`：「实际销售」分页改成 `!isHQ` 就显示（任何分行）。`EcomReport.tsx`：Southern 旁那栏固定 `.eq('company','HOMEWORKSSOUTHERN')`，
  不然老板看总部时会把 KL 的数字也加进去。
- 部署批 `kl`（mkpayload.py）：supabase.ts + App.tsx + EcomReport.tsx + core.ts。
- 加 KL 使用者：`insert into bi.allowed_users(email, role, company, note) values ('…', 'manager', 'HOMEWORKSKL', 'KL店长')`（用 Supabase MCP 跑）。

## 2026-10-04：每一页提速（Supabase 端，前端没改，不用重新部署）
- 症结：15 个 public 视图每次都即时扫 `bi.fact_sales`（55 万行），老板帐号量到 3～18 秒；authenticated 的 statement_timeout 是 8 秒，
  所以手机上常常「canceling statement due to statement timeout」。
- 做法与「每月一页纸」快照相同：建九个物化视图 `bi.mv_*`（`heavy_views_materialized`），pg_cron `bi_heavy_views_refresh`
  每 2 小时（`25 */2 * * *`）跑 `bi.refresh_heavy_views()` 并行重算（`refresh … concurrently`，重算中页面照常可读）；
  再用 `create or replace view` 把 15 个视图改读 mv（`heavy_views_rewire`、`heavy_views_rewire_purchase`，SQL 留在 `docs/bi_sql/`）。
- 物化视图没有 RLS，所以每个视图都补 `bi_is_allowed()` + `bi_company()` 公司过滤，角色门槛与原视图相同；已用 JB 店长帐号验证只看得到自家公司。
- 结果：全部 < 1.5 秒（采购建议 1.5 秒，其余多在 50 毫秒内）；8 月合计与原始明细核对一致。代价：数字最多慢 2 小时
  （每日同步 04:05 UTC 后，最晚 06:25 UTC 就会反映）。
- 以后新视图若慢：把重的聚合搬进新的 mv、加进 `bi.refresh_heavy_views()`，视图只读 mv。每个 mv 都要有唯一索引才能 concurrently 重算。
- **同晚补充**：总览页仍超时 → `bi_sales_monthly`（整表扫 fact_sales 326MB 算月汇总）与 `bi_sales_daily` 两条并发、手机冷快取就超过 8 秒。
  再加 4 个 mv：`mv_sales_monthly` / `mv_sales_daily` / `mv_mgr_channel_daily` / `mv_alert_low_stock`（`heavy_views_materialized_2`），
  视图 `bi_sales_monthly(_nc)` / `bi_sales_daily` / `bi_mgr_channel_daily` / `bi_alert_low_stock` 改读 mv（`heavy_views_rewire_2`），
  `bi.refresh_heavy_views()` 现在重算 13 个。前端还会直接扫 fact_sales 的只剩 `bi_sales_lines(_nc)`（销售明细页，按日期范围走索引，不改）。

## 2026-10-10：「健康体检」分页（使用者：「做成 BI 的健康体检分页」）
- 来源：`docs/health_check_2026-10.md` 的 8 维度记分卡（Workflow 算 + 独立核对）。页面 `src/pages/Health.tsx`，字典 `src/i18n/health.ts`，
  分页 `{ key: 'health', label: '健康体检' }`，OWNER_ONLY，只在总部视角显示（页面本身并列 总行 / 分行 JB / 集团 三列）。
- Supabase：`bi.healthcheck_snapshot(company, as_of, m jsonb, refreshed_at)`（RLS 只给 owner）+ `bi.refresh_healthcheck()`（security definer，
  各区块算成 jsonb 合并；集团 = 总行对外 + 分行，只加可加的基础值，`purch_l12` 扣掉内部往来）+ 视图 `public.bi_healthcheck` +
  pg_cron `bi_healthcheck_refresh`（`35 1,4,7,10,13,16,19,22 * * *`，同步后约 35 分钟）。migration：`healthcheck_snapshot`、`healthcheck_cron`、
  `healthcheck_low_s90_external`（缺货暴露分子改对外口径）；完整 SQL 在 `docs/bi_sql/healthcheck_snapshot.sql` / `healthcheck_cron.sql`。
- 部署：`python3 mkpayload.py health` 一批（Health.tsx + health.ts + index.ts + App.tsx 内嵌，其余 60 档以 SHA 参照）→ production
  `dpl_CZ5Vuqa9E8A9diatwASE88CP7Gyh`（2026-10-10 10:36 UTC，READY，homeworks-bi.vercel.app），四个内嵌档 SHA 已核对，manifest 已 `--commit`。
- **快照只存基础值（约 130 个键），比率、红黄绿门槛、参考区间全在前端 `buildSections()` 里**——改门槛只要改 Health.tsx 重新部署。
  ⚪ = 只供参考不评分（留存率只评总行 B2B、净现金变动、新客贡献等）。
- 名字叫 `healthcheck_*` 是因为 Supabase 里已有另一条管线（2026-10-08，不在本仓库）建的 `bi.health_snapshot` / `bi.refresh_health()` /
  cron `bi_health_refresh` / 视图 `bi_health_*`，**不要动它们**。
- 核对（2026-10-10 10:30 UTC 快照 vs 报告）：总行 GL 对外收入 7.33M、净利 1.44M（11.4%）、应收发票 248k、应付 1.10M（>90 天 76%）、
  平台费率 28.9%、负库存 853 行、DIO 224 天、DPO 40 天、缺货暴露 22.5%，都与报告一致；库存成本 6.23M（报告 6.45M，报告含的仓位略多）。

### 部署时发现别人也在改 Vercel（2026-10-05～10-08，另一条工作流）
- 现行 production 部署 `dpl_FbqpbvGBbhGykKTe3oTGPhhCa8bk` 多了 4 个入口（`delivery.html` / `driver.html` / `join.html` / `loyalty.html`，
  `vite.config.ts` 多入口）、`src/{delivery,driver,join,loyalty}/`、`src/pages/Delivery.tsx` / `Loyalty.tsx`、`src/i18n/loyalty.ts`；
  `src/i18n/index.ts` 多 spread 了 `loyalty`。其余档案 SHA 与本仓库副本相同。
- **每次部署前先 `list_deployment_files`（用 `get_project` 的 latestDeployment / 现行 production 的 id）把档案树抄成 `tree.txt`
  （每行「路径 sha」），`python3 mkpayload.py --sync tree.txt` 重建 manifest**，否则会把别人的新档案从部署里漏掉。
- `get_deployment_file_contents` 一次只回约 4KB（base64），大档会被截断：`src/styles.css`、`src/i18n/loyalty.ts`、`src/pages/Delivery.tsx` /
  `Loyalty.tsx`、`src/{delivery,driver,join,loyalty}/*.tsx|css` 本仓库**没有副本**（只在 manifest 里以 SHA 参照）；四个 `*.html` 入口已抓回。
  要改那些档案得先想别的办法取回（例如请对方把原始码放进仓库）。

### Supabase MCP `apply_migration` 的另一个坑（2026-10-10）
- 不只 `drop …` / `cron.unschedule`：SQL 里出现 `truncate`、`on commit drop` 这类字眼（连注释都算）也会被当破坏性语句等使用者确认；
  在无人值守的会话里不会回 `cancelled`，而是**卡到 60 秒 timeout，什么都没套用**（同一份 SQL 卡了两次才查出来）。
  所以 `refresh_healthcheck()` 不用临时表，改成各区块 `select to_jsonb(r) into j` 再 `||` 合并。写 migration 前 `grep -i 'drop\|truncate\|delete'`。
