-- Beer Bot — Supabase schema. Run once in the Supabase SQL editor.

create table beers (
  id            bigint generated always as identity primary key,
  beer_number   integer not null,
  member        text not null,                   -- display name for leaderboards (push_name or number)
  push_name     text,                            -- WhatsApp display name at time of posting
  participant   text,                            -- sender's phone number
  ts            timestamptz not null,
  beer_date     date generated always as (ts::date) stored,
  raw_caption   text,
  source        text not null default 'live',   -- 'live' | 'export' | 'manual'
  wa_message_id text,                            -- WhatsApp message id (live only); maps deletions
  deleted_at    timestamptz,                     -- soft-delete: excluded from counts when set
  deleted_by    text,                            -- phone number that issued the delete-for-everyone
  deleted_by_name text,                          -- display name of the deleter (admin name when by_admin)
  by_admin      boolean,                         -- deleter != author and deleter is a group admin
  created_at    timestamptz default now(),
  unique (beer_number)                           -- DB-level dedup; first writer wins
);
create index on beers (member);
create index on beers (beer_date);
create index on beers (wa_message_id);

alter table beers enable row level security;
create policy "public read" on beers for select using (true);

-- =========================================================================
-- DASHBOARD VIEWS  (re-runnable: create-or-replace + grant. Safe to paste
-- this whole section into the SQL editor to update an existing database.)
-- Time-pattern views use Europe/Berlin local time.
-- =========================================================================

create or replace view totals as
  select count(*) total_beers,
         (select count(*) from members) as members,
         count(distinct beer_date) active_days
  from beers where deleted_at is null;

-- Resolve member display name: prefer members.member (registered or auto-set from push_name)
-- over beers.member (snapshot at post time). Falls back to beers.member for backfill rows
-- where participant is null or the member is no longer in the group.
create or replace view leaderboard_alltime as
  select coalesce(m.member, b.member) as member, count(*)::int as beers
  from beers b
  left join members m on m.participant = b.participant
  where b.deleted_at is null
  group by coalesce(m.member, b.member)
  order by beers desc;

create or replace view daily_counts as
  select beer_date, count(*) beers from beers where deleted_at is null group by beer_date order by beer_date;

-- delete-for-everyone log: a filtered window over beers (no separate table)
create or replace view deleted_beers as
  select beer_number, member, deleted_by, deleted_by_name, by_admin, deleted_at
  from beers where deleted_at is not null order by deleted_at desc;

-- highest / lowest single day
create or replace view day_extremes as
  with d as (select beer_date, count(*) c from beers where deleted_at is null group by beer_date)
  select (select beer_date from d order by c desc, beer_date limit 1) as highest_date,
         (select max(c) from d) as highest,
         (select beer_date from d order by c asc,  beer_date limit 1) as lowest_date,
         (select min(c) from d) as lowest;

-- daily series with cumulative + rolling-7-day (date spine fills empty days)
create or replace view v_daily_series as
  with bounds as (select min(beer_date) lo, max(beer_date) hi from beers where deleted_at is null),
       days   as (select generate_series(lo, hi, interval '1 day')::date d from bounds),
       daily  as (
         select days.d, count(b.*) beers
         from days left join beers b on b.beer_date = days.d and b.deleted_at is null
         group by days.d
       )
  select d as beer_date,
         beers::int,
         sum(beers) over (order by d)::int as cumulative,
         sum(beers) over (order by d rows between 6 preceding and current row)::int as rolling_7d
  from daily order by d;

-- day-of-week analysis (local time)
create or replace view v_day_of_week as
  with daily as (
    select (ts at time zone 'Europe/Berlin')::date d,
           extract(isodow from (ts at time zone 'Europe/Berlin'))::int dow,
           count(*) c
    from beers where deleted_at is null group by 1, 2
  )
  select dow,
         trim(to_char(date '2024-01-01' + (dow - 1), 'FMDay')) as day_name,
         sum(c)::int as total,
         round(avg(c))::int as average,
         max(c)::int as highest,
         min(c)::int as lowest
  from daily group by dow order by dow;

-- hour x weekday matrix (local time)
create or replace view v_hourly_matrix as
  select extract(hour   from (ts at time zone 'Europe/Berlin'))::int as hour,
         extract(isodow from (ts at time zone 'Europe/Berlin'))::int as dow,
         count(*)::int as beers
  from beers where deleted_at is null group by 1, 2;

-- monthly breakdown with rank
create or replace view v_monthly as
  with m as (
    select date_trunc('month', (ts at time zone 'Europe/Berlin'))::date as month,
           count(*) c,
           count(distinct (ts at time zone 'Europe/Berlin')::date) as days
    from beers where deleted_at is null group by 1
  )
  select month, c::int as total, days::int,
         round(c::numeric / nullif(days, 0), 1) as beer_per_day,
         rank() over (order by c::numeric / nullif(days, 0) desc) as rank
  from m order by month;

