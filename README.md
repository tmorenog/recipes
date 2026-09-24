# Recipe Coordinator

The hub for a two-agent class exercise. Groups build two AI agents in Lovable: a **Recipe Scout** that finds recipes, and a **Meal Planner** that turns them into five balanced, affordable dinners priced at Kroger. This site hosts the instructions and the shared database that connects the agents.

**Pages**
- **Welcome** (`/`): what the exercise is, how the pieces fit, and a check that the class key works.
- **Recipe Scout** (`/scout`) and **Meal Planner** (`/planner`): goals, copy-ready Lovable prompts with this site's address filled in, test checklists and troubleshooting. Each agent connects to `/api/mcp?agent=…` and reads its rules from `get_expectations`.
  The sample prompts are plain text files in [`public/prompts/`](public/prompts/README.md) (`scout/step-1.txt` … `planner/step-5.txt`): edit a file and the page shows the new text after the next deploy.
- **Database** (`/database`): every recipe, meal plan and attempt (including rejections and why), filterable by group. Updates every 15 seconds.

**API** (used by the students' agents)
- **REST** under `/api/…` for Lovable backends. Same data, same rules, same error messages as MCP.
- **MCP** at `/api/mcp` with eight tools: `get_expectations`, `save_recipe`, `list_recipes`, `mark_processed`, `check_meal_plan`, `save_meal_plan`, `find_kroger_stores`, `search_kroger_products`. With `?agent=planner` the Planner sees `get_expectations`, `list_recipes`, `check_meal_plan` and `save_meal_plan`.

Everyone shares one class key. Each group also sends its chosen group name (header `X-Group`), so each recipe and plan records who made it. Kroger lookups use the instructor's Kroger credentials, so students need none.

## Deploy

You need a Vercel account and this repository on GitHub. Everything else happens in Vercel.

1. **Create the Vercel project.** Click **Add New → Project**, import this repository, leave the settings as they are, and click **Deploy**. The site works straight away, but says the database isn't connected yet.

2. **Create the database.** In the project, open the **Storage** tab, click **Create Database**, choose **Neon**, and connect it to this project (Production and Preview ticked, no prefix). Vercel adds the connection string for you.

3. **Add the settings** under **Settings → Environment Variables** (Production and Preview):

   | Name | What it is |
   | --- | --- |
   | `CLASS_KEY` | A password for the whole class, e.g. from `openssl rand -hex 8`. Give it to every group. |
   | `ADMIN_KEY` | A different password, only for you: it opens the Admin page. |
   | `KROGER_CLIENT_ID`, `KROGER_CLIENT_SECRET` | From your app at [developer.kroger.com](https://developer.kroger.com) (product scope). Needed for the Pricer’s prices; everything else works without them. |
   | `ANTHROPIC_API_KEY` | From [console.anthropic.com](https://console.anthropic.com). Runs the Pricer agent. |
   | `USDA_API_KEY` | Free from [api.data.gov/signup](https://api.data.gov/signup/). Nutrition for the Pricer; without it the shared, heavily limited `DEMO_KEY` is used. |
   | `PRICER_ZIP` (optional) | The ZIP code of the class’s Kroger store. Default `45202`. |
   | `PRICER_MODEL` (optional) | The Claude model the Pricer uses. Default `claude-opus-5`; `claude-haiku-4-5` is cheaper. |

   `DATABASE_URL` / `POSTGRES_URL` are added by step 2; don't add them yourself.

4. **Redeploy:** **Deployments → ⋯ → Redeploy**. The build creates the database tables (the log shows `✓ Database ready`). Settings only take effect in new deployments.

5. **Check it.** Open the site. The footer should say **Database ready** and **Class key set**. If not, the Database page says what's missing.

Each group picks its own group name (like `team-3`) and sends it with every request in the `X-Group` header; the agent pages fill it into the prompts. New groups need no setup.

## The Pricer agent

The Pricer runs on the coordinator. When a Scout saves a recipe, the Pricer builds the Kroger shopping cart needed to cook it (for 50 people by default) and works out its nutrition from USDA FoodData Central. The AI chooses products and amounts; code works out packages, costs and nutrition. Each TheMealDB recipe is priced once for the whole class, and Kroger and USDA answers are remembered.

The **Pricer page** (`/pricer`) shows the queue, each recipe’s cart, and every step the agent took. Signed in with the admin key, you can edit the agent’s prompt (for example, the number of people), price a recipe again, retry failed ones, or re-price everything.

Each recipe from `list_recipes` / `GET /api/recipes` carries a `pricing` object: `status` (`pending`, `pricing`, `priced` or `failed`) and, once priced, `people`, `cart_usd`, `cost_used_usd`, `cost_per_serving_usd` and `nutrition_per_serving`.

A run starts in the background after each save. The Pricer and Database pages restart it if recipes are waiting or a run stopped part-way, and a stopped run carries on where it left off.

## Admin

The **Admin** page (`/admin`, linked in the footer) opens with `ADMIN_KEY`. From there you can:
- **Download a backup** of everything as one JSON file. Do this before class.
- **Restore** a backup file. It replaces everything, in one step; the file is checked first, and if anything in it is wrong nothing changes.
- **Edit** a recipe (same rules as saving one), set it back to `new` or mark it processed, or **delete** it.
- **Delete** meal plans, **clear** the activity log, or **delete everything** to start over between classes.

Neon also keeps its own history: from Vercel's Storage tab, "Open in Neon" lets you restore the database to an earlier point in time.

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

Add `?agent=scout` or `?agent=planner` to show only that agent's tools. Every answer is plain JSON, so an agent can use an MCP client or plain `POST` requests with the JSON-RPC methods `tools/list` and `tools/call`.

| Tool | What it does |
| --- | --- |
| `get_expectations` | The agent's goal, steps and rules, and every field `save_recipe` or `save_meal_plan` accepts, with where its value comes from. Built from the same schemas that check each save, so agents don't need the format written into their code. Takes `agent` (`scout` or `planner`); defaults to the `?agent=` value. |
| `save_recipe` | Saves one recipe under your group. |
| `list_recipes` | Recipes from every group, newest first. Options: `status` (`new`, the default; `processed`; or `all`), `theme`, `group`, `limit` (default 50, max 500). |
| `mark_processed` | Takes one `recipe_id`. Marks that recipe as used by your group, so it drops out of the `new` list. Marking it again changes nothing. |
| `check_meal_plan` | Checks a draft plan without saving it: the week’s cost per person and every balance rule. |
| `save_meal_plan` | Saves a plan: five dinners, Monday to Friday, from priced recipes, with the budget. See the checks below. |
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
| `POST /api/meal-plans` | Save a meal plan (`?check=true`: check it without saving) | `201` `{ saved, plan, week_cost_per_person_usd, checks, … }` | `400` with every problem, `401` |
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

### Meal plans
A plan is `{ budget_usd, summary, meals }`: the budget in US dollars per person for the week, and five dinners, each `{ day, recipe_id, why }`. The coordinator fills in each dinner’s cost and nutrition per serving from the Pricer and adds up the week, so no number in a plan comes from the AI.

Rejected (nothing saved): a day missing or repeated (Monday to Friday, each once), a recipe used twice, an unknown `recipe_id`, or a recipe that isn’t priced yet.

Checked and reported with ✓ or ✗ (the plan is saved either way): the week’s cost per person within the budget; every dinner at 400–800 calories, at least 20 g protein, at least 5 g fibre and under 1,500 mg sodium per serving; at least 3 cuisines; no category more than twice; at least one vegetarian or vegan dinner. The rules are in `lib/plans.js`.

## Checking the setup

`/api/health` reports whether a database is connected, whether the tables exist, and whether each key and the Kroger credentials are set. It never shows their values. The site footer and the Database page use it to explain what’s missing.

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

The end-to-end tests need a Postgres they can wipe, named by `TEST_DATABASE_URL`; without it only the unit tests run:

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
| `lib/expectations.js` | What `get_expectations` returns for each agent |
| `lib/pricer.js` | The Pricer agent: its prompt, tools, loop and queue |
| `lib/units.js`, `lib/usda.js` | Package sizes and unit conversion; USDA nutrition |
| `api/pricer.js`, `public/pricer.html`, `public/pricer.js` | The Pricer page and its API |
| `public/prompts/` | The sample prompt for each step, one text file per step |
| `lib/auth.js` | Checks the class key and reads the group name from `X-Group` |
| `lib/store/` | The database queries (`postgres.js`) |
| `lib/env.js`, `lib/db.js` | Finding the database connection string |
| `lib/admin.js`, `api/admin.js`, `public/admin.*` | The Admin page: edit, delete, backup, restore, reset |
| `public/` | The site: Welcome, Scout and Planner instructions, Database |
| `tests/` | Tests |

## Security notes

- Anyone with the site's address can read the recipes, plans and activity log. Only holders of the class key can write or use the Kroger lookups. Because the key is shared, a group could write under another group's name; that's the trade-off for simplicity.
- The class key lives only in Vercel's environment variables. Don't put it in code, in the repository, or in a page's JavaScript.
