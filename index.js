/**
 * cb-worker — Cloudbeds property harvester on Cloudflare Workers.
 *
 * Flow:
 *   POST /seed        -> push domains into the queue
 *   queue consumer    -> detect Cloudbeds, enrich from booking page, write D1
 *   cron (nightly)    -> push new US properties into GoHighLevel
 *   GET  /stats       -> counts
 *   GET  /export      -> CSV of everything found
 *   GET  /ghl/fields  -> list your GHL custom field IDs (run once during setup)
 */

import { startHarvest, handlePage, handleCode } from "./commoncrawl.js";

const UA = "Mozilla/5.0 (compatible; property-research/1.0; +contact@yourdomain.com)";
const PATHS = ["", "/book", "/booking", "/reservations", "/reserve", "/rooms", "/accommodations"];

// Separators may be percent-encoded: Google Sites wraps outbound links as
// google.com/url?q=https%3A%2F%2Fhotels.cloudbeds.com%2Freservation%2F...
// (live example: roscoemotel.com).
const CODE_RE = /https?(?::\/\/|%3A%2F%2F)(?:[a-z0-9-]+\.)?cloudbeds\.com(?:\/|%2F)(?:[a-z]{2}(?:\/|%2F))?reservation(?:\/|%2F)([A-Za-z0-9]{6})/i;
// Booking widget embed, same property code:
// <script src="https://hotels.cloudbeds.com/en/widget/load/{code}/horiz">
// (live example: taosyellowstone.com).
const WIDGET_RE = /https?:\/\/(?:[a-z0-9-]+\.)?cloudbeds\.com\/(?:[a-z]{2}\/)?widget\/load\/([A-Za-z0-9]{6})/i;
const MARKERS = [
  "cloudbeds.com/reservation",
  "cloudbeds.com%2Freservation",
  "static1.cloudbeds.com",
  "cb-immersive-experience",
  "cb-book-now-button",
  "cb-portal",
  "myallocator",
];

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";

/* ---------------------------------------------------------------- helpers */

async function fetchText(url, ms = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      signal: ctl.signal,
      redirect: "follow",
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
    return r.ok ? await r.text() : "";
  } catch {
    return "";
  } finally {
    clearTimeout(t);
  }
}

function normalize(d) {
  d = String(d || "").trim().replace(/\/+$/, "");
  if (!d) return "";
  return d.startsWith("http") ? d : "https://" + d;
}

/* ------------------------------------------------------------- detection */

async function detect(domain) {
  const base = normalize(domain);
  if (!base) return null;

  const first = await scanPaths(base);
  if (first.hit) return first.hit;

  // Some apex domains are dead while www. serves fine (roscoemotel.com's
  // bare domain fails TLS). Only retry when nothing fetched at all, so
  // ordinary misses stay at one pass.
  if (!first.fetchedAny && !/^https?:\/\/www\./i.test(base)) {
    const second = await scanPaths(base.replace(/^(https?:\/\/)/i, "$1www."));
    if (second.hit) return second.hit;
  }
  return null;
}