-- weekly breakdown with rank
create or replace view v_weekly as
  with w as (
    select date_trunc('week', (ts at time zone 'Europe/Berlin'))::date week_start, count(*) c
    from beers where deleted_at is null group by 1
  )
  select week_start, (week_start + 6) as week_end, c::int as beers,
         rank() over (order by c desc) as rank
  from w order by week_start;

-- beers-per-active-day leaderboard
create or replace view v_leaderboard_active as
  select coalesce(m.member, b.member) as member,
         count(*)::int as beers,
         count(distinct b.beer_date)::int as active_days,
         round(count(*)::numeric / nullif(count(distinct b.beer_date), 0), 2) as per_active_day
  from beers b
  left join members m on m.participant = b.participant
  where b.deleted_at is null
  group by coalesce(m.member, b.member)
  order by per_active_day desc;

-- biggest single day per person
create or replace view v_biggest_day as
  with d as (
    select coalesce(m.member, b.member) as member, b.beer_date, count(*) c
    from beers b
    left join members m on m.participant = b.participant
    where b.deleted_at is null
    group by coalesce(m.member, b.member), b.beer_date
  )
  select distinct on (member) member, c::int as biggest_day, beer_date as date
  from d order by member, c desc, beer_date;

-- best single week per person (sort desc in the frontend for the board)
create or replace view v_highest_week as
  with w as (
    select coalesce(m.member, b.member) as member,
           date_trunc('week', (b.ts at time zone 'Europe/Berlin'))::date wk,
           count(*) c
    from beers b
    left join members m on m.participant = b.participant
    where b.deleted_at is null
    group by coalesce(m.member, b.member), wk
  )
  select distinct on (member) member, wk as week_start, c::int as beers
  from w order by member, c desc, wk;

-- milestones: who posted the Nth beer, and how long it took
create or replace view v_milestones as
  select b.beer_number as milestone, b.member, b.beer_date as date,
         (b.beer_date - (select min(beer_date) from beers where deleted_at is null)) as days_to_reach
  from beers b
  where b.deleted_at is null
    and b.beer_number in (100,500,1000,2000,5000,10000,25000,50000,100000,150000,200000,
                          250000,300000,400000,500000,600000,700000,750000,800000,900000,1000000)
  order by b.beer_number;

-- forecast: linear fit (regr_slope/intercept) + trailing-30-day rate, projected to thresholds
create or replace view v_forecast as
  with c as (
    select beer_date,
           extract(epoch from beer_date) / 86400 as day_num,
           sum(count(*)) over (order by beer_date) as cum
    from beers where deleted_at is null group by beer_date
  ),
  fit as (
    select regr_slope(cum, day_num) slope, regr_intercept(cum, day_num) intercept,
           max(cum) current_total, max(beer_date) last_date
    from c
  ),
  trail as (
    select (max(cum) - min(cum)) / nullif(max(day_num) - min(day_num), 0) as rate30
    from c where beer_date >= (select max(beer_date) from c) - 30
  )
  select f.current_total::int,
         round(f.slope::numeric, 1) as linear_rate_per_day,
         round(t.rate30::numeric, 1) as trailing_rate_per_day,
         to_timestamp(((100000  - f.intercept) / nullif(f.slope, 0)) * 86400)::date as linear_100k_date,
         to_timestamp(((500000  - f.intercept) / nullif(f.slope, 0)) * 86400)::date as linear_500k_date,
         to_timestamp(((1000000 - f.intercept) / nullif(f.slope, 0)) * 86400)::date as linear_1m_date,
         (f.last_date + ((1000000 - f.current_total) / nullif(t.rate30, 0))::int) as trailing_1m_date
  from fit f, trail t;

-- admin-deleting leaderboard (live-tracked deletions only)
create or replace view v_admin_deletes as
  select coalesce(deleted_by_name, deleted_by, 'unknown') as deleter,
         count(*)::int as deletes,
         count(*) filter (where by_admin)::int as admin_deletes,
         count(*) filter (where by_admin is not true)::int as own_deletes
  from beers where deleted_at is not null
  group by 1 order by deletes desc;

-- participation summary
create or replace view v_participation as
  with lb as (select member, count(*) c from beers where deleted_at is null group by member),
       t  as (select sum(c) total, count(*) people from lb),
       top10 as (select sum(c) s from (select c from lb order by c desc limit 10) x)
  select t.total::int as total_beers, t.people::int as people_posted,
         round(t.total::numeric / nullif(t.people, 0), 1) as avg_per_person,
         round(top10.s::numeric / nullif(t.total, 0) * 100, 0)::int as top10_pct
  from t, top10;

grant select on
  totals, leaderboard_alltime, daily_counts, deleted_beers, day_extremes,
  v_daily_series, v_day_of_week, v_hourly_matrix, v_monthly, v_weekly,
  v_leaderboard_active, v_biggest_day, v_highest_week, v_milestones,
  v_forecast, v_admin_deletes, v_participation
  to anon, authenticated;

-- =========================================================================
-- PHONE PRIVACY  (re-runnable)
-- =========================================================================

