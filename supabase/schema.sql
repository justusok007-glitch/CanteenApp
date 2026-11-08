-- =============================================================================
-- CanteenApp : Supabase / PostgreSQL schema
-- Implements CANTEEN_APP_SPEC.md (sections 3-8).  Target: Postgres 15+ (Supabase).
--
-- HOW TO RUN
--   1. Supabase dashboard -> SQL Editor -> paste this whole file -> Run.
--   2. Create the first admin login in Authentication -> Users (email
--      "<username>@canteen.local", any strong password), copy its UUID, then run:
--        select public.bootstrap_canteen('My School Canteen', '<that-uuid>', 'saqib', 'Saqib Khalil');
--   3. Further users are created by the admin through an Edge Function that uses
--      the service-role key (kept on the server only, NEVER in the app or in git):
--      it creates the auth user, inserts the public.users row, and is also used to
--      reset passwords and to ban a user (auth admin API) when "force logout" is used.
--
-- KEY CONVENTIONS (also explained in the comments below)
--   * Sales are never entered. They are calculated from stock counts, purchases
--     and wastage (views v_item_periods / v_period_report).
--   * Every table carries canteen_id; composite foreign keys keep parent and child
--     in the same canteen.
--   * Permissions are enforced here with row-level security, not in the app.
--   * Cost data (item_costs, item_cost_history, cost columns of the views) is shown
--     only to roles with show_cost. NOTE: the 'purchases' feature itself contains
--     purchase prices, so give 'purchases' view access only to cost-trusted roles.
--   * Count timing (canteens.count_timing) decides which day a purchase, wastage or
--     cash handover belongs to when it falls on a count date:
--       end_of_day   : count is taken after that day's business -> period is (prev, curr]
--       start_of_day : count is taken before that day's business -> period is [prev, curr)
--   * Average cost is a weighted average maintained by recalc_item_cost():
--       on a purchase : (stock_before * avg + purchase_value) / (stock_before + pieces)
--       on a count    : stock_before is reset to the counted quantity (avg unchanged)
--     Between counts the real stock is unknown (sales are not recorded), so
--     stock_before = last counted qty + purchases since that count.  This matches the
--     spec's rule "enter purchases on the day they arrive, before stock goes to the counter".
-- =============================================================================

set check_function_bodies = off;   -- helper functions below reference tables created later

-- -----------------------------------------------------------------------------
-- 0. Helper functions used by defaults and policies
--    (security definer so they can read users/roles regardless of RLS)
-- -----------------------------------------------------------------------------

-- The signed-in user's id, or NULL if the user is disabled or was force-logged-out
-- (a session whose token was issued before force_logout_at is rejected).
create or replace function public.valid_user_id() returns uuid
language sql stable security definer set search_path = public as $$
  select u.id
  from public.users u
  where u.id = auth.uid()
    and u.is_active
    and (u.force_logout_at is null
         or to_timestamp(coalesce(nullif(auth.jwt() ->> 'iat', '')::bigint, 0)) > u.force_logout_at)
$$;

create or replace function public.current_canteen_id() returns uuid
language sql stable security definer set search_path = public as $$
  select u.canteen_id from public.users u where u.id = public.valid_user_id()
$$;

create or replace function public.canteen_today() returns date
language sql stable security definer set search_path = public as $$
  select (now() at time zone coalesce(
            (select c.timezone from public.canteens c where c.id = public.current_canteen_id()),
            'Asia/Karachi'))::date
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select r.is_admin from public.users u join public.roles r on r.id = u.role_id
                   where u.id = public.valid_user_id()), false)
$$;

create or replace function public.can_see_cost() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select r.is_admin or r.show_cost from public.users u join public.roles r on r.id = u.role_id
                   where u.id = public.valid_user_id()), false)
$$;

create or replace function public.can_manage_users() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select r.is_admin or r.can_manage_users from public.users u join public.roles r on r.id = u.role_id
                   where u.id = public.valid_user_id()), false)
$$;

create or replace function public.role_is_admin(p_role uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select r.is_admin from public.roles r where r.id = p_role), false)
$$;

-- p_action is one of: view, add, edit, delete.  Admin roles pass everything.
create or replace function public.has_perm(p_feature text, p_action text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select r.is_admin or coalesce((
             select case p_action when 'view'   then rp.can_view
                                  when 'add'    then rp.can_add
                                  when 'edit'   then rp.can_edit
                                  when 'delete' then rp.can_delete
                                  else false end
             from public.role_permissions rp
             where rp.role_id = r.id and rp.feature = p_feature), false)
    from public.users u join public.roles r on r.id = u.role_id
    where u.id = public.valid_user_id()), false)
$$;

-- "Edit records older than X days" switch.  NULL limit = no restriction.
create or replace function public.edit_window_ok(p_day date) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when p_day is null then true
    else coalesce((
      select r.is_admin or r.edit_days_limit is null or p_day >= public.canteen_today() - r.edit_days_limit
      from public.users u join public.roles r on r.id = u.role_id
      where u.id = public.valid_user_id()), false)
  end
$$;

