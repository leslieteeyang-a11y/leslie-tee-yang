-- 2026-10-08：「健康度」分页的每日余额快照。migration：health_snapshot_table。
-- 为什么要快照：库存（fact_stock）、应收（fact_ar_open）、应付（fact_ap_open）、库龄（fact_item_aging）
-- 都只有「现在」的余额，没有历史，算不出库存天数 / 应收天数 / 应付天数 / 现金周期的趋势与去年同期。
-- 所以 bi.refresh_health() 每 2 小时把「今天」的余额与近 90 天流量写一行（同一天覆盖），
-- 历史从此开始累积；库存另从 bi.snap_stock_group（2026-08-24 起每日按群组的库存快照）回补。
-- 一行 = 一家公司 × 一天（马来西亚时间的日期）。
--   stock_cost     正库存成本：qty>0、排除 DEFECTS / DISPLAY 仓、排除服务群组（与 snap_stock_group 同口径）
--   stock_excluded 被排除的正库存成本（次品 / 展示仓 + 服务项目），只供说明
--   stock_neg      负库存行的成本合计（负数；仓位没转仓造成，只供说明，不抵减库存）
--   slow_cost      滞销库存：库龄表里超过 12 个月没进货、且近 12 个月没卖出（IV/CS 数量 ≤ 0）的库存成本
--   aging_total    库龄表正库存合计（滞销占比的分母，同一来源）
--   ar_pos         应收：按客户把未结单据（RI/RD/RF/RC/RP）加总，只算净额为正的客户
--                  （AutoCount 很多收款没有 knock-off 到发票，单看发票余额会虚高好几倍）
--   ar_neg         净额为负的客户合计（订金 / 预收 / 未冲销的收款），只供说明
--   ar_over90      逾期 90 天以上：每个欠款客户的净额先抵最近的单据（先进先出），
--                  剩下超过「到期日在 90 天内的单据」的部分才算逾期 90 天以上
--   ar_ic          ar_pos 里属于分行（集团内）的部分
--   ap_pos / ap_neg 应付：按供应商净额，正 = 我们欠供应商；负 = 预付给供应商（付款先于发票入账）
--   sales_90 ...   截至 snap_date 的近 90 天流量（来自 bi.mv_health_sales_daily）
--   purch_3m / purch_days 截至 snap_date 前 3 个完整月的总账进货（CO 科目中 PURCHASES / PURCHASES RETURN）与天数
--   source         'live' = refresh_health 当天实算；'snap_stock_group' = 回补（只有库存，没有应收应付）
create table if not exists bi.health_snapshot (
  company          text        not null,
  snap_date        date        not null,
  stock_cost       numeric,
  stock_excluded   numeric,
  stock_neg        numeric,
  slow_cost        numeric,
  aging_total      numeric,
  ar_pos           numeric,
  ar_neg           numeric,
  ar_over90        numeric,
  ar_ic            numeric,
  ap_pos           numeric,
  ap_neg           numeric,
  sales_90         numeric,
  sales_costed_90  numeric,
  cost_costed_90   numeric,
  sales_nocost_90  numeric,
  purch_3m         numeric,
  purch_days       integer,
  source           text        not null default 'live',
  refreshed_at     timestamptz not null default now(),
  primary key (company, snap_date)
);

-- RLS：只有 owner 读得到（含成本 / 余额），并照惯例加公司过滤；写入只经 security definer 的 bi.refresh_health()
alter table bi.health_snapshot enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
                 where schemaname = 'bi' and tablename = 'health_snapshot' and policyname = 'p_read_owner') then
    create policy p_read_owner on bi.health_snapshot
      for select to authenticated
      using ((select public.bi_is_allowed())
             and coalesce((select public.bi_role()), '') = 'owner'
             and ((select public.bi_company()) is null or company = (select public.bi_company())));
  end if;
end $$;

grant select on bi.health_snapshot to authenticated;
