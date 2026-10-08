# 送货安装模块 → HomeWorks 营运系统（交接说明）

**给谁看**：把这个 ZIP 上传到「员工多部门功能开发」（营运系统 `portal/`、分支 `claude/gifted-faraday-b16op8`、Vercel 专案
`homeworks-ops`）那个 Claude 对话，跟它说：「照 HANDOFF.md 把送货安装模块合并进来、测试、部署」。

使用者（Leslie）的原话：「帮我把这个送货的功能给我一个 zip，我要把他跟员工多部门功能开发，连在一起，不要分成两个地方」。

---

## 1. 这个模块做什么

营运系统侧栏原本的「送货安装（规划中）」变成真的模块，路由 `#/delivery/<分页>`：

| 分页 | 谁看得到 | 做什么 |
|---|---|---|
| 排单（只看的人显示「查单」） | 送货模块 ≥ 只看 | 整串贴 DO 单号（只打数字尾码也可）→ 自动找顾客与送货地址 → OpenStreetMap 找坐标 → 排最短路线 → 每站可改地址、写「给司机的备注」→ 选司机 → **WhatsApp 整张清单**（每站完整货品、备注、DO Remark、Waze 连结、Google Maps 全程路线、签收连结）或复制清单。只看的人只能查 DO 与地址。 |
| 排单纪录 | ≥ 只看 | 近 14 天每一趟、每站签收状态（已送达 / 送不成 + 时间 + 司机备注）、签收照片；可编辑的人可「载入到排单」（重排 / 补送）、再复制司机签收连结。只看的人在连结有效期间只看到照片张数（见第 2 节） |
| 我的送货 | 员工司机（送货部门、有手机号） | 派给自己、连结还有效的排单，直接签收（不用点 WhatsApp 连结） |
| 设定 | ≥ 可审批 | 出发点（排路线从这里开始）、外包司机（不是员工的司机） |

不用登入的 **司机签收页**：`#/driver?t=<24 字元代码>`（外包司机从 WhatsApp 点开；3 天有效）。每站：导航、打电话、逐项打勾对货、
拍照（压到 1280px JPEG）、「✓ 已送达」/「✗ 送不成」（送不成要写原因）、重新签收。自带 中 / EN / 马来文（不进 i18n 字典）。

首页：员工司机看到「🚚 我的送货 · 还有 N 站要送」；可编辑的人看到「今天 N 趟还没全部签收」（`ops_dlv_home`）。

## 2. 资料：不搬家、两边共用

- DO、地址、备注、排单、签收、照片都在 **BI 的 `bi.delivery_*` 表**（BI 分支 `claude/pensive-fermi-gtqw9c` 建的，见那边的
  `docs/bi_web/delivery.sql`）。SERVER 上的 `scripts/quote_push.py` 营业时间每 15 分钟从 AutoCount **只读**推 DO 进来
  （含 Deliver Address、DODTL 全部明细、表头 Remark1～4）。对 AutoCount 仍然只读。
- 送货地址顺序：店员手动改过的（只改那张 DO，同步不会盖掉）> DO 上的 Deliver Address > 顾客资料的地址。
- 营运系统只加一层 `public.ops_dlv_*` 函数，改用 **ops 的员工名单、模块权限、分店**：
  - 只看（销售 / 门市，部门预设已有）：查 DO 与地址、看排单纪录与进度
  - 可编辑（送货、仓库，部门预设已有）：排单、改这张 DO 的地址 / 备注、存坐标、传 WhatsApp
  - 可审批（主管、管理层）：出发点、外包司机
  - 分店照 `ops.sees_company`：只属 JB 的员工只看得到 JB 的 DO 与排单
- 司机：送货部门、有填手机号码的在职员工（`bi.delivery_run.driver_staff_id`，登入后「我的送货」）＋ 外包司机 `bi.delivery_driver`。
- 签收沿用 BI 的 anon 函数 `bi_driver_run` / `bi_driver_pod` 与 Storage 私有 bucket `delivery-pod`（路径 `<代码>/…`）；
  营运员工看照片靠新 policy「delivery-pod ops read」（`ops_dlv_photo_ok`）。**照片路径里就是签收连结代码**，拿到路径就能用 anon 的
  `bi_driver_pod` 假签收，所以照片跟连结代码同一个规则（`ops.dlv_full_access`）：可编辑的人、这趟的司机，或连结已过期（3 天后）；
  只看的人在那之前只拿到张数（`photo_count`）。
- 查 DO 的函数不回传顾客资料的内部备注、DO 金额、业务员、客户代号（送货 / 仓库员工不该看到 BI 的财务数字）。
- 同一批单常被重复排（按两次 WhatsApp）：前端同样的站 + 司机再按一次沿用同一个连结、不另存；首页计数以「同一天同一门市的站」算。
- BI 那边的旧送货页（`homeworks-bi` 的 `/delivery.html`、`/driver.html`）**先留着**，资料相通（两边排的单、签收都看得到）。
  营运系统这边稳定后要不要关掉，由使用者决定。

## 3. 资料库：已经套到正式环境

- `portal/supabase/migrations/20261008b_ops_delivery.sql` —— **2026-10-08 已用 Supabase MCP 套用**，分三次：`ops_delivery`（第一版）+
  `ops_delivery_review_fixes` + `ops_delivery_fixes2`（两轮审查后的修正），三次合起来 = 这个档；另外 BI 的 `bi_driver_run` 每站多回传
  `geo`（migration `driver_run_geo`，只多一个栏位，BI 旧页不受影响）。
  并用真实资料验证过（admin 看得到两间分店、JB 门市被挡在总部之外、排单纪录 / 签收进度正确）。内容可以重复套用
  （`create or replace` / `if not exists`），不含 DROP / DELETE。
