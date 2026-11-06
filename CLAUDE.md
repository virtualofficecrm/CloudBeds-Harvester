# CloudBeds Harvester

Finds independent hotels running **Cloudbeds PMS**, extracts their public
contact data, and syncs them to **GoHighLevel** as sales prospects.

## Why

We sell a voice AI agent (built on GHL + an MCP server against the Cloudbeds
API) that answers a property's phone after hours: checks live availability,
quotes real rates, books the reservation, sends the Cloudbeds payment link,
finalizes on payment, and transfers to a human on request.

The buyer is a **small independent property** — 8 to 60 rooms, owner-operated,
no 24-hour front desk. Motels, hostels, B&Bs, inns, cabins. Not chains: a
Marriott franchise runs brand-mandated software and has night staff.

The pitch that lands is not "capture missed calls." It's **"stop converting
your own direct bookings into OTA commissions."** A guest who can't reach you
at 9pm opens Booking.com and rebooks — often at the same property — and now
the owner pays 15-18% on a reservation they had already earned. Cloudbeds
sells its own booking engine on being commission-free, so these owners
already think this way.

## How detection works

Almost every Cloudbeds customer leaks the fingerprint on their own site,
because the "Book Now" button points at a Cloudbeds-hosted booking engine.

Fingerprints (see `MARKERS` and `CODE_RE` in `index.js`):

```
hotels.cloudbeds.com/reservation/{code}       # 6-char property code
hotels.cloudbeds.com/en/reservation/{code}
us1.cloudbeds.com / us2.cloudbeds.com         # regional shards
{customer}.cloudbeds.com/reservation/{code}   # custom subdomains
static1.cloudbeds.com/booking-engine/...      # Immersive Experience 2.0
<cb-immersive-experience> / <cb-book-now-button> / .cb-portal
myallocator                                   # Cloudbeds channel manager
hotels.cloudbeds.com/en/widget/load/{code}/…  # booking widget embed (WIDGET_RE)
https%3A%2F%2Fhotels.cloudbeds.com%2F…        # URL-encoded, via Google Sites
                                              # link wrapper google.com/url?q=
```

A naive `hotels.cloudbeds.com` match misses the shards and custom subdomains —
we found live examples of both (`uticaproperties.cloudbeds.com`, `us1.`).
The last two came from the live test run: roscoemotel.com (Google Sites,
percent-encoded link) and taosyellowstone.com (widget embed). The widget code
is the same property code — `enrich()` works on it directly. `detect()` also
retries `www.` when the apex fetches nothing: roscoemotel.com's bare domain
has broken TLS while `www.` serves fine.

Then the payoff: fetch `hotels.cloudbeds.com/en/reservation/{code}` and parse
the **schema.org LodgingBusiness JSON-LD**. It publishes name, telephone,
email, full address, geo, check-in/out times, every room type, amenities, and
an owner-written description. A complete enriched prospect record, public,
free, no vendor.

## Pipeline

```
POST /seed  ->  cb-scan queue  ->  consumer: detect -> enrich -> D1
                                          |
                                  cron 07:00 UTC -> GHL /contacts/upsert
```

## Endpoints

| Route | Purpose |
|---|---|
| `GET /dashboard` | Live HTML scan monitor — tiles, 12h activity chart, latest finds/checks, auto-refresh 5s. The HTML shell is served **without** auth (it contains no data); its JS calls `/dashboard/data` (gated) with the token you enter once, kept in localStorage |
| `POST /seed` | Newline/comma-separated domains into the queue |
| `GET /stats` | Counts: checked, found, us, synced, errors |
| `GET /export` | CSV of all US properties |
| `GET /needs-enrichment` | Confirmed properties with no owner yet — feed to Clay |
| `GET /ghl/fields` | List GHL custom field IDs (setup only) |
| `POST /sync?limit=N` | Force a GHL push |

All routes are gated by an `x-auth` header matching `AUTH_TOKEN`.
**If `AUTH_TOKEN` is unset the check short-circuits and everything is public.**

## Provisioned

