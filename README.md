# Recipe Coordinator

The hub for a two-agent class exercise. Groups build two AI agents in Lovable: a **Recipe Scout** that finds recipes, and a **Meal Planner** that turns them into five balanced, affordable dinners priced at Kroger. This site hosts the instructions and the shared database that connects the agents.

**Pages**
- **Welcome** (`/`): what the exercise is, how the pieces fit, and a check that the class key works.
- **Recipe Scout** (`/scout`) and **Meal Planner** (`/planner`): goals, the coordinator's API, copy-ready Lovable prompts (with this site's address filled in), test checklists and troubleshooting.
- **Database** (`/database`): every recipe, meal plan and attempt (including rejections and why), filterable by group. Updates every 15 seconds.

**API** (used by the students' agents)
- **REST** under `/api/…` for Lovable backends. Same data, same rules, same error messages as MCP.
- **MCP** at `/api/mcp` with six tools: `save_recipe`, `list_recipes`, `mark_processed`, `save_meal_plan`, `find_kroger_stores`, `search_kroger_products`.

Everyone shares one class key. Each group also sends its chosen group name (header `X-Group`), so each recipe and plan records who made it. Kroger lookups use the instructor's Kroger credentials, so students need none.

## Deploy

You need a Vercel account and this repository on GitHub.

1. **Create the Vercel project.** In Vercel, click **Add New → Project** and import this repository. Leave every setting at its default and click **Deploy**. The first deploy finishes without a database; the site will say so.

2. **Create the database.** In the project, open the **Storage** tab, click **Create Database**, choose a **Postgres** provider (Neon is the simplest), and connect it to this project. Vercel adds its connection string (`POSTGRES_URL` / `DATABASE_URL`) to the project's settings.

3. **Nothing to do for the tables.** Every deploy runs `schema.sql` against that database, creating or updating the tables automatically.

4. **Set the class key and Kroger credentials.** In Vercel, open **Settings → Environment Variables** and add `CLASS_KEY`: one password for the whole class, e.g. from `openssl rand -hex 8`. Give it to every group. Each group also picks its own group name (like `team-3`) and sends it with every request in the `X-Group` header; the agent pages fill it into the prompts.

   Also add `KROGER_CLIENT_ID` and `KROGER_CLIENT_SECRET` from your app at [developer.kroger.com](https://developer.kroger.com) (it needs the product scope). The Meal Planners' price lookups go through these. Without them, everything else works and the site shows "Kroger prices off".

5. **Redeploy.** Go to **Deployments**, open the ⋯ menu on the latest one and click **Redeploy**. Settings only take effect in new deployments. The build log shows `✓ Database ready`.

6. **Check it.** Open your site's address. The footer shows whether the database is ready, how many groups are set up, and whether Kroger prices are on. The Database page explains anything that's missing.

New groups need no setup: they just use a new group name.

**Using Supabase's API instead:** without a Postgres connection string, the app uses `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Supabase's API can't create tables, so you then have to paste [`schema.sql`](schema.sql) into Supabase's **SQL Editor** and click **Run**, and do it again whenever `schema.sql` changes. If both are set, the Postgres connection string is used.

## The recipe format

Both the MCP tool and the REST API take the same JSON:

| Field | Required | Rules |
| --- | --- | --- |
| `theme` | yes | What the agent was searching for, e.g. `"cheap weeknight vegetarian dinners"` |
| `meal_id` | yes | The recipe's id at its source, e.g. TheMealDB's `"52772"` |
| `name` | yes | |
| `category`, `cuisine` | no | Text or `null` |
| `ingredients` | yes | At least 1 item. Each item: `name` (text), `amount` (positive number or `null`), `unit` (text or `null`), `raw` (the original text, e.g. `"2 tbsp, chopped"`) |
| `instructions` | yes | At least 20 characters |
| `est_minutes` | yes | Whole number, 1 to 1440 |
| `est_servings` | yes | Whole number, 1 to 100 |
| `image_url`, `source_url` | no | `http://` or `https://` address, or `null` |
| `why_chosen` | yes | One sentence on why it fits the theme |

Rules:
- Unknown fields are rejected, so typos like `instuctions` don't slip through silently.
- **Duplicates:** a group can't save the same `meal_id` twice for the same theme. Different groups can.
- A rejected recipe gets every problem at once, in plain words, e.g. `est_servings must be at least 1`, `why_chosen is empty`, `unknown field: calories`.
- Every write attempt is recorded in the `activity` table with the group, whether it worked, and why not.

## MCP

Endpoint: `https://<your-site>.vercel.app/api/mcp`. Send the headers `Authorization: Bearer <class key>` and `X-Group: <group name>`.

| Tool | What it does |
| --- | --- |
| `save_recipe` | Saves one recipe under your group. |
| `list_recipes` | Recipes from every group, newest first. Options: `status` (`new`, the default; `processed`; or `all`), `theme`, `group`, `limit` (default 50, max 500). |
| `mark_processed` | Takes one `recipe_id`. Marks that recipe as used by your group, so it drops out of the `new` list. Marking it again changes nothing. |
| `save_meal_plan` | Saves a 5-meal plan with costs, nutrition and a shopping list. See the checks below. |
| `find_kroger_stores` | Kroger stores near a US ZIP code, each with a `store_id`. |
| `search_kroger_products` | Products at one store: description, size, price and promo price. Results are cached for an hour. |

Claude Code:

```sh
claude mcp add --transport http recipes https://<your-site>.vercel.app/api/mcp \
  --header "Authorization: Bearer <class key>" --header "X-Group: team-3"
```

Most other MCP clients take a config like this:

```json
{
  "mcpServers": {
    "recipes": {
      "type": "http",
      "url": "https://<your-site>.vercel.app/api/mcp",
      "headers": { "Authorization": "Bearer <class key>", "X-Group": "team-3" }
    }
  }
}
```

## REST

Reading recipes, plans and activity needs no key, and works from a browser. Writing and Kroger lookups need the class key and an `X-Group` group name, and only work from a server (browsers can't send keys to the coordinator), which keeps keys out of students' web pages.

| Request | What it does | Success | Errors |
| --- | --- | --- | --- |
| `GET /api/recipes?status=&theme=&group=&limit=` | List recipes (same options as `list_recipes`) | `200` `{ count, recipes }` | `400` bad option |
| `POST /api/recipes` with the recipe as JSON | Save a recipe | `201` `{ saved, recipe }` | `400` incomplete, `401` wrong key, `409` duplicate |
| `POST /api/recipes/{id}/processed` | Mark it processed | `200` `{ processed, already, recipe }` | `401` wrong key, `404` no such recipe |
| `GET /api/meal-plans?group=&limit=` | List meal plans | `200` `{ count, plans }` | |
| `POST /api/meal-plans` | Save a meal plan | `201` `{ saved, plan, warnings, next_step }` | `400` with every problem, `401` |
| `GET /api/kroger/stores?zip=` | Kroger stores (key required) | `200` `{ stores }` | `400`, `429` Kroger busy, `503` not set up |
| `GET /api/kroger/products?term=&store_id=&limit=` | Kroger products with prices (key required) | `200` `{ products }` | same |
| `GET /api/activity?group=&result=all\|accepted\|rejected` | Every save and mark attempt | `200` `{ activity }` | |
| `GET /api/whoami` | Which group a key belongs to | `200` `{ group }` | `401` |

Every error response looks like `{ "errors": ["reason", "reason"] }`.

```sh
curl -X POST https://<your-site>.vercel.app/api/recipes \
  -H "Authorization: Bearer <class key>" -H "X-Group: team-3" -H "Content-Type: application/json" \
  -d '{"theme":"15-minute lunches","meal_id":"52771","name":"Halloumi wraps","ingredients":[{"name":"halloumi","amount":1,"unit":"block","raw":"1 block halloumi"}],"instructions":"Grill the halloumi, slice it and wrap it with salad.","est_minutes":15,"est_servings":2,"why_chosen":"Ready in 15 minutes."}'
```

### Meal plan checks
- Exactly 5 meals, on different days, with no recipe repeated, and every `recipe_id` must exist.
- For each meal, `cost_per_serving_usd` = `cost_used_usd ÷ servings`, to within 5 cents.
- `total_cost_usd` = the sum of `quantity × unit_price_usd` over the shopping list, to within 5 cents.
- Each shopping list line's `recipe_ids` must be meals in this plan.
- Going over `budget_usd` is allowed but returns a warning.

## Checking the setup

`/api/health` reports whether a database is connected, whether the tables exist, and which groups are configured. It shows group names, never keys. The site footer and the Database page use it to explain what’s missing.

## Run it locally

```sh
npm install
npm i -g vercel
vercel link                  # connect this folder to your Vercel project
vercel env pull .env.local   # download the database and CLASS_KEY settings
npm run db:setup             # check the tables (with a Postgres connection string, also create them)
vercel dev                   # http://localhost:3000
```

## Tests

```sh
npm test
```

The end-to-end tests run against the Supabase store (with an in-memory stand-in for Supabase's API) and, when `TEST_DATABASE_URL` points at a Postgres you don't mind wiping, against the Postgres store too:

```sh
TEST_DATABASE_URL=postgres://postgres@localhost:5432/recipes_test npm test
```

`@modelcontextprotocol/sdk` is pinned to an exact version because `lib/mcp.js` replaces one internal SDK method (so MCP and REST share the same validation). Run the tests after upgrading it.

## Files

| File | What it is |
| --- | --- |
| `schema.sql` | Tables, indexes and permissions. Safe to run repeatedly; also upgrades databases from the earlier version |
| `scripts/setup-db.js` | `npm run db:setup`, also run on every deploy: checks the tables, and creates them when it has a Postgres connection string |
| `api/mcp.js` | MCP endpoint |
| `api/recipes.js` | REST endpoint |
| `api/meal-plans.js`, `api/kroger.js`, `api/activity.js`, `api/whoami.js` | The other REST endpoints |
| `api/health.js` | Setup check |
| `lib/recipes.js` | The recipe rules and database operations shared by MCP and REST |
| `lib/plans.js` | Meal plan rules, and the activity list |
| `lib/kroger.js` | Kroger sign-in, store and product lookups, caching |
| `lib/mcp.js` | The MCP tools |
| `lib/auth.js` | Checks the class key and reads the group name from `X-Group` |
| `lib/store/` | Where recipes are stored: `supabase.js` (default) or `postgres.js` |
| `lib/env.js`, `lib/db.js` | Finding the Supabase or Postgres settings |
| `public/` | The site: Welcome, Scout and Planner instructions, Database |
| `tests/` | Tests |

## Security notes

- Anyone with the site's address can read the recipes, plans and activity log. Only holders of the class key can write or use the Kroger lookups. Because the key is shared, a group could write under another group's name; that's the trade-off for simplicity.
- The class key lives only in Vercel's environment variables. Don't put it in code, in the repository, or in a page's JavaScript.
- Supabase's public (anon) key can't reach the tables: row level security is on with no policies. Only this app, using the service role key on the server, can. Never put the service role key in a page or app.
