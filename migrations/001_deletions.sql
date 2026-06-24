-- Apply to an existing beer-bot DB to add deletion tracking (approach A:
-- soft-delete columns on beers + a deleted_beers view). Run once in the SQL editor.

alter table beers add column if not exists push_name text;
alter table beers add column if not exists participant text;
alter table beers add column if not exists wa_message_id text;
alter table beers add column if not exists deleted_at timestamptz;
alter table beers add column if not exists deleted_by text;
alter table beers add column if not exists deleted_by_name text;
alter table beers add column if not exists by_admin boolean;
create index if not exists beers_wa_message_id_idx on beers (wa_message_id);
create index if not exists beers_participant_idx on beers (participant);

-- views now exclude soft-deleted beers
create or replace view totals as
  select count(*) total_beers, count(distinct member) members, count(distinct beer_date) active_days
  from beers where deleted_at is null;
create or replace view leaderboard_alltime as
  select member, count(*) beers from beers where deleted_at is null group by member order by beers desc;
create or replace view daily_counts as
  select beer_date, count(*) beers from beers where deleted_at is null group by beer_date order by beer_date;

-- delete-for-everyone log
create or replace view deleted_beers as
  select beer_number, member, deleted_by, deleted_by_name, by_admin, deleted_at
  from beers where deleted_at is not null order by deleted_at desc;

grant select on deleted_beers to anon, authenticated;