async function scanPaths(base) {
  let fetchedAny = false;
  for (const path of PATHS) {
    const html = await fetchText(base + path);
    if (!html) continue;
    fetchedAny = true;

    let m = html.match(CODE_RE);
    if (m) return { fetchedAny, hit: { domain: base, cb_code: m[1], marker: "reservation-url", found_on: base + path } };

    m = html.match(WIDGET_RE);
    if (m) return { fetchedAny, hit: { domain: base, cb_code: m[1], marker: "widget-url", found_on: base + path } };

    for (const marker of MARKERS) {
      if (html.includes(marker)) {
        const pc = html.match(/property[-_]code["'=:\s]+([A-Za-z0-9]{6})/i);
        return { fetchedAny, hit: { domain: base, cb_code: pc ? pc[1] : "", marker, found_on: base + path } };
      }
    }
  }
  return { fetchedAny, hit: null };
}

/* ------------------------------------------------------------ enrichment */

function extractRoomCount(text) {
  if (!text) return null;
  // Owners often state it outright: "the 15 room Snowy Mountain Inn",
  // "30 room budget motel", "10 cabin units".
  const m = String(text).match(
    /\b(\d{1,3})[\s-]*(?:guest[\s-]*)?(?:room|unit|cabin|cottage|bungalow|villa|suite)s?\b/i
  );
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 2 && n <= 500 ? n : null;
}

function pickLang(v) {
  if (Array.isArray(v)) return v[0]?.["@value"] ?? String(v[0] ?? "");
  if (v && typeof v === "object") return v["@value"] ?? "";
  return v ?? "";
}

async function enrich(code) {
  const html = await fetchText(`https://hotels.cloudbeds.com/en/reservation/${code}`);
  if (!html) return null;

  const blocks = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) blocks.push(m[1]);

  for (const raw of blocks) {
    let d;
    try {
      d = JSON.parse(raw);
    } catch {
      continue;
    }
    if (Array.isArray(d)) d = d.find((x) => x["@type"] === "LodgingBusiness");
    if (!d || d["@type"] !== "LodgingBusiness") continue;

    const a = d.address || {};
    const rooms = (d.containsPlace || []).filter((r) => r["@type"] === "HotelRoom");
    const amen = (d.amenityFeature || []).map((x) => pickLang(x.name)).filter(Boolean);
    const desc = String(pickLang(d.description) || "").replace(/\s+/g, " ").trim();

    return {
      cb_code: code,
      description: desc.slice(0, 2000),
      amenities: amen.join(" | "),
      room_count: extractRoomCount(desc),
      name: d.name || "",
      phone: d.telephone || "",
      email: d.email || "",
      website: d.url || "",
      street: a.streetAddress || "",
      city: a.addressLocality || "",
      state: a.addressRegion || "",
      zip: a.postalCode || "",
      country: a.addressCountry || "",
      checkin: d.checkinTime || "",
      checkout: d.checkoutTime || "",
      room_types: rooms.map((r) => pickLang(r.name)).filter(Boolean).join(" | "),
      room_type_count: rooms.length,
      has_24h_desk: amen.some((x) => /24-hour front desk/i.test(String(x))) ? 1 : 0,
      lat: d.geo?.latitude ?? null,
      lng: d.geo?.longitude ?? null,
    };
  }
  return null;
}

// Named exports for local testing (test-detect.js). The worker itself only
// uses the default export below.
export { detect, enrich, extractRoomCount, PATHS, CODE_RE, WIDGET_RE };

/* ------------------------------------------------------------- storage */

async function saveProperty(env, p, sourceDomain) {
  await env.DB.prepare(
    `INSERT INTO properties
       (cb_code,name,phone,email,website,street,city,state,zip,country,
        checkin,checkout,room_types,room_type_count,has_24h_desk,lat,lng,
        description,amenities,room_count,source_domain,found_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
     ON CONFLICT(cb_code) DO UPDATE SET
       phone=excluded.phone, email=excluded.email, checkin=excluded.checkin,
       room_types=excluded.room_types, has_24h_desk=excluded.has_24h_desk,
       description=excluded.description, amenities=excluded.amenities,
       room_count=excluded.room_count`
  ).bind(
    p.cb_code, p.name, p.phone, p.email, p.website, p.street, p.city, p.state,
    p.zip, p.country, p.checkin, p.checkout, p.room_types, p.room_type_count,
    p.has_24h_desk, p.lat, p.lng, p.description, p.amenities, p.room_count,
    sourceDomain
  ).run();
}

/* Exclusions: existing clients and anyone already contacted.
   Matched on cb_code, email, phone (last 10 digits), or website host. */
function host(u) {
  try { return new URL(normalize(u)).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
}
const digits = (s) => String(s || "").replace(/\D/g, "").slice(-10);

async function isExcluded(env, p) {
  const keys = [
    p.cb_code && `code:${p.cb_code}`,
    p.email && `email:${p.email.toLowerCase()}`,
    digits(p.phone).length === 10 && `phone:${digits(p.phone)}`,
    host(p.website) && `host:${host(p.website)}`,
  ].filter(Boolean);
  if (!keys.length) return false;
  const r = await env.DB.prepare(
    `SELECT 1 FROM exclusions WHERE key IN (${keys.map(() => "?").join(",")}) LIMIT 1`
  ).bind(...keys).first();
  return !!r;
}

function exclusionKey(v) {
  v = String(v || "").trim();
  if (!v) return "";
  if (/^[A-Za-z0-9]{6}$/.test(v)) return `code:${v}`;
  if (v.includes("@")) return `email:${v.toLowerCase()}`;
  if (digits(v).length === 10 && !/[a-z]/i.test(v)) return `phone:${digits(v)}`;
  const h = host(v);
  return h ? `host:${h}` : "";
}

/* ----------------------------------------------------------------- tiering */

function tier(p) {
  if (p.has_24h_desk) return "C";
  const dom = (p.email || "").split("@")[1]?.toLowerCase() || "";
  const personal = ["gmail.com", "aol.com", "yahoo.com", "hotmail.com", "outlook.com", "mail.com"];
  let s = 0;
  if (personal.includes(dom)) s += 2;
  if (!p.website || p.website.includes("cloudbeds.com")) s += 2;
  if (/motel|inn|cabin|lodge|b&b|hostel/i.test(p.name)) s += 1;
  if (parseInt((p.checkin || "0").split(":")[0], 10) >= 16) s += 1;
  return s >= 3 ? "A" : "B";
}

/* --------------------------------------------------------------- GHL sync */

// GHL gets two-letter state codes (Chris's timezone automation keys on them).
// D1 keeps whatever the property published; this converts at sync time.
const STATE_CODES = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM",
  "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH",
  oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX",
  utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
  "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
  "district of columbia": "DC",
};

function usStateCode(state) {
  const s = String(state || "").trim();
  if (!s) return "";
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return STATE_CODES[s.toLowerCase()] || s;
}

async function ghlUpsert(env, p) {
  const cf = [];
  const map = {
    GHL_FIELD_CB_CODE: p.cb_code,
    GHL_FIELD_TIER: tier(p),
    GHL_FIELD_CHECKIN: p.checkin,
    GHL_FIELD_ROOM_TYPES: p.room_types,
    GHL_FIELD_ROOM_COUNT: p.room_count,
    GHL_FIELD_DESCRIPTION: p.description,
    GHL_FIELD_OWNER_NAME: p.owner_name,
    GHL_FIELD_OWNER_LINKEDIN: p.owner_linkedin,
    GHL_FIELD_BOOKING_URL: `https://hotels.cloudbeds.com/reservation/${p.cb_code}`,
  };
  for (const [k, v] of Object.entries(map)) {
    if (env[k] && v) cf.push({ id: env[k], value: String(v) });
  }

  const tags = ["cloudbeds", `tier-${tier(p).toLowerCase()}`];
  if (p.has_24h_desk) tags.push("has-24h-desk");
  if (/gmail|aol|yahoo|hotmail/i.test(p.email || "")) tags.push("owner-operated");
  if (p.source_domain === "commoncrawl") tags.push("source-commoncrawl");

  const body = {
    locationId: env.GHL_LOCATION_ID,
    // Personal name only — the business name must never be split into
    // first/last. Empty until the Clay pass fills owner_name.
    name: p.owner_name || undefined,
    companyName: p.name,
    email: p.email || undefined,
    phone: p.phone || undefined,
    address1: p.street || undefined,
    city: p.city || undefined,
    state: usStateCode(p.state) || undefined,
    postalCode: p.zip || undefined,
    country: p.country || "US",
    website: p.website || undefined,
    // timezone deliberately NOT set here — Chris's GHL automation sets it
    // from the state field on contact creation. Sync guarantees state.
    source: "Cloudbeds harvester",
    tags,
    customFields: cf,
  };

  const r = await fetch(`${GHL_BASE}/contacts/upsert`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GHL_TOKEN}`,
      Version: GHL_VERSION,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) throw new Error(`GHL ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function syncToGHL(env, limit = 80) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM properties
      WHERE country = 'US' AND synced_at IS NULL AND name != ''
      ORDER BY found_at ASC LIMIT ?`
  ).bind(limit).all();

  let ok = 0, fail = 0, skipped = 0;
  for (const p of results) {
    try {
      if (await isExcluded(env, p)) {
        await env.DB.prepare(`UPDATE properties SET synced_at = datetime('now'), sync_error = 'excluded' WHERE cb_code = ?`)
          .bind(p.cb_code).run();
        skipped++;
        continue;
      }
      await ghlUpsert(env, p);
      await env.DB.prepare(`UPDATE properties SET synced_at = datetime('now') WHERE cb_code = ?`)
        .bind(p.cb_code).run();
      ok++;
    } catch (e) {
      await env.DB.prepare(`UPDATE properties SET sync_error = ? WHERE cb_code = ?`)
        .bind(String(e).slice(0, 300), p.cb_code).run();
      fail++;
    }
    // GHL throttles per location — stay well under.
    await new Promise((r) => setTimeout(r, 250));
  }
  return { ok, fail, skipped, considered: results.length };
}

/* ------------------------------------------------------------------ routes */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // The dashboard shell is static HTML with no data in it — safe to serve
    // unauthenticated. Its JS calls /dashboard/data with the x-auth header.
    if (url.pathname === "/dashboard") {
      return new Response(DASH_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (env.AUTH_TOKEN && req.headers.get("x-auth") !== env.AUTH_TOKEN) {
      return new Response("unauthorized", { status: 401 });
    }

    if (url.pathname === "/dashboard/data") {
      const [tot, prop, recent, timeline, finds, checks, tierRows] = await env.DB.batch([
        env.DB.prepare(`SELECT COUNT(*) n, COALESCE(SUM(is_cloudbeds),0) hits FROM checked`),
        env.DB.prepare(`SELECT COUNT(*) n,
            COALESCE(SUM(country='US'),0) us,
            COALESCE(SUM(synced_at IS NOT NULL),0) synced,
            COALESCE(SUM(sync_error IS NOT NULL),0) errors
          FROM properties`),
        env.DB.prepare(`SELECT COUNT(*) n FROM checked WHERE checked_at >= datetime('now','-10 minutes')`),
        env.DB.prepare(`SELECT substr(checked_at,1,15)||'0' t, COUNT(*) checked, COALESCE(SUM(is_cloudbeds),0) hits
          FROM checked WHERE checked_at >= datetime('now','-12 hours')
          GROUP BY t ORDER BY t`),
        env.DB.prepare(`SELECT found_at, name, city, state, country, cb_code, email, source_domain
          FROM properties ORDER BY found_at DESC LIMIT 15`),
        env.DB.prepare(`SELECT domain, is_cloudbeds, checked_at FROM checked ORDER BY checked_at DESC LIMIT 30`),
        env.DB.prepare(`SELECT name, email, website, checkin, has_24h_desk FROM properties WHERE country='US'`),
      ]);
      const tiers = { A: 0, B: 0, C: 0 };
      for (const p of tierRows.results) tiers[tier(p)]++;
      const t = tot.results[0], p = prop.results[0];
      return Response.json({
        checked: t.n,
        cb_found: t.hits,
        properties: p.n,
        us: p.us,
        synced: p.synced,
        errors: p.errors,
        rate_per_min: (recent.results[0].n || 0) / 10,
        timeline: timeline.results,
        tiers,
        recent_finds: finds.results,
        recent_checks: checks.results,
      });
    }

    if (url.pathname === "/seed" && req.method === "POST") {
      const text = await req.text();
      const domains = [...new Set(
        text.split(/[\n,]/).map((d) => d.trim()).filter(Boolean)
      )];
      for (let i = 0; i < domains.length; i += 100) {
        await env.SCAN_QUEUE.sendBatch(
          domains.slice(i, i + 100).map((d) => ({ body: { domain: d } }))
        );
      }
      return Response.json({ queued: domains.length });
    }

    if (url.pathname === "/stats") {
      const q = async (sql) => (await env.DB.prepare(sql).first())?.n ?? 0;
      return Response.json({
        checked: await q(`SELECT COUNT(*) n FROM checked`),
        found: await q(`SELECT COUNT(*) n FROM properties`),
        us: await q(`SELECT COUNT(*) n FROM properties WHERE country='US'`),
        synced: await q(`SELECT COUNT(*) n FROM properties WHERE synced_at IS NOT NULL`),
        errors: await q(`SELECT COUNT(*) n FROM properties WHERE sync_error IS NOT NULL`),
      });
    }

    if (url.pathname === "/export") {
      const { results } = await env.DB.prepare(
        `SELECT * FROM properties WHERE country='US' ORDER BY state, city`
      ).all();
      if (!results.length) return new Response("no rows", { status: 404 });
      const cols = Object.keys(results[0]);
      const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const csv = [cols.join(","), ...results.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
      return new Response(csv, {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": 'attachment; filename="cloudbeds_us.csv"',
        },
      });
    }

    if (url.pathname === "/ghl/fields") {
      const r = await fetch(
        `${GHL_BASE}/locations/${env.GHL_LOCATION_ID}/customFields?model=contact`,
        { headers: { Authorization: `Bearer ${env.GHL_TOKEN}`, Version: GHL_VERSION } }
      );
      return new Response(await r.text(), {
        status: r.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/needs-enrichment") {
      // Confirmed Cloudbeds properties with no owner attached yet.
      // Feed this list to Clay - never enrich an unverified domain.
      const { results } = await env.DB.prepare(
        `SELECT cb_code, name, website, city, state FROM properties
          WHERE country='US' AND owner_name IS NULL AND website != ''
          ORDER BY found_at ASC`
      ).all();
      return Response.json({ count: results.length, properties: results });
    }

    if (url.pathname === "/cc/harvest" && req.method === "POST") {
      const n = Math.min(Math.max(Number(url.searchParams.get("crawls")) || 3, 1), 12);
      return Response.json(await startHarvest(env, n));
    }

    if (url.pathname === "/cc/stats") {
      const { results } = await env.DB.prepare(
        `SELECT COALESCE(status,'pending') status, COUNT(*) n FROM cc_codes GROUP BY 1`
      ).all();
      return Response.json(Object.fromEntries(results.map((r) => [r.status, r.n])));
    }

    if (url.pathname === "/exclude" && req.method === "POST") {
      // Body: newline/comma list of cb_codes, emails, phones, or websites.
      const keys = [...new Set((await req.text()).split(/[\n,]/).map(exclusionKey).filter(Boolean))];
      for (const k of keys) {
        await env.DB.prepare(`INSERT OR IGNORE INTO exclusions (key, added_at) VALUES (?, datetime('now'))`)
          .bind(k).run();
      }
      return Response.json({ added: keys.length });
    }

    if (url.pathname === "/cc/export") {
      // US properties found via Common Crawl, minus exclusions, as a CSV for
      // manual GHL import (sync stays disabled). Same state codes as sync.
      const { results } = await env.DB.prepare(
        `SELECT * FROM properties WHERE country='US' AND source_domain='commoncrawl'
          ORDER BY state, city`
      ).all();
      const rows = [];
      for (const p of results) {
        if (await isExcluded(env, p)) continue;
        rows.push({
          company_name: p.name, first_name: p.owner_name ? p.owner_name.split(" ")[0] : "there",
          email: p.email, phone: p.phone, website: p.website, address1: p.street,
          city: p.city, state: usStateCode(p.state), postal_code: p.zip, country: "US",
          tier: tier(p), has_24h_desk: p.has_24h_desk, room_count: p.room_count,
          room_types: p.room_types, checkin: p.checkin, cb_code: p.cb_code,
          booking_url: `https://hotels.cloudbeds.com/reservation/${p.cb_code}`,
          description: p.description, tags: "cloudbeds,source-commoncrawl",
        });
      }
      if (!rows.length) return new Response("no rows", { status: 404 });
      const cols = Object.keys(rows[0]);
      const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
      return new Response(csv, {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": 'attachment; filename="cloudbeds_commoncrawl_us.csv"',
        },
      });
    }

    if (url.pathname === "/sync" && req.method === "POST") {
      // Hard-disabled 2026-08-16 after an unexplained sync run pushed 69
      // contacts. No GHL pushes of any kind until Chris re-enables this line
      // deliberately.
      return new Response("sync disabled", { status: 403 });
      // return Response.json(await syncToGHL(env, Number(url.searchParams.get("limit")) || 80));
    }

    return new Response("cb-worker: /dashboard /seed /stats /export /sync /ghl/fields /needs-enrichment /cc/harvest /cc/stats /cc/export /exclude", { status: 200 });
  },

  /* Queue consumer. Message types:
       { domain }                 -> domain scan
       { type: "cc-page", ... }   -> Common Crawl index page
       { type: "cc-code", ... }   -> enrich one property code */
  async queue(batch, env) {
    for (const msg of batch.messages) {
      const body = msg.body || {};
      try {
        if (body.type === "cc-page") { await handlePage(env, body); msg.ack(); continue; }
        if (body.type === "cc-code") { await handleCode(env, body, enrich, saveProperty); msg.ack(); continue; }

        const { domain } = body;
        const already = await env.DB.prepare(`SELECT 1 FROM checked WHERE domain = ?`)
          .bind(normalize(domain)).first();
        if (already) { msg.ack(); continue; }

        const hit = await detect(domain);

        await env.DB.prepare(
          `INSERT OR REPLACE INTO checked (domain, is_cloudbeds, checked_at)
           VALUES (?, ?, datetime('now'))`
        ).bind(normalize(domain), hit ? 1 : 0).run();

        if (hit?.cb_code) {
          const p = await enrich(hit.cb_code);
          if (p) await saveProperty(env, p, hit.domain);
        }
        msg.ack();
      } catch (e) {
        console.error("queue error", JSON.stringify(body), String(e));
        // Back off; Common Crawl returns 503 when busy.
        msg.retry({ delaySeconds: body.type === "cc-page" ? 120 : 30 });
      }
    }
  },

  /* Nightly GHL push. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncToGHL(env, 200));
  },
};

/* --------------------------------------------------------------- dashboard */
// Self-contained page: no external assets, no data baked in. Client JS is
// plain-string concatenation only — no backticks or ${} inside this literal.

