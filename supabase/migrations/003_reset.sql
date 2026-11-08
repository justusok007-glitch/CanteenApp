-- Reset app (run once in the Supabase SQL Editor; safe to run again).
-- Lets an admin erase all canteen data for a fresh start. Keeps the canteen settings,
-- roles, permissions and user accounts, so everyone can still log in.
create or replace function public.reset_canteen_data(p_confirm text) returns void
language plpgsql security definer set search_path = public as $$
declare v_c uuid := public.current_canteen_id();
begin
  if v_c is null or not public.is_admin() then
    raise exception 'Only an admin can reset the app.' using errcode = '42501';
  end if;
  if p_confirm is distinct from 'RESET' then
    raise exception 'Type RESET to confirm.' using errcode = '22023';
  end if;

  delete from public.wastage            where canteen_id = v_c;
  delete from public.cash_handovers     where canteen_id = v_c;
  delete from public.credit_entries     where canteen_id = v_c;
  delete from public.expenses           where canteen_id = v_c;
  delete from public.school_days        where canteen_id = v_c;
  delete from public.stock_count_lines  where canteen_id = v_c;
  delete from public.stock_counts       where canteen_id = v_c;
  delete from public.supplier_payments  where canteen_id = v_c;
  delete from public.purchase_lines     where canteen_id = v_c;
  delete from public.purchase_bills     where canteen_id = v_c;
  -- the deletes above refresh item costs, so clear those last
  delete from public.item_cost_history  where canteen_id = v_c;
  delete from public.item_costs         where canteen_id = v_c;
  delete from public.item_price_history where canteen_id = v_c;
  delete from public.items              where canteen_id = v_c;
  delete from public.suppliers          where canteen_id = v_c;
  delete from public.audit_log          where canteen_id = v_c;
end $$;

revoke all on function public.reset_canteen_data(text) from public, anon;
grant execute on function public.reset_canteen_data(text) to authenticated;
