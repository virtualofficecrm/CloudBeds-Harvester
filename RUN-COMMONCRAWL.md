# Runbook: Common Crawl harvest

Instructions for Claude Code (or Chris) to deploy and run the Common Crawl
discovery source in this repo. Read `CLAUDE.md` first for project context.
Work through the steps in order. Stop and report at any step marked **STOP IF**.

## Hard rules

- **Do not re-enable `/sync` or the cron.** Both were disabled on 2026-08-16
  after an unexplained run pushed 69 contacts to GHL. Nothing in this runbook
  pushes to GHL. New prospects leave as a CSV that Chris imports by hand.
- **Do not raise `max_concurrency`** in `wrangler.toml` (keep it at 3).
- Never print secret values (`AUTH_TOKEN`, `GHL_TOKEN`) in the terminal output
  or in summaries. Read them into shell variables only.
- Do not delete or rewrite existing D1 data. The migration only adds tables.

## Setup

```bash
WORKER="https://cloudbeds-harvester.billowing-hall-c135.workers.dev"
# AUTH_TOKEN lives in .dev.vars (KEY=value lines). Load without echoing it:
export AUTH_TOKEN="$(grep -E '^AUTH_TOKEN=' .dev.vars | cut -d= -f2- | tr -d '"')"
[ -n "$AUTH_TOKEN" ] && echo "AUTH_TOKEN loaded" || echo "AUTH_TOKEN missing"
```

**STOP IF** the token is missing. Ask Chris for it. Also confirm the deployed
worker has it set: `npx wrangler secret list` should show `AUTH_TOKEN`.

## Step 1: Test locally

```bash
npm run test:cc
node test-detect.js   # existing detection test, optional (it fetches live sites)
```

**STOP IF** `test:cc` does not print `all tests passed`.

## Step 2: Commit before deploying

A lot of work is uncommitted (dashboard, sync lockout, GHL field IDs, this
feature). Commit it so the deploy matches a known version. Do not commit
`.dev.vars` or `node_modules` (both should already be in `.gitignore`; check).

```bash
git status --short
git add -A
git status --short   # confirm .dev.vars is NOT listed
git commit -m "Add Common Crawl discovery source, exclusions, CSV export; commit August dashboard and sync lockout"
git push
```

## Step 3: Migrate D1 and deploy

```bash
npm run db:migrate:cc
npx wrangler deploy
curl -s -H "x-auth: $AUTH_TOKEN" "$WORKER/cc/stats"   # expect {} on first run
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "x-auth: $AUTH_TOKEN" "$WORKER/sync"   # expect 403
```

**STOP IF** `/sync` returns anything other than 403.

## Step 4: Load the exclusion list

Everyone already contacted must be excluded so they are not emailed twice.
Chris provides `exclude.txt` in the repo root: one email, phone, website, or
6-character Cloudbeds code per line. It must include:

- Snowy Mountain Inn (paying client): its email, phone, and website
- The original 49 prospects (an export of GHL contacts tagged `cloudbeds`
  works; any of email, phone, or website per row is enough)

Also add every property already in D1 from the domain scanner:

```bash
curl -s -H "x-auth: $AUTH_TOKEN" "$WORKER/export" -o existing.csv
python3 - <<'PY'
import csv
rows = list(csv.DictReader(open("existing.csv")))
vals = set()
for r in rows:
    for k in ("cb_code", "email", "phone", "website"):
        if r.get(k): vals.add(r[k].strip())
open("exclude-d1.txt", "w").write("\n".join(sorted(vals)))
print(len(rows), "existing properties ->", len(vals), "exclusion values")
PY
cat exclude.txt exclude-d1.txt > exclude-all.txt
curl -s -X POST -H "x-auth: $AUTH_TOKEN" --data-binary @exclude-all.txt "$WORKER/exclude"
```

**STOP IF** `exclude.txt` does not exist or does not mention Snowy Mountain
Inn. Ask Chris for it. Do not continue without it.

Don't commit `exclude*.txt` or `existing.csv` (they contain contact data).
Add them to `.gitignore`.

## Step 5: Start the harvest

```bash
curl -s -X POST -H "x-auth: $AUTH_TOKEN" "$WORKER/cc/harvest?crawls=3"
```

Expect JSON like `{"crawls":[{"crawl":"CC-MAIN-...","pages":N},...],"pages_queued":N}`.

**STOP IF** `pages_queued` is 0 or the call errors. Run `npx wrangler tail`
in a second terminal, retry once, and report the log lines. The most likely
cause is the CDX query in `commoncrawl.js` (`queryUrl()`): the
`filter=~url:/reservation/` syntax or `matchType=domain` was never tested
against the live index.

## Step 6: Monitor

Check every few minutes:

```bash
curl -s -H "x-auth: $AUTH_TOKEN" "$WORKER/cc/stats"
```

Statuses: `pending` (queued for enrichment), `us`, `non-us`, `no-jsonld`
(booking page had no data), `known` (already in D1).

What normal looks like:

- Within about 10 minutes, `pending` starts climbing as index pages drain.
- Then `us` and `non-us` climb while `pending` falls. Expect most codes to be
  non-US. Enrichment runs at roughly 1 per 2 seconds, so a few thousand codes
  take a few hours. Leaving it overnight is fine; the queue keeps running
  after the terminal closes.

**STOP IF** after 15 minutes `/cc/stats` is still `{}`, or `no-jsonld` is the
largest bucket (suggests Cloudbeds is blocking or the page format changed).
Capture `npx wrangler tail` output and report.

The dashboard at `$WORKER/dashboard` shows overall property counts too.

## Step 7: Export for GHL

When `pending` is near zero:

```bash
curl -s -H "x-auth: $AUTH_TOKEN" "$WORKER/cc/export" -o cloudbeds_commoncrawl_us.csv
python3 - <<'PY'
import csv, collections
rows = list(csv.DictReader(open("cloudbeds_commoncrawl_us.csv")))
print("rows:", len(rows))
print("tiers:", collections.Counter(r["tier"] for r in rows))
print("24h desk (poor fit):", sum(r["has_24h_desk"] == "1" for r in rows))
print("no email:", sum(not r["email"] for r in rows))
print("top states:", collections.Counter(r["state"] for r in rows).most_common(10))
assert not any("snowy mountain" in r["company_name"].lower() for r in rows), "Snowy Mountain Inn leaked!"
PY
```

**STOP IF** the Snowy Mountain Inn assertion fails.

Report the summary to Chris. Don't import into GHL. Chris imports the CSV
himself into a new workflow (never by editing existing ones). Don't commit
the CSV.

## Step 8: Hand off owner lookups

Only after Chris has reviewed the CSV: `GET /needs-enrichment` lists confirmed
properties with no owner name for the Clay pass. Run Clay searches only on
confirmed properties (see Clay learnings in `CLAUDE.md`).

## Report back with

- `/cc/stats` final counts
- Step 7 summary (rows, tiers, states, no-email count)
- Anything that hit a STOP