const DASH_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cloudbeds Harvester</title>
<style>
:root{
  color-scheme:light;
  --page:#f9f9f7; --surface:#fcfcfb; --ink:#0b0b0b; --sec:#52514e;
  --muted:#898781; --grid:#e1e0d9; --baseline:#c3c2b7;
  --border:rgba(11,11,11,0.10); --s1:#2a78d6; --neutral:#e1e0d9;
  --critical:#d03b3b;
}
@media (prefers-color-scheme: dark){
  :root{
    color-scheme:dark;
    --page:#0d0d0d; --surface:#1a1a19; --ink:#ffffff; --sec:#c3c2b7;
    --muted:#898781; --grid:#2c2c2a; --baseline:#383835;
    --border:rgba(255,255,255,0.10); --s1:#3987e5; --neutral:#383835;
    --critical:#d03b3b;
  }
}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--ink);
  font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1060px;margin:0 auto;padding:20px 16px 48px}
header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}
h1{font-size:16px;font-weight:600;margin:0}
#updated{color:var(--muted);font-size:12px}
#authbar{display:none;gap:8px;margin:12px 0;align-items:center}
#authbar input{flex:1;max-width:340px;padding:7px 10px;border:1px solid var(--border);
  border-radius:8px;background:var(--surface);color:var(--ink);font:inherit}
