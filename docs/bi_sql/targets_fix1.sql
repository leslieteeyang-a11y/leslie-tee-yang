-- 2026-10-10：「目标」分页审查后的修正。migration：targets_fix1。
-- 取代 targets_progress_view 的视图内容，并收回 authenticated 直接读 bi.mv_targets_daily 的权限（targets_daily_mv 里的 grant）。
--
-- 修了什么、为什么：
-- 1. 平台渠道晚 2 天入账：Shopee / Lazada / TikTok 的发票固定晚 2 天才进 AutoCount，原本渠道列跟公司列用同一个
--    「已过天数」（公司最后一张单的日期），等于拿 8 天的销售除以 10 天，预测少估约 20%、灯号被压成红灯。
--    → 每个（公司, 渠道）有自己的预测截止日：上个月 ≥ 90% 天数有单的渠道（天天有单）而且最后单据日离公司截止日
--      不到 4 天，就用渠道自己的最后单据日；单据零散的渠道（门市现金、分行）或停卖很久的渠道用公司截止日。
--      去年同期累计（按去年走势预测用）也按各渠道自己的天数对齐。
-- 2. 总部每月中有一张卖给 JB 分行的集团内大发票（7/14 575,736.75、8/14 560,862.45、9/15 638,175.60，占总部整月一半以上），
--    按天数线性外推时大单进来前只预测到 56～71%、进来后又高估 10～24%。
--    → 「分行」渠道不线性外推，预测 = max(至今, 近 3 个月平均)（proj_method = 'avg3'）；
--      销售公司（总部 / JB）本月的公司列预测 = 各渠道预测相加（不再用公司至今 ÷ 公司已过天数）。
--      回测（7～9 月，第 10 / 15 / 20 天）：总部预测 ÷ 整月实际从 0.56～1.52 收窄到 0.81～1.13。
-- 3. 今天还没同步完：销售一天只同步 4 次（马来西亚 09:00 / 12:00 / 15:00 / 18:00），白天看页面时今天的单只进来一部分，
--    原本把今天当成完整一天，预测系统性偏低（1 号早上第一次同步后就是「早上几张单 × 31」）。
--    → 资料到今天时，预测只用到昨天（elapsed_days = 到昨天为止的天数，分子也只算到昨天）；页面上的「至今」照样含今天。
--      分行电脑推送的公司（KL）同理：推送当天不算完整一天，算到推送日前一天。
--      剩余天数 = 当月天数 − elapsed_days（含今天），每天还需 = (目标 − 至今) ÷ 剩余天数。
-- 4. KL 分行电脑推送的是空资料（0 张单，branch_actual_month 一列都没有），原本当成「实际 RM 0」，一设目标就红灯。
--    → 推送了但 branch_actual_month 没有 scope='all' 的列：actual / branch_actual = null、branch_empty = true，
--      前端显示「分行电脑推送了 0 张单，请确认账套」，不亮灯；近 3 个月平均也不再把空推送算成 0。
-- 5. 权限加固：视图是 security_invoker，原本必须把 bi.mv_targets_daily（没有 RLS、没有公司过滤）的 SELECT 开给
--    authenticated，店长若能直接查到 bi schema 就看得到总部每天各渠道销售。
--    → 改由 security definer 函数 bi.targets_daily_rows() 读物化视图，函数内先做 bi_is_allowed() + bi_company() 过滤，
--      再收回 authenticated 对物化视图的 SELECT。视图仍是 security_invoker，target_month / branch_actual_* 的 RLS 照常生效。
--
-- 新增栏位（加在尾端，原有栏位顺序、型别不变）：
--   proj_through  预测用到哪一天（elapsed_days > 0 才有；平台渠道通常比公司早 1～2 天）
--   proj_method   'linear'（日均 × 当月天数）/ 'avg3'（分行渠道：max(至今, 近 3 个月平均)）/
--                 'channels'、'channels_avg3'（销售公司本月：各渠道预测相加；后者表示含分行渠道的 avg3 估计）/ 'actual'（过去的月份）
--   branch_empty  公司列：分行电脑这个月有推送，但内容是 0 张单
-- 栏位意义调整：
--   elapsed_days  预测用的完整天数（本月：到预测截止日；过去的月份 = 当月天数；未来 = 0）
--   as_of         「至今」包含到哪一天（公司最后一张单的日期 / 分行最后推送日；过去的月份 = 月底）
--   proj_linear   预测月底（依 proj_method；不会小于至今）
--   proj_ly       按去年同月走势：各渠道 = 截至该渠道截止日的实际 × 去年同月整月 ÷ 去年同月同期累计（分行渠道不做 = null）；
--                 销售公司本月 = 「分行」以外的渠道合起来的比例（Σ截至各渠道截止日的实际 × Σ去年整月 ÷ Σ去年同期）＋ 分行渠道预测
--   ly_mtd        去年同月同期累计（本月按各渠道自己的天数；公司列 = 各渠道相加）