-- -----------------------------------------------------------------------------
-- 1. Canteens, roles, permissions, users
-- -----------------------------------------------------------------------------
create table public.canteens (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  timezone          text not null default 'Asia/Karachi',
  daily_salary      numeric(10,2) not null default 300 check (daily_salary >= 0),  -- Rs per active school day
  count_timing      text not null default 'end_of_day' check (count_timing in ('start_of_day','end_of_day')),
  tolerance_pct     numeric(5,2) not null default 2 check (tolerance_pct >= 0),    -- normal shortage tolerance
  stale_count_days  int not null default 7 check (stale_count_days > 0),           -- flag items not counted for this long
  min_margin_pct    numeric(5,2),                                                   -- red below this
  target_margin_pct numeric(5,2),                                                   -- green at/above this
  created_at        timestamptz not null default now()
);

create table public.roles (
  id               uuid primary key default gen_random_uuid(),
  canteen_id       uuid not null references public.canteens(id) on delete cascade,
  name             text not null,
  is_admin         boolean not null default false,
  show_cost        boolean not null default false,   -- see cost price and profit
  edit_days_limit  int check (edit_days_limit >= 0), -- NULL = may edit any age; N = only records of the last N days
  can_manage_users boolean not null default false,   -- manage users (never grants admin-role assignment)
  created_at       timestamptz not null default now(),
  unique (canteen_id, id),
  unique (canteen_id, name)
);

-- Reference list of the features that appear in the admin's permission grid.
create table public.features (
  feature text primary key,
  label   text not null
);
insert into public.features (feature, label) values
  ('items',          'Items and sell prices'),
  ('purchases',      'Purchases / bills'),
  ('stock_counts',   'Stock counts'),
  ('cash_handovers', 'Cash handovers (and credit / udhar)'),
  ('expenses',       'Expenses, wastage and salary days'),
  ('suppliers',      'Suppliers and payments'),
  ('reports',        'Reports');

create table public.role_permissions (
  canteen_id uuid not null,
  role_id    uuid not null,
  feature    text not null references public.features(feature),
  can_view   boolean not null default false,
  can_add    boolean not null default false,
  can_edit   boolean not null default false,
  can_delete boolean not null default false,
  primary key (role_id, feature),
  foreign key (canteen_id, role_id) references public.roles(canteen_id, id) on delete cascade,
  check (can_view or not (can_add or can_edit or can_delete))   -- any write right needs view
);

-- Application users.  id = auth.users.id.  Disable instead of delete to keep history.
create table public.users (
  id              uuid primary key references auth.users(id) on delete cascade,
  canteen_id      uuid not null references public.canteens(id) on delete cascade,
  role_id         uuid not null,
  username        text not null check (username = lower(username) and username ~ '^[a-z0-9._-]+$'),
  full_name       text not null,
  phone           text,
  is_active       boolean not null default true,
  last_login_at   timestamptz,
  force_logout_at timestamptz,
  created_at      timestamptz not null default now(),
  unique (canteen_id, username),
  foreign key (canteen_id, role_id) references public.roles(canteen_id, id)
);

-- The canteen must always keep at least one active admin.
create or replace function public.guard_last_admin() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_canteen uuid := coalesce(old.canteen_id, new.canteen_id);
begin
  if exists (select 1 from public.canteens c where c.id = v_canteen)
     and not exists (select 1 from public.users u join public.roles r on r.id = u.role_id
                     where u.canteen_id = v_canteen and u.is_active and r.is_admin) then
    raise exception 'At least one active admin must remain in the canteen';
  end if;
  return null;
end $$;
create trigger users_guard_admin after update or delete on public.users
  for each row execute function public.guard_last_admin();
create trigger roles_guard_admin after update or delete on public.roles
  for each row execute function public.guard_last_admin();

-- -----------------------------------------------------------------------------
-- 2. Suppliers, items, prices
-- -----------------------------------------------------------------------------
create table public.suppliers (
  id         uuid primary key default gen_random_uuid(),
  canteen_id uuid not null default public.current_canteen_id() references public.canteens(id) on delete cascade,
  name       text not null,
  phone      text,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  unique (canteen_id, id)
);
create unique index suppliers_name_uq on public.suppliers (canteen_id, lower(btrim(name)));

create table public.items (
  id                uuid primary key default gen_random_uuid(),
  canteen_id        uuid not null default public.current_canteen_id() references public.canteens(id) on delete cascade,
  name              text not null check (btrim(name) <> ''),
  pieces_per_pack   int not null default 1 check (pieces_per_pack > 0),
  shelf_order       int not null default 0,                          -- count screen follows shelf order
  count_every_days  int check (count_every_days > 0),                -- suggested rhythm (2 = fast seller, 7 = slow)
  last_supplier_id  uuid,
  is_active         boolean not null default true,
  notes             text,
  created_at        timestamptz not null default now(),
  unique (canteen_id, id),
  foreign key (canteen_id, last_supplier_id) references public.suppliers(canteen_id, id)
);
create unique index items_name_uq on public.items (canteen_id, lower(btrim(name)));  -- no "Juice" vs "juice" duplicates

-- Sell price with a start date.  Old reports keep the old price.
create table public.item_price_history (
  id         uuid primary key default gen_random_uuid(),
  canteen_id uuid not null default public.current_canteen_id(),
  item_id    uuid not null,
  sell_price numeric(10,2) not null check (sell_price >= 0),
  starts_on  date not null default public.canteen_today(),
  ends_on    date,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (item_id, starts_on),
  foreign key (canteen_id, item_id) references public.items(canteen_id, id) on delete cascade,
  check (ends_on is null or ends_on >= starts_on)
);

