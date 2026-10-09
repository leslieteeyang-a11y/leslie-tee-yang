-- 2026-10-08：「毛利分析」分页的两个 RPC，migration：margin_summary_rpc。
--
-- 为什么用 RPC 而不是 public 视图：前端要按「期间」（本月至今 / 上个月 / 近 3 个月 / 近 12 个月 / 今年至今）
-- 把 bi.mv_margin_month 再汇总成 类别 / 品牌 / 渠道 / 业务员 / 商品 几张表；视图 + PostgREST
-- 预设最多回 1000 行，商品 × 月 会被截断。RPC 在 SQL 端一次算完，回一个 jsonb（不受 1000 行限制），
-- 一次来回 < 1.5 秒。
--
-- 安全：security definer + search_path ''；函数内先检查
--   bi_is_allowed()（白名单）→ bi_role() = 'owner'（只有老板）→ bi_company() 为 null 或等于 p_company。
-- 店长 / 业务员呼叫会直接 raise exception，拿不到任何数字。
--
-- 口径说明（页面「口径」也会写）：
--   * 销售净额 = 全部行 sum(sub_total)（CN 在 fact_sales 已是负数），与总览页一致。
--   * 商品 = line_class 'goods'；服务 / 费用（'svc'）与没商品代号的自由输入行（'noitem'）另列，不进商品毛利率。
--   * 可信毛利 = 商品里 cost <> 0 的行：net_costed − cost_costed；可信毛利率 = 可信毛利 / net_costed。
--   * 没成本 = 商品里 cost = 0 且 sub_total <> 0 的行（net_nocost），另外显示金额与占比。
--   * p_ex_branch = true 时剔除「分行」渠道（总部开给 HOMEWORKS (SOUTHERN) 的集团内调拨发票，
--     大部分没成本，也不是对外赚的钱）。
--   * 趋势固定为近 12 个月（马来西亚时间的本月往回 11 个月），不随期间改变。

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
as $$
declare
  v_co    text;
  v_from  integer;
  v_to    integer;
  v_today date    := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  v_tto   integer;
  v_tfrom integer;
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

  with base as (
    select m.*, m.yr * 100 + m.mth as ym
    from bi.mv_margin_month m
    where m.company = p_company
      and m.yr * 100 + m.mth between least(v_from, v_tfrom) and greatest(v_to, v_tto)
      and (not coalesce(p_ex_branch, false) or m.channel <> '分行')
  ),
  per as (
    select * from base where ym between v_from and v_to
  ),
  items as (
    select item_code,
           max(item_group) as grp, max(item_type) as brand,
           sum(qty) as qty, sum(net) as net,
           sum(qty_costed) as qty_c, sum(net_costed) as net_c, sum(cost_costed) as cost_c,
           sum(qty_nocost) as qty_nc, sum(net_nocost) as net_nc, sum(lines_nocost) as lines_nc
    from per
    where line_class = 'goods'
    group by item_code
  ),
  tot as (
    select coalesce(sum(net_c), 0) as net_c, coalesce(sum(cost_c), 0) as cost_c from items
  ),
  ref as (   -- 参考成本：期间 + 近 12 个月内有成本的行的平均单位成本（给会计补成本时参考）
    select item_code, sum(cost_costed) / nullif(sum(qty_costed), 0) as ref_cost
    from base
    where line_class = 'goods' and qty_costed <> 0
    group by item_code
  ),
  dims as (
    select 'grp'::text as dim, item_group as k,
           sum(net) as net, sum(net_costed) as net_c, sum(cost_costed) as cost_c, sum(net_nocost) as net_nc,
           0::numeric as svc_net, 0::numeric as noitem_net
    from per where line_class = 'goods' group by item_group
    union all
    select 'brand', item_type,
           sum(net), sum(net_costed), sum(cost_costed), sum(net_nocost), 0, 0
    from per where line_class = 'goods' group by item_type
    union all
    select 'channel', channel,
           coalesce(sum(net)         filter (where line_class = 'goods'), 0),
           coalesce(sum(net_costed)  filter (where line_class = 'goods'), 0),
           coalesce(sum(cost_costed) filter (where line_class = 'goods'), 0),
           coalesce(sum(net_nocost)  filter (where line_class = 'goods'), 0),
           coalesce(sum(net)         filter (where line_class = 'svc'), 0),
           coalesce(sum(net)         filter (where line_class = 'noitem'), 0)
    from per group by channel
    union all
    select 'agent', sales_agent,
           coalesce(sum(net)         filter (where line_class = 'goods'), 0),
           coalesce(sum(net_costed)  filter (where line_class = 'goods'), 0),
           coalesce(sum(cost_costed) filter (where line_class = 'goods'), 0),
           coalesce(sum(net_nocost)  filter (where line_class = 'goods'), 0),
           coalesce(sum(net)         filter (where line_class = 'svc'), 0),
           coalesce(sum(net)         filter (where line_class = 'noitem'), 0)
    from per group by sales_agent
  )
  select jsonb_build_object(
    'company',      p_company,
    'from',         v_from,
    'to',           v_to,
    'ex_branch',    coalesce(p_ex_branch, false),
    'refreshed_at', (select l.refreshed_at from bi.margin_refresh_log l where l.id = 1),
    'has_branch',   exists (select 1 from bi.mv_margin_month b
                            where b.company = p_company and b.channel = '分行'
                              and b.yr * 100 + b.mth between v_from and v_to),
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
      ) from per
    ),
    'svc', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'cls', x.cls, 'grp', x.grp, 'code', x.code, 'desc', coalesce(d.description, ''),
               'net', round(x.net, 2), 'cost', round(x.cost, 2), 'lines', x.lines)
             order by abs(x.net) desc), '[]'::jsonb)
      from (select line_class as cls, item_group as grp, item_code as code,
                   sum(net) as net, sum(cost) as cost, sum(lines) as lines
            from per where line_class in ('svc', 'noitem')
            group by 1, 2, 3) x
      left join bi.dim_item d on d.company = p_company and d.item_code = x.code
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
    -- (a) 卖得多但毛利率低：期间销售额前 100 名里，可信毛利率最低的 N 个
    'low', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'code', t.item_code, 'desc', coalesce(d.description, t.item_code), 'grp', t.grp, 'brand', t.brand,
               'qty', round(t.qty, 2), 'net', round(t.net, 2),
               'qty_c', round(t.qty_c, 2), 'net_c', round(t.net_c, 2), 'cost_c', round(t.cost_c, 2),
               'qty_nc', round(t.qty_nc, 2), 'net_nc', round(t.net_nc, 2), 'lines_nc', t.lines_nc)
             order by (t.net_c - t.cost_c) / t.net_c), '[]'::jsonb)
      from (select * from (select * from items where net_c > 0 order by net desc limit 100) a
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
               'ref_cost', round(r.ref_cost, 4))
             order by t.net_nc desc), '[]'::jsonb)
      from (select * from items where net_nc <> 0 order by net_nc desc limit 1000) t
      left join ref r on r.item_code = t.item_code
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
            from base where ym between v_tfrom and v_tto
            group by yr, mth) tr
    )
  ) into v_out;

  return v_out;