#authbar button{padding:7px 14px;border:1px solid var(--border);border-radius:8px;
  background:var(--surface);color:var(--ink);font:inherit;cursor:pointer}
#authbar .msg{color:var(--critical);font-size:12px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:10px;margin:14px 0 4px}
.tile{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px 14px}
.tile-value{font-size:24px;font-weight:600;line-height:1.2}
.tile-value.err{color:var(--critical)}
.tile-label{color:var(--muted);font-size:12px;margin-top:2px}
#tiers{color:var(--sec);font-size:12px;margin:2px 2px 10px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin:12px 0}
.card-head{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:10px}
.card h2{margin:0;font-size:13px;font-weight:600;color:var(--sec)}
.legend{display:flex;gap:14px;font-size:12px;color:var(--sec);align-items:center}
.dot{width:8px;height:8px;border-radius:2px;display:inline-block;margin-right:6px;vertical-align:baseline}
.dot.hit{background:var(--s1)}
.dot.miss{background:var(--neutral);border:1px solid var(--baseline)}
#ymax{color:var(--muted);font-size:11px}
#chart{display:flex;align-items:flex-end;gap:2px;height:160px;border-bottom:1px solid var(--baseline);padding-top:6px}
.col{flex:1;display:flex;flex-direction:column;justify-content:flex-end;gap:2px;min-width:2px;height:100%}
.seg{width:100%}
.seg.hit{background:var(--s1)}
.seg.miss{background:var(--neutral)}
.seg.zero{background:var(--grid);height:1px}
.seg.top{border-radius:4px 4px 0 0}
#xlabels{display:flex;justify-content:space-between;color:var(--muted);font-size:11px;margin-top:4px}
.empty{color:var(--muted);font-size:13px;align-self:center;margin:0 auto}
.grid2{display:grid;grid-template-columns:3fr 2fr;gap:12px;align-items:start}
@media (max-width:820px){.grid2{grid-template-columns:1fr}}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th{color:var(--muted);text-align:left;font-weight:500;font-size:12px;padding:6px 8px;border-bottom:1px solid var(--grid);white-space:nowrap}
td{padding:6px 8px;border-bottom:1px solid var(--grid);font-size:13px;white-space:nowrap}
td.name{white-space:normal;min-width:140px}
.checkrow{display:flex;justify-content:space-between;gap:10px;padding:5px 2px;border-bottom:1px solid var(--grid);font-size:13px}
.checkrow .when{color:var(--muted);font-size:12px;flex-shrink:0}
.checkrow .d{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#tooltip{position:fixed;display:none;background:var(--ink);color:var(--page);padding:6px 9px;
  border-radius:6px;font-size:12px;pointer-events:none;z-index:10;max-width:260px}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Cloudbeds Harvester</h1>
    <span id="updated"></span>
  </header>

  <div id="authbar">
    <input id="tok" type="password" placeholder="x-auth token" autocomplete="off">
    <button id="savetok" type="button">Connect</button>
    <span class="msg">Auth required</span>
  </div>

  <div class="tiles">
    <div class="tile"><div class="tile-value" id="t-checked">&ndash;</div><div class="tile-label">domains checked</div></div>
    <div class="tile"><div class="tile-value" id="t-found">&ndash;</div><div class="tile-label">Cloudbeds found</div></div>
    <div class="tile"><div class="tile-value" id="t-rate">&ndash;</div><div class="tile-label">hit rate</div></div>
    <div class="tile"><div class="tile-value" id="t-us">&ndash;</div><div class="tile-label">US properties</div></div>
    <div class="tile"><div class="tile-value" id="t-speed">&ndash;</div><div class="tile-label">scan rate (10-min avg)</div></div>
    <div class="tile"><div class="tile-value" id="t-synced">&ndash;</div><div class="tile-label">synced to GHL</div></div>
    <div class="tile"><div class="tile-value" id="t-err">&ndash;</div><div class="tile-label">sync errors</div></div>
  </div>
  <div id="tiers"></div>

  <div class="card">
    <div class="card-head">
      <h2>Scan activity &mdash; last 12 hours, 10-minute buckets (UTC)</h2>
      <div class="legend">
        <span><span class="dot hit"></span>Cloudbeds hit</span>
        <span><span class="dot miss"></span>no match</span>
        <span id="ymax"></span>
      </div>
    </div>
    <div id="chart"></div>
    <div id="xlabels"></div>
  </div>

  <div class="grid2">
    <div class="card">
      <div class="card-head"><h2>Latest properties found</h2></div>
      <div class="scroll">
        <table>
          <thead><tr><th>When</th><th>Property</th><th>Location</th><th>Code</th><th>Email</th><th>Source domain</th></tr></thead>
          <tbody id="finds"></tbody>
        </table>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Latest checks</h2></div>
      <div id="checks"></div>
    </div>
  </div>
