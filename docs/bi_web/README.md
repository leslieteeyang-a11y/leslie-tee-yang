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

## 2026-10-14：订货页「CS 厂号」下拉改列全部厂号并标件数（修法 A，老板「做 A」）
- 起因：老板问为何 CS007…CS075 共 18 个厂号没出现在下拉（诊断 `cs_dropdown_2026-10-14.md`：下拉只列目前载入的走量品身上的厂号，
  厂号来自商品最近一张 PO 的供应商名称；14 个不走量、2 个零销售、CS014 / CS029 从没开过 PO）。
- Supabase：视图 `public.bi_cs_code`（migration `cs_code_view`，SQL 在 `docs/bi_sql/cs_code_view.sql`）：PO 供应商名称里出现过的每个 CS 码一行，
  `items_last_po`（最近一张 PO 挂此码的商品数，含无销售）、`items`（候选名单内）、`loaded10/30/100`（前端三个门槛下会载入的行数，直接从
  `public.bi_purchase_suggest` 汇总，口径永远与前端一致）。security_invoker + `bi_is_allowed()` + `bi_company()`，sales 角色 0 行。老板视角 0.7 秒。
  核对：55 个码，三个门槛的件数与前端查询逐码相等，0 个不符。
- 前端 `Purchasing.tsx`（SuggestTab）：下拉改读 `bi_cs_code`，选项显示「CS007(0 项 · 4 项未达门槛)」/「CS052(0 项 · 8 项无销售)」/「CS065(93 项)」；
  选到门槛内 0 项的厂号时显示提示（原因 + 最近 PO 日期）并给「把门槛切到 10」按钮；**选了厂号后 rows 的查询加 `.eq('cs_code', …)` 在伺服器端过滤**
  （limit 1000 不再切掉排后面的厂号；门槛 10 时已载入 972 行，离上限很近）；rows 满 1000 行且没选厂号时显示警告。
  新字典 `src/i18n/cscode.ts`，`index.ts` 合并。型别检查：在暂存区装 typescript 5.6 + react/supabase 型别，对 Purchasing.tsx / Health.tsx 跑
  `tsc --noEmit --strict --noUnusedLocals`（本地副本缺的 margin / targets / loyalty 字典用空字典顶替，`import.meta.env` 用一个 d.ts 顶替）通过。
- 部署批 `cscode`（mkpayload.py）：Purchasing.tsx + i18n/cscode.ts + i18n/index.ts 内嵌，其余以 SHA 参照（manifest 已先 `--sync` 到
  dpl_CJE3AbnkcyRJ1QP7z7zgdczxFUyv 的档案树，含别人加的 Targets / Margin）。
- 部署：`dpl_HZ29H2uDpX86zYJvZr4juJj8ZCxs`（2026-10-14 10:32 UTC，production，homeworks-bi.vercel.app），三个内嵌档 SHA 已核对、manifest 已 `--commit`。
- 审查工作流（4 路审查 + 必修项独立反驳）后补的修正：rows 的 effect 加 `alive` 过期回应保护（连按方向键换厂号时先发后到会显示错厂号的数据）；
  厂号清单与「该下单」供应商拆成只随 `tick` 重抓的 effect；视图读不到时降级用 rows 实算件数、提示框只在伺服器真回 0 行时出现；换厂号时清掉供应商筛选；
  门槛按钮改切到「最接近且有货」的门槛（100→30→10）；视图 v2 `items` 排除 exclude、尾端加 `excluded` 栏（`create or replace view` 不能在中间插栏）。
- 内嵌部署的坑：`Purchasing.tsx` 的 CSV 匯出有一个肉眼看不见的 U+FEFF（BOM）字元写在字串里；我改成 `'\uFEFF'` 跳脱再内嵌，
  结果 MCP 传输把 JSON 里的 `\uFEFF` 解回原字元，Vercel 上的 SHA 等于改之前的版本（功能相同）。副本已改回原字元与生产一致；以后遇到这类不可见字元，直接保留原样内嵌即可。