- D1 `cloudbeds` — `9ec2d186-b334-47ec-8b8a-1ffef9ff6b60`, bound as `DB`
- Queues `cb-scan` (producer `SCAN_QUEUE` + consumer) and `cb-scan-dlq`
- `max_concurrency = 3` — deliberate, see Gotchas
- Cron **paused** 2026-08-16 (`crons = []`) — nothing auto-pushes to GHL;
  sync is manual (`POST /sync?limit=N`) until Chris says otherwise
- Deployed: `https://cloudbeds-harvester.billowing-hall-c135.workers.dev`

## Not done yet

1. ~~`AUTH_TOKEN`~~ — set 2026-08-16, routes are gated (verified: 401 without
   header, 200 with). Cloudflare can't read secrets back; if the value is
   lost, rotate from the project dir with
   `openssl rand -hex 24 | tee /dev/tty | npx wrangler secret put AUTH_TOKEN`.
   The current value is saved locally in `.dev.vars` (git-ignored) — that's
   the token the dashboard asks for.
2. `GHL_TOKEN` — unset. Use a GHL **Private Integration Token** scoped to
   `contacts.write` + `locations/customFields.readonly`. Not OAuth; that only
   matters if we distribute this as a Marketplace app.
3. ~~`GHL_LOCATION_ID`~~ — set 2026-08-16 (`BERHSQxYZiY2K2G7TJwC`), deployed.
4. `GHL_FIELD_*` vars — empty. Get IDs from `/ghl/fields` after the token works.
   Empty fields are skipped safely.
5. `properties` has **4 hand-inserted demo rows** (Snowy Mountain Inn, Hotel
   Wolf, Taos Inn, Kama Central Park). Delete before a real run.
6. `preview_urls` / `workers_dev` not set — both defaulted on, so every
   preview deploy gets a public URL. Set `preview_urls = false`.
7. GitHub -> Cloudflare auto-deploy is **not firing**. Both builds so far were
   manual. Just use `wrangler deploy` and ignore Workers Builds.

## First task: prove detection works — DONE 2026-08-16

`node test-detect.js` runs the real `detect()` + `enrich()` (named exports
from `index.js`) against 27 known Cloudbeds domains and 3 chain negatives.
The domain list lives in the test file — it doubles as a regression suite.

Results: **22/27 detected, 0/3 false positives, enrich 20/20** (the other
2 hits were marker-only, no code). All 5 misses are explained:

- kinshiplanding.com — left Cloudbeds for StayNTouch (`ibe.stayntouch.com`)
- abovethecloudshostel.com — left for Front Desk Express
- snowymountaininn.com — left; now runs its own cart (`/checkout/`)
- travelersmotelaz.com — still Cloudbeds (`RvGi9z` per Wayback) but 403s our
  research UA. We honor the block per the Gotchas rule.
- taosyellowstone.com — still Cloudbeds (`ti1FhQ`, enriches to Taos Inn) but
  the widget embed only appears on `/the-inn.html`, a page `PATHS` never
  fetches. Only fixable by following on-site nav links — not worth it yet.

So among still-on-Cloudbeds, reachable domains: 22/22.

**Path distribution: 21 of 22 hits on `/`, 1 on `/reserve`
(bigsurriverinn.com), zero on the other five paths.** Trimming `PATHS` to
`["", "/reserve"]` would cut a miss from 7 fetches to 2 — but n=22, and
these are sites that all link their booking engine from the homepage. Note
the worker doesn't store `found_on`, so the real seeding run won't grow this
sample unless a column is added. Decide before the first big seed.

The run also surfaced three detection gaps, all fixed — see the fingerprint
list above (encoded URLs, widget embeds, `www.` fallback). roscoemotel.com
was a miss on the first run and detects now.

## Then

1. Secrets + `wrangler deploy`
2. Build a domain universe: Google Places API (`type=lodging`, tiled by city)
   or OSM Overpass (`tourism=hotel|hostel|guest_house|motel`). Free and broad.
3. Seed a few hundred, watch `/stats` for the real hit rate
4. `/needs-enrichment` -> Clay for owner names. **Only ever enrich confirmed
   Cloudbeds properties** — that is where credits die otherwise.

## Schema notes

