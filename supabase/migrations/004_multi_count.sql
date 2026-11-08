-- Several stock counts per day (run once in the Supabase SQL Editor, after 002 and 003; safe to run again).
-- Sales are worked out between every pair of consecutive counts, even on the same day.

alter table public.stock_counts drop constraint if exists stock_counts_canteen_id_counted_on_key;
create index if not exists stock_counts_day_idx on public.stock_counts (canteen_id, counted_on, created_at);

-- Where an event sits on one timeline, so several counts on the same day can be told apart.
--   end_of_day : a purchase/count made on its own date keeps its real time; a backdated purchase
--                sits at the start of its date, a backdated count at the end of its date.
--   start_of_day: a count sits just before its date begins, a purchase at the start of its date.
create or replace function public.event_pos(p_date date, p_created timestamptz, p_tz text, p_start_of_day boolean, p_is_count boolean)
returns timestamptz language sql stable as $$
  select case
    when p_start_of_day then (p_date::timestamp at time zone p_tz) - case when p_is_count then interval '1 second' else interval '0' end
    when (p_created at time zone p_tz)::date = p_date then p_created
    when p_is_count then (p_date::timestamp at time zone p_tz) + interval '1 day' - interval '1 second'
    else (p_date::timestamp at time zone p_tz)
  end
$$;
grant execute on function public.event_pos(date, timestamptz, text, boolean, boolean) to authenticated;

create or replace function public.recalc_item_cost(p_item uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_canteen uuid; v_timing text; v_tz text;
  r record;
  v_qty numeric := 0; v_avg numeric := 0; v_new numeric;
  v_last numeric; v_last_on date; v_has_purchase boolean := false;
begin
  select i.canteen_id, c.count_timing, c.timezone into v_canteen, v_timing, v_tz
  from public.items i join public.canteens c on c.id = i.canteen_id where i.id = p_item;
  if not found then return; end if;

  delete from public.item_cost_history where item_id = p_item;

  for r in
    select 'count'::text as kind, sc.counted_on as d,
           public.event_pos(sc.counted_on, sc.created_at, v_tz, v_timing = 'start_of_day', true) as pos,
           sc.id as ref, scl.qty as q, null::numeric as val, null::uuid as sup, null::numeric as unit
    from public.stock_count_lines scl join public.stock_counts sc on sc.id = scl.count_id
    where scl.item_id = p_item
    union all
    select 'purchase', pb.bill_date, public.event_pos(pb.bill_date, pb.created_at, v_tz, v_timing = 'start_of_day', false), pl.id, pl.total_pieces, pl.line_total, pb.supplier_id, pl.piece_cost
    from public.purchase_lines pl join public.purchase_bills pb on pb.id = pl.bill_id
    where pl.item_id = p_item
    order by pos, ref
  loop
    if r.kind = 'count' then
      insert into public.item_cost_history
        (canteen_id, item_id, event_type, event_date, ref_id, qty_before, qty_after, avg_cost_after)
      values (v_canteen, p_item, 'count', r.d, r.ref, v_qty, r.q, v_avg);
      v_qty := r.q;
    else
      v_new := v_qty + r.q;
      if v_new > 0 then v_avg := (v_qty * v_avg + r.val) / v_new; end if;
      insert into public.item_cost_history
        (canteen_id, item_id, event_type, event_date, ref_id, supplier_id, qty_before, qty_after, unit_cost, avg_cost_after)
      values (v_canteen, p_item, 'purchase', r.d, r.ref, r.sup, v_qty, v_new, r.unit, v_avg);
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

create or replace view public.v_item_status as
with me as (
  select c.id as canteen_id, c.stale_count_days, c.min_margin_pct, c.target_margin_pct
  from public.canteens c where c.id = public.current_canteen_id()
),
lc as (
  select distinct on (scl.item_id) scl.item_id, sc.counted_on
  from public.stock_count_lines scl join public.stock_counts sc on sc.id = scl.count_id
  order by scl.item_id, sc.counted_on desc, sc.created_at desc
),
x as (
  select i.id as item_id, i.canteen_id, i.name, i.shelf_order, i.pieces_per_pack, i.count_every_days,
         public.price_on(i.id, public.canteen_today()) as sell_price,
         lc.counted_on as last_counted_on,
         public.canteen_today() - lc.counted_on as days_since_count,
         (lc.counted_on is null
          or public.canteen_today() - lc.counted_on > coalesce(i.count_every_days, me.stale_count_days)) as count_overdue,
         ic.avg_cost, ic.last_cost, me.min_margin_pct, me.target_margin_pct
  from public.items i
  join me on me.canteen_id = i.canteen_id
  left join lc on lc.item_id = i.id
  left join public.item_costs ic on ic.item_id = i.id
  where i.is_active
    and ((select public.has_perm('items', 'view')) or (select public.has_perm('stock_counts', 'view')))
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
            else 'ok' end as margin_flag
from x;

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
       cnt.prev_on as from_on, cnt.counted_on as to_on,
       cnt.prev_qty as opening_qty, pu.q as purchased_qty, wa.q as wastage_qty, cnt.qty as closing_qty,
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
  select coalesce(sum(pl.total_pieces), 0) as q
  from public.purchase_lines pl join public.purchase_bills pb on pb.id = pl.bill_id
  where pl.item_id = cnt.item_id
    and public.event_pos(pb.bill_date, pb.created_at, cfg.tz, cfg.sod, false) > cnt.prev_pos
    and public.event_pos(pb.bill_date, pb.created_at, cfg.tz, cfg.sod, false) <= cnt.pos) pu
cross join lateral (
  select coalesce(sum(w.qty), 0) as q from public.wastage w
  where w.item_id = cnt.item_id
    and public.event_pos(w.wasted_on, w.created_at, cfg.tz, cfg.sod, false) > cnt.prev_pos
    and public.event_pos(w.wasted_on, w.created_at, cfg.tz, cfg.sod, false) <= cnt.pos) wa
cross join lateral (select cnt.prev_qty + pu.q - wa.q - cnt.qty as sold) s
cross join lateral (select public.price_on(cnt.item_id, cnt.counted_on - cfg.o) as price) pr
left join public.item_cost_history ch
       on ch.item_id = cnt.item_id and ch.event_type = 'count' and ch.ref_id = cnt.count_id
where cnt.prev_on is not null
  and (select public.has_perm('reports', 'view'));

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
         x.item_id, x.open_q, x.close_q, wa.q as wasted,
         case when x.open_q is not null and x.close_q is not null
              then x.open_q + pu.q - wa.q - x.close_q end as sold,
         public.price_on(x.item_id, per.counted_on - per.o) as price,
         ch.avg_cost_after as avg_cost
  from per
  cross join lateral (
    select item_id, a.qty as open_q, b.qty as close_q
    from (select item_id, qty from public.stock_count_lines where count_id = per.prev_id) a
    full join (select item_id, qty from public.stock_count_lines where count_id = per.count_id) b using (item_id)
  ) x
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

-- Rebuild every item's cost history with the new ordering.
select public.recalc_item_cost(id) from public.items;
