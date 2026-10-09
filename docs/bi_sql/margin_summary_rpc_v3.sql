-- 2026-10-08：「毛利分析」RPC 小修，migration：margin_summary_rpc_v3。
--
-- 为什么：v2 的 (a)「卖得多但毛利率低」用「全部销售额」挑前 100 名，结果挑到一些大部分销售都没成本的商品
-- （例：ST003084 期间卖 RM 44,814，但有成本的只有 RM 297），毛利率只按那一小段算，很不稳。
-- 改成用「有成本的销售额」(net_costed) 挑前 100 名，再从中找可信毛利率最低的 N 个；其他区块与 v2 相同。
-- 函数签名、权限检查、回传 jsonb 结构都不变（前端不用改）。

create or replace function public.bi_margin_summary(
  p_company   text,
  p_from      date,
  p_to        date,
  p_ex_branch boolean default false,
  p_top       integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
set work_mem to '16MB'
as $$
declare
  v_co    text;
  v_from  integer;
  v_to    integer;
  v_today date    := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  v_tto   integer;
  v_tfrom integer;
  v_lo    integer;
  v_hi    integer;
  v_exb   boolean := coalesce(p_ex_branch, false);
  v_top   integer := least(greatest(coalesce(p_top, 30), 5), 200);
  v_out   jsonb;
begin
  if not coalesce((select public.bi_is_allowed()), false) then
    raise exception '这个账号不在 BI 白名单';
  end if;
  if coalesce((select public.bi_role()), '') <> 'owner' then
    raise exception '毛利分析只有老板账号可以看';
  end if;
  v_co := (select public.bi_company());
  if v_co is not null and v_co <> p_company then
    raise exception '这个账号只能看 % 的资料', v_co;
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception '期间不正确（开始 % / 结束 %）', p_from, p_to;
  end if;

  v_from  := extract(year from p_from)::integer * 100 + extract(month from p_from)::integer;
  v_to    := extract(year from p_to)::integer * 100 + extract(month from p_to)::integer;
  v_tto   := extract(year from v_today)::integer * 100 + extract(month from v_today)::integer;
  v_tfrom := extract(year from date_trunc('month', v_today) - interval '11 months')::integer * 100
           + extract(month from date_trunc('month', v_today) - interval '11 months')::integer;
  v_lo    := least(v_from, v_tfrom);
  v_hi    := greatest(v_to, v_tto);

  with it as materialized (   -- 商品 / 服务 / 无代号 × 期间：只扫一次 item_month
    select s.item_code, s.line_class,
           max(s.item_group) as grp, max(s.item_type) as brand,
           count(*) filter (where s.in_per)                        as n_per,
           coalesce(sum(s.qty)          filter (where s.in_per), 0) as qty,
           coalesce(sum(s.net)          filter (where s.in_per), 0) as net,
           coalesce(sum(s.cost)         filter (where s.in_per), 0) as cost,
           coalesce(sum(s.qty_costed)   filter (where s.in_per), 0) as qty_c,
           coalesce(sum(s.net_costed)   filter (where s.in_per), 0) as net_c,
           coalesce(sum(s.cost_costed)  filter (where s.in_per), 0) as cost_c,
           coalesce(sum(s.qty_nocost)   filter (where s.in_per), 0) as qty_nc,
           coalesce(sum(s.net_nocost)   filter (where s.in_per), 0) as net_nc,
           coalesce(sum(s.lines)        filter (where s.in_per), 0) as lines,
           coalesce(sum(s.lines_nocost) filter (where s.in_per), 0) as lines_nc,
           -- 参考成本：期间 + 近 12 个月内有成本的行的平均单位成本（给会计补成本时参考）
           sum(s.cost_costed) / nullif(sum(s.qty_costed), 0)        as ref_cost
    from (select m.*, (m.yr * 100 + m.mth between v_from and v_to) as in_per
          from bi.mv_margin_item_month m
          where m.company = p_company
            and (m.yr, m.mth) >= (v_lo / 100, v_lo % 100)
            and (m.yr, m.mth) <= (v_hi / 100, v_hi % 100)
            and (not v_exb or not m.is_branch)) s
    group by s.item_code, s.line_class
  ),
  items as materialized (
    select * from it where line_class = 'goods' and n_per > 0
  ),
  tot as materialized (   -- 只算一次（不 materialized 的话会在 hidden 的 nested loop 里每行重算）
    select coalesce(sum(net_c), 0) as net_c, coalesce(sum(cost_c), 0) as cost_c from items
  ),
  dm as materialized (    -- 渠道 × 业务员 × 行类别 × 月（约 350 行 / 12 个月）
    select m.*, m.yr * 100 + m.mth as ym, (m.yr * 100 + m.mth between v_from and v_to) as in_per
    from bi.mv_margin_dim_month m
    where m.company = p_company
      and (m.yr, m.mth) >= (v_lo / 100, v_lo % 100)
      and (m.yr, m.mth) <= (v_hi / 100, v_hi % 100)
      and (not v_exb or m.channel <> '分行')
  ),
  dims as (
    select 'grp'::text as dim, grp as k,
           sum(net) as net, sum(net_c) as net_c, sum(cost_c) as cost_c, sum(net_nc) as net_nc,
           0::numeric as svc_net, 0::numeric as noitem_net
    from items group by grp
    union all
    select 'brand', brand,
           sum(net), sum(net_c), sum(cost_c), sum(net_nc), 0, 0
    from items group by brand
    union all
    select 'channel', channel,
           coalesce(sum(net)         filter (where line_class = 'goods'), 0),
           coalesce(sum(net_costed)  filter (where line_class = 'goods'), 0),
           coalesce(sum(cost_costed) filter (where line_class = 'goods'), 0),
           coalesce(sum(net_nocost)  filter (where line_class = 'goods'), 0),
           coalesce(sum(net)         filter (where line_class = 'svc'), 0),
           coalesce(sum(net)         filter (where line_class = 'noitem'), 0)
    from dm where in_per group by channel
    union all
    select 'agent', sales_agent,
           coalesce(sum(net)         filter (where line_class = 'goods'), 0),
           coalesce(sum(net_costed)  filter (where line_class = 'goods'), 0),
           coalesce(sum(cost_costed) filter (where line_class = 'goods'), 0),
           coalesce(sum(net_nocost)  filter (where line_class = 'goods'), 0),
           coalesce(sum(net)         filter (where line_class = 'svc'), 0),
           coalesce(sum(net)         filter (where line_class = 'noitem'), 0)
    from dm where in_per group by sales_agent
  )
  select jsonb_build_object(
    'company',      p_company,
    'from',         v_from,
    'to',           v_to,
    'ex_branch',    v_exb,
    'refreshed_at', (select l.refreshed_at from bi.margin_refresh_log l where l.id = 1),
    'has_branch',   exists (select 1 from bi.mv_margin_dim_month b
                            where b.company = p_company
                              and (b.yr, b.mth) >= (v_from / 100, v_from % 100)
                              and (b.yr, b.mth) <= (v_to / 100, v_to % 100)
                              and b.channel = '分行'),
    'kpi', (
      select jsonb_build_object(
        'net_all',     round(coalesce(sum(net), 0), 2),
        'goods_net',   round(coalesce(sum(net)          filter (where line_class = 'goods'), 0), 2),
        'net_c',       round(coalesce(sum(net_costed)   filter (where line_class = 'goods'), 0), 2),
        'cost_c',      round(coalesce(sum(cost_costed)  filter (where line_class = 'goods'), 0), 2),
        'net_nc',      round(coalesce(sum(net_nocost)   filter (where line_class = 'goods'), 0), 2),
        'lines_nc',    coalesce(sum(lines_nocost)       filter (where line_class = 'goods'), 0),
        'items_nc',    (select count(*) from items where net_nc <> 0),
        'svc_net',     round(coalesce(sum(net)          filter (where line_class = 'svc'), 0), 2),
        'svc_cost',    round(coalesce(sum(cost)         filter (where line_class = 'svc'), 0), 2),
        'noitem_net',  round(coalesce(sum(net)          filter (where line_class = 'noitem'), 0), 2),
        'noitem_cost', round(coalesce(sum(cost)         filter (where line_class = 'noitem'), 0), 2),
        'lines',       coalesce(sum(lines), 0)
      ) from dm where in_per
    ),
    'svc', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'cls', x.line_class, 'grp', x.grp, 'code', x.item_code, 'desc', coalesce(d.description, ''),
               'net', round(x.net, 2), 'cost', round(x.cost, 2), 'lines', x.lines)
             order by abs(x.net) desc), '[]'::jsonb)
      from it x
      left join bi.dim_item d on d.company = p_company and d.item_code = x.item_code
      where x.line_class in ('svc', 'noitem') and x.n_per > 0
    ),
    'dims', (
      select coalesce(jsonb_object_agg(z.dim, z.arr), '{}'::jsonb)
      from (select dim, jsonb_agg(jsonb_build_object(
                     'k', k, 'net', round(coalesce(net, 0), 2),
                     'net_c', round(coalesce(net_c, 0), 2), 'cost_c', round(coalesce(cost_c, 0), 2),
                     'net_nc', round(coalesce(net_nc, 0), 2),
                     'svc_net', round(coalesce(svc_net, 0), 2), 'noitem_net', round(coalesce(noitem_net, 0), 2))
                   order by coalesce(net, 0) desc) as arr
            from dims group by dim) z
    ),
    -- (a) 卖得多但毛利率低：期间「有成本的销售额」前 100 名里，可信毛利率最低的 N 个
    'low', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'code', t.item_code, 'desc', coalesce(d.description, t.item_code), 'grp', t.grp, 'brand', t.brand,
               'qty', round(t.qty, 2), 'net', round(t.net, 2),
               'qty_c', round(t.qty_c, 2), 'net_c', round(t.net_c, 2), 'cost_c', round(t.cost_c, 2),
               'qty_nc', round(t.qty_nc, 2), 'net_nc', round(t.net_nc, 2), 'lines_nc', t.lines_nc)
             order by (t.net_c - t.cost_c) / t.net_c), '[]'::jsonb)
      from (select * from (select * from items where net_c > 0 order by net_c desc limit 100) a
            order by (a.net_c - a.cost_c) / a.net_c limit v_top) t
      left join bi.dim_item d on d.company = p_company and d.item_code = t.item_code
    ),
    -- (b) 毛利为负：有成本的行卖出去（数量 > 0）但可信毛利 < 0（含售价 0 的赠品）
    'neg', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'code', t.item_code, 'desc', coalesce(d.description, t.item_code), 'grp', t.grp, 'brand', t.brand,
               'qty', round(t.qty, 2), 'net', round(t.net, 2),
               'qty_c', round(t.qty_c, 2), 'net_c', round(t.net_c, 2), 'cost_c', round(t.cost_c, 2),
               'qty_nc', round(t.qty_nc, 2), 'net_nc', round(t.net_nc, 2), 'lines_nc', t.lines_nc)
             order by t.net_c - t.cost_c), '[]'::jsonb)
      from (select * from items where qty_c > 0 and net_c - cost_c < 0
            order by net_c - cost_c limit 50) t
      left join bi.dim_item d on d.company = p_company and d.item_code = t.item_code
    ),
    -- (d) 赚钱但被忽略：可信毛利率 ≥ 公司平均 × 1.3、可信销售 ≥ RM 300，但销售额不在前 100 名
    'hidden', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'code', t.item_code, 'desc', coalesce(d.description, t.item_code), 'grp', t.grp, 'brand', t.brand,
               'qty', round(t.qty, 2), 'net', round(t.net, 2),
               'qty_c', round(t.qty_c, 2), 'net_c', round(t.net_c, 2), 'cost_c', round(t.cost_c, 2),
               'qty_nc', round(t.qty_nc, 2), 'net_nc', round(t.net_nc, 2), 'lines_nc', t.lines_nc)
             order by t.net_c - t.cost_c desc), '[]'::jsonb)
      from (select i.* from items i, tot
            where tot.net_c > 0 and i.net_c >= 300 and i.qty_c > 0
              and (i.net_c - i.cost_c) / i.net_c >= 1.3 * (tot.net_c - tot.cost_c) / tot.net_c
              and i.item_code not in (select item_code from items order by net desc limit 100)
            order by i.net_c - i.cost_c desc limit v_top) t
      left join bi.dim_item d on d.company = p_company and d.item_code = t.item_code
    ),
    -- (c) 没成本的商品（给会计补成本）：按没成本销售额排序，最多 1000 个
    'nocost', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'code', t.item_code, 'desc', coalesce(d.description, t.item_code), 'grp', t.grp, 'brand', t.brand,
               'qty', round(t.qty, 2), 'net', round(t.net, 2),
               'qty_c', round(t.qty_c, 2), 'net_c', round(t.net_c, 2), 'cost_c', round(t.cost_c, 2),
               'qty_nc', round(t.qty_nc, 2), 'net_nc', round(t.net_nc, 2), 'lines_nc', t.lines_nc,
               'ref_cost', round(t.ref_cost, 4))
             order by t.net_nc desc), '[]'::jsonb)
      from (select * from items where net_nc <> 0 order by net_nc desc limit 1000) t
      left join bi.dim_item d on d.company = p_company and d.item_code = t.item_code
    ),
    'trend', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'yr', yr, 'mth', mth,
               'net', round(net, 2), 'net_c', round(net_c, 2), 'cost_c', round(cost_c, 2),
               'net_nc', round(net_nc, 2), 'svc_net', round(svc_net, 2))
             order by yr, mth), '[]'::jsonb)
      from (select yr, mth,
                   coalesce(sum(net)         filter (where line_class = 'goods'), 0) as net,
                   coalesce(sum(net_costed)  filter (where line_class = 'goods'), 0) as net_c,
                   coalesce(sum(cost_costed) filter (where line_class = 'goods'), 0) as cost_c,
                   coalesce(sum(net_nocost)  filter (where line_class = 'goods'), 0) as net_nc,
                   coalesce(sum(net)         filter (where line_class = 'svc'), 0)   as svc_net
            from dm where ym between v_tfrom and v_tto
            group by yr, mth) tr
    )
  ) into v_out;

  return v_out;
end $$;

revoke execute on function public.bi_margin_summary(text, date, date, boolean, integer) from public, anon;
grant execute on function public.bi_margin_summary(text, date, date, boolean, integer) to authenticated, service_role;
