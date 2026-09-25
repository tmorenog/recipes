# Sample prompts

Each file here is one step's sample prompt, shown on the site with a **Copy prompt** button:

| File | Page |
| --- | --- |
| `scout/step-0.txt`, `step-1.txt`, `step-2.txt`, `step-3a.txt`, `step-3b.txt` | Recipe Scout (`/scout`), steps 0, 1, 2, 3a and 3b |
| `planner/step-1.txt` … `planner/step-5.txt` | Meal Planner (`/planner`), steps 1 to 5 |

There are two ways to change a prompt:

- **On the site (quickest):** sign in on the Admin page, then open the Recipe Scout or Meal Planner page. Each step has an **Edit** button; your version is saved in the database and every student sees it straight away. **Back to the default** returns the step to its file.
- **In the file (permanent):** edit it on GitHub (open the file, click the pencil, then **Commit changes**). Vercel redeploys in a minute or two. A step edited on the site keeps showing the site version until you use **Back to the default**.

The whole file is the prompt, so don't add notes or comments inside it.

Two placeholders are filled in on the page:

- `{{SITE}}`: this site's address, e.g. `https://recipes-delta-red.vercel.app`
- `{{GROUP}}`: the group name the student typed on the page (`YOUR-GROUP-NAME` until they do)

A step's title, goal, "What you should see" and "Things to try" live in `public/scout.html` and `public/planner.html`. If you change what a step does, update those too.