`room_type_count` is the number of room *types*, not units. Actual `room_count`
is regex-extracted from the owner's description and only present when they
state it outright ("the 15 room Snowy Mountain Inn"). Roughly 1 in 5. The
regex deliberately rejects years — "Since 1964" and "Built in 2016" must not
parse as room counts. There are unit tests worth keeping for this.

`owner_name`, `owner_title`, `owner_linkedin`, `owner_email`,
`company_linkedin`, `employee_count`, `entity_name`, `enriched_at` are all
**null by design**. The worker cannot get them. LinkedIn data comes from Clay
in a second pass; scraping LinkedIn from Workers would be blocked instantly
and violates their ToS.

## Qualification signals

Tiering lives in `tier()`. What actually predicts a good prospect:

- **Personal email domain** (gmail/aol/yahoo) — owner-operated, no IT layer,
  and the listed address *is* the decision maker. At 2-8 employees there is
  no reservations department for `reservations@` to route to.
- **No website**, or website points back at Cloudbeds — very low-tech.
- **Check-in 16:00 or later** — no daytime desk coverage.
- **`has_24h_desk = 1`** — a *segment*, not a disqualifier (decided
  2026-08-16). The amenity is self-reported and ambiguous: staffed night
  desk, 24h self-check-in kiosk, or a stale checkbox. These contacts get the
  staffing-agnostic "answers when a human can't get to the phone" template
  (`ghl-email-template-desk.html`) instead of the after-hours pitch, and
  they're sent last so early reply data comes from the strongest segment.
- Seasonal/resort towns: peak-season call volume, skeleton staff.

Real examples: Inn at Corolla is 42 rooms with 2 employees. Wrigley Hostel's
co-founder lives in Melbourne. Shoreham Inn's co-innkeeper lives in Cincinnati
while the inn is in Vermont. Above the Clouds Hostel's own booking page tells
guests to *call directly* for anything inside 48 hours.

## GHL outreach design

**Email only.** Cold SMS to these numbers is a TCPA problem — most are cell
numbers, and it applies regardless of B2B framing. A2P 10DLC also expects
documented opt-in and carriers filter cold SMS hard.

Template design (settled 2026-08-16): **one shell template in GHL, all
verbiage injected** — `ghl-email-template.html` is the frozen shell, all
copy lives in `outreach-copy.json`, and the workflow prompt is
`ghl-workflow-prompt.md`. Five injected slots per contact:

```
Subject:  {{contact.email_subject}}    <- fully rendered on our side
Preview:  {{contact.personal_hook}}

{{contact.email_greeting}}     <- "Hi Kevin," or fallback "Hi there,"
{{contact.personal_hook}}      <- unique per contact, from their own bio
{{contact.email_body_1}}       <- pitch paragraph, per-segment constant
{{contact.email_body_2}}       <- offer paragraph
{{contact.email_body_3}}       <- CTA line
(static signature + postal footer)
```

GHL is delivery only. Copy changes = edit outreach-copy.json + re-run the
field writer; the template and workflow are never edited. Segments (main vs
has-24h-desk) and follow-up messages are just different field values.
Follow-up flow: send -> wait 4d -> workflow webhooks the worker -> worker
rewrites all five slots to message 2 and swaps tag msg-1 -> msg-2 /
msg-2-ready -> workflow waits for that tag -> same template sends again.
Subject variant recorded as subj-1/2/3 tags, touch number as msg-N, so
reply rates are filterable by both. The containment rule: bodies are
per-segment constants reviewed once in the JSON; per-contact generated
prose stays confined to the hook (and subject name), reviewed as columns.
Never generate free-form full bodies per contact — you can't review 250 of
them, and you can't tell copy from personalization in the results.

Generate hooks in batch, eyeball them, then load into GHL. Move generation
into the sync step later, once the output is trusted.

**Division of labor (agreed 2026-08-16):** the email template itself is
built by hand inside GHL, with merge variables for contact fields and custom
fields. The code side never sends email — it only populates contact records,
custom fields (`personal_hook` etc.), and tags. Sending is triggered by a
tag inside a GHL workflow, so a send is armed by applying the tag after the
hook column has been reviewed. The GHL workflow gets built together when the
list is ready.

