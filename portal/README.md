# HomeWorks 营运系统（员工各部门用）

给各部门员工用的网页：首页、任务、审批、员工与权限、订货与 ETA、打卡；仓库、送货、HR… 依路线图陆续加上。
与 HomeWorks BI 用同一个 Supabase 专案、同一套登入，但**员工名单分开**（`ops.staff`），
所以仓库、HR 的员工进得了营运系统，却看不到 BI 的财务数据。

- 网址：Vercel 专案 `homeworks-ops`（team leslie-tee）→ https://homeworks-ops.vercel.app
- 前端：Vite + React 18 + supabase-js（`src/`），hash 路由（`#/tasks`），手机可用
- 资料：Supabase schema `ops`，前端只能透过 `public.ops_*` 函数读写，权限都在资料库里检查
- 开账号：Edge Function `ops-account`（管理员在「员工与权限」按「开通登入 / 重设密码」）

## 目录

| 路径 | 用途 |
|---|---|
| `src/api.ts` | 型别与所有 `ops_*` 呼叫 |
| `src/pages/` | 各页：Home / Tasks / Approvals / Purchasing（订货与 ETA）/ Attendance（打卡）/ Admin / Planned（规划中模块）/ Login / Password |
| `src/att/`、`src/att-api.ts`、`src/att.css` | 打卡模块：Today（打卡、补下班卡、外勤签到）、Camera（自拍）、Records（逐日纪录、月报 CSV）、Board（团队今天）、Corrections（补卡）、Settings（HR 设定） |
| `src/podo/`、`src/podo-api.ts`、`src/podo.css`、`src/i18n-dict-podo.ts` | 订货页的厂家到货（`#/purchasing/do`、`/do/new`、`/do/<id>`：选厂家 → 选 PO → 上传厂家 DO → 分给各分店 → 确认）、厂家问题（`/issues`：按厂家分组、厂家会补 / 取消、Excel、打印）、在路上（`/transit`：JB 只看 JB）。`podo/parse.ts` 在浏览器读 Excel / CSV（SheetJS CE 0.20.3，npm 套件 `@e965/xlsx`，动态载入）；档案放 Storage 私有 bucket `ops-po`。这四个画面用 `React.lazy`，点到才下载。在路上的算法（同厂家同型号一起算、起算点）写在 migration `20261012_ops_po_do.sql` §3 |
| `src/pages/Delivery.tsx`、`src/dlv/`、`src/dlv-api.ts`、`src/dlv.css` | 送货：Plan（一键排单、最短路线、WhatsApp 司机）、Runs（排单纪录、签收照片）、Mine（员工司机签收）、Setup（出发点、外包司机）、DriverSign（司机签收页，`#/driver?t=` 不用登入）、HomeCard（首页提醒） |
| `src/rpl/`、`src/rpl-api.ts`、`src/rpl.css`、`src/wh/Stock.tsx`、`src/wh/Slow.tsx`、`src/i18n-dict-rpl.ts` | 2026-10-14 从 BI 搬来的四页：订货模块的「补货建议」（`#/purchasing/replenish`）与「供应商交期」（`/leadtime`，只有看得到厂家的人有这页）、仓库模块的「库存总表」（`#/warehouse/stock`）与「滞销品」（`/slow`）。资料仍是 BI 同步进来的 `bi.*` 表，算法沿用 BI 的视图（`bi.v_purchase_suggest`）；函数 `ops_rpl_*` / `ops_wh_stock` / `ops_wh_slow` 在 migration `20261016_ops_bi_pages.sql`。补货建议与供应商交期用 `React.lazy` |
| `supabase/migrations/` | 已套用到 Supabase 的 migration 留底（改动请另开新档，并用 MCP `apply_migration` 套用） |
| `supabase/functions/ops-account/` | 建账号 / 重设密码的 Edge Function |
| `supabase/tests/` | 本机 PostgreSQL 跑的权限测试（stub 掉 Supabase 的 auth 与 BI 表） |