</div>
<div id="tooltip"></div>

<script>
var TK = "cb_auth";
function $(i){ return document.getElementById(i); }
function el(t,c,x){ var e=document.createElement(t); if(c)e.className=c; if(x!=null)e.textContent=x; return e; }
function fmt(n){ return (n==null) ? "0" : Number(n).toLocaleString(); }
function pd(s){ return new Date(s.replace(" ","T")+"Z"); }
function ago(s){
  if(!s) return "";
  var v=(Date.now()-pd(s).getTime())/1000; if(v<0)v=0;
  if(v<90) return Math.round(v)+"s ago";
  if(v<5400) return Math.round(v/60)+"m ago";
  if(v<129600) return Math.round(v/3600)+"h ago";
  return Math.round(v/86400)+"d ago";
}
var lastOk=0;
setInterval(function(){
  if(!lastOk) return;
  $("updated").textContent="updated "+Math.round((Date.now()-lastOk)/1000)+"s ago";
},1000);

function hover(elm,text){
  elm.onmousemove=function(ev){
    var tp=$("tooltip");
    tp.style.display="block"; tp.textContent=text;
    tp.style.left=Math.min(ev.clientX+12,window.innerWidth-240)+"px";
    tp.style.top=(ev.clientY+14)+"px";
  };
  elm.onmouseleave=function(){ $("tooltip").style.display="none"; };
}