create or replace function public.item_price_before_ins() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_latest date;
begin
  select max(starts_on) into v_latest from public.item_price_history where item_id = new.item_id;
  if v_latest is not null and new.starts_on <= v_latest then
    raise exception 'New price must start after the current price (which started on %)', v_latest;
  end if;
  update public.item_price_history set ends_on = new.starts_on - 1
   where item_id = new.item_id and ends_on is null;
  new.ends_on := null;
  return new;
end $$;
create trigger item_price_before_ins before insert on public.item_price_history
  for each row execute function public.item_price_before_ins();

-- Price in force on a given day (used by the report views).
create or replace function public.price_on(p_item uuid, p_day date) returns numeric
language sql stable security definer set search_path = public as $$
  select sell_price from public.item_price_history
  where item_id = p_item and starts_on <= p_day
    and canteen_id = public.current_canteen_id()
  order by starts_on desc limit 1
$$;

-- App entry point for changing a price.  Same-day corrections overwrite today's row.
-- Remember: take the stock count BEFORE changing a price (spec section 3).
create or replace function public.set_item_price(p_item uuid, p_price numeric, p_on date default null) returns void
language plpgsql security invoker set search_path = public as $$
declare v_on date := coalesce(p_on, public.canteen_today()); v_cur public.item_price_history;
begin
  select * into v_cur from public.item_price_history where item_id = p_item and ends_on is null;
  if found and v_cur.sell_price = p_price then return; end if;
  if found and v_cur.starts_on = v_on then
    update public.item_price_history set sell_price = p_price where id = v_cur.id;
  else
    insert into public.item_price_history (item_id, sell_price, starts_on) values (p_item, p_price, v_on);
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 3. Purchases (bills), supplier payments
-- -----------------------------------------------------------------------------
create table public.purchase_bills (
  id             uuid primary key default gen_random_uuid(),
  canteen_id     uuid not null default public.current_canteen_id() references public.canteens(id) on delete cascade,
  supplier_id    uuid not null,
  bill_date      date not null default public.canteen_today(),
  bill_no        text,
  total_amount   numeric(14,2) not null default 0,               -- maintained from the lines
  amount_paid    numeric(14,2) not null default 0 check (amount_paid >= 0),
  pending_amount numeric(14,2) generated always as (total_amount - amount_paid) stored,
  notes          text,
  created_by     uuid default auth.uid(),
  created_at     timestamptz not null default now(),
  unique (canteen_id, id),
  foreign key (canteen_id, supplier_id) references public.suppliers(canteen_id, id)
);
create index purchase_bills_date_idx on public.purchase_bills (canteen_id, bill_date);

create table public.purchase_lines (
  id              uuid primary key default gen_random_uuid(),
  canteen_id      uuid not null default public.current_canteen_id(),
  bill_id         uuid not null,
  item_id         uuid not null,
  packs           numeric(12,2) not null check (packs > 0),
  pieces_per_pack int not null default 1 check (pieces_per_pack > 0),
  cost_mode       text not null default 'pack' check (cost_mode in ('pack','piece')),  -- which price the user typed
  pack_cost       numeric(14,4) check (pack_cost >= 0),
  piece_cost      numeric(14,4) check (piece_cost >= 0),
  new_sell_price  numeric(10,2) check (new_sell_price >= 0),  -- optional: applied as a new price on save
  total_pieces    numeric(14,2) generated always as (packs * pieces_per_pack) stored,
  line_total      numeric       generated always as (packs * pack_cost) stored,       -- exact, unrounded
  foreign key (canteen_id, bill_id) references public.purchase_bills(canteen_id, id) on delete cascade,
  foreign key (canteen_id, item_id) references public.items(canteen_id, id)
);
create index purchase_lines_item_idx on public.purchase_lines (item_id);
create index purchase_lines_bill_idx on public.purchase_lines (bill_id);

-- The typed price is the true one; the other is derived (Rs 400 pack of 12 stays exactly Rs 400).
create or replace function public.purchase_lines_fill() returns trigger
language plpgsql as $$
begin
  if new.cost_mode = 'pack' then
    if new.pack_cost is null then raise exception 'pack_cost is required when cost_mode is pack'; end if;
    new.piece_cost := new.pack_cost / new.pieces_per_pack;
  else
    if new.piece_cost is null then raise exception 'piece_cost is required when cost_mode is piece'; end if;
    new.pack_cost := new.piece_cost * new.pieces_per_pack;
  end if;
  return new;
end $$;
create trigger purchase_lines_fill before insert or update on public.purchase_lines
  for each row execute function public.purchase_lines_fill();

create table public.supplier_payments (
  id          uuid primary key default gen_random_uuid(),
  canteen_id  uuid not null default public.current_canteen_id() references public.canteens(id) on delete cascade,
  supplier_id uuid not null,
  bill_id     uuid,                                              -- optional: payment against a specific bill
  paid_on     date not null default public.canteen_today(),     -- the expense falls on THIS date, not the bill date
  amount      numeric(14,2) not null check (amount > 0),
  notes       text,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  foreign key (canteen_id, supplier_id) references public.suppliers(canteen_id, id),
  foreign key (canteen_id, bill_id) references public.purchase_bills(canteen_id, id)
);

