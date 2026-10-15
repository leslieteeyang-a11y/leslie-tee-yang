-- 货架画面（#/warehouse/bins）靠的资料库行为（2026-10-17）。接在 bin_test.sql 之后跑（用它建的货架：HQ 的 A-R1-1、A-R1-2、A-R2-1、A-R2-2、B-R9-1，SRGADING 的 S1）。
-- 画面的「撤销」= 做一个反向动作；扫到「BIN:<编号>」时没选商品就不带仓位（自动换仓位）；只看的人只能看清单与对不上。
\set ON_ERROR_STOP 1
create or replace function pg_temp.as_user(p_email text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('email', p_email)::text, false);
end $$;
create or replace function pg_temp.expect_error(p_sql text, p_like text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'expected error "%" from: %', p_like, p_sql;
exception when others then
  if sqlerrm like 'expected error%' or sqlerrm not like '%' || p_like || '%' then
    raise;
  end if;
end $$;
create or replace function pg_temp.binqty(p_code text, p_item text) returns numeric language sql as $$
  select coalesce((select (x->>'qty')::numeric
    from jsonb_array_elements(public.ops_wh_bin_get(jsonb_build_object('bin', p_code, 'location', 'HQ'))->'items') x
    where x->>'item_code' = p_item), 0)
$$;
create or replace function pg_temp.barcode(p_loc text, p_code text) returns text language sql as $$
  select x->>'barcode' from jsonb_array_elements(public.ops_wh_bins(jsonb_build_object('location', p_loc, 'include_inactive', true))->'bins') x
  where x->>'code' = p_code
$$;
grant execute on all functions in schema pg_temp to authenticated;

set role authenticated;

-- 1. 撤销 = 反向动作：上架 → 拿下、拿下 → 上架（带 confirm）、移货架 → 反方向、改数 → 改回原本的数
select pg_temp.as_user('picker@example.com');
do $$ declare a0 numeric; b0 numeric; r jsonb; bc text; begin
  bc := pg_temp.barcode('HQ', 'A-R1-1');
  a0 := pg_temp.binqty('A-R1-1', 'ST003');
  r := public.ops_wh_bin_op(jsonb_build_object('kind', 'putaway', 'item', 'ST003', 'qty', 2, 'bin', bc, 'location', 'HQ', 'confirm', true));
  assert (r->>'ok')::boolean and pg_temp.binqty('A-R1-1', 'ST003') = a0 + 2, 'putaway by barcode: ' || r::text;
  r := public.ops_wh_bin_op(jsonb_build_object('kind', 'take', 'item', 'ST003', 'qty', 2, 'bin', bc, 'location', 'HQ', 'note', '撤销上架'));
  assert pg_temp.binqty('A-R1-1', 'ST003') = a0, 'undo putaway';
  r := public.ops_wh_bin_op(jsonb_build_object('kind', 'putaway', 'item', 'ST003', 'qty', 2, 'bin', bc, 'location', 'HQ', 'note', '撤销拿下', 'confirm', true));
  assert pg_temp.binqty('A-R1-1', 'ST003') = a0 + 2, 'undo take (confirm)';
  b0 := pg_temp.binqty('A-R1-2', 'ST003');
  r := public.ops_wh_bin_op(jsonb_build_object('kind', 'move', 'item', 'ST003', 'qty', 1, 'from_bin', bc, 'to_bin', pg_temp.barcode('HQ', 'A-R1-2'), 'location', 'HQ'));
  assert pg_temp.binqty('A-R1-2', 'ST003') = b0 + 1 and pg_temp.binqty('A-R1-1', 'ST003') = a0 + 1, 'move';
  r := public.ops_wh_bin_op(jsonb_build_object('kind', 'move', 'item', 'ST003', 'qty', 1, 'from_bin', pg_temp.barcode('HQ', 'A-R1-2'), 'to_bin', bc, 'location', 'HQ', 'note', '撤销移货架'));
  assert pg_temp.binqty('A-R1-2', 'ST003') = b0 and pg_temp.binqty('A-R1-1', 'ST003') = a0 + 2, 'undo move';
end $$;
select pg_temp.as_user('whmgr@example.com');
do $$ declare before numeric; r jsonb; begin
  before := pg_temp.binqty('A-R2-2', 'ST003');
  r := public.ops_wh_bin_op('{"kind":"adjust","item":"ST003","qty":0,"bin":"A-R2-2","location":"HQ","note":"实际没有"}');
  assert pg_temp.binqty('A-R2-2', 'ST003') = 0 and (r->>'ok')::boolean, 'adjust to 0 allowed';
  r := public.ops_wh_bin_op(jsonb_build_object('kind', 'adjust', 'item', 'ST003', 'qty', before, 'bin', 'A-R2-2', 'location', 'HQ', 'note', '撤销改数', 'confirm', true));
  assert pg_temp.binqty('A-R2-2', 'ST003') = before, 'undo adjust';
  -- 改数后的纪录：kind adjust、备注照写
  assert public.ops_wh_bin_get('{"bin":"A-R2-2","location":"HQ"}')->'log'->0->>'note' = '撤销改数', 'adjust note';
end $$;

-- 2. 扫货架条码：不带仓位也找得到（画面会换到那个仓位）；带错的仓位 → 告诉在哪个仓位
select pg_temp.as_user('picker@example.com');
do $$ declare g jsonb; begin
  g := public.ops_wh_bin_get(jsonb_build_object('bin', pg_temp.barcode('SRGADING', 'S1')));
  assert g->>'location' = 'SRGADING' and g->>'code' = 'S1', 'barcode without location: ' || g::text;
  g := public.ops_wh_bin_get(jsonb_build_object('bin', lower(pg_temp.barcode('HQ', 'A-R1-1'))));
  assert g->>'code' = 'A-R1-1', 'barcode lowercase';
  g := public.ops_wh_bin_get('{"bin":"a-r1-1","location":"HQ"}');
  assert g->>'code' = 'A-R1-1', 'typed code';
end $$;
select pg_temp.expect_error(format($q$select public.ops_wh_bin_get('{"bin":"%s","location":"HQ"}')$q$, pg_temp.barcode('SRGADING', 'S1')), '在 SRGADING');
select pg_temp.expect_error(format($q$select public.ops_wh_bin_op('{"kind":"putaway","item":"ST003","qty":1,"bin":"%s","location":"HQ"}')$q$,
  pg_temp.barcode('SRGADING', 'S1')), '不是 HQ');
-- 打的字不是货架：找不到（画面接着当品名找）
select pg_temp.expect_error($q$select public.ops_wh_bin_get('{"bin":"basin","location":"HQ"}')$q$, '找不到货架');
-- 商品找不到：画面接着当货架代号找
select pg_temp.expect_error($q$select public.ops_wh_item_bins('{"item":"A-R1-1"}')$q$, '找不到这个商品');

-- 3. 停用的货架：清单要勾「显示停用的」才看得到、不能上架
select pg_temp.as_user('whmgr@example.com');
do $$ declare b jsonb; begin
  b := public.ops_wh_bin_save('{"location":"HQ","zone":"Z","shelf":"R1"}');
  perform public.ops_wh_bin_save(jsonb_build_object('id', b->>'id', 'location', 'HQ', 'zone', 'Z', 'shelf', 'R1', 'level', '', 'note', '拆掉了', 'active', false));
  assert not exists (select 1 from jsonb_array_elements(public.ops_wh_bins('{"location":"HQ"}')->'bins') x where x->>'code' = 'Z-R1'), 'inactive hidden';
  assert exists (select 1 from jsonb_array_elements(public.ops_wh_bins('{"location":"HQ","include_inactive":true}')->'bins') x
                 where x->>'code' = 'Z-R1' and not (x->>'active')::boolean and x->>'note' = '拆掉了'), 'inactive listed with flag';
  -- 重新启用
  perform public.ops_wh_bin_save(jsonb_build_object('id', b->>'id', 'location', 'HQ', 'zone', 'Z', 'shelf', 'R1', 'level', '', 'active', true));
  assert exists (select 1 from jsonb_array_elements(public.ops_wh_bins('{"location":"HQ"}')->'bins') x where x->>'code' = 'Z-R1'), 'reactivated';
  perform public.ops_wh_bin_save(jsonb_build_object('id', b->>'id', 'location', 'HQ', 'zone', 'Z', 'shelf', 'R1', 'level', '', 'active', false));
end $$;
select pg_temp.as_user('picker@example.com');
select pg_temp.expect_error($q$select public.ops_wh_bin_op('{"kind":"putaway","item":"ST003","qty":1,"bin":"Z-R1","location":"HQ"}')$q$, '已经停用');
-- 编辑货架（备注 / 停用）要可审批
select pg_temp.expect_error(format($q$select public.ops_wh_bin_save('{"id":%s,"location":"HQ","zone":"A","shelf":"R1","level":"1","note":"x"}')$q$,
  substr(pg_temp.barcode('HQ', 'A-R1-1'), 5)), '审批');

-- 4. 只看（门市）：清单、货架明细、对不上、商品分布都看得到；动作、建货架、带入都不行
select pg_temp.as_user('hqsales@example.com');
do $$ declare r jsonb; begin
  assert jsonb_array_length(public.ops_wh_bins('{}')->'summary') >= 2, 'view: summary';
  r := public.ops_wh_bin_recon('{"location":"HQ","filter":"all"}');
  assert (r->>'total')::int >= 2 and r->'counts' ? 'shelved', 'view: recon';
  assert jsonb_array_length(public.ops_wh_bin_get('{"bin":"A-R1-1","location":"HQ"}')->'log') >= 1, 'view: bin log';
  assert exists (select 1 from jsonb_array_elements(public.ops_wh_item_bins('{"item":"ST003"}')->'locations') x
                 where x->>'location' = 'HQ' and (x->>'has_bins')::boolean), 'view: item bins';
end $$;
select pg_temp.expect_error($q$select public.ops_wh_bin_op('{"kind":"take","item":"ST003","qty":1,"bin":"A-R1-1","location":"HQ"}')$q$, '编辑');
select pg_temp.expect_error($q$select public.ops_wh_bin_bulk('{"location":"HQ","shelves":["R7"]}')$q$, '审批');
select pg_temp.expect_error($q$select public.ops_wh_bin_import('{"location":"HQ","rows":[{"item":"ST003","bin":"A-R1-1","qty":1}],"dry_run":true}')$q$, '审批');

-- 5. Excel 带入（画面送的格式）：WMS 宽表整理过的 区 / 货架 / 层、长表的货架代号、0 = 改成 0；检查（dry_run）不存
select pg_temp.as_user('whmgr@example.com');
do $$ declare r jsonb; before numeric; begin
  before := pg_temp.binqty('A-R1-1', 'ST003');
  r := public.ops_wh_bin_import('{"location":"HQ","rows":[{"item":"st003","zone":"W","shelf":"R1","level":"1","qty":4},{"item":"ST004","bin":"a-r1-1","qty":2}],"create_bins":true,"dry_run":true}');
  assert (r->>'ok')::boolean and not (r->>'saved')::boolean and (r->>'new_bins')::int = 1, 'dry run: ' || r::text;
  assert r->'rows'->0->>'item_code' = 'ST003' and r->'rows'->0->>'bin' = 'W-R1-1' and r->'rows'->1->>'bin' = 'A-R1-1', 'row results: ' || r::text;
  assert not exists (select 1 from jsonb_array_elements(public.ops_wh_bins('{"location":"HQ"}')->'bins') x where x->>'code' = 'W-R1-1'), 'dry run creates nothing';
  -- 中文区名、货架有错字（空格）→ 那一行错，其他行照样回结果
  r := public.ops_wh_bin_import('{"location":"HQ","rows":[{"item":"ST003","zone":"大件","shelf":"R1","qty":1},{"item":"ST003","shelf":"R 2","qty":1}],"create_bins":true,"dry_run":true}');
  assert (r->>'errors')::int = 1 and (r->'rows'->0->>'ok')::boolean and r->'rows'->0->>'bin' = '大件-R1'
     and r->'rows'->1->>'error' like '%空格%', 'part errors: ' || r::text;
  r := public.ops_wh_bin_import('{"location":"HQ","rows":[{"item":"ST003","zone":"W","shelf":"R1","level":"1","qty":4},{"item":"ST003","bin":"A-R1-1","qty":0}],"create_bins":true}');
  assert (r->>'saved')::boolean and pg_temp.binqty('W-R1-1', 'ST003') = 4 and pg_temp.binqty('A-R1-1', 'ST003') = 0, 'import saved: ' || r::text;
  -- 改回原本的数（之后的测试不受影响）
  perform public.ops_wh_bin_import(jsonb_build_object('location', 'HQ', 'rows', jsonb_build_array(
    jsonb_build_object('item', 'ST003', 'bin', 'A-R1-1', 'qty', before), jsonb_build_object('item', 'ST003', 'bin', 'W-R1-1', 'qty', 0))));
  assert pg_temp.binqty('A-R1-1', 'ST003') = before, 'restored';
end $$;

-- 6. JB：扫到总部的货架条码 → 找不到（不会跨分店）；JB 的清单是空的
reset role;
do $$ declare bc text; begin
  select 'BIN:' || id into bc from ops.wh_bin where company = 'HOMEWORKSSB' order by id limit 1;
  perform set_config('test.hqbin', bc, false);
end $$;
set role authenticated;
select pg_temp.as_user('jbwh@example.com');
select pg_temp.expect_error(format($q$select public.ops_wh_bin_get('{"bin":"%s"}')$q$, current_setting('test.hqbin')), '找不到货架');
select pg_temp.expect_error($q$select public.ops_wh_item_bins('{"company":"HOMEWORKSSB","item":"ST003"}')$q$, '分店');
reset role;
select 'binui_test ok' as result;