**Send window (Chris's rule, 2026-08-16):** Tuesday–Thursday, 10am–2pm in
the contact's local time — midweek late-morning is the cold-email reply
peak and it dodges the innkeeper rhythm (breakfast 7–9am, checkout ~10–11am,
check-in crunch 3–6pm). Timezone is set by **Chris's existing GHL
automation** from the state field on contact creation — the sync deliberately
does not write timezone (two writers would fight); it just guarantees
`state` is populated. D1 stores states as published (usually full names);
`usStateCode()` converts to two-letter codes at sync time because the
timezone automation keys on them.

**Positioning:** say "integrates with Cloudbeds" or "built for properties
running Cloudbeds." Never "partner," "authorized," or "certified" — we have
no relationship with Cloudbeds. Applying to the Cloudbeds Marketplace would
let us say "available in the Cloudbeds Marketplace" truthfully, which is
worth more than anything we could imply now.

## Gotchas

- **`max_concurrency = 3` is intentional.** We hit `hotels.cloudbeds.com`
  repeatedly from Cloudflare egress IPs. Raise it and we get rate-limited or
  blocked, and a blocked pipeline finds zero properties. It runs on cron.
- **GHL upsert honors the location's "Allow Duplicate Contact" setting.** If
  it matches on both email and phone and two contacts already match each
  separately, the API updates the first in the configured sequence and
  ignores the other. Check this before the first bulk sync or unrelated
  records get merged.
- The `checked` table is the dedupe layer — re-seeding is idempotent, so you
  can safely re-run `/seed` with an expanded list.
- Keep the User-Agent honest with a real contact address. We read public
  pages that properties publish deliberately for search engines — the same
  JSON-LD Google reads. Honor any block rather than routing around it.

## Common Crawl source (`commoncrawl.js`), added 2026-11-05

Second discovery path that skips domain guessing. Common Crawl's public CDX
index lists every `*.cloudbeds.com/.../reservation/{code}` URL it has crawled,
so we pull property codes in bulk and go straight to `enrich()`.

```
POST /cc/harvest?crawls=3 -> "cc-page" msgs (one per index page, ~3s apart)
  consumer cc-page        -> extract codes -> cc_codes (dedupe) -> "cc-code" msgs
  consumer cc-code        -> enrich() -> properties (source_domain='commoncrawl')
GET /cc/export            -> CSV of new US properties minus exclusions, for manual GHL import
```

| Route | Purpose |
|---|---|
| `POST /cc/harvest?crawls=N` | Queue the newest N crawls (1-12, default 3) |
| `GET /cc/stats` | cc_codes by status: pending, us, non-us, no-jsonld, known |
| `GET /cc/export` | GHL-ready CSV (state codes, first_name "there" when no owner) |
| `POST /cc/codes?source=&delay=` | Up to 100 codes per request, collected off-worker; pass back `next_delay` to keep one rate across requests |
| `POST /exclude` | Newline list of codes, emails, phones or websites never exported/synced |

- **Common Crawl was unusable on 2026-11-05.** From the worker, `collinfo.json`
  returned 521 on every attempt while the same URL returned 200 locally (cause
  unknown), and index queries often returned 504 from anywhere. Wayback Machine
  CDX worked as the source: fetch codes locally, load them via `/cc/codes`.
  Those rows still use `source_domain='commoncrawl'` and the `source-commoncrawl`
  tag; `cc_codes.crawl` holds the real source (`wayback`).
- `/sync` stays hard-disabled. Import the CSV by hand. If sync is ever
  re-enabled, it also skips exclusions and tags `source-commoncrawl`.
- Load existing outreach contacts and Snowy Mountain Inn into `/exclude`
  before exporting.
- Codes are worldwide; most will be non-US. Re-running harvest is idempotent.
- Rate: keep `max_concurrency = 3`. Common Crawl wants about 1 req/s.
- Tests: `npm run test:cc` (Node 22+, node:sqlite stands in for D1).
- Unverified against the live service: the CDX `filter=~url:/reservation/`
  syntax. If `/cc/stats` stays empty after pages drain, check that first.
