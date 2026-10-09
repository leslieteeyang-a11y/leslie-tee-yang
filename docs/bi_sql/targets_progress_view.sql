-- 2026-10-08：「目标」分页（BI 网页 src/pages/Targets.tsx）读的进度视图。migration：targets_progress_view。
-- 一列 = 公司 × 月（马来西亚时间本月往前 12 个月 ～ 下个月，共 14 个月）× 范围：
--   scope='company' / scope_key='ALL'（公司总目标）＋ scope='channel' / scope_key=渠道名（每个有销售的渠道）。
-- 实际值来源：
--   src='sales'  （HOMEWORKSSB / HOMEWORKSSOUTHERN，fact_sales 有资料）→ bi.mv_targets_daily 的净额（IV + CS − CN，
--                 CN 的 sub_total 在 fact_sales 里已是负数），渠道 = bi.sale_channel()，与「门店」分页同口径。
--   src='branch' （HOMEWORKSKL 等 fact_sales 没资料、只有分行电脑推送的公司）→ bi.branch_actual_month 的
--                 scope='all' 各类别 actual_amount 合计（SO + 非SO发票 − 贷项）；该月在 bi.branch_actual_meta 有推送
--                 记录就算有资料（全 0 时 branch_actual_month 没有列，但 meta 有），只有公司总目标、没有渠道。
-- 栏位：
--   target          bi.target_month 的目标（没设 = null，前端显示「未设定」）
--   actual          本月至今 / 该月实际净额；该公司该月完全没资料 = null（未来月份也是 null）
--   pct             达成率 = actual / target
--   days_in_month / elapsed_days / remaining_days
--                   已过天数 = 资料最后一天（sales：fact_sales 最后有单据的日期；branch：分行电脑最后推送日；都不超过今天）
--                   在该月是第几天，当天也算一天（资料一天同步数次，当天大部分已进来）；过去的月份 = 整月，未来 = 0
--   as_of           资料截至日期
--   proj_linear     按目前速度预测月底 = actual ÷ 已过天数 × 当月天数（过去的月份 = actual）
--   proj_pct        预测达成率（前端灯号：≥100% 绿、90～100% 黄、<90% 红）
--   proj_ly         按去年同月每日分布预测 = actual × 去年同月整月 ÷ 去年同月 1 号到同一天的累计
--                   （只算本月、sales 公司；去年同月没资料或累计 ≤ 0 时 null。月初或去年同月前几天特别淡 / 旺时会偏离，仅供参考）
--   need_per_day    每天还需 = max(目标 − 至今, 0) ÷ 剩余天数（没目标或已无剩余天数 = null；未来月份 = 目标 ÷ 当月天数）
--   ly_full / ly_mtd 去年同月整月 / 去年同月同期累计
--   avg3            近 3 个月平均：该月（未来月份则以本月为准）之前 3 个完整月的平均，分母 = 该公司有资料的月数
--   branch_actual / branch_as_of  公司列才有：分行电脑推送的「实际销售」与推送日（JB 作参考，KL 就是 actual）
--   branch_channel_actual         公司列才有：其中「分行」渠道（总部卖给分行的集团内销售）的金额
-- 权限：security_invoker；bi.mv_targets_daily 没有 RLS，所以在 d 与最外层都加 bi_is_allowed() + bi_company() 公司过滤；
--       bi.target_month / branch_actual_* 本身有 RLS。没有成本 / 毛利栏，店长（manager）可看自己公司。
-- 效能：全部来自约 5,000 行的物化视图与几十行的小表，以 authenticated owner 跑 explain analyze 约 30～60ms。
create or replace view public.bi_targets_progress with (security_invoker = true) as
with p as (
  select (now() at time zone 'Asia/Kuala_Lumpur')::date                     as today,
         date_trunc('month', now() at time zone 'Asia/Kuala_Lumpur')::date  as cur_month
),
d as (
  select t.company, t.doc_date, t.channel, t.net
  from bi.mv_targets_daily t
  where (select public.bi_is_allowed())
    and ((select public.bi_company()) is null or t.company = (select public.bi_company()))
),
bm as (
  select m.company, m.month, (max(m.updated_at) at time zone 'Asia/Kuala_Lumpur')::date as pushed_on
  from bi.branch_actual_meta m
  group by m.company, m.month
),
ba as (
  select b.company, b.month, coalesce(sum(a.actual_amount), 0) as actual
  from bm b
  left join bi.branch_actual_month a on a.company = b.company and a.month = b.month and a.scope = 'all'
  group by b.company, b.month
),
dc as (
  select company, max(doc_date) filter (where doc_date <= (select today from p)) as last_date
  from d group by company
),
bc as (
  select company, max(pushed_on) as last_push from bm group by company
),
comp as (
  select c.company,
         case when dc.company is not null then 'sales' when bc.company is not null then 'branch' else 'none' end as src,
         least(coalesce(dc.last_date, bc.last_push), (select today from p)) as as_of
  from (select company from dc union select company from bc union select company from bi.target_month) c
  left join dc on dc.company = c.company
  left join bc on bc.company = c.company
),
months as (
  select gs::date as month
  from p, generate_series(p.cur_month - interval '12 months', p.cur_month + interval '1 month', interval '1 month') gs
),
mc as (
  select company, date_trunc('month', doc_date)::date as month, channel, sum(net) as net
  from d group by 1, 2, 3
),
mt as (
  select company, month, 'channel'::text as scope, channel as scope_key, net from mc
  union all
  select company, month, 'company', 'ALL', sum(net) from mc group by company, month
  union all
  select a.company, a.month, 'company', 'ALL', a.actual
  from ba a where a.company not in (select company from dc)
),
cm as (
  select distinct company, month from mt
),
keys as (
  select company, 'company'::text as scope, 'ALL'::text as scope_key from comp
  union
  select company, 'channel', channel from mc where month >= ((select cur_month from p) - interval '13 months')
  union
  select company, scope, scope_key from bi.target_month
),
g as (
  select k.company, c.src, c.as_of, m.month, k.scope, k.scope_key,
         (m.month + interval '1 month' - interval '1 day')::date as month_end
  from keys k
  join comp c on c.company = k.company
  cross join months m
),
g2 as (
  select g.*,
         extract(day from g.month_end)::int as dim,
         greatest(0, least(extract(day from g.month_end)::int, coalesce(g.as_of - g.month + 1, 0)))::int as elapsed
  from g
),
lyc as (
  select d.company, d.channel, sum(d.net) as net
  from d
  join comp c on c.company = d.company
  cross join p
  where d.doc_date >= (p.cur_month - interval '1 year')::date
    and d.doc_date <  (p.cur_month - interval '1 year')::date + greatest(0, least(c.as_of, (p.cur_month + interval '1 month' - interval '1 day')::date) - p.cur_month + 1)
  group by d.company, d.channel
),
r as (
  select g2.*,
         tg.amount as target, tg.updated_at as target_updated_at,
         case when exists (select 1 from cm where cm.company = g2.company and cm.month = g2.month)
              then coalesce(a.net, 0) end as actual,
         case when exists (select 1 from cm where cm.company = g2.company and cm.month = (g2.month - interval '1 year')::date)
              then coalesce(ly.net, 0) end as ly_full,
         (select sum(x.net) / nullif((select count(*) from cm y
                                       where y.company = g2.company
                                         and y.month >= (least(g2.month, (select cur_month from p)) - interval '3 months')::date
                                         and y.month <  least(g2.month, (select cur_month from p))), 0)
            from mt x
           where x.company = g2.company and x.scope = g2.scope and x.scope_key = g2.scope_key
             and x.month >= (least(g2.month, (select cur_month from p)) - interval '3 months')::date
             and x.month <  least(g2.month, (select cur_month from p))) as avg3,
         case when g2.scope = 'company' then
           (select sum(l.net) from lyc l where l.company = g2.company)
         else
           (select sum(l.net) from lyc l where l.company = g2.company and l.channel = g2.scope_key)
         end as ly_cum_cur,
         case when g2.scope = 'company' then
           (select b.actual from ba b where b.company = g2.company and b.month = g2.month) end as branch_actual,
         case when g2.scope = 'company' then
           (select least(b.pushed_on, g2.month_end) from bm b where b.company = g2.company and b.month = g2.month) end as branch_as_of,
         case when g2.scope = 'company' and g2.src = 'sales'
              and exists (select 1 from cm where cm.company = g2.company and cm.month = g2.month) then
           coalesce((select x.net from mt x where x.company = g2.company and x.month = g2.month
                       and x.scope = 'channel' and x.scope_key = '分行'), 0) end as branch_channel_actual
  from g2
  left join bi.target_month tg on tg.company = g2.company and tg.month = g2.month
                               and tg.scope = g2.scope and tg.scope_key = g2.scope_key
  left join mt a  on a.company = g2.company and a.month = g2.month
                 and a.scope = g2.scope and a.scope_key = g2.scope_key
  left join mt ly on ly.company = g2.company and ly.month = (g2.month - interval '1 year')::date
                 and ly.scope = g2.scope and ly.scope_key = g2.scope_key
),
r2 as (
  select r.*,
         case when r.elapsed >= r.dim then r.ly_full
              when r.month = (select cur_month from p) and r.src = 'sales' then coalesce(r.ly_cum_cur, 0)
         end as ly_mtd,
         case when r.actual is null or r.elapsed = 0 then null
              when r.elapsed >= r.dim then r.actual
              else r.actual / r.elapsed * r.dim end as proj_linear
  from r
)
select r2.company,
       r2.month,
       r2.scope,
       r2.scope_key,
       r2.src,
       r2.target,
       r2.actual,
       round(r2.actual / nullif(r2.target, 0), 4)                               as pct,
       r2.dim                                                                   as days_in_month,
       r2.elapsed                                                               as elapsed_days,
       r2.dim - r2.elapsed                                                      as remaining_days,
       case when r2.elapsed > 0 then least(r2.as_of, r2.month_end) end          as as_of,
       round(r2.proj_linear, 2)                                                 as proj_linear,
       round(r2.proj_linear / nullif(r2.target, 0), 4)                          as proj_pct,
       round(case when r2.actual is null or r2.elapsed = 0 then null
                  when r2.elapsed >= r2.dim then r2.actual
                  when r2.ly_mtd > 0 and r2.ly_full > 0 then r2.actual * r2.ly_full / r2.ly_mtd end, 2) as proj_ly,
       round(case when r2.actual is null or r2.elapsed = 0 then null
                  when r2.elapsed >= r2.dim then r2.actual
                  when r2.ly_mtd > 0 and r2.ly_full > 0 then r2.actual * r2.ly_full / r2.ly_mtd end
             / nullif(r2.target, 0), 4)                                         as proj_ly_pct,
       round(case when r2.target is null or r2.dim - r2.elapsed <= 0 then null
                  else greatest(r2.target - coalesce(r2.actual, 0), 0) / (r2.dim - r2.elapsed) end, 2) as need_per_day,
       r2.ly_full,
       r2.ly_mtd,
       round(r2.avg3, 2)                                                        as avg3,
       r2.branch_actual,
       r2.branch_as_of,
       r2.branch_channel_actual,
       r2.target_updated_at
from r2
where (select public.bi_is_allowed())
  and ((select public.bi_company()) is null or r2.company = (select public.bi_company()));

comment on view public.bi_targets_progress is '「目标」分页：公司 × 月 × (ALL + 各渠道) 的目标、至今、达成率、预测（线性 / 去年走势）、每天还需与参考值。';

grant select on public.bi_targets_progress to authenticated;
