# Deploy guide: The Sycophancy Meter site

This guide covers putting the static site online. For the project setup, see `README.md`.
Run the commands from the project folder, `/Users/mobinzaki/Github/Hacktest/spine-meter`,
unless a step says otherwise.

The Python used below is the project's virtual environment:
`/Users/mobinzaki/Github/Hacktest/.venv-spine/bin/python`.

## 1. What is deployed

1. Only the `site/` folder and `netlify.toml` are uploaded.
2. Nothing else is uploaded. The scripts, the results and the tests stay on your computer.
3. The project's own key, in `.env`, is never deployed. The site never reads it.
4. Visitors type their own key into the page. Section 5 explains what happens to it.

The site is static. It is plain HTML, CSS and JavaScript with no build step, and it has no server state.
There is no database on the server. Saved runs and presets live in each visitor's browser (IndexedDB), and
nothing is stored on Netlify or in any other service.

The data files in `site/data/` are written by `scripts/export_site_data.py`. They include:

- `suites.json`: one entry for each pushback set and question set pair.
- `ladder.json`, `probe_spec.json` and `questions.json`: the `gauntlet_v3` and `easy` files.
- `ladder_v4.json` and `probe_spec_v4.json`: the `gauntlet_v4` files.
- `questions_hard.json`: the `hard` question set.
- `results.json`, `probes.json`, `sample_run.json`, `manifest.json`, `version.json`, `config.json` and the
  `compare/` folder.

Check section 2a after any change to these files.

The Netlify Content Security Policy (in `netlify.toml`) allows the browser to send requests only to
`https://api.tokenfactory.nebius.com` (`connect-src`). It allows no other API host and no CDN. Custom model
endpoints are blocked by this rule. Widening `connect-src` for custom models needs the owner's approval
first. Do not widen it in a deploy without that approval.

## 2. Checks before every deploy

Run these in order. If one fails, fix it before you go on. The three checks that must pass are the
secrets check (b), `npm test` (c) and the local preview (d).

**a. Refresh the data.**

```
/Users/mobinzaki/Github/Hacktest/.venv-spine/bin/python scripts/export_site_data.py
```

This writes the files in `site/data/` from the saved results. It makes no network calls.
It refuses to write any file that contains a key-like string.

**b. Check for secrets.**

```
/Users/mobinzaki/Github/Hacktest/.venv-spine/bin/python scripts/check_no_secrets.py
```

The command must exit with code 0. The check scans `site/`, `netlify/` if it exists, and `netlify.toml`.
By default it also looks for the project key from `.env`. It prints the file, the line and the
pattern name. It never prints the key. If it fails, fix the file and run the check again.
Do not deploy until it passes.

**c. Run the tests.**

```
npm test
```

```
/Users/mobinzaki/Github/Hacktest/.venv-spine/bin/python -m unittest discover -s tests -t .
```

**d. Preview the site locally.**

```
cd site
/Users/mobinzaki/Github/Hacktest/.venv-spine/bin/python -m http.server 8080
```

Open http://127.0.0.1:8080/ in a browser. Check the three pages:

- `/index.html` (The Gauntlet)
- `/batch.html` (The Batch)
- `/live.html` (The Theatre)

The local server does not apply the headers in `netlify.toml` or the redirects in
`site/_redirects`. Check those after the deploy. Stop the server with Ctrl+C, then run
`cd /Users/mobinzaki/Github/Hacktest/spine-meter`.

## 3. How to deploy

There are two ways. The second is safer.

**Option A: drag and drop.**

1. Log in to Netlify with your own account.
2. Go to **Sites**, then **Add new site**, then **Deploy manually**.
3. Drag the `site` folder onto the page.

A drag of `site/` alone does not include `netlify.toml`. The security headers may then not apply.
Check them after the deploy (see section 9).

**Option B: Netlify CLI.**

1. Log in once. The project owner must do this step with their own Netlify account.

   ```
   npx netlify-cli login
   ```

2. Deploy from the project folder.

   ```
   npx netlify-cli deploy --dir site --prod
   ```

   The CLI may ask you to create or link a site. Choose the owner's site. The `--prod` flag
   publishes to the live address. Without it, you get a draft preview address.

The assistant cannot do the login step. Only the project owner can.

After any deploy, open the live address. Check `/index.html`, `/batch.html` and `/live.html`.
Also check `/gauntlet`, `/batch` and `/live`, which the redirects in `site/_redirects` serve.

## 4. Custom domain and HTTPS

1. Open the site in the Netlify dashboard.
2. Open the site's **Domain management** settings and add your domain.
3. Point the domain's DNS records to Netlify, as Netlify shows them.
4. Netlify provides the HTTPS certificate. Wait until it is issued, then check for the padlock.

The site also sends a `Strict-Transport-Security` header, set in `netlify.toml`. It asks browsers
to use HTTPS for one year.

## 5. What visitors do with their key

1. A visitor types their Nebius Token Factory key into a dialog.
2. The key stays in the page's memory only. The site does not save it to browser storage,
   cookies or the address.
3. The browser sends the key only to `https://api.tokenfactory.nebius.com`.
4. Closing the tab removes the key.

The project owner never sees a visitor's key. No server receives it.

## 6. Fonts

1. The site works with fallback fonts. Nothing breaks without font files.
2. Before you add Tiempos or Styrene files, read `site/fonts/README.md`.
3. Add a font file only if you hold a licence that allows web use.
4. Do not upload font files you are not licensed to publish.
5. Check that the repository is private before you commit any font file.

## 7. Updating the results

1. Run a new experiment, as described in `README.md`.
2. Refresh the data with check 2a.
3. Run checks 2b and 2c.
4. Redeploy with section 3.

The data files are cached for 5 minutes (`netlify.toml`). Visitors see new results within that time.

## 8. Known limits to tell visitors

- A batch run in the browser needs the tab to stay open.
- Saved runs and presets are kept in the visitor's own browser. They are not shared between browsers or devices,
  and the browser may clear them. Export a run to keep a copy.
- The API may rate-limit a visitor's key.
- The saved run is for condition `none` only (no system prompt).

## 9. Troubleshooting

| Problem | What to do |
|---|---|
| "The key was refused" | Check the key for typos. Check that the account has credit. |
| "Pages look plain" | The licensed fonts are missing. This is expected. See section 6. |
| "Data failed to load" | Run check 2a, then check 2b, then redeploy with section 3. |
| Security headers missing | `netlify.toml` controls the headers. Deploy with Option B, then check the response headers in the browser's developer tools. Do not add inline scripts or inline styles to any page. The headers block them. |