-- -----------------------------------------------------------------------------
-- 4. Costing: current cost and full cost history (maintained by recalc_item_cost)
-- -----------------------------------------------------------------------------
create table public.item_costs (
  item_id      uuid primary key references public.items(id) on delete cascade,
  canteen_id   uuid not null,
  avg_cost     numeric(14,4) not null,
  last_cost    numeric(14,4) not null,
  last_cost_on date not null
);

create table public.item_cost_history (
  id             bigint generated always as identity primary key,
  canteen_id     uuid not null,
  item_id        uuid not null references public.items(id) on delete cascade,
  event_type     text not null check (event_type in ('purchase','count')),
  event_date     date not null,
  ref_id         uuid not null,            -- purchase_lines.id or stock_counts.id
  supplier_id    uuid,
  qty_before     numeric(14,2) not null,
  qty_after      numeric(14,2) not null,
  unit_cost      numeric(14,4),            -- piece cost paid (purchase events)
  avg_cost_after numeric(14,4) not null,
  unique (item_id, event_type, ref_id)
);
create index item_cost_history_item_idx on public.item_cost_history (item_id, event_date);

-- Rebuilds the cost history and current cost of one item from the full ledger,
-- so editing or deleting an old bill or count automatically fixes everything after it.
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

create or replace function public.purchase_lines_after() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_bill uuid; v_sup uuid; v_date date; v_is_latest boolean;
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
  if tg_op <> 'INSERT' then perform public.recalc_item_cost(old.item_id); end if;
  if tg_op <> 'DELETE' and not (tg_op = 'UPDATE' and new.item_id = old.item_id) then
    perform public.recalc_item_cost(new.item_id);
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
create trigger purchase_lines_after after insert or update or delete on public.purchase_lines
  for each row execute function public.purchase_lines_after();

create or replace function public.purchase_bills_after() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_item uuid;
begin
  if new.bill_date is distinct from old.bill_date or new.supplier_id is distinct from old.supplier_id then
    for v_item in select distinct item_id from public.purchase_lines where bill_id = new.id loop
      perform public.recalc_item_cost(v_item);
    end loop;
  end if;
  return null;
end $$;
create trigger purchase_bills_after after update on public.purchase_bills
  for each row execute function public.purchase_bills_after();

-- -----------------------------------------------------------------------------
-- 5. Stock counts (checkpoints), wastage
-- -----------------------------------------------------------------------------
create table public.stock_counts (
  id         uuid primary key default gen_random_uuid(),
  canteen_id uuid not null default public.current_canteen_id() references public.canteens(id) on delete cascade,
  counted_on date not null default public.canteen_today(),
  is_full    boolean not null default true,       -- a cash check needs a FULL count of all items (several counts per day are fine)
  counted_by uuid default auth.uid() references public.users(id),   -- who counted (owner or the named backup)
  notes      text,
  created_at timestamptz not null default now(),
  unique (canteen_id, id)
);

create index stock_counts_day_idx on public.stock_counts (canteen_id, counted_on, created_at);

create table public.stock_count_lines (
  id         uuid primary key default gen_random_uuid(),
  canteen_id uuid not null default public.current_canteen_id(),
  count_id   uuid not null,
  item_id    uuid not null,
  qty        numeric(12,2) not null check (qty >= 0),
  unique (count_id, item_id),
  foreign key (canteen_id, count_id) references public.stock_counts(canteen_id, id) on delete cascade,
  foreign key (canteen_id, item_id) references public.items(canteen_id, id)
);
create index stock_count_lines_item_idx on public.stock_count_lines (item_id);

create or replace function public.stock_count_lines_after() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op <> 'INSERT' then perform public.recalc_item_cost(old.item_id); end if;
  if tg_op <> 'DELETE' and not (tg_op = 'UPDATE' and new.item_id = old.item_id) then
    perform public.recalc_item_cost(new.item_id);
  end if;
  return null;
end $$;
create trigger stock_count_lines_after after insert or update or delete on public.stock_count_lines
  for each row execute function public.stock_count_lines_after();

create or replace function public.stock_counts_after() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_item uuid;
begin
  if new.counted_on is distinct from old.counted_on then
    for v_item in select item_id from public.stock_count_lines where count_id = new.id loop
      perform public.recalc_item_cost(v_item);
    end loop;
  end if;
  return null;
end $$;
create trigger stock_counts_after after update on public.stock_counts
  for each row execute function public.stock_counts_after();

-- Damage, expiry etc. are recorded here (valued at cost in reports), never as a shortage.
create table public.wastage (
  id         uuid primary key default gen_random_uuid(),
  canteen_id uuid not null default public.current_canteen_id(),
  item_id    uuid not null,
  qty        numeric(12,2) not null check (qty > 0),
  wasted_on  date not null default public.canteen_today(),
  reason     text not null default 'other' check (reason in ('damage','expiry','spoilage','other')),
  notes      text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (canteen_id, item_id) references public.items(canteen_id, id)
);