- `portal/supabase/migrations/20261008c_ops_delivery_ready.sql` —— 把 `ops.module` 的 `delivery` 设成 `ready = true`。
  **还没套**：要等前端部署好再套（先套的话，旧前端点侧栏会进「没有权限」页）。

## 4. 合并步骤（给营运系统那边的 Claude）

ZIP 里有：`delivery-module.patch`（`git am` 用）、`files/`（同样的改动、完整档案，路径照 repo 根目录；`files/portal/src/App.tsx` 等
「改到的旧档」是以 `118aaca` 为底的完整版，你那边若已经改过这些档，**不要直接覆盖**，照下面「改到的旧档」补那几行）。
交出前已在 `claude/gifted-faraday-b16op8` 最新版（`118aaca`）上实测：`git am` 无冲突、`run.sh` 全部通过（含 `dlv_test ok`）、`npm run build` 通过。

1. 在 `claude/gifted-faraday-b16op8` 最新版上：`git am delivery-module.patch`（这个 patch 以 `118aaca 加入申请改成批准时才建登入账号`
   为底，只改了 6 个旧档的几行，其余都是新档）。冲突时以你那边的最新版为准，照下面「改到的旧档」手动补上那几行。
2. 资料库测试：`PGHOST=… PGPORT=… PGUSER=postgres sh portal/supabase/tests/run.sh`（最后会印 `dlv_test ok`）。
3. 前端：`cd portal && npm run build`。
4. 部署到 `homeworks-ops`（照 `portal/README.md` 的「部署」）。新档：`src/pages/Delivery.tsx`、`src/dlv/*.tsx`（6 个）、
   `src/dlv-api.ts`、`src/dlv.css`、`src/i18n-dict-dlv.ts`；改到的档：`src/App.tsx`、`src/pages/Home.tsx`、`src/i18n.ts`。
5. 部署成功后，用 Supabase MCP `apply_migration` 套 `20261008c_ops_delivery_ready.sql`（名称 `ops_delivery_ready`）。
6. 把 CLAUDE.md 的「送货安装」那段留着（patch 里有），之后的人才知道资料在 BI 表。

### 改到的旧档（patch 冲突时手动补）

- `portal/src/App.tsx`：import `Delivery`（`./pages/Delivery`）与 `{ DriverPage }`（`./dlv/DriverSign`）；
  在 `if (session === undefined)` **之前**加 `if (route.startsWith("/driver")) return <DriverPage key={route} />;`；
  switch 加 `case "delivery": page = can(me, "delivery", "view") ? <Delivery me={me} sub={arg} /> : <NoAccess />; break;`
- `portal/src/pages/Home.tsx`：import `{ DeliveryHomeCard }`（`../dlv/HomeCard`），在 `<AttCard>` 后面放 `<DeliveryHomeCard me={me} />`。
- `portal/src/i18n.ts`：import `{ DICT_DLV, PATTERNS_DLV }`（`./i18n-dict-dlv`），DICT 最前面展开 `...DICT_DLV`、ALL_PATTERNS 最前面 `...PATTERNS_DLV`；
  `translateNode` 开头加「`translate="no"` 的区块不翻」（司机签收页自带中 / 英 / 马来文）。
- `portal/supabase/tests/run.sh`：最后加一行跑 `dlv_test.sql`。
- `portal/supabase/tests/stub_supabase.sql`：最后加「送货安装」那一段（BI 送货表与 `storage.foldername` 的 stub）。
- `portal/README.md`、`CLAUDE.md`：加送货安装的说明。

## 5. 上线后请使用者做的设定

1. **员工司机**：「员工与权限」→ 把司机的部门设成「送货安装」、填手机号码（WhatsApp 用）、开通登入。
2. **外包司机**：「送货安装 → 设定 → 外包司机」新增（BI 那边加过的外包司机「ming」已经在，不用重加）。
3. **出发点**：「送货安装 → 设定」填总部（和 JB）的地址或贴 Google Maps 坐标。
4. 自己当司机试一趟：排一张单 → 选自己 → WhatsApp → 点连结拍照签收 → 回「排单纪录」看照片。

## 6. 验证纪录（交出前做过的）

- **多人审查**：5 位审查者分别看安全、SQL、前端、英文翻译、跟 BI 旧版的差异，每个问题再由另一位试着推翻；确认的 21 项都已修正
  （最重要：只看的人能从照片路径拿到签收连结代码而假签收；查 DO 回传了内部备注与金额；换分页会清掉排到一半的单；重复按 WhatsApp
  会重复存排单、首页计数灌水；找位置期间改的地址会被盖掉；英文模式的确认框、司机页错误讯息没翻）。修正后再由另一组检查。

- 本机 PostgreSQL 跑 `portal/supabase/tests/run.sh`：原有全部测试 + 新的 `dlv_test.sql` 通过（权限分级、分店、司机、连结代码只给可编辑的人、
  照片权限、首页计数、外包司机分店、错误讯息）。
- `npm run build`（tsc + vite）通过。
- Playwright（手机 390px、模拟资料）：中文与 EN 模式各跑一遍——一键排单、找不到 / 已取消 / 没地址提示、备注与地址储存、选员工司机、
  WhatsApp 讯息（含完整货品、备注、签收连结）、排单纪录看照片、设定新增外包司机、我的送货、只看的人只能查单、不用登入的司机签收页
  （拍照上传 + 已送达）。EN 模式下剩下的中文都是资料（员工名字、司机写的备注）。
- 正式资料库唯读验证（交易最后回滚）：查 DO、今天 19 张 DO、排单纪录与签收数、JB 员工被挡。