## 权限模型

- 模块权限四级：无 / 只看 / 可编辑 / 可审批
- 部门预设（「员工与权限 → 部门权限」表格）+ 个人例外（员工资料里的「个人权限例外」）
- 角色：`admin` 全开；`manager` 在部门「可编辑」的模块自动升为「可审批」；`staff` 照部门预设
- 分店：`HOMEWORKSSB`（总部）、`HOMEWORKSSOUTHERN`（JB）、`ALL`；只看得到自己分店的任务与申请
- 审批：不能批自己的；指定审批人、该部门主管、管理层、admin 可批

## 开发与测试

```sh
npm install
npm run dev          # http://localhost:5173（连正式 Supabase，要用真账号登入）
npm run build        # 型别检查 + 打包

# 资料库权限测试（需要本机 PostgreSQL）
PGHOST=... PGPORT=... PGUSER=postgres sh supabase/tests/run.sh
```

## 打卡（移植自 AttendX）

- 员工：按「上班 / 下班」→ 读 GPS → 前镜头自拍 → 照片上传到 Storage `ops-hr/<staff_id>/<日期>/…` → `ops_att_punch`。
  上班卡要在分店打卡点范围内（免打卡范围的人除外）；中午 11:00–15:00 下班再上班 = 午休。
- 之前有一天没打下班卡 → 挡住今天的上班卡，要先「补下班卡」（立刻生效，主管 / HR 驳回就还原）。
- 补卡：员工 14 天内自己申请 → 直属主管（没设就是部门主管）→ HR 定案；HR 可以改定案时间、替员工申请。
- 主管 / HR：「团队今天」看谁还没打卡、迟到、照片；「月报」可下载 CSV。
- HR 设定：打卡点（站在现场按「用我现在的位置」）、班别、员工设定（班别、直属主管、免打卡范围、星期五午休、到职日）、
  每月上班星期六、公共假日。

## 中英双语

介面预设中文，右上角 / 侧栏 / 登入页有「中文 | EN」切换。做法是 DOM 翻译层（`src/i18n.ts`）：
只翻整段完全等于字典键的文字，员工输入的内容保持原文。新增或修改介面文字时，同步更新
`src/i18n-dict-a.ts`（共用、首页、任务、审批、登入）、`src/i18n-dict-b.ts`（订货、员工与权限）、
`src/i18n-dict-db.ts`（数据库来的模块 / 部门名称与错误讯息）、`src/i18n-dict-att.ts` / `src/i18n-patterns-att.ts`（打卡模块）或 `src/i18n-patterns.ts`（带数字的句子）。

## 部署

非 git 部署：用 Vercel MCP `create_deployment`（`project: homeworks-ops`, `target: production`），
把 `package.json`、`tsconfig.json`、`vite.config.ts`、`index.html`、`src/**` 以 utf-8 内嵌上传，
Vercel 自己 `npm install` + `vite build`。
- **不要带 `teamId` 参数**：这个 MCP 连线带 teamId 时读专案会 404、正式部署会 403；不带就正常。
- **推荐做法**：改过的档先逐一 `upload_file`（base64 内容 + `xVercelDigest` = SHA1），再 `create_deployment`
  全部用 `{file, sha, size}` 参照（没改的档沿用上一版的 SHA）。每次呼叫都很小，不会因内容太大而中断。
  `public/` 底下的档要保留 `public/` 前缀。部署后用 `list_deployment_files` 核对每个档的 uid（= SHA1）与本机一致。
- 新功能尽量放新的小档（例：`src/sync.tsx`、`src/extra.css`），少动大档，部署时要上传的量就小。

## 送货（2026-10-08 上线；原名「送货安装」，不做安装）

