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

-- views exclude soft-deleted beers
create view totals as
  select count(*) total_beers, count(distinct member) members, count(distinct beer_date) active_days
  from beers where deleted_at is null;
create view leaderboard_alltime as
  select member, count(*) beers from beers where deleted_at is null group by member order by beers desc;
create view daily_counts as
  select beer_date, count(*) beers from beers where deleted_at is null group by beer_date order by beer_date;

-- delete-for-everyone log: just a filtered window over beers (no separate table)
create view deleted_beers as
  select beer_number, member, deleted_by, deleted_by_name, by_admin, deleted_at
  from beers where deleted_at is not null order by deleted_at desc;

alter table beers enable row level security;
create policy "public read" on beers for select using (true);

-- Let the publishable (anon) key read the views from the frontend.
grant select on totals, leaderboard_alltime, daily_counts, deleted_beers to anon, authenticated;