-- Mask middle digits of phone-number-like strings; display names pass through.
create or replace function mask_phone(m text) returns text language plpgsql immutable as $$
declare
  digits text := regexp_replace(m, '[^0-9]', '', 'g');
  mid    int;
begin
  if m ~ '[a-zA-Z~]' or length(digits) < 8 then return m; end if;
  mid := length(digits) - 8;
  return case when left(m, 1) = '+' then '+' else '' end
    || left(digits, 4) || repeat('x', mid) || right(digits, 4);
end;
$$;

-- One-time migration: mask any phone numbers already stored in member.
-- Safe to re-run: mask_phone is idempotent on already-masked values.
update beers set member = mask_phone(member) where member != mask_phone(member);

-- Self-service display name registration.
create table if not exists member_names (
  participant  text primary key,
  display_name text not null,
  updated_at   timestamptz default now()
);
alter table member_names enable row level security;
create policy "public read"   on member_names for select using (true);
create policy "public insert" on member_names for insert with check (true);
create policy "public update" on member_names for update using (true);
grant select, insert, update on member_names to anon, authenticated;

-- RPC: normalise phone, upsert into member_names, update beers.member in place.
-- security definer so it can update beers despite anon read-only RLS.
-- Returns number of beer rows updated.
create or replace function register_display_name(phone text, name text)
returns int language plpgsql security definer as $$
declare
  norm text := regexp_replace(phone, '[^0-9]', '', 'g');
  n    int;
begin
  insert into member_names(participant, display_name)
  values (norm, name)
  on conflict (participant) do update set display_name = name, updated_at = now();

  update beers set member = name where participant = norm;
  get diagnostics n = row_count;
  return n;
end;
$$;
grant execute on function register_display_name to anon, authenticated;

-- =========================================================================
-- MEMBERSHIP  (re-runnable)
-- =========================================================================

-- Current group members, synced by the bot on each connect.
create table if not exists members (
  participant  text primary key,
  is_admin     boolean default false,
  phone        text,               -- same as participant, kept for readability
  member       text,               -- user-registered display name
  push_name    text,               -- WhatsApp display name (updated from live beers)
  synced_at    timestamptz default now()
);
alter table members enable row level security;
drop policy if exists "public read" on members;
create policy "public read" on members for select using (true);
grant select on members to anon, authenticated;

-- Add columns to existing installs (safe no-ops if columns already exist).
alter table members add column if not exists phone     text;
alter table members add column if not exists member    text;
alter table members add column if not exists push_name text;

-- Populate phone from participant (idempotent).
update members set phone = participant where phone is null;
update members m set push_name = (
  select b.push_name from beers b
  where b.participant = m.participant and b.push_name is not null
  order by b.ts desc limit 1
) where push_name is null;
drop table if exists member_names cascade;

-- Trigger: auto-set member = push_name (or masked phone) whenever it would be null.
-- User-registered names (non-null member) are never overwritten by this.
create or replace function members_default_name() returns trigger language plpgsql as $$
begin
  if new.member is null then
    new.member := coalesce(new.push_name, mask_phone(new.participant));
  end if;
  return new;
end;
$$;
drop trigger if exists members_default_name_trigger on members;
create trigger members_default_name_trigger
  before insert or update on members
  for each row execute function members_default_name();

-- Backfill member for any existing rows that are still null.
update members set member = coalesce(push_name, mask_phone(participant)) where member is null;

-- Group-wide stats that require knowing total membership (not just posters).
create or replace view v_member_stats as
  with
    total   as (select count(*)                        as total_members  from members),
    posters as (select count(distinct participant)     as posting_members from beers where deleted_at is null and participant is not null),
    bcnt    as (select count(*)                        as total_beers    from beers where deleted_at is null)
  select
    t.total_members::int,
    p.posting_members::int,
    b.total_beers::int,
    round(b.total_beers::numeric / nullif(t.total_members, 0), 1) as bpm,
    round(p.posting_members::numeric / nullif(t.total_members, 0) * 100, 0)::int as pct_posting
  from total t, posters p, bcnt b;

-- Full membership table: resolves display name, never exposes participant.
create or replace view v_members as
  select
    coalesce(m.member, m.push_name, mask_phone(m.participant)) as display_name,
    m.is_admin,
    count(b.id)::int as beers_posted,
    max(b.ts)        as last_beer_at
  from members m
  left join beers b on b.participant = m.participant and b.deleted_at is null
  group by m.participant, m.member, m.push_name, m.is_admin
  order by beers_posted desc;

grant select on v_member_stats, v_members to anon, authenticated;

-- Update RPC: sets member name in both members and beers so they stay in sync.
-- Returns 1 if the phone matched a known group member, 0 if not found.
create or replace function register_display_name(phone text, name text)
returns int language plpgsql security definer as $$
declare
  norm text := regexp_replace(phone, '[^0-9]', '', 'g');
  n    int;
begin
  update members set member = name where participant = norm;
  get diagnostics n = row_count;
  update beers set member = name where participant = norm;
  return n;
end;
$$;
grant execute on function register_display_name to anon, authenticated;
