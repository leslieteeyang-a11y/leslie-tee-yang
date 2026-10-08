-- 送货模块上线开关（2026-10-08）：前端（src/pages/Delivery.tsx 等）部署到 homeworks-ops 之后再套这个档。
-- 先套的话，侧栏「送货」会连到 #/delivery，但旧版前端没有这一页（显示「没有权限」）。
-- 使用者 2026-10-08：「只要送货，没有安装」→ 模块名称由「送货安装」改成「送货」。
update ops.module
   set ready = true,
       name = '送货',
       description = '送货排单（DO 单号 → 最短路线 → WhatsApp 司机）、司机签收拍照、送货纪录'
 where key = 'delivery';