function load(){
  var h={}; var tok=localStorage.getItem(TK); if(tok) h["x-auth"]=tok;
  fetch("/dashboard/data",{headers:h}).then(function(r){
    if(r.status===401){ $("authbar").style.display="flex"; throw new Error("auth"); }
    if(!r.ok) throw new Error("http "+r.status);
    $("authbar").style.display="none";
    return r.json();
  }).then(function(d){ lastOk=Date.now(); render(d); }).catch(function(e){});
}
$("savetok").onclick=function(){ localStorage.setItem(TK,$("tok").value.trim()); load(); };
$("tok").addEventListener("keydown",function(ev){ if(ev.key==="Enter") $("savetok").onclick(); });

function render(d){
  $("t-checked").textContent=fmt(d.checked);
  $("t-found").textContent=fmt(d.cb_found);
  $("t-rate").textContent=(d.checked ? (100*d.cb_found/d.checked).toFixed(1) : "0")+"%";
  $("t-us").textContent=fmt(d.us);
  $("t-speed").textContent=(d.rate_per_min||0).toFixed(1)+"/min";
  $("t-synced").textContent=fmt(d.synced);
  var errEl=$("t-err");
  errEl.textContent=d.errors>0 ? ("\\u26A0 "+fmt(d.errors)) : "0";
  errEl.className="tile-value"+(d.errors>0?" err":"");
  $("tiers").textContent="US tier counts \\u2014 A: "+fmt(d.tiers.A)+" \\u00B7 B: "+fmt(d.tiers.B)+" \\u00B7 C (24h desk): "+fmt(d.tiers.C);
  renderChart(d.timeline||[]);
  renderFinds(d.recent_finds||[]);
  renderChecks(d.recent_checks||[]);
}

