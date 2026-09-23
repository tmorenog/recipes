-- Recipes API schema.
-- Run once in the Supabase SQL editor (or with `supabase db push`).
--
-- Every table has row level security ON and no policies, so the public
-- anon key can't read or write anything. Only the API server, which uses
-- the service role key, can touch the data.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- recipes
-- Written by the Recipe Scout (add_recipe), read by the Meal Planner
-- (list_recipes), handed off with mark_processed.
create table if not exists public.recipes (
  id            uuid primary key default gen_random_uuid(),
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
  created_by    text not null default 'recipe-scout',
  created_at    timestamptz not null default now(),
  processed_at  timestamptz,
  processed_by  text,
  unique (theme, meal_id)
);
create index if not exists recipes_status_created_idx on public.recipes (status, created_at);

-- ---------------------------------------------------------------- meal plans
-- Written by the Meal Planner (save_meal_plan).
create table if not exists public.meal_plans (
  id              uuid primary key default gen_random_uuid(),
  planner         text not null,
  summary         text not null,
  budget_usd      numeric(10,2) check (budget_usd >= 0),
  total_cost_usd  numeric(10,2) not null check (total_cost_usd >= 0),
  store_id        text,                              -- Kroger locationId used for prices
  rule_checks     jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now()
);

create table if not exists public.meal_plan_items (
  id                    uuid primary key default gen_random_uuid(),
  plan_id               uuid not null references public.meal_plans(id) on delete cascade,
  day                   int  not null check (day between 1 and 7),
  recipe_id             uuid not null references public.recipes(id),
  servings              int  not null check (servings between 1 and 100),
  cost_used_usd         numeric(10,2) not null check (cost_used_usd >= 0),
  cost_per_serving_usd  numeric(10,2) not null check (cost_per_serving_usd >= 0),
  nutrition             jsonb not null,             -- per serving: calories, protein_g, fiber_g, sodium_mg
  unique (plan_id, day),
  unique (plan_id, recipe_id)
);

create table if not exists public.shopping_list_items (
  id                 uuid primary key default gen_random_uuid(),
  plan_id            uuid not null references public.meal_plans(id) on delete cascade,
  item               text not null,
  kroger_product_id  text,
  description        text,
  size               text,
  quantity           int  not null check (quantity >= 1),
  unit_price_usd     numeric(10,2) not null check (unit_price_usd >= 0),
  recipe_ids         uuid[] not null default '{}'
);

-- ---------------------------------------------------------------- audit log
-- Every MCP tool call, accepted or rejected. Useful in class to show what
-- each agent tried and why the server said no.
create table if not exists public.mcp_calls (
  id          bigint generated always as identity primary key,
  tool        text not null,
  caller      text,
  ok          boolean not null,
  input       jsonb,
  error       text,
  created_at  timestamptz not null default now()
);

alter table public.recipes             enable row level security;
alter table public.meal_plans          enable row level security;
alter table public.meal_plan_items     enable row level security;
alter table public.shopping_list_items enable row level security;
alter table public.mcp_calls           enable row level security;

-- ---------------------------------------------------------------- save_meal_plan
-- Inserts a plan, its meals and its shopping list in one transaction, so a
-- half-saved plan can't happen. The API validates the plan before calling this.
create or replace function public.save_meal_plan(plan jsonb)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  pid uuid;
begin
  insert into meal_plans (planner, summary, budget_usd, total_cost_usd, store_id, rule_checks)
  values (
    plan->>'planner',
    plan->>'summary',
    (plan->>'budget_usd')::numeric,
    (plan->>'total_cost_usd')::numeric,
    plan->>'store_id',
    coalesce(plan->'rule_checks', '[]'::jsonb)
  )
  returning id into pid;

  insert into meal_plan_items (plan_id, day, recipe_id, servings, cost_used_usd, cost_per_serving_usd, nutrition)
  select pid,
         (m->>'day')::int,
         (m->>'recipe_id')::uuid,
         (m->>'servings')::int,
         (m->>'cost_used_usd')::numeric,
         (m->>'cost_per_serving_usd')::numeric,
         m->'nutrition_per_serving'
  from jsonb_array_elements(plan->'meals') as m;

  insert into shopping_list_items (plan_id, item, kroger_product_id, description, size, quantity, unit_price_usd, recipe_ids)
  select pid,
         s->>'item',
         s->>'kroger_product_id',
         s->>'description',
         s->>'size',
         (s->>'quantity')::int,
         (s->>'unit_price_usd')::numeric,
         coalesce(array(select jsonb_array_elements_text(s->'recipe_ids'))::uuid[], '{}')
  from jsonb_array_elements(plan->'shopping_list') as s;

  return pid;
end;
$$;

-- Only the API server may call it. Supabase grants new functions to anon and
-- authenticated by default, so revoke those explicitly.
revoke all on function public.save_meal_plan(jsonb) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.save_meal_plan(jsonb) from anon, authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.save_meal_plan(jsonb) to service_role;
  end if;
end $$;