-- ---------- 1. 读物化视图的 security definer 函数（先过滤公司） ----------
create or replace function bi.targets_daily_rows()
returns table (company text, doc_date date, channel text, net numeric)
language sql
stable
security definer
set search_path to ''
as $fn$
  select t.company, t.doc_date, t.channel, t.net
  from bi.mv_targets_daily t
  where (select public.bi_is_allowed())
    and ((select public.bi_company()) is null or t.company = (select public.bi_company()))
$fn$;

comment on function bi.targets_daily_rows() is '「目标」分页：bi.mv_targets_daily 依目前登入者过滤公司后的逐日渠道净额（public.bi_targets_progress 用）。';

revoke execute on function bi.targets_daily_rows() from public;
revoke execute on function bi.targets_daily_rows() from anon;
grant execute on function bi.targets_daily_rows() to authenticated;
grant execute on function bi.targets_daily_rows() to service_role;

-- ---------- 2. 进度视图 ----------
create or replace view public.bi_targets_progress with (security_invoker = true) as
with p as (
  select (now() at time zone 'Asia/Kuala_Lumpur')::date                     as today,
         date_trunc('month', now() at time zone 'Asia/Kuala_Lumpur')::date  as cur_month
),
d as (
  select t.company, t.doc_date, t.channel, t.net
  from bi.targets_daily_rows() t
),
bm as (
  select m.company, m.month, (max(m.updated_at) at time zone 'Asia/Kuala_Lumpur')::date as pushed_on
  from bi.branch_actual_meta m
  group by m.company, m.month
),
ba as (
  -- 有推送但 branch_actual_month 没有 scope='all' 的列 = 推送内容是 0 张单 → actual = null、empty = true
  select b.company, b.month, sum(a.actual_amount) as actual, count(a.company) = 0 as empty
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
         least(coalesce(dc.last_date, bc.last_push), (select today from p)) as as_of,
         -- 本月预测用的「完整资料」截止日：资料到今天 → 只算到昨天；分行电脑推送当天也不算完整一天
         case when dc.company is not null then
                case when dc.last_date >= (select today from p) then (select today from p) - 1 else dc.last_date end
              when bc.company is not null then least(bc.last_push, (select today from p)) - 1
         end as cut
  from (select company from dc union select company from bc union select company from bi.target_month) c
  left join dc on dc.company = c.company
  left join bc on bc.company = c.company
),
chd as (
  -- 各（公司, 渠道）的最后单据日、上个月有单天数
  select d.company, d.channel,
         max(d.doc_date) filter (where d.doc_date <= p.today) as ch_last,
         count(distinct d.doc_date) filter (where d.doc_date >= (p.cur_month - interval '1 month')::date
                                              and d.doc_date < p.cur_month) as prev_days
  from d cross join p
  group by d.company, d.channel
),
chc as (
  -- 渠道自己的本月预测截止日：上个月 ≥ 90% 天数有单（天天有单，例如 Shopee / Lazada / TikTok）而且最后单据日离公司截止日
  -- 不到 4 天（平台发票晚 2 天入账）→ 用渠道自己的最后单据日（上限 = 公司截止日）；其余用公司截止日
  select ch.company, ch.channel,
         case when ch.prev_days >= 0.9 * extract(day from (select cur_month from p) - 1)
               and ch.ch_last >= c.cut - 4
              then least(ch.ch_last, c.cut) else c.cut end as cut
  from chd ch
  join comp c on c.company = ch.company
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
  from ba a where not a.empty and a.company not in (select company from dc)
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
         (m.month + interval '1 month' - interval '1 day')::date as month_end,
         case when m.month = (select cur_month from p)
              then case when k.scope = 'channel' then coalesce(x.cut, c.cut) else c.cut end
              else c.as_of end as cut
  from keys k
  join comp c on c.company = k.company
  left join chc x on k.scope = 'channel' and x.company = k.company and x.channel = k.scope_key
  cross join months m
),
g2 as (
  select g.*,
         extract(day from g.month_end)::int as dim,
         greatest(0, least(extract(day from g.month_end)::int, coalesce(g.cut - g.month + 1, 0)))::int as elapsed
  from g
),
cur as (
  -- 本月各渠道列：截至渠道自己截止日的实际（thru），以及去年同月 1 号起同样天数的累计（ly_cum）
  select g2.company, g2.scope_key as channel,
         coalesce(sum(d.net) filter (where d.doc_date >= g2.month and d.doc_date <= g2.cut), 0) as thru,
         coalesce(sum(d.net) filter (where d.doc_date >= (g2.month - interval '1 year')::date
                                       and d.doc_date <  (g2.month - interval '1 year')::date + g2.elapsed), 0) as ly_cum
  from g2
  left join d on d.company = g2.company and d.channel = g2.scope_key
             and d.doc_date >= (g2.month - interval '1 year')::date
  where g2.scope = 'channel' and g2.month = (select cur_month from p)
  group by g2.company, g2.scope_key
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
         cu.thru,
         cu.ly_cum,
         case when g2.scope = 'company' then
           (select b.actual from ba b where b.company = g2.company and b.month = g2.month) end as branch_actual,
         case when g2.scope = 'company' then
           (select least(b.pushed_on, g2.month_end) from bm b where b.company = g2.company and b.month = g2.month) end as branch_as_of,
         case when g2.scope = 'company' then
           (select b.empty from ba b where b.company = g2.company and b.month = g2.month) end as branch_empty,
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
  left join cur cu on g2.scope = 'channel' and g2.month = (select cur_month from p)
                  and cu.company = g2.company and cu.channel = g2.scope_key
),
r2 as (
  -- 各列自己的预测（渠道列、分行电脑推送的公司列；销售公司本月的公司列在 r3 改成各渠道相加）
  select r.*,
         case when r.actual is null then null
              when r.elapsed >= r.dim then r.actual
              when r.scope = 'channel' and r.scope_key = '分行' and r.avg3 is not null then greatest(r.actual, r.avg3)
              when r.elapsed = 0 then null
              when r.thru is not null then greatest(r.actual, r.thru / r.elapsed * r.dim)
              else greatest(r.actual, r.actual / r.elapsed * r.dim)
         end as p_own,
         case when r.actual is null then null
              when r.elapsed >= r.dim then 'actual'
              when r.scope = 'channel' and r.scope_key = '分行' and r.avg3 is not null then 'avg3'
              when r.elapsed = 0 then null
              else 'linear'
         end as p_method,
         case when r.actual is null or r.elapsed = 0 then null
              when r.elapsed >= r.dim then r.actual
              when r.scope = 'channel' and r.scope_key <> '分行' and r.ly_full > 0 and r.ly_cum > 0
                then greatest(r.actual, r.thru * r.ly_full / r.ly_cum)
         end as ply_own
  from r
),
agg as (
  -- 销售公司本月：预测 = 各渠道预测相加；有任何一个有销售的渠道还算不出预测（例如月初平台渠道还没有完整的一天）→ 公司也不预测。
  -- 按去年走势 = 「分行」以外的渠道合起来算一个比例（各渠道截至自己截止日的实际合计 × 去年同月整月合计 ÷ 去年同期累计合计；
  --   小渠道去年同期很淡时单独算会放大好几倍，合起来比较稳）＋「分行」渠道的预测（近 3 个月平均）。
  select company, month,
         case when bool_or(p_own is null) then null else sum(p_own) end                       as p_sum,
         case when bool_or(p_own is null) then null
              when sum(ly_cum) filter (where scope_key <> '分行') > 0
               and sum(ly_full) filter (where scope_key <> '分行') > 0
              then greatest(sum(actual),
                            coalesce(sum(thru) filter (where scope_key <> '分行'), 0)
                              * sum(ly_full) filter (where scope_key <> '分行')
                              / sum(ly_cum) filter (where scope_key <> '分行')
                            + coalesce(sum(p_own) filter (where scope_key = '分行'), 0))
         end                                                                                   as ply_sum,
         sum(ly_cum)                                                                           as ly_cum_sum,
         bool_or(p_method = 'avg3')                                                            as has_avg3
  from r2
  where scope = 'channel' and month = (select cur_month from p) and actual is not null
  group by company, month
),
r3 as (
  select r2.*,
         case when r2.scope = 'company' and r2.src = 'sales' and r2.month = (select cur_month from p)
              then ag.p_sum else r2.p_own end as proj,
         case when r2.scope = 'company' and r2.src = 'sales' and r2.month = (select cur_month from p)
              then ag.ply_sum else r2.ply_own end as proj_ly2,
         case when r2.scope = 'company' and r2.src = 'sales' and r2.month = (select cur_month from p)
              then case when ag.p_sum is null then null when ag.has_avg3 then 'channels_avg3' else 'channels' end
              else r2.p_method end as proj_method,
         case when r2.elapsed >= r2.dim then r2.ly_full
              when r2.month = (select cur_month from p) and r2.src = 'sales' then
                case when r2.scope = 'company' then coalesce(ag.ly_cum_sum, 0) else coalesce(r2.ly_cum, 0) end
         end as ly_mtd2
  from r2
  left join agg ag on ag.company = r2.company and ag.month = r2.month
)
select r3.company,
       r3.month,
       r3.scope,
       r3.scope_key,
       r3.src,
       r3.target,
       r3.actual,
       round(r3.actual / nullif(r3.target, 0), 4)                               as pct,
       r3.dim                                                                   as days_in_month,
       r3.elapsed                                                               as elapsed_days,
       r3.dim - r3.elapsed                                                      as remaining_days,
       case when r3.as_of >= r3.month then least(r3.as_of, r3.month_end) end    as as_of,
       round(r3.proj, 2)                                                        as proj_linear,
       round(r3.proj / nullif(r3.target, 0), 4)                                 as proj_pct,
       round(r3.proj_ly2, 2)                                                    as proj_ly,
       round(r3.proj_ly2 / nullif(r3.target, 0), 4)                             as proj_ly_pct,
       round(case when r3.target is null or r3.dim - r3.elapsed <= 0 then null
                  else greatest(r3.target - coalesce(r3.actual, 0), 0) / (r3.dim - r3.elapsed) end, 2) as need_per_day,
       r3.ly_full,
       r3.ly_mtd2                                                               as ly_mtd,
       round(r3.avg3, 2)                                                        as avg3,
       r3.branch_actual,
       r3.branch_as_of,
       r3.branch_channel_actual,
       r3.target_updated_at,
       case when r3.elapsed > 0 then r3.month + r3.elapsed - 1 end              as proj_through,
       r3.proj_method,
       r3.branch_empty
from r3
where (select public.bi_is_allowed())
  and ((select public.bi_company()) is null or r3.company = (select public.bi_company()));

comment on view public.bi_targets_progress is '「目标」分页：公司 × 月 × (ALL + 各渠道) 的目标、至今、达成率、预测（各渠道自己的截止日 / 分行渠道按近 3 个月平均 / 公司 = 各渠道相加）、每天还需与参考值。';

grant select on public.bi_targets_progress to authenticated;

-- ---------- 3. 收回前端角色直接读物化视图（视图改经 bi.targets_daily_rows() 读） ----------
revoke select on bi.mv_targets_daily from authenticated;
