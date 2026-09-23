-- Recipes database. Safe to run any number of times.
--
-- With Supabase: open your project, go to SQL Editor, paste this whole file
-- and click Run.
-- With a Postgres connection string: `npm run db:setup` runs it (and Vercel
-- runs that on every deploy).

create extension if not exists pgcrypto;

create table if not exists recipes (
  id            uuid primary key default gen_random_uuid(),
  group_name    text not null,                     -- the group whose key saved it
  theme         text not null check (length(trim(theme)) > 0),
  meal_id       text not null check (length(trim(meal_id)) > 0),  -- id at the source, e.g. TheMealDB idMeal
  name          text not null check (length(trim(name)) > 0),
  category      text,
  cuisine       text,
  ingredients   jsonb not null check (jsonb_typeof(ingredients) = 'array' and jsonb_array_length(ingredients) > 0),
  instructions  text not null check (length(trim(instructions)) > 0),
  est_minutes   int  check (est_minutes between 1 and 1440),
  est_servings  int  check (est_servings between 1 and 100),
  image_url     text,
  source_url    text,
  why_chosen    text not null check (length(trim(why_chosen)) > 0),
  status        text not null default 'new' check (status in ('new', 'processed')),
  created_at    timestamptz not null default now(),
  processed_at  timestamptz,
  processed_by  text
);

-- Databases set up by an earlier version of this project have no group column
-- and a uniqueness rule without it. Bring them up to date.
alter table recipes add column if not exists group_name text not null default 'unassigned';
alter table recipes alter column group_name drop default;
alter table recipes drop constraint if exists recipes_theme_meal_id_key;

-- A group can't save the same recipe twice for the same theme.
create unique index if not exists recipes_group_theme_meal_key on recipes (group_name, theme, meal_id);
create index if not exists recipes_status_created_idx on recipes (status, created_at);

-- Every write attempt through MCP or REST, accepted or rejected, and why.
create table if not exists activity (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  group_name  text,
  channel     text not null check (channel in ('mcp', 'rest')),
  action      text not null,
  ok          boolean not null,
  detail      text,
  input       jsonb
);
create index if not exists activity_at_idx on activity (at desc);

-- Meal plans saved by the Meal Planner agents. Meals and the shopping list
-- are stored with the plan, so saving a plan is a single write.
create table if not exists plans (
  id              uuid primary key default gen_random_uuid(),
  group_name      text not null,
  summary         text not null,
  budget_usd      numeric(10,2),
  total_cost_usd  numeric(10,2) not null check (total_cost_usd >= 0),
  store_id        text,                       -- Kroger store the prices came from
  meals           jsonb not null check (jsonb_typeof(meals) = 'array'),
  shopping_list   jsonb not null check (jsonb_typeof(shopping_list) = 'array'),
  rule_checks     jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists plans_created_idx on plans (created_at desc);

-- Row level security with no policies: Supabase's public (anon) key can't read
-- or write anything. This app uses the service role key (or connects as the
-- tables' owner), which RLS doesn't restrict.
alter table recipes  enable row level security;
alter table activity enable row level security;
alter table plans    enable row level security;

-- On Supabase, make sure the service role can use the tables through the API,
-- and tell the API to pick up the new tables right away.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update on recipes to service_role;
    grant select, insert on activity to service_role;
    grant select, insert on plans to service_role;
    grant usage, select on sequence activity_id_seq to service_role;
  end if;
end $$;
notify pgrst, 'reload schema';