- 待办（审查提的、这次没做）：`bi_purchase_suggest` 的 cs_code 第二支退路（代理账号最近一张 PO 的名称）会把 29 个商品贴上与自己无关的厂号
  （CS017 +9、CS032 +12…），且随代理下一张 PO 漂移；要改成「该代理只出现过一个厂号时才用」或直接拿掉退路，另开 migration。

## 2026-10-14（晚）：没货的商品不受走量门槛限制（老板「虽然卖的少，但没货了还是要给我知道啊」）
- 载入规则从「q90 ≥ 门槛 或 欠分行」改成「q90 ≥ 门槛 或 欠分行 或 **现存 ≤ 0**」：`Purchasing.tsx` rows 查询的 `.or()` 加 `on_hand.lte.0`；
  门槛标签加 tooltip、页尾口径加一句「走量门槛只筛还有货的商品」。门槛 30 下多出 183 行没货商品，CS007 / CS020 / CS052 / CS060 各出现 1 项。
- 伺服器一次最多 1000 行，门槛 10 加没货商品已有 1,127 行 → rows 改用 `.range()` 翻页最多 3 页（3,000 行），排序加第二键 `item_code` 让分页稳定；
  超过 3,000 行时的警告文字取代原本的 1000 行警告。
- 视图 `public.bi_cs_code` v3（migration `cs_code_view_v3_out_of_stock`，SQL 副本已同步）：`loaded10/30/100` 的口径同步加 `on_hand <= 0`，
  核对 55 个码三个门槛仍 0 个不符。提示框文字改成「…都不到门槛、也都还有货，所以没列出来」。
- 部署：`dpl_6ttGuYm5Z3wbn82wyhdLaaoiakbx`（2026-10-14 12:07 UTC，production），三个内嵌档 SHA 已核对（Purchasing ea45e031…、cscode 7dd770a3…、
  index 302ad583…），manifest 已 `--commit cscode`。
- BOM 的最终解法：CSV 匯出改成 `String.fromCharCode(0xfeff) + …`，档案里既没有不可见字元也没有 `\uFEFF` 跳脱，内嵌部署与本地 SHA 一致。

## 2026-10-14（晚，第二轮）：老板「现在再加一条「现存 ≤ 0」这个没看到」——把规则显示在画面上
- 老板去「走量门槛」下拉找「现存 ≤ 0」找不到：上一版只改了查询条件，画面上一个字都没变（tooltip 手机上看不到、页尾注脚在几百行之后）。
- 先做了一版（commit 27f338e）：门槛旁灰字「+ 没货的一律列出」+ 琥珀色勾选框「只看没货(现存 ≤ 0)({n})」。跑 Workflow 审查（4 路：程式 / 老板手机 UX /
  双语字典 / 数据口径，每条 must/should 由 3 位反驳者独立复核；第一次有 19 个反驳者撞到 session 用量上限，`resumeFromRunId` 重跑一次）。
  反驳者**否决**了：把「只看没货」做成下拉第四个选项（会把状态藏进下拉；357 项没货里 83 项徽章是「来不及」不是「已断货」，改名反而词不对数）、
  件数改成筛选后口径（目前 0 行已处理，改了反而难懂）、状态列加按钮（与勾选框重复）、空状态文案（厂号是伺服器端重抓，件数会跟着变）。
  反驳者**确认**了：灰字夹在两个下拉中间会被读成「全部供应商」的前缀或「+ 新增」按钮；候选名单只含近 90 天有卖的商品（见下）；SQL 副本没同步。
- 最终版（本次部署）：规则写进下拉选项文字「90 天 ≥30 件 + 没货的」、拿掉灰字、label 与下拉包成 inline-flex 一组（手机折行不拆开）、保留琥珀色勾选框、
  「只看没货 / 只看欠分行」时不显示凑柜建议、页尾口径补「名单只含近 90 天有卖的商品」、字典去掉「勾右边」位置词与 on-hand 连字号、
  `docs/bi_sql/cs_code_view.sql` 副本补齐 v3 的 loaded10/30。
