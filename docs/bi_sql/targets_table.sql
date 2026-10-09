-- 2026-10-08：「目标」分页（BI 网页 src/pages/Targets.tsx）的目标表。migration：targets_table。
-- 为什么另开一张表、不放 bi.app_setting：
--   app_setting 的 store_month_target / agent_month_target 是「门店」分页（Manager.tsx）在读的门市 / 业务员目标，
--   一个公司只有一个数、没有月份；老板要的是「每个月、每家公司总目标 + 每个渠道目标」，而且要有历史可看达成率。
--   所以新表一行 = 公司 × 月 × 范围（company 总目标 / channel 渠道目标），门店分页完全不受影响。
-- 栏位：
--   month      该月 1 号（check 保证是月初，避免同一个月存出两种日期）
--   scope      'company' = 公司总目标（scope_key 固定 'ALL'）；'channel' = 渠道目标（scope_key = 渠道名，
--              与 bi.sale_channel() 的回传值一致：门市现金 / B2B客户 / Shopee / Lazada / TikTok / 其他平台 / 分行）
--   amount     目标净销售额（RM，> 0）；要删除目标就呼叫 public.bi_target_set 传 0 或 null
--   updated_by / updated_at  谁、何时改的（RPC 自动填）
-- 权限：RLS 只开读取（bi_is_allowed + 公司过滤，与其他 bi 表相同）；写入只能经 security definer 的
--       public.bi_target_set / public.bi_target_copy_prev（函数内检查 bi_role() = 'owner'），前端角色没有写入权限。
create table if not exists bi.target_month (
  company     text        not null,
  month       date        not null,
  scope       text        not null,
  scope_key   text        not null,
  amount      numeric     not null,
  updated_by  text,
  updated_at  timestamptz not null default now(),
  primary key (company, month, scope, scope_key),
  constraint target_month_month_chk  check (month = date_trunc('month', month)::date),
  constraint target_month_scope_chk  check (scope in ('company', 'channel')),
  constraint target_month_key_chk    check (scope <> 'company' or scope_key = 'ALL'),
  constraint target_month_amount_chk check (amount > 0)
);

comment on table bi.target_month is '每月目标：公司总目标（scope=company, scope_key=ALL）与渠道目标（scope=channel）。只经 public.bi_target_set / bi_target_copy_prev 写入（owner）。';

alter table bi.target_month enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
                 where schemaname = 'bi' and tablename = 'target_month' and policyname = 'p_read_allowed') then
    create policy p_read_allowed on bi.target_month
      for select to authenticated
      using ((select public.bi_is_allowed())
             and ((select public.bi_company()) is null or company = (select public.bi_company())));
  end if;
end $$;

grant select on bi.target_month to authenticated;
grant select on bi.target_month to service_role;
