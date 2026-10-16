# 仓库：成本只给老板 + 货架清单分区收放（交接说明）

**给谁看**：把这个 ZIP 上传到「员工多部门功能开发」（营运系统 `portal/`、分支 `claude/gifted-faraday-b16op8`、Vercel 专案
`homeworks-ops`）那个 Claude 对话，跟它说：「照 HANDOFF.md 把仓库成本与货架分区合并进来、测试、部署」。

使用者（Leslie）2026-10-16 的两个要求：

1. （附「仓库 → 货架 → 货架清单」截图）「仓库货架清单，需要分成三个区，5区，6区，3区（三个工厂），要做成收放功能，以方便查询」。
2. （附「库存总表」与「旧货」截图）「这两个地方都看到成本，我都要收起来，不要让职员看到，包含店长」。

ZIP 里有：`wh-cost-bins.patch`（3 个 commit，`git am` 用，以 `07ac62e 顾客资料第二版前端部署：记下部署编号与清单` 为底）、`files/`（同样的改动、
完整档案，路径照 repo 根目录；你那边若已经改过同一个档，**不要直接覆盖**，照 patch 补那几行）。

---

## 1. 成本只给老板（资料库**正式环境已套**，前端要部署）

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

### 资料库

- `portal/supabase/migrations/20261019b_ops_cost_owner_only.sql` —— **正式环境 2026-10-16 已套**（Supabase migration `ops_cost_owner_only`）。
  **你那边不用再套。**
  - 新函数 `ops.sees_cost(ops.staff)`（security definer；authenticated 叫不到）。
  - DO 段读出 9 个函数的现行定义（`pg_get_functiondef`），只把判断成本的那几个字换掉，其余一字不动；找到的字数不对就整个停（函数被改过）、已经改过就跳过，
    所以可以重复套用。改到的：`ops_wh_aged`、`ops_wh_stock`、`ops_wh_stock_export`、`ops_wh_slow`、`ops_wh_overview`、`ops_wh_item`、
    `ops.wh_count_json`、`ops_wh_sheet_get`、`ops_wh_count_stats`。
- **以后新增或重写会回成本的函数，一律用 `ops.sees_cost(me)`**，不要再用「仓库可审批」判断。新的 `tests/cost_test.sql` 会挡：静态检查（任何函数里
  `cost := lvl >= …` 或 `cost := ops.level_rank(…` 这种写法就失败）＋ 仓库主管实测每个函数都没有成本、老板都有。**如果你那边之后要重写上面任何一个函数**
  （例如改库存总表），记得保留 `ops.sees_cost(me)`，不然店长又会看到成本。
- 改到的测试（断言从「可审批看得到成本」改成「只有老板看得到」）：`wh_test`、`todo_test`、`receive_test`、`rpl_test`、`sheet_test`、`overview_test`、
  `tag_test`；`run.sh` 最后加跑 `cost_test.sql`。

### 前端

| 档案 | 内容 |
|---|---|
| `portal/src/wh/CountStats.tsx` | 照 `show_cost` 显示金额（以前一律显示）。没有成本时：没有「差异金额」那格与栏位，每月表只有「差异」长条（件数）。 |
| `portal/src/wh-sheet-api.ts` | `CountStats.show_cost`；`top.value / abs_value`、盘点单明细 `diff_value` 可能是 null。 |
| `portal/src/wh/SheetDetail.tsx` | `diff_value` 是 null 就不显示。 |
| `portal/src/wh/Aged.tsx` | 下面的说明文字没有成本时不提成本。 |
| `portal/src/i18n-dict-more.ts`、`i18n-dict-whsheet.ts` | 新句子的英文。 |
| `Stock.tsx`、`Slow.tsx`、`Review.tsx`、`wh-overview-api.ts`、`wh-tag-api.ts` | 只改注释（「成本只给仓库可审批」→「只给老板」）；这些页本来就照资料库回不回成本显示。 |
| `CLAUDE.md` | 仓库那几段的「看成本」改掉，加一段「成本只给老板」。 |

**部署前的过渡**：资料库已经不给店长成本了，旧前端的库存总表、旧货、滞销品、总览、查货、差异审核本来就照资料库显示，**已经看不到成本**；
只有「盘点统计」旧前端还会显示「差异金额 RM 0」（数字是 0，不是真的成本），部署新前端后就没有那格。

## 2. 货架清单：每个区可以收起 / 展开（只有前端）

| 档案 | 内容 |
|---|---|
| `portal/src/wh/BinList.tsx` | 每个区变成一行可以点的标题：「▸ 5 区　56 个货架 · 3 个有货 · 12 件」（有停用的再加「· N 个已停用」）。点了展开 / 收起。 |
| `portal/src/wh-bin.css` | 区标题那一行的样式（整行可以点，展开时底色改成 `--primary-soft`）。颜色都用原本的变数。 |
| `portal/src/i18n-dict-whbin.ts` | 新字：「全选这区」「全部展开」「全部收起」、「N 个已停用」。 |

规则：
- **预设收起**，记住每个人上次展开了哪些区（`localStorage` 的 `hw-bin-open:<公司>`，读不到就当全部收起）。
- 一个仓位只有一个区（例如 HQ）就直接展开，不用点。
- **找货架代号时**，所有区都展开（只看得到符合的货架），「全部展开 / 全部收起」暂时藏起来。
- 区照数字排：3 区、5 区、6 区（没分区的放最后）。
- 印货架标签：「全选（看得到的）」只选**展开的区**；每个区标题旁边多「全选这区」；**印出来的顺序跟画面一样**（3 区、5 区、6 区）。
- 用「建货架」/「一次建很多」建好后，**那个区自动展开**。

**3 区还没有货架**（正式环境 2026-10-16：SRGADING 只有 5 区 56 个、6 区 65 个；A～K 区是之前试建、已停用的）。3 区要由主管用
「一次建很多」建（区填 `3`），建好就会自动出现在清单里、自动展开，不用改程式。

## 3. 合并步骤

1. 在 `claude/gifted-faraday-b16op8` 最新版上：`git am wh-cost-bins.patch`。冲突时以你那边为准，照 `files/` 的完整档补。
2. 资料库测试：`PGHOST=… PGPORT=… PGUSER=postgres sh portal/supabase/tests/run.sh`（最后印 `cost_test ok`）。
3. 前端：`cd portal && npm run build`。
4. 部署到 `homeworks-ops`（照 `portal/README.md` 的「部署」）。
5. 部署后验证：
   - 用仓库主管或店长帐号：库存总表、旧货、滞销品、总览、查货、盘点统计都**没有**成本 / 金额；旧货照样可以勾商品「标处理方式」。
   - 用老板帐号：上面都看得到成本。
   - 「仓库 → 货架 → 货架清单」：SRGADING 下面是收起来的 5 区、6 区两行，点了会展开。

## 4. 验证纪录（交出前做过的）

（交出前补上）