- 部署：`dpl_7TSztDz3UXC1owtoGsebyrqKa1gu`（2026-10-14 14:28 UTC，production），Purchasing 68efff71…、cscode b154e624…、index 302ad583…，manifest 已 `--commit cscode`。
- **内嵌部署抄错一个字的教训**：第一次 production 部署 `dpl_GAP8V7nRZKCjWyoqLYHatydu5meY` 建置成功，但 Vercel 上的 Purchasing.tsx SHA 是 583fdd08…、本地是 68efff71…——
  5 万字的内嵌内容里有一处走样（中文转成 \uXXXX 时抄错一个十六进位就变成另一个汉字，建置照样过）；`get_deployment_file_contents` 只回 4KB、找不出差异。
  以后**大档一律这样部署**：(1) 先不带 `target` 部署到 preview（不动 production）；(2) `list_deployment_files` 核对 uid = 本地 sha1；(3) 相符后再建一个 production 部署，
  **全部档案用 `{file, sha}` 参照、不再内嵌**（档案已在 Vercel 内容库，这个呼叫只有 7KB，且用 production 环境变数重新建置；不用 `request_promote`，
  promote 不重建、会把 preview 环境变数的产物推上线）；不符就重做 (1)。本次 preview `dpl_CsUjFgni2fqjAH3K2nnjzkWjyvpT`。
- **487 项「断货超过 90 天」商品的结论（老板 2026-10-14：「这些可能是工程订单，顾客只是订了为了工程用，平时不会卖的」）**：数据证实——
  487 项里 432 项只有一个客户、426 项一年内 ≤2 张发票或一张占八成以上（SHING SOON HENG HARDWARE 的 3,600 个角阀分 5 张、MUAR HARDWARE 的 1,560 个分 4 张）。
  跨 ≥3 个客户的只有 23 项，其中一年卖 ≥30 件的只有 3 项（ST001637 抽拉龙头 124 件/9 客户/91 张、ST000760 手持 bidet 92/4/72、ST000618 缓降马桶盖 26/4/16）。
  **候选集口径不改**（近 90 天有卖或欠分行）；那 3 项直接告诉老板补货。若以后要自动抓，用窄规则「没货且一年内发票 ≥10 张、客户 ≥3 个」即可。
  查数注意：`mv_purchase_sold` 里近 90 天没卖的 q90 是 **NULL 不是 0**，要用 `coalesce(q90,0)`（第一次用 `q90 = 0` 只查到 1 项）。

## 订货 / 库存 / 滞销品搬到营运系统（2026-10-14）

老板：「我想要把订货，滞销品，库存这三个移到员工多部门功能那边，然后BI这边就去掉这个项目」。
营运系统那边的改动（四页、RPC、migration、测试）做成 patch 放在 `docs/ops_handoff/`，由「员工多部门功能开发」session 合并部署；
Supabase 端的 migration 本 session 已套用（`ops_bi_pages_1_views` ～ `6_grants`；`public.bi_purchase_suggest` 改读 `bi.v_purchase_suggest`，
栏位不变，老板看到的仍是 2,590 行；`bi.buyer_item_action` 多了 `undone_at / undone_by` 两栏）。

BI 端：
- `App.tsx`：TABS 去掉 `buy` / `stock` / `slow`，三个角色名单同步拿掉；订货员登入预设从订货改成应付账款；`canWrite` 不再需要。
- 删掉 `pages/Purchasing.tsx`、`pages/StockPage.tsx`、`pages/SlowMovers.tsx`、`i18n/purchasing.ts`、`i18n/cscode.ts`；`i18n/index.ts` 不再合并这两本字典
  （`pages1.ts` / `pages2.ts` 里 StockPage / SlowMovers 的键留着没用，无害）。
- `pages/Alerts.tsx`：「库存告急」区块底下的「查看库存 →」按钮拿掉（BI 没有库存页了），`i18n/finance.ts` 对应键删除。
- `mkpayload.py` 新增批 `opsmove`：内嵌 App.tsx / i18n/index.ts / pages/Alerts.tsx / i18n/finance.ts，
  **`DROP:` 前缀 = 从部署里拿掉的档案**（不内嵌、不参照；`--commit` 时从 manifest 删除）。`--sync` 会把 production 现有档案全部抄回 manifest，
  所以拿掉档案一定要走 `DROP:`，不能只删 manifest。
