-- New items from purchases, live stock, faster saves (run once in the Supabase SQL Editor, after 005; safe to run again).
--
-- 1. An item typed straight into a purchase (never counted before) now has stock from the moment it is bought:
--    its opening stock is 0, so the first count after the purchase closes a normal sales period.
--    It shows up in stock, the count screen, Items by sales, daily sales, the dashboard and the cash check.
-- 2. v_item_status gives the stock on the shelf now (last count + purchases since - wastage since), so the
--    count, items and stock-report screens get it in one request instead of five.
-- 3. Stock counted before the first purchase no longer counts as costing Rs 0: it takes the first price paid,
--    and periods before any purchase are flagged "no cost" instead of showing the whole sale as profit.
-- 4. Saving a count or a bill only rebuilds the cost history from that entry onward (it used to rebuild
--    every item's whole history on every save, which got slower every week).
-- 5. The home dashboard reads only this month's periods instead of all history.

create index if not exists wastage_item_idx on public.wastage (item_id);

-- Where each cost-history row sits on the timeline, so a rebuild can start from a point instead of the beginning.
alter table public.item_cost_history add column if not exists pos timestamptz;
alter table public.item_cost_history alter column avg_cost_after drop not null;   -- NULL = no purchase yet, cost unknown
create index if not exists item_cost_history_pos_idx on public.item_cost_history (item_id, pos);

-- Rebuilds one item's cost history from p_from onward (NULL = from the beginning).
create or replace function public.recalc_item_cost_from(p_item uuid, p_from timestamptz) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_canteen uuid; v_timing text; v_tz text;
  r record;
  v_qty numeric := 0; v_avg numeric; v_new numeric;
  v_last numeric; v_last_on date; v_has_purchase boolean := false;
  v_seed_qty numeric; v_seed_avg numeric;
begin
  select i.canteen_id, c.count_timing, c.timezone into v_canteen, v_timing, v_tz
  from public.items i join public.canteens c on c.id = i.canteen_id where i.id = p_item;
  if not found then return; end if;

  -- rows written before this migration have no position: rebuild everything once
  if p_from is not null and exists (select 1 from public.item_cost_history where item_id = p_item and pos is null) then
    p_from := null;
  end if;

  if p_from is null then
    delete from public.item_cost_history where item_id = p_item;
  else
    select h.qty_after, h.avg_cost_after into v_seed_qty, v_seed_avg
    from public.item_cost_history h where h.item_id = p_item and h.pos < p_from
    order by h.pos desc, h.id desc limit 1;
    if found then v_qty := v_seed_qty; v_avg := v_seed_avg; end if;
    select h.unit_cost, h.event_date into v_last, v_last_on
    from public.item_cost_history h where h.item_id = p_item and h.event_type = 'purchase' and h.pos < p_from
    order by h.pos desc, h.id desc limit 1;
    v_has_purchase := found;
    delete from public.item_cost_history where item_id = p_item and pos >= p_from;
  end if;

  for r in
    select * from (
      select 'count'::text as kind, sc.counted_on as d,
             public.event_pos(sc.counted_on, sc.created_at, v_tz, v_timing = 'start_of_day', true) as pos,
             sc.id as ref, scl.qty as q, null::numeric as val, null::uuid as sup, null::numeric as unit
      from public.stock_count_lines scl join public.stock_counts sc on sc.id = scl.count_id
      where scl.item_id = p_item
      union all
      select 'purchase', pb.bill_date, public.event_pos(pb.bill_date, pb.created_at, v_tz, v_timing = 'start_of_day', false),
             pl.id, pl.total_pieces, pl.line_total, pb.supplier_id, pl.piece_cost
      from public.purchase_lines pl join public.purchase_bills pb on pb.id = pl.bill_id
      where pl.item_id = p_item
    ) e
    where p_from is null or e.pos >= p_from
    order by e.pos, e.ref
  loop
    if r.kind = 'count' then
      insert into public.item_cost_history
        (canteen_id, item_id, event_type, event_date, ref_id, qty_before, qty_after, avg_cost_after, pos)
      values (v_canteen, p_item, 'count', r.d, r.ref, v_qty, r.q, case when v_has_purchase then v_avg end, r.pos);
      v_qty := r.q;
    else
      v_new := v_qty + r.q;
      if not v_has_purchase or v_avg is null then
        v_avg := r.unit;   -- stock already on the shelf had no known cost: value it at the first price paid
      elsif v_new > 0 then
        v_avg := (v_qty * v_avg + r.val) / v_new;
      end if;
      insert into public.item_cost_history
        (canteen_id, item_id, event_type, event_date, ref_id, supplier_id, qty_before, qty_after, unit_cost, avg_cost_after, pos)
      values (v_canteen, p_item, 'purchase', r.d, r.ref, r.sup, v_qty, v_new, r.unit, v_avg, r.pos);
      v_qty := v_new; v_last := r.unit; v_last_on := r.d; v_has_purchase := true;
    end if;
  end loop;

  if v_has_purchase then
    insert into public.item_costs (item_id, canteen_id, avg_cost, last_cost, last_cost_on)
    values (p_item, v_canteen, v_avg, v_last, v_last_on)
    on conflict (item_id) do update
      set avg_cost = excluded.avg_cost, last_cost = excluded.last_cost, last_cost_on = excluded.last_cost_on;
  else
    delete from public.item_costs where item_id = p_item;   -- no cost known: reports flag it
  end if;
end $$;

-- Full rebuild (used after edits, deletes and date changes).
create or replace function public.recalc_item_cost(p_item uuid) returns void
language sql security definer set search_path = public as $$
  select public.recalc_item_cost_from(p_item, null)
$$;

-- A new count line only rebuilds from that count onward.
create or replace function public.stock_count_lines_after() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.recalc_item_cost_from(new.item_id,
      (select public.event_pos(sc.counted_on, sc.created_at, c.timezone, c.count_timing = 'start_of_day', true)
       from public.stock_counts sc join public.canteens c on c.id = sc.canteen_id where sc.id = new.count_id));
    return null;
  end if;
  perform public.recalc_item_cost(old.item_id);
  if tg_op = 'UPDATE' and new.item_id <> old.item_id then perform public.recalc_item_cost(new.item_id); end if;
  return null;
end $$;

-- Same for a new purchase line; everything else is unchanged from schema.sql.
create or replace function public.purchase_lines_after() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_bill uuid; v_sup uuid; v_date date; v_is_latest boolean; v_pos timestamptz;
begin
  -- keep bill totals in step with their lines
  for v_bill in
    select distinct t.b from (values (case when tg_op <> 'INSERT' then old.bill_id end),
                                     (case when tg_op <> 'DELETE' then new.bill_id end)) t(b)
    where t.b is not null
  loop
    update public.purchase_bills
       set total_amount = round(coalesce((select sum(line_total) from public.purchase_lines where bill_id = v_bill), 0), 2)
     where id = v_bill;
  end loop;

  -- rebuild cost for the affected item(s)
  if tg_op = 'INSERT' then
    select public.event_pos(b.bill_date, b.created_at, c.timezone, c.count_timing = 'start_of_day', false)
      into v_pos
    from public.purchase_bills b join public.canteens c on c.id = b.canteen_id where b.id = new.bill_id;
    perform public.recalc_item_cost_from(new.item_id, v_pos);
  else
    perform public.recalc_item_cost(old.item_id);
    if tg_op = 'UPDATE' and new.item_id <> old.item_id then perform public.recalc_item_cost(new.item_id); end if;
  end if;

  -- a new line refreshes the item's usual pack size / last supplier and may set a new sell price
  if tg_op = 'INSERT' then
    select b.supplier_id, b.bill_date into v_sup, v_date from public.purchase_bills b where b.id = new.bill_id;
    select not exists (select 1 from public.purchase_lines pl join public.purchase_bills b2 on b2.id = pl.bill_id
                       where pl.item_id = new.item_id and pl.id <> new.id and b2.bill_date > v_date)
      into v_is_latest;
    if v_is_latest then
      update public.items set pieces_per_pack = new.pieces_per_pack, last_supplier_id = v_sup where id = new.item_id;
    end if;
    if new.new_sell_price is not null then
      -- the item's very first price starts on the bill date; later changes start today
      perform public.set_item_price(new.item_id, new.new_sell_price,
        case when exists (select 1 from public.item_price_history h where h.item_id = new.item_id)
             then null else v_date end);
    end if;
  end if;
  return null;
end $$;

-- Items with their stock on the shelf now. New columns are added at the end.
--   stock_qty = last count + purchases since - wastage since  (never counted: purchases - wastage)
create or replace view public.v_item_status as
with me as (
  select c.id as canteen_id, c.stale_count_days, c.min_margin_pct, c.target_margin_pct,
         c.timezone as tz, (c.count_timing = 'start_of_day') as sod
  from public.canteens c where c.id = public.current_canteen_id()
),
x as (
  select i.id as item_id, i.canteen_id, i.name, i.shelf_order, i.pieces_per_pack, i.count_every_days,
         public.price_on(i.id, public.canteen_today()) as sell_price,
         lc.counted_on as last_counted_on,
         public.canteen_today() - lc.counted_on as days_since_count,
         (lc.counted_on is null
          or public.canteen_today() - lc.counted_on > coalesce(i.count_every_days, me.stale_count_days)) as count_overdue,
         ic.avg_cost, ic.last_cost, me.min_margin_pct, me.target_margin_pct,
         lc.qty as last_count_qty, pu.q as purchased_since, wa.q as wasted_since
  from public.items i
  join me on me.canteen_id = i.canteen_id
  left join lateral (
    select sc.counted_on, scl.qty, p.pos
    from public.stock_count_lines scl
    join public.stock_counts sc on sc.id = scl.count_id
    cross join lateral (select public.event_pos(sc.counted_on, sc.created_at, me.tz, me.sod, true) as pos) p
    where scl.item_id = i.id
    order by p.pos desc, sc.created_at desc, sc.id desc
    limit 1) lc on true
  left join public.item_costs ic on ic.item_id = i.id
  cross join lateral (
    select coalesce(sum(pl.total_pieces), 0) as q
    from public.purchase_lines pl join public.purchase_bills pb on pb.id = pl.bill_id
    where pl.item_id = i.id
      and (lc.pos is null or public.event_pos(pb.bill_date, pb.created_at, me.tz, me.sod, false) > lc.pos)) pu
  cross join lateral (
    select coalesce(sum(w.qty), 0) as q from public.wastage w
    where w.item_id = i.id
      and (lc.pos is null or public.event_pos(w.wasted_on, w.created_at, me.tz, me.sod, false) > lc.pos)) wa
  where i.is_active
    and ((select public.has_perm('items', 'view')) or (select public.has_perm('stock_counts', 'view'))
         or (select public.has_perm('reports', 'view')) or (select public.has_perm('purchases', 'add')))
)
select item_id, canteen_id, name, shelf_order, pieces_per_pack, count_every_days, sell_price,
       last_counted_on, days_since_count, count_overdue,
       case when public.can_see_cost() then avg_cost  end as avg_cost,
       case when public.can_see_cost() then last_cost end as last_cost,
       case when public.can_see_cost() and avg_cost is not null and sell_price > 0
            then round((sell_price - avg_cost) / sell_price * 100, 2) end as margin_pct,
       case when not public.can_see_cost() then null
            when avg_cost is null   then 'no_cost'      -- profit would silently be wrong
            when sell_price is null then 'no_price'
            when sell_price < avg_cost then 'below_cost'
            when min_margin_pct is not null and (sell_price - avg_cost) / nullif(sell_price,0) * 100 < min_margin_pct then 'low'
            when target_margin_pct is not null and (sell_price - avg_cost) / nullif(sell_price,0) * 100 >= target_margin_pct then 'good'
            else 'ok' end as margin_flag,
       last_count_qty, purchased_since, wasted_since,
       coalesce(last_count_qty, 0) + purchased_since - wasted_since as stock_qty
from x;

-- Per item, between each pair of consecutive counts (partial counts included):
--   sold = last count + purchases in the window - wastage in the window - new count
-- An item bought before it was ever counted starts at 0 stock, so its first count closes a period too
-- (from_on is then the date of its first purchase).
create or replace view public.v_item_periods as
with cfg as (
  select c.id as canteen_id, case when c.count_timing = 'start_of_day' then 1 else 0 end as o,
         c.timezone as tz, (c.count_timing = 'start_of_day') as sod
  from public.canteens c where c.id = public.current_canteen_id()
),
cnt as (
  select scl.canteen_id, scl.item_id, sc.id as count_id, sc.counted_on, scl.qty, x.pos,
         lag(sc.counted_on) over w as prev_on, lag(scl.qty) over w as prev_qty, lag(x.pos) over w as prev_pos
  from public.stock_count_lines scl
  join public.stock_counts sc on sc.id = scl.count_id
  cross join cfg
  cross join lateral (select public.event_pos(sc.counted_on, sc.created_at, cfg.tz, cfg.sod, true) as pos) x
  where scl.canteen_id = public.current_canteen_id()
  window w as (partition by scl.item_id order by x.pos, sc.created_at, sc.id)
)
select cnt.canteen_id, cnt.item_id, i.name as item_name,
       coalesce(cnt.prev_on, pu.first_on) as from_on, cnt.counted_on as to_on,
       coalesce(cnt.prev_qty, 0) as opening_qty, pu.q as purchased_qty, wa.q as wastage_qty, cnt.qty as closing_qty,
       s.sold as sold_qty, pr.price as sell_price, s.sold * pr.price as sales_value,
       case when public.can_see_cost() then ch.avg_cost_after end as avg_cost,
       case when public.can_see_cost() then s.sold * ch.avg_cost_after end as cogs,
       case when public.can_see_cost() then s.sold * (pr.price - ch.avg_cost_after) end as gross_profit,
       case when public.can_see_cost() and pr.price > 0 and ch.avg_cost_after is not null
            then round((pr.price - ch.avg_cost_after) / pr.price * 100, 2) end as margin_pct,
       (s.sold < 0) as sold_negative,                          -- count mistake or missing purchase
       case when public.can_see_cost() then ch.avg_cost_after is null end as cost_missing,
       cnt.count_id
from cnt
join cfg on cfg.canteen_id = cnt.canteen_id
join public.items i on i.id = cnt.item_id
cross join lateral (
  select coalesce(sum(pl.total_pieces), 0) as q, min(pb.bill_date) as first_on
  from public.purchase_lines pl join public.purchase_bills pb on pb.id = pl.bill_id
  where pl.item_id = cnt.item_id
    and (cnt.prev_pos is null or public.event_pos(pb.bill_date, pb.created_at, cfg.tz, cfg.sod, false) > cnt.prev_pos)
    and public.event_pos(pb.bill_date, pb.created_at, cfg.tz, cfg.sod, false) <= cnt.pos) pu
cross join lateral (
  select coalesce(sum(w.qty), 0) as q from public.wastage w
  where w.item_id = cnt.item_id
    and (cnt.prev_pos is null or public.event_pos(w.wasted_on, w.created_at, cfg.tz, cfg.sod, false) > cnt.prev_pos)
    and public.event_pos(w.wasted_on, w.created_at, cfg.tz, cfg.sod, false) <= cnt.pos) wa
cross join lateral (select coalesce(cnt.prev_qty, 0) + pu.q - wa.q - cnt.qty as sold) s
cross join lateral (select public.price_on(cnt.item_id, cnt.counted_on - cfg.o) as price) pr
left join public.item_cost_history ch
       on ch.item_id = cnt.item_id and ch.event_type = 'count' and ch.ref_id = cnt.count_id
where (cnt.prev_on is not null or pu.q > 0)
  and (select public.has_perm('reports', 'view'));

-- Cash check between full counts. An item that had never been counted before the opening full count
-- (bought new in this period) opens at 0 instead of being reported as missing.
create or replace view public.v_period_report as
with cfg as (
  select c.id as canteen_id, case when c.count_timing = 'start_of_day' then 1 else 0 end as o,
         c.timezone as tz, (c.count_timing = 'start_of_day') as sod,
         c.tolerance_pct, c.daily_salary
  from public.canteens c where c.id = public.current_canteen_id()
),
fc0 as (   -- the day's last full count closes that day's cash
  select distinct on (sc.counted_on) sc.canteen_id, sc.id as count_id, sc.counted_on, sc.created_at
  from public.stock_counts sc
  where sc.is_full and sc.canteen_id = public.current_canteen_id()
  order by sc.counted_on, sc.created_at desc
),
fc as (
  select f.canteen_id, f.count_id, f.counted_on, x.pos,
         lag(f.count_id) over w as prev_id, lag(f.counted_on) over w as prev_on, lag(x.pos) over w as prev_pos
  from fc0 f cross join cfg
  cross join lateral (select public.event_pos(f.counted_on, f.created_at, cfg.tz, cfg.sod, true) as pos) x
  window w as (order by f.counted_on)
),
per as (
  select fc.canteen_id, fc.count_id, fc.prev_id, fc.prev_on, fc.counted_on, fc.pos, fc.prev_pos,
         cfg.o, cfg.tz, cfg.sod, cfg.tolerance_pct, cfg.daily_salary
  from fc join cfg on cfg.canteen_id = fc.canteen_id
  where fc.prev_id is not null
),
lines as (
  select per.canteen_id, per.count_id, per.prev_on, per.counted_on, per.o, per.tolerance_pct, per.daily_salary,
         x.item_id, oq.open_q, x.close_q, wa.q as wasted,
         case when oq.open_q is not null and x.close_q is not null
              then oq.open_q + pu.q - wa.q - x.close_q end as sold,
         public.price_on(x.item_id, per.counted_on - per.o) as price,
         ch.avg_cost_after as avg_cost
  from per
  cross join lateral (
    select item_id, a.qty as open_q, b.qty as close_q
    from (select item_id, qty from public.stock_count_lines where count_id = per.prev_id) a
    full join (select item_id, qty from public.stock_count_lines where count_id = per.count_id) b using (item_id)
  ) x
  cross join lateral (
    select coalesce(x.open_q,
             case when not exists (
                    select 1 from public.stock_count_lines l2 join public.stock_counts s2 on s2.id = l2.count_id
                    where l2.item_id = x.item_id
                      and public.event_pos(s2.counted_on, s2.created_at, per.tz, per.sod, true) <= per.prev_pos)
                  then 0 end) as open_q) oq
  cross join lateral (
    select coalesce(sum(pl.total_pieces), 0) as q
    from public.purchase_lines pl join public.purchase_bills pb on pb.id = pl.bill_id
    where pl.item_id = x.item_id
      and public.event_pos(pb.bill_date, pb.created_at, per.tz, per.sod, false) > per.prev_pos
      and public.event_pos(pb.bill_date, pb.created_at, per.tz, per.sod, false) <= per.pos) pu
  cross join lateral (
    select coalesce(sum(w.qty), 0) as q from public.wastage w
    where w.item_id = x.item_id
      and public.event_pos(w.wasted_on, w.created_at, per.tz, per.sod, false) > per.prev_pos
      and public.event_pos(w.wasted_on, w.created_at, per.tz, per.sod, false) <= per.pos) wa
  left join public.item_cost_history ch
         on ch.item_id = x.item_id and ch.event_type = 'count' and ch.ref_id = per.count_id
),
agg as (
  select canteen_id, prev_on, counted_on, o, tolerance_pct, daily_salary,
         sum(sold * price)      filter (where sold is not null and price is not null)    as revenue,
         sum(sold * avg_cost)   filter (where sold is not null and avg_cost is not null) as cogs,
         sum(wasted * avg_cost) filter (where avg_cost is not null)                       as wastage_cost,
         count(*) filter (where open_q is null or close_q is null)  as items_missing,   -- not in both full counts
         count(*) filter (where sold < 0)                           as items_negative,
         count(*) filter (where sold > 0 and avg_cost is null)      as items_no_cost,
         count(*) filter (where sold > 0 and price is null)         as items_no_price
  from lines
  group by canteen_id, prev_on, counted_on, o, tolerance_pct, daily_salary
),
calc as (
  select a.*,
         coalesce(a.revenue, 0) as sales_value,
         cr.given as credit_given, cr.received as credit_received,
         coalesce(a.revenue, 0) - cr.given + cr.received as expected_cash,
         h.cash_handed, h.salary_kept,
         ex.other_expenses, sd.active_days
  from agg a
  cross join lateral (
    select coalesce(sum(ce.amount) filter (where ce.entry_type = 'given'), 0)    as given,
           coalesce(sum(ce.amount) filter (where ce.entry_type = 'received'), 0) as received
    from public.credit_entries ce
    where ce.canteen_id = a.canteen_id and ce.entry_on > a.prev_on - a.o and ce.entry_on <= a.counted_on - a.o) cr
  cross join lateral (
    select coalesce(sum(ch2.cash_handed), 0) as cash_handed, coalesce(sum(ch2.salary_kept), 0) as salary_kept
    from public.cash_handovers ch2
    where ch2.canteen_id = a.canteen_id and ch2.handed_on > a.prev_on - a.o and ch2.handed_on <= a.counted_on - a.o) h
  cross join lateral (
    select coalesce(sum(e.amount), 0) as other_expenses
    from public.expenses e
    where e.canteen_id = a.canteen_id and e.spent_on > a.prev_on - a.o and e.spent_on <= a.counted_on - a.o) ex
  cross join lateral (
    select count(*) as active_days
    from public.school_days d
    where d.canteen_id = a.canteen_id and d.is_active and d.day > a.prev_on - a.o and d.day <= a.counted_on - a.o) sd
)
select c.canteen_id, c.prev_on as from_on, c.counted_on as to_on, c.counted_on - c.prev_on as days,
       c.sales_value, c.credit_given, c.credit_received, c.expected_cash,
       c.cash_handed, c.salary_kept,
       c.expected_cash - c.cash_handed - c.salary_kept as shortage,
       round((c.expected_cash - c.cash_handed - c.salary_kept) / nullif(c.expected_cash, 0) * 100, 2) as shortage_pct,
       abs((c.expected_cash - c.cash_handed - c.salary_kept) / nullif(c.expected_cash, 0) * 100) <= c.tolerance_pct as within_tolerance,
       c.active_days, c.active_days * c.daily_salary as salary_expected,
       case when public.can_see_cost() then c.cogs end as cogs,
       case when public.can_see_cost() then c.sales_value - coalesce(c.cogs, 0) end as gross_profit,
       case when public.can_see_cost() then coalesce(c.wastage_cost, 0) end as wastage_cost,
       c.other_expenses,
       case when public.can_see_cost() then
            c.sales_value - coalesce(c.cogs, 0) - c.salary_kept - coalesce(c.wastage_cost, 0) - c.other_expenses end as expected_net_profit,
       case when public.can_see_cost() then
            c.sales_value - coalesce(c.cogs, 0) - c.salary_kept - coalesce(c.wastage_cost, 0) - c.other_expenses
            - (c.expected_cash - c.cash_handed - c.salary_kept) end as actual_net_profit,
       c.items_missing, c.items_negative, c.items_no_cost, c.items_no_price
from calc c
where (select public.has_perm('reports', 'view'));

-- One row per business day (same as schema.sql; 002 had an older version that dropped same-day periods).
create or replace view public.v_sales_by_day as
select p.canteen_id,
       gs.day::date as day,
       sum(p.sales_value / (b.hi - b.lo + 1)) as sales_value,
       case when public.can_see_cost() then sum(p.gross_profit / (b.hi - b.lo + 1)) end as gross_profit
from public.v_item_periods p
join public.canteens c on c.id = p.canteen_id
cross join lateral (
  select case when p.to_on = p.from_on then p.to_on
              else p.from_on + 1 - case when c.count_timing = 'start_of_day' then 1 else 0 end end as lo,
         case when p.to_on = p.from_on then p.to_on
              else p.to_on - case when c.count_timing = 'start_of_day' then 1 else 0 end end as hi) b
cross join lateral generate_series(b.lo::timestamp, b.hi::timestamp, interval '1 day') as gs(day)
group by p.canteen_id, gs.day;

-- Home screen: only periods that end this month or later are read (it used to work through all history).
create or replace view public.v_dashboard as
with t as (
  select c.id as canteen_id, public.canteen_today() as today,
         date_trunc('month', public.canteen_today())::date as m0,
         case when c.count_timing = 'start_of_day' then 1 else 0 end as o
  from public.canteens c where c.id = public.current_canteen_id()
),
p as (
  select ip.canteen_id, ip.sales_value, ip.gross_profit,
         case when ip.to_on = ip.from_on then ip.to_on else ip.from_on + 1 - t.o end as lo,
         case when ip.to_on = ip.from_on then ip.to_on else ip.to_on - t.o end as hi
  from public.v_item_periods ip join t on t.canteen_id = ip.canteen_id
  where ip.to_on >= date_trunc('month', public.canteen_today())::date
),
s as (
  select p.canteen_id,
         sum(p.sales_value  * (least(p.hi, t.today) - greatest(p.lo, t.m0) + 1) / (p.hi - p.lo + 1))
           filter (where p.hi >= t.m0 and p.lo <= t.today) as month_sales,
         sum(p.gross_profit * (least(p.hi, t.today) - greatest(p.lo, t.m0) + 1) / (p.hi - p.lo + 1))
           filter (where p.hi >= t.m0 and p.lo <= t.today) as month_gross,
         sum(p.sales_value / (p.hi - p.lo + 1)) filter (where t.today between p.lo and p.hi) as today_sales
  from p join t on t.canteen_id = p.canteen_id
  group by p.canteen_id
)
select t.canteen_id,
       (select max(sc.counted_on) from public.stock_counts sc where sc.canteen_id = t.canteen_id) as as_of,
       t.today, t.m0 as month_start,
       s.today_sales,
       coalesce(s.month_sales, 0) as month_sales,
       case when public.can_see_cost() then
         coalesce(s.month_gross, 0)
         - coalesce((select sum(h.salary_kept) from public.cash_handovers h
                     where h.canteen_id = t.canteen_id and h.handed_on between t.m0 and t.today), 0)
         - coalesce((select sum(w.qty * ic.avg_cost) from public.wastage w join public.item_costs ic on ic.item_id = w.item_id
                     where w.canteen_id = t.canteen_id and w.wasted_on between t.m0 and t.today), 0)
         - coalesce((select sum(e.amount) from public.expenses e
                     where e.canteen_id = t.canteen_id and e.spent_on between t.m0 and t.today), 0)
       end as month_profit
from t left join s on s.canteen_id = t.canteen_id
where (select public.has_perm('reports', 'view'));

revoke all on public.v_item_status, public.v_item_periods, public.v_period_report, public.v_sales_by_day, public.v_dashboard
  from anon, public;
grant select on public.v_item_status, public.v_item_periods, public.v_period_report, public.v_sales_by_day, public.v_dashboard
  to authenticated;
revoke execute on function public.recalc_item_cost_from(uuid, timestamptz) from public, anon, authenticated;

-- Rebuild every item's cost history once (fills the new position column and the first-cost fix).
select public.recalc_item_cost(id) from public.items;