function fillGaps(tl){
  if(!tl.length) return tl;
  var byT={}, i;
  for(i=0;i<tl.length;i++) byT[tl[i].t]=tl[i];
  function key(ms){
    var dt=new Date(ms), p=function(n){ return (n<10?"0":"")+n; };
    return dt.getUTCFullYear()+"-"+p(dt.getUTCMonth()+1)+"-"+p(dt.getUTCDate())+" "+p(dt.getUTCHours())+":"+p(dt.getUTCMinutes());
  }
  var start=pd(tl[0].t).getTime(), end=pd(tl[tl.length-1].t).getTime();
  if((end-start)/600000<11) start=end-11*600000;
  var out=[], cur=start, guard=0;
  while(cur<=end && guard++<200){
    out.push(byT[key(cur)]||{t:key(cur),checked:0,hits:0});
    cur+=600000;
  }
  return out;
}

function renderChart(raw){
  var tl=fillGaps(raw);
  var box=$("chart"), lab=$("xlabels");
  box.innerHTML=""; lab.innerHTML="";
  if(!tl.length){
    box.appendChild(el("div","empty","No scan activity in the last 12 hours \\u2014 POST /seed to start."));
    $("ymax").textContent="";
    return;
  }
  var max=1,i;
  for(i=0;i<tl.length;i++) if(tl[i].checked>max) max=tl[i].checked;
  $("ymax").textContent="peak "+fmt(max)+" / 10 min";
  var H=150;
  for(i=0;i<tl.length;i++){
    var b=tl[i], miss=b.checked-b.hits;
    var col=el("div","col");
    var hh=Math.round(H*b.hits/max), mh=Math.round(H*miss/max);
    if(b.hits>0 && hh<3) hh=3;
    if(miss>0 && mh<3) mh=3;
    if(mh>0){ var m=el("div","seg miss top"); m.style.height=mh+"px"; col.appendChild(m); }
    if(hh>0){ var g=el("div","seg hit"+(mh>0?"":" top")); g.style.height=hh+"px"; col.appendChild(g); }
    if(!col.childNodes.length) col.appendChild(el("div","seg zero"));
    var pct=b.checked ? (100*b.hits/b.checked).toFixed(1) : "0";
    hover(col, b.t.slice(11,16)+" UTC \\u00B7 "+fmt(b.checked)+" checked \\u00B7 "+fmt(b.hits)+" hits ("+pct+"%)");
    box.appendChild(col);
  }
  lab.appendChild(el("span","",tl[0].t.slice(11,16)));
  if(tl.length>2) lab.appendChild(el("span","",tl[Math.floor(tl.length/2)].t.slice(11,16)));
  lab.appendChild(el("span","",tl[tl.length-1].t.slice(11,16)));
}

