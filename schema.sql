-- Recipes database. Safe to run any number of times: every deploy runs it
-- (`npm run db:setup`), creating or updating the tables.

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

-- (Recipes are unique per TheMealDB meal: see "One recipe per meal" below.)

-- The Pricer's result, kept on each recipe (see "Prices on each recipe" below).
alter table recipes add column if not exists price_status text not null default 'pending';
alter table recipes add column if not exists cost_per_serving_usd numeric(10,2);
alter table recipes add column if not exists cart_usd numeric(10,2);
alter table recipes add column if not exists priced_for int;           -- people the cart feeds
alter table recipes add column if not exists estimated_lines int not null default 0;
alter table recipes add column if not exists price_estimated boolean not null default false;
alter table recipes add column if not exists priced_at timestamptz;

create index if not exists recipes_status_created_idx on recipes (status, created_at);

-- Every write attempt through MCP or REST, accepted or rejected, and why.
create table if not exists activity (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  group_name  text,
  channel     text not null,
  action      text not null,
  ok          boolean not null,
  detail      text,
  input       jsonb
);
create index if not exists activity_at_idx on activity (at desc);
-- Where an action came from: an agent over MCP or REST, or the admin page.
alter table activity drop constraint if exists activity_channel_check;
alter table activity add constraint activity_channel_check check (channel in ('mcp', 'rest', 'admin'));

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

