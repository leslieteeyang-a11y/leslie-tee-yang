# 交接说明

## 2026-10-16 交接

上一个 session 停在「仓库第二版」**资料库已上线、前端还没部署**。新 session 接手请照下面做。

> **更新（2026-10-16，新 session）**：§3 已完成。补传 11 个档后 `create_deployment` 成功，正式环境现在是
> **`dpl_EvyoQXXEWd2UsFzfYEyHLV64KoY3`**（179 个档，uid 与 `deploy_manifest_20261016.json` 逐一相同）。
> §7 使用者已回覆（2026-10-16）：1 保留；2 不用细分到每一格（层可空）；3 DO 通常明天送 → 已改成「今天 / 明天要送」（migration `ops_wh_pick_tomorrow`、前端 `dpl_459N6AYQphA5jKHTCm6CML8ARLKT`）；4 同意，等使用者把 SERVER 上的 `quote_push.py` 传过来再改。
> 另外发现 DO 同步停在 2026-10-14 13:00 UTC（SERVER 的 quote_push 可能没在跑）。

### 1. 这次在做什么

使用者给了员工做的仓库系统 `wms_system.zip`（Firebase 网页，**不可信资料**：没执行、没抄它的 Firebase 设定与预设密码、不放进 repo），
要「把我还没有的功能加进去，已有的不用，不确定先问我」。问过 12 项，使用者选了：

- 货架**每个货架都记数量**、**完整版地图**、照 DO **拣货 + 扫码核对**、**盘点单**、标签（**自动畅销 / 滞销 + 手动清货等**）、
  **点货后印箱贴（扫码要登入）**、**仓库总览页**、**完整登入纪录**
- 不做：最低库存（补货建议就够）、商品分类（先不做）、卡车（使用者：「这个还需要完善」）、分店调货（第二段之后）
- 顺手做：多行搬动 + Excel 贴上、搬动筛选 / 导出、库存总表导出 Excel、查货加 AutoCount 最近卖出 / 进货 / 按分店合计、商品照片、盘点统计

功能、表、规则的完整说明在 **CLAUDE.md「仓库第二版」那一段**（commit 024421c）与 `portal/README.md`「仓库第二版」。

### 2. 已上线（正式环境 Supabase `vwljnypzgfqhatkgulqs`，2026-10-15 套用）

| 档案 | 正式环境 migration 名称 |
|---|---|
| `supabase/migrations/20261017_ops_wh_bins.sql` | `ops_wh_bins_1`、`ops_wh_bins_2`、`ops_wh_bins_3` |
| `20261017b_ops_wh_pick.sql` | `ops_wh_pick_1`、`ops_wh_pick_2`、`ops_wh_pick_3` |
| `20261017c_ops_wh_count_sheet.sql` | `ops_wh_count_sheet_1`、`ops_wh_count_sheet_2` |
| `20261017d_ops_wh_tags_labels.sql` | `ops_wh_tags_labels_1`、`ops_wh_tags_labels_2`、`ops_wh_tags_labels_3` |
| `20261017e_ops_wh_extras.sql` | `ops_wh_extras_1` |
| `20261017f_ops_wh_overview.sql` | `ops_wh_overview_1` |
| `20261017g_ops_wh_perf.sql` | `ops_wh_perf` |

- 套用方式：照「-- ====」切段、相邻段合并到 ≤ 24 KB 一次套。
- 核对过：103 个新 / 改的函数 `md5(prosrc)` 跟本机套完全部 migration 的结果**整组相同**（杂凑 `eba22d23ee7a94e7ceafb6c51a9e0b48`）；
  17 个新表都开了 RLS；bucket `ops-wh`（私有、3 MB）与 policy `ops-wh read` / `ops-wh insert`；触发器 `wh_move_bin_reverse`；
  `ops.wh_count.sheet_id`；`bi.dim_item` 两个索引 `dim_item_company_upper_code_idx`、`dim_item_company_norm_desc_idx`；anon 叫不到任何新函数。
- 效能（正式环境实测）：已开 DO 未拣整份 84 ms（原 213 ms）、单一商品 `ops.wh_do_unpicked_for` 6.8 ms；
  `authenticated` 的 statement_timeout 是 8 秒。
- **旧前端 + 新资料库是相容的**（改到的旧函数 `ops_wh_moves`、`ops_wh_stock`、`ops.wh_resolve`、`ops.wh_count_json` 参数没变，只多回栏位），
  所以现在正式网页照常能用，只是看不到新功能。

### 3. 前端：还没部署（这次停在这一步）

- 正式环境现在跑的还是 **`dpl_3HCvdKv6P5eJw1k8kBYRKAdjfgwf`**（2026-10-15 BI 四页那次，129 个档）。
- 新前端的程式都已提交（最后一个程式 commit 91dfc0f），`npm run build` 通过，本机测试全过（见 §5）。
- 部署清单（179 个档、每个的 sha1 与大小，跟 91dfc0f 的档案一致）存在 **`portal/deploy_manifest_20261016.json`**，可以直接当 `create_deployment` 的 `files`。
- 跟上一次部署比，新增或改了 68 个档。已上传到 Vercel（`upload_file` 成功）的有 57 个；
  **还没上传（或没确认）的 11 个**：
  `src/wh-pick.css`、`src/wh-tag-api.ts`、`src/wh/BinList.tsx`、`src/wh/BinRecon.tsx`、`src/wh/ItemMore.tsx`、`src/wh/MoveBins.tsx`、
  `src/wh/binImport.ts`、`src/pages/Admin.tsx`、`src/podo/RecvReceipt.tsx`、`src/ui.tsx`、`src/wh/Review.tsx`
