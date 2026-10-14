-- 顾客资料模块上线开关（2026-10-14）：前端（src/pages/Customers.tsx 等）部署到 homeworks-ops 之后再套这个档。
-- 先套的话，侧栏「顾客资料」会连到 #/customers，但旧版前端没有这一页（显示「没有权限」）。
update ops.module set ready = true where key = 'customers';
