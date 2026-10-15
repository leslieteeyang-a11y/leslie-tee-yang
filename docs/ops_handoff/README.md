# 交接：BI 的订货 / 库存 / 滞销品搬到营运系统（2026-10-14）

老板 2026-10-14 决定「把订货、滞销品、库存这三个移到员工多部门功能那边，BI 那边去掉」。
营运系统（`portal/`，Vercel 专案 `homeworks-ops`）由另一个 session「员工多部门功能开发」维护，分支
`claude/gifted-faraday-b16op8`；本 session 不直接推那条分支，改把完整改动做成一个 commit 的 patch 放在这里：

- `0001-bi-pages-to-ops.patch`：以 `claude/gifted-faraday-b16op8` 的 `3e0352b`（顾客资料模块之后）为基底，
  `git am -3` 可直接套上；16 个档案（README、migration、测试、四个页面、API、CSS、字典、三处分页接线）。
- Supabase 端的 migration **已经套用**（分六段：`ops_bi_pages_1_views` ～ `ops_bi_pages_6_grants`），
  营运系统那边只要合并程式、建置、部署即可；不用再 apply。

## 请老板贴进「员工多部门功能开发」session 的话

```
请把 BI 的订货 / 库存 / 滞销品四页合并进来并部署：另一个 session 已把改动做成 patch，
放在分支 claude/monthly-data-prep-vtcnct 的 docs/ops_handoff/0001-bi-pages-to-ops.patch。

1. git fetch origin claude/monthly-data-prep-vtcnct
   git show origin/claude/monthly-data-prep-vtcnct:docs/ops_handoff/0001-bi-pages-to-ops.patch > /tmp/bi-pages.patch
   git am -3 /tmp/bi-pages.patch
   （如果你的分支已经比 3e0352b 更新而有冲突，照 portal/README.md「从 BI 搬来的四页」那节的说明解；
   run.sh 与 stub_supabase.sql 两档是两边都加了东西，保留两边即可。）
2. cd portal && npm run build；再跑 supabase/tests/run.sh（应该看到 cust_test ok 与 rpl_test ok）。
3. Supabase 的 migration 20261016_ops_bi_pages.sql 已套用（ops_bi_pages_1_views ～ 6_grants），不用再 apply；
   若要确认：select proname from pg_proc where proname like 'ops_rpl_%' 应有 8 个函数，另有 ops_wh_stock / ops_wh_slow。
4. 照你平常的方式部署 homeworks-ops，然后用老板帐号检查：
   订货 → 补货建议（门槛 30 约 850 项、门槛 10 约 1,150 项，厂号下拉约 50 个）、订货 → 供应商交期（约 110 家）、
   仓库 → 库存总表（搜 HM-UB001 有结果、可审批看得到成本）、仓库 → 滞销品（6 个月以上约 1,400 项）。
5. 部署好、画面正常后回报一句「ops 四页已上线」，BI 那边才会把订货 / 库存 / 滞销品三个分页拿掉。
```

## 营运系统这边的设计（细节在 patch 里的 portal/README.md）

| 营运系统分页 | 原 BI 分页 | 谁能看 | 谁能改 |
|---|---|---|---|
| 订货 → 补货建议 `#/purchasing/replenish` | 订货 | 订货「只看」以上；看不到厂家的人没有供应商 / 厂号 / 在途 PO 号，看不到进货单价的人没有上次单价 | 订货「可编辑」：已下单 / 暂不订 / 留言、商品设定；撤销限本人或「可审批」 |
| 订货 → 供应商交期 `#/purchasing/leadtime` | 订货页下半的供应商设定 | 看得到厂家的人 | 订货「可编辑」 |
| 仓库 → 库存总表 `#/warehouse/stock` | 库存 | 仓库「只看」以上 | （只读）成本只给仓库「可审批」 |
| 仓库 → 滞销品 `#/warehouse/slow` | 滞销品 | 仓库「只看」以上 | （只读）成本只给仓库「可审批」 |

- 资料仍是 BI 同步进来的 `bi.*` 表；补货建议的算法拆成 `bi.v_purchase_suggest`（只算），BI 原视图 `public.bi_purchase_suggest`
  改读它并保留 BI 名单检查，栏位不变（老板在 BI 看到 2,590 行，改前改后一样）。
- 已下单 / 暂不订 / 商品设定 / 供应商设定写进 BI 的 `bi.buyer_*` 表，与 BI 共用；`created_by / updated_by` = 员工 email。
- 撤销是软撤销（`bi.buyer_item_action.undone_at / undone_by`）：Supabase MCP 的 `apply_migration` 看到 `delete` 会等人确认，
  无人确认整段取消，所以不用 delete。品牌取消分配同理：行留着、`supplier_code` 清成 null。
- BI 端的拿掉（App.tsx 去掉 `buy` / `stock` / `slow` 三个分页与三个页面档、两本字典）已备好，等营运系统上线后才部署到 production。
