# Sample prompts

Each file here is one step's sample prompt, shown on the site with a **Copy prompt** button:

| File | Page |
| --- | --- |
| `scout/step-1.txt` … `scout/step-5.txt` | Recipe Scout (`/scout`), steps 1 to 5 |
| `planner/step-1.txt` … `planner/step-5.txt` | Meal Planner (`/planner`), steps 1 to 5 |

To change a prompt, edit its file (on GitHub: open the file, click the pencil, then **Commit changes**). Vercel redeploys in a minute or two and the page shows the new text. The whole file is the prompt, so don't add notes or comments inside it.

Two placeholders are filled in on the page:

- `{{SITE}}`: this site's address, e.g. `https://recipes-delta-red.vercel.app`
- `{{GROUP}}`: the group name the student typed on the page (`YOUR-GROUP-NAME` until they do)

A step's title, its one-line description and "You should see" live in `public/scout.html` and `public/planner.html`. If you change what a step does, update those too.
