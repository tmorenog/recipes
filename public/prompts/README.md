# Sample prompts

Each file here is one step's sample prompt, shown on the site with a **Copy prompt** button:

| File | Page |
| --- | --- |
| `scout/step-1.txt` … `scout/step-5.txt` | Recipe Scout (`/scout`), steps 1 to 5 |
| `planner/step-1.txt` … `planner/step-5.txt` | Meal Planner (`/planner`), steps 1 to 5 |

There are two ways to change a prompt:

- **On the site (quickest):** sign in on the Admin page, then open the Recipe Scout or Meal Planner page. Each step has an **Edit** button; your version is saved in the database and every student sees it straight away. **Back to the default** returns the step to its file.
- **In the file (permanent):** edit it on GitHub (open the file, click the pencil, then **Commit changes**). Vercel redeploys in a minute or two. A step edited on the site keeps showing the site version until you use **Back to the default**.

The whole file is the prompt, so don't add notes or comments inside it.

Two placeholders are filled in on the page:

- `{{SITE}}`: this site's address, e.g. `https://recipes-delta-red.vercel.app`
- `{{GROUP}}`: the group name the student typed on the page (`YOUR-GROUP-NAME` until they do)

A step's title, its one-line description and "You should see" live in `public/scout.html` and `public/planner.html`. If you change what a step does, update those too.