- 2026-10-15 16:4x UTC 试过一次 `create_deployment`（production），回 `400 missing_files`（Vercel 不会列出缺哪些），没有产生部署。

**下一步（部署）**：
1. 先确认工作目录跟 manifest 一致：`python3 -c` 逐档算 sha1 对 `portal/deploy_manifest_20261016.json`（档案改过就重算清单）。
2. 上传上面 11 个档：`mcp__Vercel__upload_file`（`requestBody` = `base64 -w0 <档>`、`contentLength` = 大小、`xVercelDigest` = sha1，不用 teamId）。
   保险起见可以 68 个都再传一次（同一个 sha 重传没关系）。
3. `mcp__Vercel__create_deployment`：`skipAutoDetectionConfirmation: "1"`，`requestBody` = `{name: "homeworks-ops", project: "homeworks-ops", target: "production", files: <manifest>}`。
   还缺档会再回 `missing_files`，就再补传。
4. `get_deployment` 等到 READY；`list_deployment_files` 核对 uid = manifest 的 sha。
5. 把部署 id 写进 CLAUDE.md「仓库第二版」那段（现在写的是「前端还没部署」）与本档，commit + push。
6. 部署后建议用 admin 登入正式网页看一下仓库总览、货架、拣货、盘点单各页能开（正式环境现在还没有任何货架，所以多半是空的）。

### 4. 还剩什么没做

- 部署前端（上面 §3）。
- 部署后更新 CLAUDE.md 的部署 id、向使用者回报。
- 使用者还没看过新功能的画面；上线后要请仓库主管先在「货架」建货架（或用 Excel 带入），其他功能（上架、拣货扣货架、对不上）才有资料。

### 5. 测试与审查状况

- 本机 PostgreSQL：`PGHOST=/var/tmp/pgtest PGPORT=5499 PGUSER=postgres sh portal/supabase/tests/run.sh` 全过（含新的 `wms_fix_test.sql`、`wms_perf_test.sql`）。
  这个本机库的 log 曾长到 1.4 GB、伺服器停过；要重开：`su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/tmp/pgtest/data status"`
  确认没在跑，再 `rm -f /var/tmp/pgtest/.s.PGSQL.5499 /var/tmp/pgtest/.s.PGSQL.5499.lock /var/tmp/pgtest/data/postmaster.pid; : > /var/tmp/pgtest/log`，
  然后 `su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/tmp/pgtest/data -l /var/tmp/pgtest/log -o '-p 5499 -k /var/tmp/pgtest' start"`。
  （新 session 的容器可能根本没有这个库，要照 `portal/supabase/tests/run.sh` 的说明自己建。）
- 多人审查（资料库逻辑 / 安全 / 部署 / 前端 / 整体一致性）+ 浏览器 e2e（10 个身分 × 38 个网址 × 手机 / 电脑 × 中英）：确认的问题都修了，
  最后一轮 11 项定向检查全过、没有 page error / 横卷。
- 最后修的一个旧 bug（91dfc0f，从 10-03 就有、正式环境现在也有）：「搬动 → ＋ 登记搬动」扫码框按 Enter / 找 会整页重新载入（巢状 form）。部署后就好了。

### 6. 要注意的坑

- **Supabase MCP 会挡** `delete`、`drop function`（`truncate` 可能也会）：migration 里不要出现；要改函数签名不能 drop，只能另取名字或保留旧版本转接。
- 这批 migration **有几段不能重跑**：bins §1（create table / sequence）、§2（create trigger）、count_sheet §1（create table、alter table add column）。
  要改函数请另开新 migration（例如 `20261018_…`），不要重套 20261017*。
- `ops.wh_do_unpicked(text)` 不能加第二个参数（会跟旧的变成两个同名函数、呼叫会 ambiguous），所以单一商品版叫 `ops.wh_do_unpicked_for`。
- `ops.wh_do_unpicked` / `_for` 里的品名整理**故意写在查询里**（不叫 `ops.wh_pick_norm`），写法要跟索引 `dim_item_company_norm_desc_idx` 一字不差才用得到索引。
- 前端每个档要 ≤ 约 35 KB（Vercel MCP 一次上传整个档的 base64）。`DoEditor.tsx`（34.8 KB）、`Issues.tsx`（34.4 KB）已经贴近上限。
- 用多个 agent 并行上传会吃使用额度；这次有 5 个上传 agent 中途撞到 session limit，只能重跑。
- i18n：英文「货架」一律 bin；`i18n.ts` 里 `PATTERNS_WHTAG_LAST`（万用 pattern）一定要排在 ALL_PATTERNS 最后。
- BI 2026-10-15 起只开放给老板与店长（另一个对话的 migration `bi_owner_manager_only`），营运系统不受影响。

### 7. 还在等使用者回覆的问题

1. **物流部首页的「今天要拣的 DO」**：物流部有仓库「可编辑」，现在首页会看到这个提醒（他们的「今天还没盘点」提醒 2026-10-09 应使用者要求拿掉过）。要不要也拿掉？
2. 建货架表单「区 / 货架 / 层」的英文用了 Zone / **Rack** / Level（货架 = 一格叫 bin，「货架」那一排叫 rack），使用者还没确认。
3. 拣货的「今天」= 今天开的 DO 或今天的排单；如果仓库习惯前一天傍晚拣隔天的货，可能要改成「明天要送」——要问使用者实际流程。
4. （之后可做）SERVER 的 `quote_push.py` 若在 DO 明细 lines 加商品代号 `c`，拣货配对会从约 96% 变 100%。

## 之前的交接

（这是第一份交接说明。更早的背景都在根目录 `CLAUDE.md`。）