-- The Recipe Pricer: an agent that prices each recipe at the class's Kroger
-- store and saves the price here. One pricing per TheMealDB
-- recipe (meal_id), shared by every group that saved it.
create table if not exists pricings (
  meal_id          text primary key,
  status           text not null default 'pending' check (status in ('pending', 'pricing', 'priced', 'failed')),
  store_id         text,
  attempts         int  not null default 0,
  claimed_at       timestamptz,                -- when a run picked it up; a stale claim is picked up again
  finished_at      timestamptz,
  error            text,
  summary          text,
  basket           jsonb not null default '[]'::jsonb,   -- one entry per ingredient line
  total_cost_usd   numeric(10,2),              -- what the whole recipe uses (shares of packages)
  to_buy_usd       numeric(10,2),              -- what you'd pay for whole packages
  nutrition_total  jsonb,                      -- { calories, protein_g, fiber_g, sodium_mg } for the whole recipe
  tool_calls       int  not null default 0,
  messages         jsonb,                      -- the conversation so far, so an interrupted run resumes
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists pricings_status_idx on pricings (status, created_at);

-- Every step the Pricer takes, for the trace on the Pricer page.
create table if not exists pricer_steps (
  id        bigint generated always as identity primary key,
  meal_id   text not null references pricings (meal_id) on delete cascade,
  attempt   int  not null,
  at        timestamptz not null default now(),
  kind      text not null check (kind in ('thought', 'tool_call', 'tool_result', 'error', 'final')),
  tool      text,
  input     jsonb,
  output    jsonb,
  text      text
);
create index if not exists pricer_steps_meal_idx on pricer_steps (meal_id, id);

-- Kroger and TheMealDB answers, so the same search is made once for the class.
create table if not exists pricer_cache (
  key   text primary key,
  data  jsonb not null,
  at    timestamptz not null default now()
);

-- Recipes saved before the Pricer existed get priced too.
insert into pricings (meal_id) select distinct meal_id from recipes on conflict do nothing;

-- How many people the cart feeds (from the Pricer's instructions) and the
-- instructions it followed, so a change of prompt is visible per recipe.
alter table pricings add column if not exists people int;
alter table pricings add column if not exists prompt text;
-- Which run holds a recipe being priced: only that run's results are saved.
alter table pricings add column if not exists claim_token uuid;

-- Settings the instructor changes on the Pricer page, e.g. the agent's prompt.
create table if not exists pricer_config (
  key         text primary key,
  value       text not null,
  updated_at  timestamptz not null default now()
);

-- Sample prompts the instructor edited on the Recipe Scout and Meal Planner
-- pages. A step with no row shows its text file (public/prompts/…).
create table if not exists prompt_overrides (
  agent       text not null check (agent in ('scout', 'planner')),
  step        int  not null check (step between 1 and 20),
  text        text not null,
  updated_at  timestamptz not null default now(),
  primary key (agent, step)
);

-- The instructor's test runs of the Pricer on a short ingredient list
-- (Pricer page). Nothing here touches the recipes.
create table if not exists pricer_tests (
  id           uuid primary key default gen_random_uuid(),
  status       text not null default 'running' check (status in ('running', 'done', 'failed')),
  ingredients  jsonb not null,
  serves       int  not null,
  prompt       text not null,
  draft        boolean not null default false,  -- tried with unsaved instructions
  steps        jsonb not null default '[]'::jsonb,
  basket       jsonb not null default '[]'::jsonb,
  totals       jsonb,
  people       int,
  summary      text,
  error        text,
  tool_calls   int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Never keep an API key that an error message quoted back (e.g. a mis-pasted
-- ANTHROPIC_API_KEY). Runs on every deploy; cheap when there's nothing to fix.
update pricer_tests set error = regexp_replace(error, 'sk-ant-[A-Za-z0-9_-]{8,}', 'sk-ant-[hidden]', 'g') where error ~ 'sk-ant-';
update pricer_tests set steps = regexp_replace(steps::text, 'sk-ant-[A-Za-z0-9_-]{8,}', 'sk-ant-[hidden]', 'g')::jsonb where steps::text ~ 'sk-ant-';
update pricer_steps set text = regexp_replace(text, 'sk-ant-[A-Za-z0-9_-]{8,}', 'sk-ant-[hidden]', 'g') where text ~ 'sk-ant-';
update pricings set error = regexp_replace(error, 'sk-ant-[A-Za-z0-9_-]{8,}', 'sk-ant-[hidden]', 'g') where error ~ 'sk-ant-';

-- 'unpriced': prices cleared by the instructor; not queued until someone
-- asks for it to be priced.
alter table pricings drop constraint if exists pricings_status_check;
alter table pricings add constraint pricings_status_check check (status in ('unpriced', 'pending', 'pricing', 'priced', 'failed'));

-- The Lovable secret for the class key is called CLASS_KEY (it was
-- COORDINATOR_KEY): bring step prompts edited on the site in line.
update prompt_overrides set text = replace(text, 'COORDINATOR_KEY', 'CLASS_KEY'), updated_at = now() where text like '%COORDINATOR_KEY%';

-- ---------------------------------------------------------------- One recipe per meal
-- Each TheMealDB recipe is stored once. Every group that picks it adds a
-- pick (group, theme, why), so a recipe shows how many groups chose it.
-- The recipe's own group_name/theme/why_chosen are its first pick's.
create table if not exists recipe_picks (
  id          bigint generated always as identity primary key,
  recipe_id   uuid not null references recipes (id) on delete cascade,
  group_name  text not null,
  theme       text not null,
  why_chosen  text not null,
  created_at  timestamptz not null default now(),
  unique (recipe_id, group_name, theme)
);
create index if not exists recipe_picks_group_idx on recipe_picks (group_name);

-- Recipes saved before picks existed: each row is its own first pick.
insert into recipe_picks (recipe_id, group_name, theme, why_chosen, created_at)
  select id, group_name, theme, why_chosen, created_at from recipes r
  where not exists (select 1 from recipe_picks p where p.recipe_id = r.id)
  on conflict do nothing;

-- Merge duplicates saved by earlier versions into the first copy: its picks
-- gain the others' picks, plans point at it, and the copies go.
do $$
declare d record;
begin
  for d in
    select id, keep from (
      select id, first_value(id) over (partition by meal_id order by created_at, id) as keep from recipes
    ) x where id <> keep
  loop
    insert into recipe_picks (recipe_id, group_name, theme, why_chosen, created_at)
      select d.keep, group_name, theme, why_chosen, created_at from recipe_picks where recipe_id = d.id
      on conflict do nothing;
    update plans set meals = replace(meals::text, d.id::text, d.keep::text)::jsonb where meals::text like '%' || d.id::text || '%';
    update recipes k set status = 'processed', processed_at = r.processed_at, processed_by = r.processed_by
      from recipes r where k.id = d.keep and r.id = d.id and r.status = 'processed' and k.status = 'new';
    delete from recipes where id = d.id;
  end loop;
end $$;

drop index if exists recipes_group_theme_meal_key;
create unique index if not exists recipes_meal_key on recipes (meal_id);

-- ---------------------------------------------------------------- Prices on each recipe
-- The Pricer's result, kept on the recipe itself: whether it's priced, what a
-- serving costs, the cart, and whether any ingredient's price is estimated.
-- (The price columns are added with the recipes table, above.)

create or replace function sync_recipe_price() returns trigger language plpgsql as $f$
declare est int;
begin
  est := case when new.status = 'priced'
    then (select count(*) from jsonb_array_elements(new.basket) e where e->>'status' = 'estimated') else 0 end;
  update recipes set
    price_status         = new.status,
    cost_per_serving_usd = case when new.status = 'priced' and new.people > 0 then round(new.total_cost_usd / new.people, 2) end,
    cart_usd             = case when new.status = 'priced' then new.to_buy_usd end,
    priced_for           = case when new.status = 'priced' then new.people end,
    estimated_lines      = est,
    price_estimated      = est > 0,
    priced_at            = case when new.status = 'priced' then new.finished_at end
  where meal_id = new.meal_id;
  return new;
end $f$;
drop trigger if exists pricings_sync_recipe on pricings;
create trigger pricings_sync_recipe after insert or update on pricings for each row execute function sync_recipe_price();
-- Bring existing recipes up to date.
update pricings set meal_id = meal_id;

-- A Pricer prompt saved before nutrition moved to the Meal Planner tells the
-- agent to use USDA tools that no longer exist: drop it so the default applies.
delete from pricer_config where key = 'prompt' and value ~* '(search_usda|usda_fdc_id)';

-- A test run is priced as a named recipe.
alter table pricer_tests add column if not exists name text;

-- The Meal Planner no longer has a nutrition look-up tool (search_foods): the
-- agent estimates nutrition itself. Take it out of step prompts edited on the site.
update prompt_overrides set
  text = regexp_replace(regexp_replace(text, '\s*Also call search_foods[^\n]*?show me the result\.', '', 'g'), ',? and USDA nutrition data', '', 'g'),
  updated_at = now()
where agent = 'planner' and text ~ '(search_foods|USDA nutrition data)';

-- The coordinator's exchange log (Coordinator page): each MCP request an agent
-- sent and the answer, and each Pricer result. Headers, so the class key, are
-- never stored; only the newest 2,000 entries are kept.
create table if not exists exchanges (
  id               bigserial primary key,
  at               timestamptz not null default now(),
  group_name       text,
  agent            text,
  method           text not null,
  tool             text,
  ok               boolean not null,
  request          jsonb,
  request_summary  text,
  response         jsonb,
  summary          text,
  ms               int
);

-- The exercise plans dinners: bring a Scout step 1 edited on the site in line.
update prompt_overrides set text = replace(text, '"15-minute lunches"', '"20-minute dinners"'), updated_at = now()
where agent = 'scout' and text like '%"15-minute lunches"%';

-- The site is called Meal Squad, and the Recipe Pricer is an agent of its own:
-- update that line in a Pricer prompt saved from the earlier default.
update pricer_config set
  value = replace(value, 'You are the Pricer, an agent that runs on the class''s recipe coordinator.', 'You are the Recipe Pricer, one of the agents in the class''s Meal Squad system.'),
  updated_at = now()
where key = 'prompt' and value like '%an agent that runs on the class''s recipe coordinator.%';

-- The coordinator's limits and checks, set on the Admin page (lib/settings.js).
create table if not exists coordinator_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

-- get_expectations was renamed get_contract: bring step prompts edited on the site in line.
update prompt_overrides set text = replace(text, 'get_expectations', 'get_contract'), updated_at = now()
where text like '%get\_expectations%';

-- Meal Planner step 2 edited on the site: add the fix for a blank page when
-- the page parses an already-parsed coordinator result (once only).
update prompt_overrides set
  text = replace(text, 'If there are no priced recipes yet, say so plainly instead of showing an error.',
    E'Each coordinator tool returns its answer as text that contains JSON. Parse it once, in the backend, and send the page ready-to-use data; the page should not parse it again. If a section can’t be shown, display a short message in that section instead of breaking the page.\n\nIf there are no priced recipes yet, say so plainly instead of showing an error.'),
  updated_at = now()
where agent = 'planner' and step = 11
  and text like '%If there are no priced recipes yet, say so plainly instead of showing an error.%'
  and text not like '%Parse it once, in the backend%';

-- Runs of the instructor's backup agents (a Scout or Planner Agent run from
-- the site): the input, every step as it happens, and how it ended.
create table if not exists backup_runs (
  id          uuid primary key default gen_random_uuid(),
  agent       text not null check (agent in ('scout', 'planner')),
  group_name  text not null,
  input       jsonb not null,
  status      text not null default 'running' check (status in ('running', 'done', 'failed')),
  outcome     text,
  summary     text,
  steps       jsonb not null default '[]'::jsonb,
  actions     int not null default 0,
  created_at  timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists backup_runs_created_idx on backup_runs (created_at desc);

-- Step prompts edited on the site that don't say how to send the group name
-- (the X-Group header): add it, once, to the versions saved on 2026-09-26.
update prompt_overrides set
  text = replace(replace(replace(replace(text,
    'The coordinator requires two things on every request: our class key and our group name.',
    'The coordinator requires two things on every request: our class key, sent as the header “Authorization: Bearer ” followed by the value of the CLASS_KEY secret, and our group name, {{GROUP}}, sent as the header “X-Group”. All requests to the coordinator must be made from the backend.'),
    'Ask me for the group name too.', 'If the group name is YOUR-GROUP-NAME, ask me for our group name first.'),
    'Do not give the tools to the Recipe Scout yet, and do not change how the Scout works.', 'Do not give the tools to the Scout Agent yet, and do not change how it works.'),
    'Once you have established the connection, explain the tools that are available.',
    'Once you have established the connection, explain the tools that are available. Show the connection status and the tools, with their descriptions, in a “Coordinator connection” section on the page.'),
  updated_at = now()
where agent = 'scout' and step = 13 and text like '%our class key and our group name.%';

update prompt_overrides set
  text = replace(replace(text,
    'followed by CLASS_KEY, and our group name.',
    'followed by the value of the CLASS_KEY secret, and our group name, {{GROUP}}, sent as the header “X-Group”.'),
    'If you don''t have our group name, ask me.', 'If the group name is YOUR-GROUP-NAME, ask me for our group name first.'),
  updated_at = now()
where agent = 'planner' and step = 11 and text like '%followed by CLASS_KEY, and our group name.%';

-- Meal Planner step 1: the instructor chose their own version with its typos
-- fixed, which is now the file; the older saved copy goes.
delete from prompt_overrides where agent = 'planner' and step = 10 and text like '%Scouting Agents%';

-- The Shopper Agent (run on the site) chooses the class's plan and the
-- coordinator builds its Kroger cart from the Pricer's carts. The newest
-- choice is the class's; earlier ones stay as history.
create table if not exists class_choices (
  id          uuid primary key default gen_random_uuid(),
  plan_id     uuid not null references plans (id) on delete cascade,
  reason      text not null,
  people      int,
  cart        jsonb not null,
  total_usd   numeric(10,2) not null,
  created_at  timestamptz not null default now()
);
create index if not exists class_choices_created_idx on class_choices (created_at desc);
alter table backup_runs drop constraint if exists backup_runs_agent_check;
alter table backup_runs add constraint backup_runs_agent_check check (agent in ('scout', 'planner', 'shopper'));

-- The Scout Agent now finds four recipes (five was easy to confuse with the
-- Meal Planner's five dinners): bring step prompts edited on the site in line.
update prompt_overrides set
  text = replace(replace(replace(replace(replace(replace(replace(text,
    'find five real recipes', 'find four real recipes'),
    'If five suitable recipes cannot be found', 'If four suitable recipes cannot be found'),
    'No more than five recipes can be selected', 'No more than four recipes can be selected'),
    'Find five recipes that fit the theme', 'Find four recipes that fit the theme'),
    'once five recipes have been accepted', 'once four recipes have been accepted'),
    'Finish after five recipes have been accepted', 'Finish after four recipes have been accepted'),
    'If five recipes cannot be accepted', 'If four recipes cannot be accepted'),
  updated_at = now()
where agent = 'scout' and text ~ '(find five real recipes|five suitable recipes|than five recipes|Find five recipes|five recipes have been accepted|If five recipes)';

-- The site agents' instructions can be edited on the Admin page too.
alter table prompt_overrides drop constraint if exists prompt_overrides_agent_check;
alter table prompt_overrides add constraint prompt_overrides_agent_check check (agent in ('scout', 'planner', 'backup_scout', 'backup_planner', 'shopper'));

-- Defaults the instructor replaced (the original defaults are the text files
-- in public/prompts/ and the defaults in the code). "Back to the default"
-- returns a prompt to its default: this one if set, otherwise the original.
create table if not exists prompt_defaults (
  agent       text not null check (agent in ('scout', 'planner', 'pricer', 'backup_scout', 'backup_planner', 'shopper')),
  step        int  not null check (step between 1 and 20),
  text        text not null,
  updated_at  timestamptz not null default now(),
  primary key (agent, step)
);
