# Recipes API

A shared recipe database for a class building AI agents. Each group's agent saves recipes it finds; another agent reads them and marks the ones it uses. Everyone can watch the results on a live board.

- **MCP server** at `/api/mcp`, with three tools: `save_recipe`, `list_recipes` and `mark_processed`.
- **REST API** at `/api/recipes` for apps that don't speak MCP. Same data, same rules, same error messages.
- **Recipe Board** at the site root: photos, ingredients, group and status, filterable by theme, group and status. It updates itself every 15 seconds.

Every group has its own key. The key tells the API which group is calling, so each recipe records which group saved it, and which group processed it.

## Deploy

You need a Vercel account, a Supabase database, and this repository on GitHub.

1. **Create the Vercel project.** In Vercel, click **Add New → Project** and import this repository. Leave every setting at its default and click **Deploy**. The first deploy finishes without a database; the site will say so.

2. **Connect Supabase.** In the project, open the **Storage** tab and create or connect a Supabase database for this project. Vercel adds `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to the project's environment variables. (Adding those two yourself also works: copy them from Supabase's **Project Settings → API**.)

3. **Create the tables, once.** Open the project in Supabase (**Open in Supabase** in Vercel's Storage tab), go to **SQL Editor**, paste the whole of [`schema.sql`](schema.sql), and click **Run**. It's safe to run again. This step is manual because Supabase's API can't create tables.

4. **Set the group keys.** In Vercel, open **Settings → Environment Variables** and add one variable, `GROUP_KEYS`, listing every group and its key:

   ```
   team-1:8f3c1a9d2b7e4f60,team-2:c41e97a05d3b28f1,team-3:5a0d6e2f9c18b743
   ```

   - Separate groups with commas (or new lines). Each entry is `group-name:key`.
   - Keys must be at least 8 characters and all different. Make them random, e.g. with `openssl rand -hex 8`.
   - Give each group only its own key.

5. **Redeploy.** Go to **Deployments**, open the ⋯ menu on the latest one and click **Redeploy**. Settings only take effect in new deployments. The build log shows `✓ Supabase is connected and the tables exist`.

6. **Check it.** Open your site's address. You should see the Recipe Board (empty at first). If something is missing, a notice at the top says exactly what.

To add a group later, edit `GROUP_KEYS` and redeploy.

**Without Supabase:** the app also works with any Postgres database that gives a connection string (`POSTGRES_URL` or `DATABASE_URL`), for example Neon from Vercel's Storage tab. Then step 3 isn't needed: every deploy creates the tables itself. If both are set, Supabase is used.

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

Endpoint: `https://<your-site>.vercel.app/api/mcp`. Send the group's key as `Authorization: Bearer <group key>`.

| Tool | What it does |
| --- | --- |
| `save_recipe` | Saves one recipe under your group. |
| `list_recipes` | Recipes from every group, newest first. Options: `status` (`new`, the default; `processed`; or `all`), `theme`, `group`, `limit` (default 50, max 500). |
| `mark_processed` | Takes one `recipe_id`. Marks that recipe as used by your group, so it drops out of the `new` list. Marking it again changes nothing. |

Claude Code:

```sh
claude mcp add --transport http recipes https://<your-site>.vercel.app/api/mcp \
  --header "Authorization: Bearer <group key>"
```

Most other MCP clients take a config like this:

```json
{
  "mcpServers": {
    "recipes": {
      "type": "http",
      "url": "https://<your-site>.vercel.app/api/mcp",
      "headers": { "Authorization": "Bearer <group key>" }
    }
  }
}
```

## REST

Reading needs no key. Writing needs the group key, sent the same way.

| Request | What it does | Success | Errors |
| --- | --- | --- | --- |
| `GET /api/recipes?status=&theme=&group=&limit=` | List recipes (same options as `list_recipes`) | `200` `{ count, recipes }` | `400` bad option |
| `POST /api/recipes` with the recipe as JSON | Save a recipe | `201` `{ saved, recipe }` | `400` incomplete, `401` wrong key, `409` duplicate |
| `POST /api/recipes/{id}/processed` | Mark it processed | `200` `{ processed, already, recipe }` | `401` wrong key, `404` no such recipe |

Every error response looks like `{ "errors": ["reason", "reason"] }`.

```sh
curl -X POST https://<your-site>.vercel.app/api/recipes \
  -H "Authorization: Bearer <group key>" -H "Content-Type: application/json" \
  -d '{"theme":"15-minute lunches","meal_id":"52771","name":"Halloumi wraps","ingredients":[{"name":"halloumi","amount":1,"unit":"block","raw":"1 block halloumi"}],"instructions":"Grill the halloumi, slice it and wrap it with salad.","est_minutes":15,"est_servings":2,"why_chosen":"Ready in 15 minutes."}'
```

## Checking the setup

`/api/health` reports whether a database is connected, whether the tables exist, and which groups are configured. It shows group names, never keys. The Recipe Board uses it to explain what's missing.

## Run it locally

```sh
npm install
npm i -g vercel
vercel link                  # connect this folder to your Vercel project
vercel env pull .env.local   # download the database and GROUP_KEYS settings
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
| `api/health.js` | Setup check |
| `lib/recipes.js` | The recipe rules and database operations shared by MCP and REST |
| `lib/mcp.js` | The three MCP tools |
| `lib/groups.js` | Reads `GROUP_KEYS` and matches a request's key to its group |
| `lib/store/` | Where recipes are stored: `supabase.js` (default) or `postgres.js` |
| `lib/env.js`, `lib/db.js` | Finding the Supabase or Postgres settings |
| `public/` | The Recipe Board |
| `tests/` | Tests |

## Security notes

- Anyone with the site's address can read the recipes. Only holders of a group key can write.
- Keys live only in Vercel's environment variables. Don't put them in code, in the repository, or in a page's JavaScript.
- Supabase's public (anon) key can't reach the tables: row level security is on with no policies. Only this app, using the service role key on the server, can. Never put the service role key in a page or app.