- 本地 `tsc --noEmit --strict --noUnusedLocals` 通过（scratchpad 的 tscheck 专案，tsconfig 的 files 清单同步拿掉五个档）。
- **Preview 部署 `dpl_6qCnjTtFPCtXG8iFQxWyTaytcgqE`**（2026-10-14 晚，无 target，READY）：`list_deployment_files` 核对四个内嵌档 uid = 本地 sha1
  （App 7731bcfd…、i18n/index d95dbdbf…、Alerts 47f5753d…、finance 5bf623ee…），五个 DROP 的档案已不在档案树。
- **Production 部署 `dpl_5Hv676uke15ChRu5ZkbCsWMTAg3C`**（2026-10-15 UTC，READY，homeworks-bi.vercel.app）：营运系统那边回报「ops 四页已上线」
  （homeworks-ops 部署 READY、老板帐号权限查核：补货建议门槛 30 为 853 项、供应商 111 家、库存总表搜 HM-UB001 36 行、滞销 6 个月以上 1,437 项）后才做。
  62 个档案**全部 `{file, sha}` 参照**（四个改动档用 preview 已验证的 SHA），`list_deployment_files` 核对无误，manifest 已 `--commit opsmove`（67 → 62 个档案）。
  BI 上订货 / 库存 / 滞销品三个分页从此消失；订货员登入先看应付账款。
- 营运系统那边合并后另做了 `ops_bi_pages_7_fix`（只 `create or replace` 两个函数：`ops_rpl_rows` 的留言 / 商品备注 / 记录人只给看得到厂家的人；
  `ops_wh_stock` 每行多回 `item_total` 商品全仓合计），**没动 `bi.v_purchase_suggest` / `public.bi_purchase_suggest`**，BI 的其他页不受影响。

## BI 只开放给老板与店长（2026-10-15）

老板：「我的 BI 之后换成只有店长能进去」「其他员工都不能进去」。做法分两层：

- **资料层（migration `bi_owner_manager_only`）**：`bi_is_allowed()` / `bi_role()` / `bi_company()` / `bi_me()` 一律只认
  `bi.allowed_users.role in ('owner','manager')`，`bi_can_write()` 只剩 owner。订货员 / 销售 / 不在名单的人在资料层就跟没登入一样
  （所有 `public.bi_*` 视图靠 `bi_is_allowed()`）。验证：总部订货员 `bi_me` 0 行、视图 0 行；JB 店长照旧（manager / HOMEWORKSSOUTHERN，实际销售 187 行）。
- **名单**：三位（总部订货员、JB 订货员、JB 销售）的行**没删成**（MCP 的 `delete` 要人确认、无人确认就 60 秒 timeout），改在 `note` 加注记；
  他们反正被函数挡下。要删的话在 Supabase SQL editor 跑 `delete from bi.allowed_users where role in ('buyer','sales')`，
  营运系统「员工 → 在 BI 名单」的旗标才会正确。
- **营运系统不受影响**：它的顾客资料页 `bi.crm_require` 先看 BI 名单、不在就看营运系统自己的模块权限；验证 JB 销售 `bi_is_allowed()=false`
  但 `crm_ops_role()='sales'`，顾客页照常。登入账号是同一套 Supabase Auth，所以不能从 Auth 停用他们，只能在 BI 这层挡。
- **前端**：`App.tsx` 的 `Role` 只剩 owner / manager / viewer（viewer = 不在名单或角色已不开放），不是 owner / manager 的人登入后看到
  `Blocked` 提示页（「BI 只开放给老板与店长」+ 营运系统连结 + 退出），`BUYER_TABS` / `SALES_TABS` / `OWNER_ONLY` 拿掉；
  `i18n/core.ts` 加三个英文键。`mkpayload.py` 批 `biguard`（App.tsx + core.ts 内嵌）。
- Preview `dpl_GHL5T9WbEm6s9XLXxGpFKTTQwkWP`：App 88d82618…、core 50549662… 与本地 sha1 一致。
- **Production `dpl_9yWDzWupZUkuTBGBkHr3LjP1bgcx`**（2026-10-15，READY，homeworks-bi.vercel.app）：全 SHA 参照，档案树核对无误，manifest 已 `--commit biguard`。

