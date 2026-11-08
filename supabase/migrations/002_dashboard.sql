-- Dashboard stats (run once in the Supabase SQL Editor; safe to run again).
-- Sales are calculated from stock counts, so each count-to-count period's sales and
-- gross profit are spread evenly over the business days that period covers.

-- One row per business day with that day's estimated sales and gross profit.
create or replace view public.v_sales_by_day as
select p.canteen_id,
       gs.day::date as day,
       sum(p.sales_value / nullif(p.to_on - p.from_on, 0)) as sales_value,
       case when public.can_see_cost() then sum(p.gross_profit / nullif(p.to_on - p.from_on, 0)) end as gross_profit
from public.v_item_periods p
join public.canteens c on c.id = p.canteen_id
cross join lateral generate_series(
  (p.from_on + 1 - case when c.count_timing = 'start_of_day' then 1 else 0 end)::timestamp,
  (p.to_on          - case when c.count_timing = 'start_of_day' then 1 else 0 end)::timestamp,
  interval '1 day') as gs(day)
group by p.canteen_id, gs.day;

-- Single row for the home screen.
--   today_sales is NULL until a stock count closes today.
--   month_profit = gross profit - salary kept - wastage (at current average cost) - other expenses.
create or replace view public.v_dashboard as
with t as (
  select c.id as canteen_id, public.canteen_today() as today,
         date_trunc('month', public.canteen_today())::date as m0
  from public.canteens c where c.id = public.current_canteen_id()
),
s as (
  select d.canteen_id,
         sum(d.sales_value)  filter (where d.day between t.m0 and t.today) as month_sales,
         sum(d.gross_profit) filter (where d.day between t.m0 and t.today) as month_gross,
         sum(d.sales_value)  filter (where d.day = t.today)                as today_sales
  from public.v_sales_by_day d join t on t.canteen_id = d.canteen_id
  group by d.canteen_id
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

revoke all on public.v_sales_by_day, public.v_dashboard from anon, public;
grant select on public.v_sales_by_day, public.v_dashboard to authenticated;
