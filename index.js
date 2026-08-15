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

const UA = "Mozilla/5.0 (compatible; property-research/1.0; +contact@yourdomain.com)";
const PATHS = ["", "/book", "/booking", "/reservations", "/reserve", "/rooms", "/accommodations"];

const CODE_RE = /https?:\/\/(?:[a-z0-9-]+\.)?cloudbeds\.com\/(?:[a-z]{2}\/)?reservation\/([A-Za-z0-9]{6})/i;
const MARKERS = [
  "cloudbeds.com/reservation",
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

  for (const path of PATHS) {
    const html = await fetchText(base + path);
    if (!html) continue;

    const m = html.match(CODE_RE);
    if (m) return { domain: base, cb_code: m[1], marker: "reservation-url", found_on: base + path };

    for (const marker of MARKERS) {
      if (html.includes(marker)) {
        const pc = html.match(/property[-_]code["'=:\s]+([A-Za-z0-9]{6})/i);
        return { domain: base, cb_code: pc ? pc[1] : "", marker, found_on: base + path };
      }
    }
  }
  return null;
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

  const body = {
    locationId: env.GHL_LOCATION_ID,
    name: p.name,
    companyName: p.name,
    email: p.email || undefined,
    phone: p.phone || undefined,
    address1: p.street || undefined,
    city: p.city || undefined,
    state: p.state || undefined,
    postalCode: p.zip || undefined,
    country: p.country || "US",
    website: p.website || undefined,
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

  let ok = 0, fail = 0;
  for (const p of results) {
    try {
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
  return { ok, fail, considered: results.length };
}

/* ------------------------------------------------------------------ routes */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (env.AUTH_TOKEN && req.headers.get("x-auth") !== env.AUTH_TOKEN) {
      return new Response("unauthorized", { status: 401 });
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

    if (url.pathname === "/sync" && req.method === "POST") {
      return Response.json(await syncToGHL(env, Number(url.searchParams.get("limit")) || 80));
    }

    return new Response("cb-worker: /seed /stats /export /sync /ghl/fields /needs-enrichment", { status: 200 });
  },

  /* Queue consumer — one message per domain. */
  async queue(batch, env) {
    for (const msg of batch.messages) {
      const { domain } = msg.body;
      try {
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
          if (p) {
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
              hit.domain
            ).run();
          }
        }
        msg.ack();
      } catch (e) {
        console.error("queue error", domain, String(e));
        msg.retry();
      }
    }
  },

  /* Nightly GHL push. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncToGHL(env, 200));
  },
};
