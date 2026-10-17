# 仓库成本只给老板（交接说明）

**给谁看**：把这个 ZIP 上传到「员工多部门功能开发」（营运系统 `portal/`、分支 `claude/gifted-faraday-b16op8`、Vercel 专案
`homeworks-ops`）那个 Claude 对话，跟它说：「照 HANDOFF.md 把仓库成本只给老板合并进来、测试、部署」。

使用者（Leslie）2026-10-16 附「库存总表」与「旧货」截图：「这两个地方都看到成本，我都要收起来，不要让职员看到，包含店长」。

ZIP 里有：`wh-cost-owner-only.patch`（1 个 commit，`git am` 用，以 `a3f58a4 仓库把关：进货 / 出货都要有人核对，加今天要做与工作量` 为底）、`files/`（同样的改动、
完整档案，路径照 repo 根目录；你那边若已经改过同一个档，**不要直接覆盖**，照 patch 补那几行）。

（同一天使用者也要货架清单分区收放；你那边的 `ffc5cdc` 已经做好上线，这包**不含**货架的改动。2026-10-16 先给过一版以 `ffc5cdc` 为底的；你那边之后加了 `gate_test.sql`，`run.sh` 那行会冲突，所以 10-17 重新以 `a3f58a4` 为底再包一次，内容一样。）

---

## 1. 改了什么

**以前**：仓库「可审批」（仓库主管、管理层、店长）就拿得到成本。**现在**：只有 BI 名单 `bi.allowed_users` 上 role = `owner` 的人（目前只有
Leslie）拿得到。资料库就不回成本，不是只在画面藏。

| 地方 | 以前（可审批） | 现在 |
|---|---|---|
| 库存总表、下载 Excel | 成本值 | 只给老板 |
| 旧货 | 成本栏、上面三格 RM 金额 | 只给老板；**「标处理方式」照旧给仓库可审批**（以前跟成本绑在同一个变数，拆开了） |
| 滞销品 | 库存成本值 | 只给老板 |
| 总览 | 各仓位成本值 | 只给老板 |
| 查货 | 单位成本 | 只给老板 |
| 盘点纪录 / 差异审核 | 单位成本、成本差额 | 只给老板；**应有 / 差额件数照旧给可审批** |
| 盘点单明细 | 成本差额 | 只给老板 |
| 盘点统计 | 差异金额（KPI、常常不准的商品、每个人、每月） | 只给老板（多回 `show_cost`）；其他人画面没有金额，每月长条改用差异项数 |

订货模块的进货单价（`ops.sees_prices`，采购下单要用）**不在这次范围**，没动。

## 2. 资料库：正式环境已套

- `portal/supabase/migrations/20261019b_ops_cost_owner_only.sql` —— **正式环境 2026-10-16 已套**（Supabase migration `ops_cost_owner_only`）。
  **你那边不用再套。**
  - 新函数 `ops.sees_cost(ops.staff)`（security definer；authenticated 叫不到）。
  - DO 段读出 9 个函数的现行定义（`pg_get_functiondef`），只把判断成本的那几个字换掉，其余一字不动；找到的字数不对就整个停（函数被改过）、已经改过就跳过，
    所以可以重复套用。改到的：`ops_wh_aged`、`ops_wh_stock`、`ops_wh_stock_export`、`ops_wh_slow`、`ops_wh_overview`、`ops_wh_item`、
    `ops.wh_count_json`、`ops_wh_sheet_get`、`ops_wh_count_stats`。
- **以后新增或重写会回成本的函数，一律用 `ops.sees_cost(me)`**，不要再用「仓库可审批」判断。**如果你之后要重写上面任何一个函数**（例如改库存总表），
  记得保留 `ops.sees_cost(me)`，不然店长又会看到成本。新的 `tests/cost_test.sql` 会挡：
  - 静态检查：任何函数里有 `cost := lvl >= …` 或 `cost := ops.level_rank(…` 这种写法就失败；
  - 仓库主管（不在 BI 名单）与店长（BI 名单 role = manager、营运系统管理员）实测每个函数都没有成本、老板都有。
- 改到的测试（断言从「可审批看得到成本」改成「只有老板看得到」）：`wh_test`、`todo_test`（另加：只看的人不能标处理方式）、`receive_test`、`rpl_test`、
  `sheet_test`、`overview_test`、`tag_test`；`run.sh` 最后加跑 `cost_test.sql`。

## 3. 前端