- 资料与 HomeWorks BI 共用（`bi.delivery_*`）：SERVER 的 `scripts/quote_push.py`（BI 分支）营业时间每 15 分钟从 AutoCount 只读推 DO。
- 店员：整串贴 DO 单号（只打数字尾码也可）→ 找顾客与送货地址（手动改过的 > DO 的 Deliver Address > 顾客资料）→ OpenStreetMap 找坐标
  （每秒 1 次）→ 最近邻 + 2-opt 排顺序（直线距离）→ 选司机 → WhatsApp 整张清单（每站货品、备注、Waze 连结、Google Maps 全程路线、签收连结）。
- 司机：员工司机（送货部 / 物流部、有手机号）登入在「我的送货」签收；外包司机用讯息里的 `#/driver?t=<代码>`（3 天有效，不用登入）。外包司机 store 为空 = 两间分店共用（只有分店 ALL 的人能改）。每站可打勾对货、拍照（压到 1280px）、
  按「已送达 / 送不成」（要写原因）。照片在 Storage 私有 bucket `delivery-pod/<代码>/`。
- 权限：`ops_dlv_*` 函数开头检查 `delivery` 模块等级与分店；签收连结代码只给可编辑的人与这趟的司机。照片路径里有连结代码，所以照片同样只给这些人（连结过期后只看的人也看得到）。
- 英文模式：`translate="no"` 的区块不翻（司机签收页自带中 / 英 / 马来文）；`window.confirm` 用 `dlv-api.ts` 的 `ui()` 先翻。

## 从 BI 搬来的四页（2026-10-14）

老板决定把 BI 的「订货 / 库存 / 滞销品」搬到营运系统，BI 那边拿掉。搬法与权限：

- **补货建议**（订货 → 补货建议）：近 90 天走量 ≥ 门槛（10 / 30 / 100）、或欠分行、或现存 ≤ 0 的商品，按急迫度排；
  已下单 / 暂不订 / 留言、商品设定（最小订量、包装数、不再提醒、指定供应商）写进 BI 的 `bi.buyer_*` 表（与 BI 共用）。
  订货「只看」可看；看不到厂家的人看不到供应商 / 厂号 / 在途 PO 号；看不到进货单价的人看不到上次单价；
  改动要订货「可编辑」。**撤销是软撤销**（`bi.buyer_item_action.undone_at / undone_by`，视图不再算它）：
  Supabase MCP 的 `apply_migration` 看到 `delete` 会等人确认，无人确认整段取消，所以不用 delete。
- **供应商交期**（订货 → 供应商交期）：交期 / 安全 / 覆盖 / 订货周期、品牌 → 默认供应商；看得到厂家的人可看，订货「可编辑」可改。
- **库存总表**（仓库 → 库存总表）：商品 × 仓位现存量、售价 P2–P4、负库存筛选、搜寻；成本只给仓库「可审批」。
- **滞销品**（仓库 → 滞销品）：最后进货超过 6 / 3–6 个月还没售完；成本只给仓库「可审批」。
- BI 的 `public.bi_purchase_suggest` 拆成 `bi.v_purchase_suggest`（只算）+ 原视图（加 BI 名单检查），栏位不变，
  老板在 BI 看到的数字与之前一样（2,590 行对 2,590 行）。
- Migration 已分六段套到 Supabase（`ops_bi_pages_1_views` ～ `ops_bi_pages_6_grants`），档案 `20261016_ops_bi_pages.sql` 可重跑。
  测试 `supabase/tests/rpl_test.sql`（stub 补了 `bi.mv_purchase_sold`、`bi.buyer_*` 等表）。
- 合并后审查修正 `20261016c_ops_bi_pages_fix.sql`（正式环境 `ops_bi_pages_7_fix`，已套；要在 `20261016_ops_bi_pages.sql` 之后）：
  补货建议的留言 / 商品备注 / 记录人只给看得到厂家的人（常写厂家名与 PO 号）；库存总表每行多回 `item_total`（商品全部仓位合计，
  不受分页与「只看负库存」影响）。
