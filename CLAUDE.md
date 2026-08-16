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
```

A naive `hotels.cloudbeds.com` match misses the shards and custom subdomains —
we found live examples of both (`uticaproperties.cloudbeds.com`, `us1.`).

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
- Cron `0 7 * * *`
- Deployed: `https://cloudbeds-harvester.billowing-hall-c135.workers.dev`

## Not done yet

1. `AUTH_TOKEN` — unset. Everything is public until this exists. **Do first.**
2. `GHL_TOKEN` — unset. Use a GHL **Private Integration Token** scoped to
   `contacts.write` + `locations/customFields.readonly`. Not OAuth; that only
   matters if we distribute this as a Marketplace app.
3. `GHL_LOCATION_ID` — still the literal string `REPLACE_WITH_YOUR_LOCATION_ID`.
4. `GHL_FIELD_*` vars — empty. Get IDs from `/ghl/fields` after the token works.
   Empty fields are skipped safely.
5. `properties` has **4 hand-inserted demo rows** (Snowy Mountain Inn, Hotel
   Wolf, Taos Inn, Kama Central Park). Delete before a real run.
6. `preview_urls` / `workers_dev` not set — both defaulted on, so every
   preview deploy gets a public URL. Set `preview_urls = false`.
7. GitHub -> Cloudflare auto-deploy is **not firing**. Both builds so far were
   manual. Just use `wrangler deploy` and ignore Workers Builds.

## First task: prove detection works

**This has never been tested against a real site.** Everything so far was
built from search-engine results, and the worker has never fetched a hotel
domain.

Write a standalone local test importing `detect()` and `enrich()`:

- ~20 known Cloudbeds domains (below) — expect 100%
- `marriott.com`, `hilton.com`, `choicehotels.com` — expect zero
- Report: hit rate, false positives, **and which of the 7 `PATHS` actually
  produce hits**

That last one matters. A miss currently costs 7 sequential fetches. If hits
land almost entirely on `/` or `/book`, trimming `PATHS` more than halves
scan time across thousands of domains.

Known-good test domains:

```
roscoemotel.com          pinebrookmotel.com      shoremeadows.com
thegrahamandco.com       shorehaminn.com         wells-ogunquit.com
innatcorolla.com         oceanisleinn.com        rhetthouseinn.com
classeninn.com           fullmooninn.com         wrigleyhostel.com
coloradobearcreekcabins.com  kinshiplanding.com  11thavenuehostel.com
bigsurriverinn.com       innatmountshasta.com    nwportlandhostel.com
a-lodge.com              wolfhotel.com           snowymountaininn.com
taosyellowstone.com      thestevensmotel.com     abovethecloudshostel.com
olympicsuitesinn.com     travelersmotelaz.com    parkflorence.com
```

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
- **`has_24h_desk = 1`** — disqualifying. The after-hours pitch does not land.
- Seasonal/resort towns: peak-season call volume, skeleton staff.

Real examples: Inn at Corolla is 42 rooms with 2 employees. Wrigley Hostel's
co-founder lives in Melbourne. Shoreham Inn's co-innkeeper lives in Cincinnati
while the inn is in Vermont. Above the Clouds Hostel's own booking page tells
guests to *call directly* for anything inside 48 hours.

## GHL outreach design

**Email only.** Cold SMS to these numbers is a TCPA problem — most are cell
numbers, and it applies regardless of B2B framing. A2P 10DLC also expects
documented opt-in and carriers filter cold SMS hard.

Template design — **one static template, one generated field**:

```
Hi {{first_name}},

{{contact.custom_field.personal_hook}}

I build a voice assistant that connects directly to Cloudbeds...
```

The hook is one sentence generated from the property's own `description` or
`room_types`. Do *not* generate the whole email body into a custom field:
reviewing 250 full emails to catch a bad one is impractical, and you can
never tell whether the template or the personalization is what's working.
With this split you review a single spreadsheet column and can A/B the
static body independently.

Generate hooks in batch, eyeball them, then load into GHL. Move generation
into the sync step later, once the output is trusted.

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