end $$;

revoke execute on function public.bi_margin_summary(text, date, date, boolean, integer) from public, anon;
grant execute on function public.bi_margin_summary(text, date, date, boolean, integer) to authenticated, service_role;


-- 没成本的明细行（含单号），给「下载 CSV」按钮用：会计照单号在 AutoCount 打开发票补成本。
-- 直接查 fact_sales，但走 (company, doc_date) 索引、只取期间内的行；12 个月约 0.3～0.7 秒。
-- 只回商品行（不含服务 / 费用群组与没商品代号的行），最多 5000 行；回 jsonb 避开 PostgREST 1000 行上限。
create or replace function public.bi_margin_nocost_lines(
  p_company   text,
  p_from      date,
  p_to        date,
  p_ex_branch boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_co  text;
  v_out jsonb;
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

  select coalesce(jsonb_agg(jsonb_build_object(
           'doc_type', x.doc_type, 'doc_no', x.doc_no, 'doc_date', x.doc_date,
           'debtor_code', x.debtor_code, 'debtor_name', x.debtor_name, 'channel', x.channel,
           'item_code', x.item_code, 'desc', x.descr, 'grp', x.item_group,
           'qty', x.qty, 'uom', x.uom, 'unit_price', x.unit_price, 'sub_total', x.sub_total,
           'sales_agent', x.sales_agent)
         order by x.doc_date, x.doc_no), '[]'::jsonb)
    into v_out
  from (
    select s.doc_type, s.doc_no, s.doc_date, s.debtor_code, s.debtor_name,
           bi.sale_channel(s.debtor_code, c.debtor_type) as channel,
           s.item_code, coalesce(i.description, s.item_description) as descr, i.item_group,
           s.qty, s.uom, s.unit_price, s.sub_total, s.sales_agent
    from bi.fact_sales s
    left join bi.dim_item     i on i.company = s.company and i.item_code   = s.item_code
    left join bi.dim_customer c on c.company = s.company and c.debtor_code = s.debtor_code
    where s.company = p_company
      and s.doc_date >= date_trunc('month', p_from)::date
      and s.doc_date <  (date_trunc('month', p_to) + interval '1 month')::date
      and coalesce(s.cost, 0) = 0
      and s.sub_total <> 0
      and coalesce(s.item_code, '') <> ''
      and coalesce(i.item_group, '') not in ('ONLINE','SHIP FEE','PAY FEE','TRAN FEE','SERV FEE','INSTALL','TRANSPOR',
                                             'DELIVERY','SERV INC','CARD INT','GST')
      and (not coalesce(p_ex_branch, false) or bi.sale_channel(s.debtor_code, c.debtor_type) <> '分行')
    order by s.doc_date, s.doc_no
    limit 5000
  ) x;

  return v_out;
end $$;

revoke execute on function public.bi_margin_nocost_lines(text, date, date, boolean) from public, anon;
grant execute on function public.bi_margin_nocost_lines(text, date, date, boolean) to authenticated, service_role;
