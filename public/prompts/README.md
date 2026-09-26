# Sample prompts

Each file here is one step's sample prompt, shown on the site with a **Copy prompt** button:

| File | Page |
| --- | --- |
| `scout/step-0.txt`, `step-1.txt`, `step-2.txt`, `step-3a.txt`, `step-3b.txt` | Recipe Scout (`/scout`), steps 0, 1, 2, 3a and 3b |
| `planner/step-1.txt`, `step-2.txt`, `step-3.txt` | Meal Planner (`/planner`), steps 1, 2 and 3 |

There are two ways to change a prompt:

- **On the site (quickest):** sign in on the Admin page, then open the Recipe Scout or Meal Planner page. Each step has an **Edit** button; your version is saved in the database and every student sees it straight away (it goes **live**). **Save as the safe copy too** also keeps it as the step’s safe copy; **Restore the safe copy** puts the safe copy back live if an edit goes wrong. The safe copy starts as this file.
- **In the file (permanent):** edit it on GitHub (open the file, click the pencil, then **Commit changes**). Vercel redeploys in a minute or two. A step edited on the site keeps showing the site version until you use **Restore the safe copy** (and, if you replaced the safe copy, **Reset the safe copy to the original** on the Admin page).

The whole file is the prompt, so don't add notes or comments inside it.

Two placeholders are filled in on the page:

- `{{SITE}}`: this site's address, e.g. `https://recipes-delta-red.vercel.app`
- `{{GROUP}}`: the group name the student typed on the page (`YOUR-GROUP-NAME` until they do)

A step's title, goal, "What you should see" and "Things you can try" live in `public/scout.html` and `public/planner.html`. If you change what a step does, update those too.
