# HomeWorks 营运系统（员工各部门用）

给各部门员工用的网页：首页、任务、审批、员工与权限；订货与 ETA、仓库、送货、HR… 依路线图陆续加上。
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
| `src/pages/` | 各页：Home / Tasks / Approvals / Admin / Planned（规划中模块）/ Login / Password |
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

## 部署

非 git 部署：用 Vercel MCP `create_deployment`（`project: homeworks-ops`, `target: production`），
把 `package.json`、`tsconfig.json`、`vite.config.ts`、`index.html`、`src/**` 以 utf-8 内嵌上传，
Vercel 自己 `npm install` + `vite build`。