| 档案 | 内容 |
|---|---|
| `portal/src/wh/CountStats.tsx` | 照 `show_cost` 显示金额（以前一律显示）。没有成本时：没有「差异金额」那格与栏位，每月表只有「差异」长条（件数）。 |
| `portal/src/wh-sheet-api.ts` | `CountStats.show_cost`；`top.value / abs_value`、盘点单明细 `diff_value` 可能是 null。 |
| `portal/src/wh/SheetDetail.tsx` | `diff_value` 是 null 就不显示。 |
| `portal/src/wh/Aged.tsx` | 下面的说明文字没有成本时不提成本。 |
| `portal/src/i18n-dict-more.ts`、`i18n-dict-whsheet.ts` | 新句子的英文。 |
| `Stock.tsx`、`Slow.tsx`、`Review.tsx`、`wh-overview-api.ts`、`wh-tag-api.ts` | 只改注释（「成本只给仓库可审批」→「只给老板」）；这些页本来就照资料库回不回成本显示。 |
| `CLAUDE.md` | 仓库那几段的「看成本」改掉，加一段「成本只给老板」。 |

**部署前的过渡**：资料库已经不给店长成本了。旧前端的库存总表、旧货、滞销品、总览、查货、差异审核本来就照资料库显示，**已经看不到成本**；
只有「盘点统计」旧前端还会显示「差异金额 RM 0.00」（数字是 0，不是真的成本），部署新前端后那格就没有了。

## 4. 合并步骤

1. 在 `claude/gifted-faraday-b16op8` 最新版上：`git am wh-cost-owner-only.patch`。冲突时以你那边为准，照 `files/` 的完整档补。
2. 资料库测试：`PGHOST=… PGPORT=… PGUSER=postgres sh portal/supabase/tests/run.sh`（最后印 `cost_test ok`）。
3. 前端：`cd portal && npm run build`。
4. 部署到 `homeworks-ops`（照 `portal/README.md` 的「部署」）。
5. 部署后验证：
   - 用仓库主管或店长帐号：库存总表、旧货、滞销品、总览、查货、盘点统计都**没有**成本 / 金额；旧货照样可以勾商品「标处理方式」。
   - 用老板帐号：上面都看得到成本。

## 5. 验证纪录（交出前做过的）

- **正式资料库**（只读，测试都在交易里回滚）：套用后 9 个函数都改用 `ops.sees_cost`、没有函数还用旧规则；`ops.sees_cost` 一般帐号叫不到。
  以 5 个帐号实际呼叫：Leslie（老板）库存总表 100 行有成本、旧货 300 行有成本（三格金额都有）、滞销品、总览、查货单位成本都有；
  ZI HONG（店长、管理员）、Luiguanpin（仓库主管）、JB 店长、Puchong 店长：每个函数都 `show_cost = false`、成本栏全是 null，旧货 `can_edit` 照旧 true。
- **多人审查**（3 个角度：成本还有没有别的出口、资料库正确性、前端；每个问题再由另一位试着推翻）：程式没有问题；确认 2 个测试缺口，都补了 ——
  ① 原本只测了不在 BI 名单上的仓库主管，把规则改成「在 BI 名单上」或「营运系统管理员」测试照样过 → 加店长（BI manager + 管理员）那段；
  ② 旧货 `can_edit` 跟成本拆开后没有测「只看的人不能标」→ 加了。三种改坏的写法（拿掉 role = owner、改成管理员、`can_edit` 写死 true）现在都会让测试失败。
  被推翻的：采购员读得到 BI 的库存视图（其实 `bi_is_allowed()` 只放 owner / manager，采购员拿不到）；每日盘点清单照库存值排顺序（不回任何金额，是盘点策略）。
- 本机 PostgreSQL：在 `a3f58a4`（含你的仓库把关 `20261020_ops_wh_gate.sql`）+ patch 上 `run.sh` 全部通过（含 `gate_test`、`cost_test`）；`npx tsc --noEmit`、`npm run build` 通过；改到的档都 ≤ 35 KB。仓库把关的新函数没有回任何成本。2026-10-17 再查正式环境：9 个函数仍用 `ops.sees_cost`、没有函数用旧规则。
- Playwright（模拟资料，1280 / 390px，中文与 EN）：盘点统计 `show_cost` = false / 旧资料库没有这个栏位：没有任何「RM」、栏位与表头对齐、每月长条用差异项数；
  = true：金额照旧。旧货没有成本时三格没有 RM、说明不提成本、照样可以勾选。EN 没有漏翻的中文。390px 没有横向卷动。