-- -----------------------------------------------------------------------------
-- 6. Cash: handovers, credit (udhar), expenses, school days
-- -----------------------------------------------------------------------------
create table public.cash_handovers (
  id          uuid primary key default gen_random_uuid(),
  canteen_id  uuid not null default public.current_canteen_id() references public.canteens(id) on delete cascade,
  handed_on   date not null default public.canteen_today(),
  cash_handed numeric(12,2) not null check (cash_handed >= 0),   -- cash actually handed over
  salary_kept numeric(12,2) not null check (salary_kept >= 0),   -- salary he kept (defaults to canteens.daily_salary)
  notes       text,
  received_by uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  unique (canteen_id, handed_on)
);
create or replace function public.cash_handovers_default_salary() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.salary_kept is null then
    select daily_salary into new.salary_kept from public.canteens where id = new.canteen_id;
  end if;
  return new;
end $$;
create trigger cash_handovers_default_salary before insert on public.cash_handovers
  for each row execute function public.cash_handovers_default_salary();

-- Credit (udhar) to students / teachers.  Spec lists it as an open question: tables are
-- ready; simply do not give anyone the screen if credit is banned.
create table public.credit_entries (
  id         uuid primary key default gen_random_uuid(),
  canteen_id uuid not null default public.current_canteen_id() references public.canteens(id) on delete cascade,
  party_name text not null check (btrim(party_name) <> ''),
  party_type text not null default 'student' check (party_type in ('student','teacher','other')),
  entry_type text not null check (entry_type in ('given','received')),   -- given = sold on credit; received = repayment
  amount     numeric(12,2) not null check (amount > 0),
  entry_on   date not null default public.canteen_today(),
  notes      text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

create table public.expenses (
  id          uuid primary key default gen_random_uuid(),
  canteen_id  uuid not null default public.current_canteen_id() references public.canteens(id) on delete cascade,
  spent_on    date not null default public.canteen_today(),
  category    text not null default 'other',
  amount      numeric(12,2) not null check (amount > 0),
  description text,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now()
);
-- Daily salary is recorded on the cash handover (salary_kept) and counted separately in profit.

create table public.school_days (
  canteen_id uuid not null default public.current_canteen_id() references public.canteens(id) on delete cascade,
  day        date not null,
  is_active  boolean not null default true,
  note       text,
  primary key (canteen_id, day)
);

-- -----------------------------------------------------------------------------
-- 7. Audit log (who did what and when) - written only by triggers
-- -----------------------------------------------------------------------------
create table public.audit_log (
  id         bigint generated always as identity primary key,
  canteen_id uuid,
  user_id    uuid,
  table_name text not null,
  row_id     text,
  action     text not null,
  old_data   jsonb,
  new_data   jsonb,
  at         timestamptz not null default now()
);
create index audit_log_idx on public.audit_log (canteen_id, at desc);

create or replace function public.audit_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare j jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
begin
  -- skip system-maintained noise (bill totals, last_login) and no-op updates
  if tg_op = 'UPDATE' and (to_jsonb(new) - 'total_amount' - 'pending_amount' - 'last_login_at')
                        = (to_jsonb(old) - 'total_amount' - 'pending_amount' - 'last_login_at') then
    return null;
  end if;
  insert into public.audit_log (canteen_id, user_id, table_name, row_id, action, old_data, new_data)
  values ((j ->> 'canteen_id')::uuid, auth.uid(), tg_table_name,
          coalesce(j ->> 'id', j ->> 'day', concat_ws('/', j ->> 'role_id', j ->> 'feature')),
          tg_op,
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['users','roles','role_permissions','suppliers','items','item_price_history',
                           'purchase_bills','purchase_lines','supplier_payments','stock_counts',
                           'stock_count_lines','wastage','cash_handovers','credit_entries','expenses','school_days']
  loop
    execute format('create trigger audit_%1$s after insert or update or delete on public.%1$I
                    for each row execute function public.audit_row()', t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- 8. Row-level security
-- -----------------------------------------------------------------------------
-- Standard pattern per table: canteen match + the role's view/add/edit/delete right for
-- the feature + the "edit records older than X days" window on the record's date.
do $$
declare
  t record;
  cid  constant text := '(select public.current_canteen_id())';
  win  text;
begin
  for t in select * from (values
      ('items',              'items',          null),
      ('item_price_history', 'items',          null),
      ('suppliers',          'suppliers',      null),
      ('supplier_payments',  'suppliers',      'paid_on'),
      ('purchase_bills',     'purchases',      'bill_date'),
      ('purchase_lines',     'purchases',      '(select b.bill_date from public.purchase_bills b where b.id = bill_id)'),
      ('stock_counts',       'stock_counts',   'counted_on'),
      ('stock_count_lines',  'stock_counts',   '(select s.counted_on from public.stock_counts s where s.id = count_id)'),
      ('cash_handovers',     'cash_handovers', 'handed_on'),
      ('credit_entries',     'cash_handovers', 'entry_on'),
      ('expenses',           'expenses',       'spent_on'),
      ('wastage',            'expenses',       'wasted_on'),
      ('school_days',        'expenses',       'day')
    ) as v(tbl, feature, datecol)
  loop
    win := format('(select public.edit_window_ok(%s))', coalesce(t.datecol, 'null::date'));
    execute format('alter table public.%I enable row level security', t.tbl);
    execute format('create policy %I on public.%I for select to authenticated
                      using (canteen_id = %s and (select public.has_perm(%L, ''view'')))',
                   t.tbl || '_sel', t.tbl, cid, t.feature);
    execute format('create policy %I on public.%I for insert to authenticated
                      with check (canteen_id = %s and (select public.has_perm(%L, ''add'')) and %s)',
                   t.tbl || '_ins', t.tbl, cid, t.feature, win);
    execute format('create policy %I on public.%I for update to authenticated
                      using (canteen_id = %s and (select public.has_perm(%L, ''edit'')) and %s)
                      with check (canteen_id = %s and (select public.has_perm(%L, ''edit'')) and %s)',
                   t.tbl || '_upd', t.tbl, cid, t.feature, win, cid, t.feature, win);
    execute format('create policy %I on public.%I for delete to authenticated
                      using (canteen_id = %s and (select public.has_perm(%L, ''delete'')) and %s)',
                   t.tbl || '_del', t.tbl, cid, t.feature, win);
  end loop;
end $$;

-- Canteen settings: everyone in the canteen reads, only admin changes.
alter table public.canteens enable row level security;
create policy canteens_sel on public.canteens for select to authenticated
  using (id = (select public.current_canteen_id()));
create policy canteens_upd on public.canteens for update to authenticated
  using (id = (select public.current_canteen_id()) and (select public.is_admin()))
  with check (id = (select public.current_canteen_id()) and (select public.is_admin()));

-- Roles and permission grid: readable in the canteen, changed by admin only.
alter table public.roles enable row level security;
create policy roles_sel on public.roles for select to authenticated
  using (canteen_id = (select public.current_canteen_id()));
create policy roles_ins on public.roles for insert to authenticated
  with check (canteen_id = (select public.current_canteen_id()) and (select public.is_admin()));
create policy roles_upd on public.roles for update to authenticated
  using (canteen_id = (select public.current_canteen_id()) and (select public.is_admin()))
  with check (canteen_id = (select public.current_canteen_id()) and (select public.is_admin()));
create policy roles_del on public.roles for delete to authenticated
  using (canteen_id = (select public.current_canteen_id()) and (select public.is_admin()));

alter table public.role_permissions enable row level security;
create policy role_permissions_sel on public.role_permissions for select to authenticated
  using (canteen_id = (select public.current_canteen_id()));
create policy role_permissions_ins on public.role_permissions for insert to authenticated
  with check (canteen_id = (select public.current_canteen_id()) and (select public.is_admin()));
create policy role_permissions_upd on public.role_permissions for update to authenticated
  using (canteen_id = (select public.current_canteen_id()) and (select public.is_admin()))
  with check (canteen_id = (select public.current_canteen_id()) and (select public.is_admin()));
create policy role_permissions_del on public.role_permissions for delete to authenticated
  using (canteen_id = (select public.current_canteen_id()) and (select public.is_admin()));

-- Users: all can see the list (names for "counted by"); admin or a user-manager can update.
-- A non-admin manager can neither touch an admin nor hand out an admin role.
-- Rows are created by the Edge Function with the service role (it must create the auth user first).
alter table public.users enable row level security;
create policy users_sel on public.users for select to authenticated
  using (canteen_id = (select public.current_canteen_id()));
create policy users_upd on public.users for update to authenticated
  using (canteen_id = (select public.current_canteen_id()) and (select public.can_manage_users())
         and ((select public.is_admin()) or not public.role_is_admin(role_id)))
  with check (canteen_id = (select public.current_canteen_id()) and (select public.can_manage_users())
         and ((select public.is_admin()) or not public.role_is_admin(role_id)));

-- Cost data: system-maintained, readable only with the show_cost switch.
alter table public.item_costs enable row level security;
create policy item_costs_sel on public.item_costs for select to authenticated
  using (canteen_id = (select public.current_canteen_id()) and (select public.can_see_cost()));
alter table public.item_cost_history enable row level security;
create policy item_cost_history_sel on public.item_cost_history for select to authenticated
  using (canteen_id = (select public.current_canteen_id()) and (select public.can_see_cost()));

-- Audit log: admin reads; nobody writes directly (triggers only).
alter table public.audit_log enable row level security;
create policy audit_log_sel on public.audit_log for select to authenticated
  using (canteen_id = (select public.current_canteen_id()) and (select public.is_admin()));

alter table public.features enable row level security;
create policy features_sel on public.features for select to authenticated using (true);

-- -----------------------------------------------------------------------------
-- 9. Table privileges (RLS is the real gate; this is the outer fence)
-- -----------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

grant select on all tables in schema public to authenticated;
grant insert, update, delete on
  public.roles, public.role_permissions,
  public.suppliers, public.items, public.item_price_history,
  public.purchase_lines, public.supplier_payments,
  public.stock_counts, public.stock_count_lines, public.wastage,
  public.cash_handovers, public.credit_entries, public.expenses, public.school_days
  to authenticated;

-- Column-level grants where some columns are system-maintained or sensitive.
grant delete on public.purchase_bills to authenticated;
grant insert (canteen_id, supplier_id, bill_date, bill_no, amount_paid, notes) on public.purchase_bills to authenticated;
grant update (supplier_id, bill_date, bill_no, amount_paid, notes) on public.purchase_bills to authenticated;   -- total_amount is trigger-only
grant update (name, timezone, daily_salary, count_timing, tolerance_pct, stale_count_days, min_margin_pct, target_margin_pct)
  on public.canteens to authenticated;
grant update (role_id, username, full_name, phone, is_active, force_logout_at) on public.users to authenticated;

-- Functions that policies, defaults and the app call directly.
grant execute on function
  public.valid_user_id(), public.current_canteen_id(), public.canteen_today(), public.is_admin(),
  public.can_see_cost(), public.can_manage_users(), public.role_is_admin(uuid),
  public.has_perm(text, text), public.edit_window_ok(date),
  public.price_on(uuid, date)      -- views call it with the caller's rights
  to authenticated;

-- -----------------------------------------------------------------------------
-- 10. App functions (RPC)
-- -----------------------------------------------------------------------------

-- Call once after every successful login (shows "last login" to the admin).
create or replace function public.touch_login() returns void
language sql security definer set search_path = public as $$
  update public.users set last_login_at = now() where id = public.valid_user_id()
$$;

-- Submit a whole purchase bill atomically (the "review, then final submit" step).
--   p_lines = [{ "item_id": uuid | "item_name": "New item",   -- a new name creates a new item
--                "packs": 12, "pieces_per_pack": 24,
--                "cost_mode": "pack" | "piece", "cost": 400,   -- the price the user typed
--                "sell_price": 25 (optional) }, ...]
-- Runs as the caller, so row-level security applies (needs add rights on purchases,
-- and on items when a line creates a new item).
create or replace function public.create_purchase_bill(
  p_supplier_id uuid, p_bill_date date, p_amount_paid numeric, p_lines jsonb, p_bill_no text default null
) returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_bill uuid; v_line jsonb; v_item uuid; v_ppp int; v_mode text;
begin
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'A bill needs at least one line';
  end if;

  insert into public.purchase_bills (supplier_id, bill_date, amount_paid, bill_no)
  values (p_supplier_id, coalesce(p_bill_date, public.canteen_today()), coalesce(p_amount_paid, 0), p_bill_no)
  returning id into v_bill;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_item := nullif(v_line ->> 'item_id', '')::uuid;
    v_ppp  := coalesce(nullif(v_line ->> 'pieces_per_pack', '')::int, 1);
    v_mode := coalesce(v_line ->> 'cost_mode', 'pack');
    if v_item is null then
      if btrim(coalesce(v_line ->> 'item_name', '')) = '' then
        raise exception 'Each line needs an item_id or an item_name';
      end if;
      -- reuse an existing item with the same name (case-insensitive) instead of failing on the duplicate
      select i.id into v_item from public.items i
       where lower(btrim(i.name)) = lower(btrim(v_line ->> 'item_name'));
      if v_item is null then
        insert into public.items (name, pieces_per_pack) values (btrim(v_line ->> 'item_name'), v_ppp)
        returning id into v_item;
      end if;
    end if;
    insert into public.purchase_lines
      (bill_id, item_id, packs, pieces_per_pack, cost_mode, pack_cost, piece_cost, new_sell_price)
    values (v_bill, v_item, (v_line ->> 'packs')::numeric, v_ppp, v_mode,
            case when v_mode = 'pack'  then (v_line ->> 'cost')::numeric end,
            case when v_mode = 'piece' then (v_line ->> 'cost')::numeric end,
            nullif(v_line ->> 'sell_price', '')::numeric);
  end loop;

  if (select b.amount_paid > b.total_amount from public.purchase_bills b where b.id = v_bill) then
    raise exception 'Amount paid is more than the bill total';
  end if;
  return v_bill;
end $$;

-- Warning helper for the edit/delete-bill screen: true when a stock count already exists
-- after the bill's date, i.e. changing it will change a past period's sales figure.
create or replace function public.bill_touches_closed_period(p_bill uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select (select public.has_perm('purchases', 'view'))
     and exists (
       select 1
       from public.purchase_bills b
       join public.canteens c on c.id = b.canteen_id
       join public.stock_counts sc on sc.canteen_id = b.canteen_id
       where b.id = p_bill
         and b.canteen_id = public.current_canteen_id()
         and sc.counted_on - (case when c.count_timing = 'start_of_day' then 1 else 0 end) >= b.bill_date)
$$;

grant execute on function
  public.touch_login(),
  public.set_item_price(uuid, numeric, date),
  public.create_purchase_bill(uuid, date, numeric, jsonb, text),
  public.bill_touches_closed_period(uuid)
  to authenticated;

-- One-time setup (SQL editor / service role only, not callable from the app).
create or replace function public.bootstrap_canteen(
  p_name text, p_admin_auth_id uuid, p_username text, p_full_name text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_c uuid; v_admin uuid; v_counter uuid;
begin
  if not exists (select 1 from auth.users where id = p_admin_auth_id) then
    raise exception 'Create the login in Authentication -> Users first, then pass its UUID';
  end if;
  insert into public.canteens (name) values (p_name) returning id into v_c;
  insert into public.roles (canteen_id, name, is_admin, show_cost, can_manage_users)
    values (v_c, 'Admin', true, true, true) returning id into v_admin;
  -- Example limited role: can count stock and record cash, sees no costs or profit.
  insert into public.roles (canteen_id, name) values (v_c, 'Counter') returning id into v_counter;
  insert into public.role_permissions (canteen_id, role_id, feature, can_view, can_add, can_edit) values
    (v_c, v_counter, 'items',          true, false, false),
    (v_c, v_counter, 'stock_counts',   true, true,  true),
    (v_c, v_counter, 'cash_handovers', true, true,  false);
  insert into public.users (id, canteen_id, role_id, username, full_name)
    values (p_admin_auth_id, v_c, v_admin, lower(p_username), p_full_name);
  return v_c;
end $$;

-- -----------------------------------------------------------------------------
-- 11. Views for the app and reports
--     Views run with the owner's rights but filter by the caller's canteen,
--     permission and show_cost switch themselves, so they stay safe.
-- -----------------------------------------------------------------------------

-- Who am I, and what may I do (drives which buttons the app shows).
create or replace view public.v_me as
select u.id, u.canteen_id, u.role_id, u.username, u.full_name, r.name as role_name,
       r.is_admin, (r.is_admin or r.show_cost) as show_cost,
       (r.is_admin or r.can_manage_users) as can_manage_users, r.edit_days_limit
from public.users u join public.roles r on r.id = u.role_id
where u.id = public.valid_user_id();

create or replace view public.v_my_permissions as
select f.feature, f.label,
       (m.is_admin or coalesce(rp.can_view,   false)) as can_view,
       (m.is_admin or coalesce(rp.can_add,    false)) as can_add,
       (m.is_admin or coalesce(rp.can_edit,   false)) as can_edit,
       (m.is_admin or coalesce(rp.can_delete, false)) as can_delete
from public.features f
cross join public.v_me m
left join public.role_permissions rp on rp.role_id = m.role_id and rp.feature = f.feature;

-- Count screen: active items in shelf order with "last counted" and an overdue flag.
-- No expected stock is shown here on purpose, so counting stays blind.
-- Cost / margin columns appear only for roles with show_cost.
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

-- Per item, between each pair of consecutive counts (partial counts included):
--   sold = last count + purchases in the window - wastage in the window - new count
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

-- Cash check and profit, between each pair of consecutive FULL counts.
--   expected cash = sum(sold x price) - credit given + credit repaid
--   shortage      = expected cash - (cash handed over + salary kept)
--   actual net    = gross profit - salary - wastage (at cost) - other expenses - shortage
-- The data-quality counters at the end must be zero for the numbers to be trusted.
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

-- Cost went up or down on the latest purchase: a cue to review the sell price.
create or replace view public.v_cost_alerts as
select canteen_id, item_id, item_name, latest_on, latest_cost, previous_cost, change_pct
from (
  select ch.canteen_id, ch.item_id, i.name as item_name, ch.event_date as latest_on, ch.unit_cost as latest_cost,
         lag(ch.unit_cost) over w as previous_cost,
         round((ch.unit_cost - lag(ch.unit_cost) over w) / nullif(lag(ch.unit_cost) over w, 0) * 100, 2) as change_pct,
         row_number() over (partition by ch.item_id order by ch.event_date desc, ch.id desc) as rn
  from public.item_cost_history ch join public.items i on i.id = ch.item_id
  where ch.event_type = 'purchase' and ch.canteen_id = public.current_canteen_id()
  window w as (partition by ch.item_id order by ch.event_date, ch.id)
) x
where rn = 1 and previous_cost is not null
  and (select public.can_see_cost()) and (select public.has_perm('reports', 'view'));

-- Supplier screen: total bought, total paid, balance owed.
create or replace view public.v_supplier_balances as
select s.id as supplier_id, s.canteen_id, s.name, s.phone, s.is_active,
       coalesce(b.bought, 0) as total_bought,
       coalesce(b.paid, 0) + coalesce(p.paid, 0) as total_paid,
       coalesce(b.bought, 0) - coalesce(b.paid, 0) - coalesce(p.paid, 0) as balance_owed
from public.suppliers s
left join (select supplier_id, sum(total_amount) as bought, sum(amount_paid) as paid
           from public.purchase_bills group by supplier_id) b on b.supplier_id = s.id
left join (select supplier_id, sum(amount) as paid
           from public.supplier_payments group by supplier_id) p on p.supplier_id = s.id
where s.canteen_id = public.current_canteen_id()
  and (select public.has_perm('suppliers', 'view'));

-- Credit (udhar) balance per student / teacher.
create or replace view public.v_credit_balances as
select canteen_id, party_name, party_type,
       sum(amount) filter (where entry_type = 'given')    as total_given,
       sum(amount) filter (where entry_type = 'received') as total_received,
       coalesce(sum(amount) filter (where entry_type = 'given'), 0)
         - coalesce(sum(amount) filter (where entry_type = 'received'), 0) as balance_due
from public.credit_entries
where canteen_id = public.current_canteen_id()
  and (select public.has_perm('cash_handovers', 'view'))
group by canteen_id, party_name, party_type;

revoke all on
  public.v_me, public.v_my_permissions, public.v_item_status, public.v_item_periods,
  public.v_period_report, public.v_cost_alerts, public.v_supplier_balances, public.v_credit_balances
  from anon, public;
grant select on
  public.v_me, public.v_my_permissions, public.v_item_status, public.v_item_periods,
  public.v_period_report, public.v_cost_alerts, public.v_supplier_balances, public.v_credit_balances
  to authenticated;

-- -----------------------------------------------------------------------------
-- 12. Dashboard stats for the home screen (also available alone as migrations/002_dashboard.sql)
-- -----------------------------------------------------------------------------

-- One row per business day with that day's estimated sales and gross profit.
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

-- -----------------------------------------------------------------------------
-- 13. Reset app (admin only)
-- -----------------------------------------------------------------------------
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
