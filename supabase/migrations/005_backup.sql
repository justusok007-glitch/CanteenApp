-- Restore from a backup file (run once in the Supabase SQL Editor; safe to run again).
-- Admin only. Replaces ALL canteen data with the contents of a backup made by the app's "Download backup".
-- Kept as they are: canteen settings, roles, everyone's login.

create or replace function public.restore_canteen_data(p_confirm text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_c uuid := public.current_canteen_id();
  v_tables text[] := array['suppliers','items','item_price_history','purchase_bills','purchase_lines',
    'supplier_payments','stock_counts','stock_count_lines','wastage','cash_handovers','credit_entries','expenses','school_days'];
  t text; v_cols text; v_sel text; v_rows jsonb; v_n int; v_order text; v_out jsonb := '{}'::jsonb;
begin
  if v_c is null or not public.is_admin() then
    raise exception 'Only an admin can restore a backup.' using errcode = '42501';
  end if;
  if p_confirm is distinct from 'RESTORE' then
    raise exception 'Type RESTORE to confirm.' using errcode = '22023';
  end if;
  if p_data is null or p_data->>'format' is distinct from 'canteenapp-backup' or jsonb_typeof(p_data->'tables') <> 'object' then
    raise exception 'This file is not a CanteenApp backup.' using errcode = '22023';
  end if;

  perform public.reset_canteen_data('RESET');

  foreach t in array v_tables loop
    v_rows := coalesce(p_data->'tables'->t, '[]'::jsonb);
    if jsonb_typeof(v_rows) <> 'array' then raise exception 'Backup table % is damaged.', t; end if;
    select string_agg(quote_ident(column_name), ', ' order by ordinal_position),
           string_agg(case column_name
                        when 'canteen_id' then quote_literal(v_c::text) || '::uuid'
                        when 'counted_by' then 'case when counted_by in (select id from public.users) then counted_by end'
                        when 'new_sell_price' then 'null::numeric'
                        else quote_ident(column_name) end, ', ' order by ordinal_position)
      into v_cols, v_sel
      from information_schema.columns
     where table_schema = 'public' and table_name = t and is_generated = 'NEVER' and is_identity = 'NO';
    v_order := case t when 'item_price_history' then ' order by starts_on, created_at' else '' end;
    execute format('insert into public.%I (%s) select %s from jsonb_populate_recordset(null::public.%I, $1)%s',
                   t, v_cols, v_sel, t, v_order) using v_rows;
    get diagnostics v_n = row_count;
    v_out := v_out || jsonb_build_object(t, v_n);
  end loop;

  -- purchases adjust pack size and last supplier while loading; put the saved values back
  update public.items i set pieces_per_pack = r.pieces_per_pack, last_supplier_id = r.last_supplier_id
    from jsonb_populate_recordset(null::public.items, coalesce(p_data->'tables'->'items', '[]'::jsonb)) r
   where i.id = r.id and i.canteen_id = v_c;

  perform public.recalc_item_cost(id) from public.items where canteen_id = v_c;
  return v_out;
end $$;

revoke all on function public.restore_canteen_data(text, jsonb) from public, anon;
grant execute on function public.restore_canteen_data(text, jsonb) to authenticated;