function renderFinds(rows){
  var tb=$("finds"); tb.innerHTML="";
  if(!rows.length){
    var tr=el("tr"), td=el("td","empty","Nothing found yet.");
    td.colSpan=6; tr.appendChild(td); tb.appendChild(tr); return;
  }
  rows.forEach(function(r){
    var tr=el("tr");
    tr.appendChild(el("td","",ago(r.found_at)));
    tr.appendChild(el("td","name",r.name||"(no name)"));
    var loc=(r.city||"")+((r.city&&r.state)?", ":"")+(r.state||"");
    if(r.country && r.country!=="US") loc=loc+(loc?" \\u00B7 ":"")+r.country;
    tr.appendChild(el("td","",loc||"\\u2014"));
    tr.appendChild(el("td","",r.cb_code||"\\u2014"));
    tr.appendChild(el("td","",r.email?"\\u2713":"\\u2014"));
    tr.appendChild(el("td","",(r.source_domain||"").replace(/^https?:\\/\\//,"")));
    tb.appendChild(tr);
  });
}

function renderChecks(rows){
  var box=$("checks"); box.innerHTML="";
  if(!rows.length){ box.appendChild(el("div","empty","No checks yet.")); return; }
  rows.forEach(function(r){
    var row=el("div","checkrow");
    var left=el("span","d");
    var dot=el("span","dot "+(r.is_cloudbeds?"hit":"miss"));
    left.appendChild(dot);
    left.appendChild(document.createTextNode((r.domain||"").replace(/^https?:\\/\\//,"")+(r.is_cloudbeds?"  \\u2713":"")));
    row.appendChild(left);
    row.appendChild(el("span","when",ago(r.checked_at)));
    box.appendChild(row);
  });
}

load();
setInterval(function(){ if(!document.hidden) load(); },5000);
document.addEventListener("visibilitychange",function(){ if(!document.hidden) load(); });
</script>
</body>
</html>`;
