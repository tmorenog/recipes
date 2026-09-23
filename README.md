# Recipes API

A shared recipe database for a class building AI agents. Each group's agent saves recipes it finds; another agent reads them and marks the ones it uses. Everyone can watch the results on a live board.

- **MCP server** at `/api/mcp`, with three tools: `save_recipe`, `list_recipes` and `mark_processed`.
- **REST API** at `/api/recipes` for apps that don't speak MCP. Same data, same rules, same error messages.
- **Recipe Board** at the site root: photos, ingredients, group and status, filterable by theme, group and status. It updates itself every 15 seconds.

Every group has its own key. The key tells the API which group is calling, so each recipe records which group saved it, and which group processed it.

## Deploy

You need a Vercel account and this repository on GitHub.

1. **Create the Vercel project.** In Vercel, click **Add New → Project** and import this repository. Leave every setting at its default and click **Deploy**. The first deploy finishes without a database; the site will say so.

2. **Create the database.** In the project, open the **Storage** tab, click **Create Database**, and pick a Postgres provider (Neon is the simplest; Supabase also works). Connect it to this project. Vercel adds the connection string (`POSTGRES_URL` or `DATABASE_URL`) to the project's environment variables for you.

3. **Set the group keys.** Open **Settings → Environment Variables** and add one variable, `GROUP_KEYS`, listing every group and its key:

   ```
   team-1:8f3c1a9d2b7e4f60,team-2:c41e97a05d3b28f1,team-3:5a0d6e2f9c18b743
   ```

   - Separate groups with commas (or new lines). Each entry is `group-name:key`.
   - Keys must be at least 8 characters and all different. Make them random, e.g. with `openssl rand -hex 8`.
   - Give each group only its own key.

4. **Redeploy.** Go to **Deployments**, open the ⋯ menu on the latest one and click **Redeploy**. The build creates the tables automatically; the build log shows `✓ Database ready`.

5. **Check it.** Open your site's address. You should see the Recipe Board (empty at first). If something is missing, a notice at the top says exactly what.

To add a group later, edit `GROUP_KEYS` and redeploy.

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
npm run db:setup             # create or update the tables (safe to repeat)
vercel dev                   # http://localhost:3000
```

## Tests

```sh
npm test
```

The tests that need a database run only when `TEST_DATABASE_URL` points at a Postgres you don't mind wiping; they recreate the tables each time:

```sh
TEST_DATABASE_URL=postgres://postgres@localhost:5432/recipes_test npm test
```

`@modelcontextprotocol/sdk` is pinned to an exact version because `lib/mcp.js` replaces one internal SDK method (so MCP and REST share the same validation). Run the tests after upgrading it.

## Files

| File | What it is |
| --- | --- |
| `schema.sql` | Tables and indexes. Safe to run repeatedly; also upgrades databases from the earlier Supabase version |
| `scripts/setup-db.js` | Runs `schema.sql` (`npm run db:setup`; Vercel runs it on every deploy) |
| `api/mcp.js` | MCP endpoint |
| `api/recipes.js` | REST endpoint |
| `api/health.js` | Setup check |
| `lib/recipes.js` | The recipe rules and database operations shared by MCP and REST |
| `lib/mcp.js` | The three MCP tools |
| `lib/groups.js` | Reads `GROUP_KEYS` and matches a request's key to its group |
| `lib/db.js` | Postgres connection |
| `public/` | The Recipe Board |
| `tests/` | Tests |

## Security notes

- Anyone with the site's address can read the recipes. Only holders of a group key can write.
- Keys live only in Vercel's environment variables. Don't put them in code, in the repository, or in a page's JavaScript.
- If the database comes from Supabase, its public data API is blocked: row level security is on and no public access is allowed. Only this app, which connects as the database owner, can reach the tables.
