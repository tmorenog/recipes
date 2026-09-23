# Recipes API

A shared Supabase database for two teaching agents, exposed as an MCP server on Vercel.

- The **Recipe Scout** finds recipes and stores them with `save_recipe`.
- The **Meal Planner** reads unused recipes with `list_recipes`, prices them, saves a 5-meal plan with `save_meal_plan`, and hands back the recipes it used with `mark_processed`.

Every write is validated. A rejected call returns every problem at once, so the agent can fix them and try again. Every call, accepted or rejected, is recorded in the `mcp_calls` table.

## Tools

| Tool | Who calls it | What it does |
| --- | --- | --- |
| `save_recipe` | Recipe Scout | Stores one recipe. Rejects missing or empty fields, fields that aren't in the contract, bad numbers or URLs, and duplicates (same `theme` + `meal_id`). |
| `list_recipes` | Meal Planner | Returns recipes in the agreed format, oldest first. `status` is `new` (default), `processed` or `all`. Optional `theme` and `limit` (max 100). |
| `mark_processed` | Meal Planner | Marks recipes as used, so they drop out of `list_recipes`. Reports which ids were `updated`, `already_processed` or `not_found`. |
| `save_meal_plan` | Meal Planner | Stores a plan: exactly 5 meals, their costs and nutrition, and a shopping list. Checked before saving, see below. |

The exact fields and limits are in [`lib/schemas.js`](lib/schemas.js). Agents also receive them as each tool's input schema.

### What `save_meal_plan` checks
- Exactly 5 meals, on different days, with no recipe used twice.
- Every `recipe_id` exists (use the ids from `list_recipes`).
- For each meal, `cost_per_serving_usd` = `cost_used_usd / servings` (within 5 cents).
- `total_cost_usd` = the sum of `quantity × unit_price_usd` over the shopping list (within 5 cents).
- Every `recipe_ids` entry in the shopping list is one of the plan's meals.
- Going over `budget_usd` is allowed, but the response includes a warning.

The plan, its meals and its shopping list are saved in one transaction: either all of it is stored or none of it is.

## Set up Supabase

The simplest route is Vercel's Supabase integration, which creates the database and the connection settings for you.

1. In your Vercel project, open **Storage → Create Database → Supabase** (or add Supabase from the Marketplace) and connect it to this project. This adds `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to the project's environment variables.
2. Create the tables. The integration doesn't run SQL for you:
   - open the database in Supabase (the **Open in Supabase** button in Vercel's Storage tab)
   - go to **SQL Editor**, paste the contents of [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql), and click **Run**
   - it's safe to run again

If you create the Supabase project yourself instead, run the same SQL, then copy the **Project URL** and the **service_role** key (in newer projects, a **secret key** starting `sb_secret_`) from **Project Settings → API**. Add them to Vercel as `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

Keep the service role key out of chats, code and frontends: it bypasses all security rules.

Row level security is on for every table, with no policies. The public `anon` key can't read or write anything; only this API, using the service role key, can.

### Tables

| Table | Holds |
| --- | --- |
| `recipes` | Scout output. `status` goes from `new` to `processed`. |
| `meal_plans` | One row per plan: planner, summary, budget, total, Kroger store id, rule checks. |
| `meal_plan_items` | The 5 meals of each plan, with cost and nutrition per serving. |
| `shopping_list_items` | What to buy for each plan, with Kroger product, quantity and price. |
| `mcp_calls` | Audit log of every tool call and why it was rejected. |

## Deploy to Vercel

1. Import this repo in Vercel (**Add New → Project**). Leave **Framework Preset** as **Other**.
2. Check **Settings → Environment Variables** has `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (the Supabase integration adds them), then add one more, for Production and Preview:
   - `MCP_API_KEY`: a long random string you make up, e.g. from `openssl rand -hex 32`. Agents send this to use the server.
3. Deploy. The MCP endpoint is `https://<your-app>.vercel.app/mcp`.
4. Open `https://<your-app>.vercel.app/` in a browser. It shows whether the settings are in place and the tables exist, and says what to fix if not. The same check, as JSON, is at `/api/health`.

## Connect an agent

Send two headers with every request:
- `Authorization: Bearer <MCP_API_KEY>` (required)
- `X-Caller: <team or agent name>` (optional). It's recorded in `mcp_calls` and as `created_by` / `processed_by`.

Claude Code:

```sh
claude mcp add --transport http recipes https://<your-app>.vercel.app/mcp \
  --header "Authorization: Bearer <MCP_API_KEY>" --header "X-Caller: scout-team-1"
```

Most other MCP clients take a config like this:

```json
{
  "mcpServers": {
    "recipes": {
      "type": "http",
      "url": "https://<your-app>.vercel.app/mcp",
      "headers": { "Authorization": "Bearer <MCP_API_KEY>", "X-Caller": "planner-team-1" }
    }
  }
}
```

Quick check from a terminal, which should list the four tools:

```sh
curl -s https://<your-app>.vercel.app/mcp \
  -H "Authorization: Bearer <MCP_API_KEY>" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Develop

```sh
npm install
npm test        # end-to-end MCP tests against an in-memory database
```

`@modelcontextprotocol/sdk` is pinned to an exact version because `lib/server.js` hooks an internal SDK method to log calls that fail schema validation. Run the tests after upgrading it.

## Files

| File | What it is |
| --- | --- |
| `api/mcp.js` | Vercel function: checks the API key and serves MCP over HTTP |
| `api/health.js` | Status check: settings present, tables reachable (no secrets shown) |
| `index.html` | Home page showing the status check |
| `lib/server.js` | The four tools |
| `lib/schemas.js` | The data contract and the meal-plan consistency checks |
| `lib/db.js` | Supabase queries |
| `supabase/migrations/0001_init.sql` | Tables, constraints, security, and the `save_meal_plan` function |
| `tests/` | Tests and an in-memory database |
