-- Beer Bot — Supabase schema. Run once in the Supabase SQL editor.

create table beers (
  id           bigint generated always as identity primary key,
  beer_number  integer not null,
  member       text not null,
  ts           timestamptz not null,
  beer_date    date generated always as (ts::date) stored,
  raw_caption  text,
  source       text not null default 'live',   -- 'live' (baileys) | 'export' (backfill)
  created_at   timestamptz default now(),
  unique (beer_number)                          -- DB-level dedup; first writer wins
);
create index on beers (member);
create index on beers (beer_date);

create view totals as
  select count(*) total_beers, count(distinct member) members, count(distinct beer_date) active_days
  from beers;
create view leaderboard_alltime as
  select member, count(*) beers from beers group by member order by beers desc;
create view daily_counts as
  select beer_date, count(*) beers from beers group by beer_date order by beer_date;

alter table beers enable row level security;
create policy "public read" on beers for select using (true);

-- Let the publishable (anon) key read the aggregate views from the frontend.
grant select on totals, leaderboard_alltime, daily_counts to anon, authenticated;