## 2026-10-15（晚）：未来感主题（老板传来 Nexora 仪表板截图，问「可以把BI改成这种带有未来感，但又不是太夸张的主题吗」）

- **做法**：先从 Vercel sandbox 抓回线上 `styles.css`（`live.pretty.css`），用 Playwright 把一页假资料的 mock（KPI、表格、图表、登入页）
  在桌机 1280 / 手机 390 两种宽度下截图当基准；做了三个候选主题（`cyan-steel` 青钢色、`glass-indigo` 玻璃靛紫、`nebula-violet` 星云紫），
  用 Workflow 评审小组各自打分（22 / 21 / 19），最后选 **glass-indigo**——分数只差 1，但它是三个里最接近老板参考图的紫色系，
  再做一轮润饰：三层径向渐层背景（`html{min-height:100%}`，body 透明）、`:focus-visible` 焦点环、更柔和的 hover、
  dataviz validator 两个资料系列（`#8b7cff` / `#0ea5c6`，底色 `#191d47`）ALL PASS、文字对比度全部过关。备选 `cyan-steel` 存在
  `docs/bi_web/themes/cyan-steel.css`（想换只要整份覆盖 `src/styles.css` 再部署）。改版前后对照图：`theme_compare_2026-10-15.png`。
- **代码**：`src/styles.css` 整份换成新 token（`--page --surface --ink --ink-2 --muted --grid --border --series-1/2 --good --critical
  --accent --warn --warn-bg --good-green --branch-bg --row-expand-bg --tag-bg --hover-bg --accent-hi/lo --accent-grad --accent-glow
  --accent-ring --focus --glass* --field --row-hover`）；8 个 TSX 把写死的颜色改成 token（Manager / Payables / Receivables / Targets /
  EcomReport / BranchActual / PriceEffect / App，commit bc36738），以后换主题只改 CSS。
- **部署**：`mkpayload.py` 批 `theme`（styles.css + 8 个 TSX）。这次改用 `mcp__Vercel__upload_file`（base64 + `xVercelDigest` sha1）
  逐档上传、让 Vercel 端校验，再全部以 `{file, sha}` 参照建 preview `dpl_3pAZYQjxkcj3p95y4tnkbidPFWf9`，`list_deployment_files`
  核对 62 个 uid 全部等于本机 sha1 后，才建 **production `dpl_6GPMnuXZydBAVmJwxNTyc983obGN`**（2026-10-15，READY，homeworks-bi.vercel.app），
  manifest 已 `--commit theme`。
- **这次踩到的坑**（以后部署照这个做）：
  1. `upload_file` 的 base64 若与 digest 不符，MCP **不会回错误，而是 60 秒 timeout**，看起来像伺服器慢。手抄 base64 在中文密集的段落
     很容易抄错（EcomReport 在第 4129 字元抄错，Manager 28k 字元却一次成功）。要先在本机用 heredoc 把准备上传的字串写进档案
     `cmp` 一次再上传。
  2. 明文比 base64 可靠得多：把 TSX 用 heredoc 抄进暂存区、`sha1sum` 核对（两个档案都一次就对），再用 `python3 -c 'json.dumps(...)'`
     印出 JSON 跳脱字串，以 `{file, data, encoding:"utf-8"}` 内嵌到 create_deployment。
  3. 内嵌资料里的反斜线：在 sandbox 用 `node -e` 实测，`\d` `\.` `\s` `\\` 都原样到达，**只有 `\uXXXX` 这种合法 JSON 跳脱会被解码**
     （就是之前 `﻿` 那次）。Targets.tsx 的正则因此可以安全内嵌。
  4. 旧档案的 SHA 永远留在 Vercel 内容库：回滚 = 用上一版 manifest 的 SHA（styles.css `90e574f0…`、App `88d82618…`、Manager `8f2c7816…`、
     Payables `f56a059a…`、Receivables `2f73513c…`、Targets `97728c17…`、EcomReport `af6ac3a8…`、BranchActual `95bffc11…`、
     PriceEffect `3e635a1d…`，完整值见 git 上一版 `deploy_manifest.json`）重建一次全参照部署，或在 Vercel 后台把
     `dpl_9yWDzWupZUkuTBGBkHr3LjP1bgcx` promote 回 production。
