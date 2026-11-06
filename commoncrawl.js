/**
 * Common Crawl source: pull Cloudbeds property codes in bulk.
 *
 * Every Cloudbeds property has a public booking page at
 *   https://hotels.cloudbeds.com/reservation/{6-char code}
 * (plus us1./us2. shards and custom subdomains). Common Crawl's public CDX
 * index lists every one of those URLs it has crawled, so we can collect
 * codes directly instead of guessing hotel domains and probing 7 paths each.
 *
 * Flow:
 *   POST /cc/harvest?crawls=3   -> one "cc-page" queue message per index page
 *   consumer "cc-page"          -> fetch page, extract codes, insert cc_codes,
 *                                  enqueue one "cc-code" message per NEW code
 *   consumer "cc-code"          -> enrich() from the booking page, write properties
 *
 * Common Crawl asks clients to stay around 1 request/second, so pages are
 * spread out with delaySeconds and every page fetch sleeps afterwards.
 */

const CC_BASE = "https://index.commoncrawl.org";
const CC_UA = "property-research/1.0 (+https://vofficeai.com)";

// Matches the property code in any Cloudbeds booking-engine URL.
export const CC_CODE_RE =
  /^https?:\/\/(?:[a-z0-9-]+\.)?cloudbeds\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?reservation\/([A-Za-z0-9]{6})(?:[\/?#]|$)/i;

const ENRICH_SPACING_S = 2;      // about one booking-page fetch per 2 seconds
const MAX_QUEUE_DELAY_S = 43200; // Queues caps delaySeconds at 12h
export const MAX_CODES_PER_UPLOAD = 100; // keeps one request under the subrequest limit

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ccFetch(url) {
  const r = await fetch(url, { headers: { "User-Agent": CC_UA } });
  if (r.status === 404) return ""; // no captures in this crawl for the query
  if (!r.ok) throw new Error(`commoncrawl ${r.status} for ${url}`);
  return r.text();
}

/** Newest N crawl IDs, e.g. ["CC-MAIN-2026-40", ...]. */
export async function latestCrawls(n = 3) {
  const list = JSON.parse(await ccFetch(`${CC_BASE}/collinfo.json`));
  return list.slice(0, n).map((c) => c.id);
}

function queryUrl(crawl, extra = "") {
  const q = new URLSearchParams({
    url: "cloudbeds.com",
    matchType: "domain",        // includes hotels., us1., us2., custom subdomains
    output: "json",
    fl: "url",
    filter: "~url:/reservation/", // "contains" filter, keeps only booking pages
  });
  return `${CC_BASE}/${crawl}-index?${q}${extra}`;
}

/** How many index pages a crawl has for our query. */
export async function pageCount(crawl) {
  const txt = await ccFetch(queryUrl(crawl, "&showNumPages=true"));
  if (!txt) return 0;
  const j = JSON.parse(txt);
  return Number(j.pages ?? j) || 0;
}

/** Pure: pull unique codes out of a CDX json-lines response. */
export function extractCodes(ndjson) {
  const codes = new Set();
  for (const line of String(ndjson).split("\n")) {
    if (!line.trim()) continue;
    let url;
    try {
      url = JSON.parse(line).url;
    } catch {
      continue;
    }
    const m = url && url.match(CC_CODE_RE);
    if (m) codes.add(m[1]);
  }
  return [...codes];
}

/* ------------------------------------------------------- route + consumers */

/** POST /cc/harvest — fan out index pages for the newest N crawls. */
export async function startHarvest(env, nCrawls = 3) {
  const crawls = await latestCrawls(nCrawls);
  const plan = [];
  let delay = 0;
  for (const crawl of crawls) {
    const pages = await pageCount(crawl);
    await sleep(1100);
    plan.push({ crawl, pages });
    const msgs = [];
    for (let page = 0; page < pages; page++) {
      // ~3s apart; Queues caps delaySeconds at 12h, far above what we need.
      msgs.push({ body: { type: "cc-page", crawl, page }, delaySeconds: Math.min(delay, 43200) });
      delay += 3;
    }
    for (let i = 0; i < msgs.length; i += 100) {
      await env.SCAN_QUEUE.sendBatch(msgs.slice(i, i + 100));
    }
  }
  return { crawls: plan, pages_queued: plan.reduce((s, p) => s + p.pages, 0) };
}

/** Consumer for one index page. Returns number of NEW codes enqueued. */
export async function handlePage(env, { crawl, page }) {
  const txt = await ccFetch(queryUrl(crawl, `&page=${page}`));
  await sleep(1100);
  const codes = extractCodes(txt);
  if (!codes.length) return 0;
  return (await ingestCodes(env, codes, crawl)).queued;
}

/**
 * Record codes in cc_codes and queue enrichment for the new ones. `source` is
 * the crawl ID, or e.g. "wayback" for codes uploaded through POST /cc/codes.
 * `startDelay` lets a multi-request upload keep one steady rate across requests.
 */
export async function ingestCodes(env, codes, source, startDelay = 0) {
  const fresh = [];
  for (const code of codes) {
    const r = await env.DB.prepare(
      `INSERT OR IGNORE INTO cc_codes (cb_code, crawl, seen_at) VALUES (?, ?, datetime('now'))`
    ).bind(code, source).run();
    if (r.meta?.changes) fresh.push(code);
  }

  // Codes already in properties (from the domain scanner) need no re-fetch.
  const todo = [];
  for (const code of fresh) {
    const have = await env.DB.prepare(`SELECT 1 FROM properties WHERE cb_code = ?`).bind(code).first();
    if (have) {
      await env.DB.prepare(`UPDATE cc_codes SET status='known' WHERE cb_code=?`).bind(code).run();
    } else {
      todo.push(code);
    }
  }

  // Spread enrichment so hotels.cloudbeds.com sees a gentle, steady rate.
  const delayFor = (n) => Math.min(startDelay + n * ENRICH_SPACING_S, MAX_QUEUE_DELAY_S);
  for (let i = 0; i < todo.length; i += 100) {
    await env.SCAN_QUEUE.sendBatch(
      todo.slice(i, i + 100).map((cb_code, j) => ({
        body: { type: "cc-code", cb_code },
        delaySeconds: delayFor(i + j),
      }))
    );
  }
  return {
    received: codes.length,
    fresh: fresh.length,
    known: fresh.length - todo.length,
    queued: todo.length,
    next_delay: todo.length ? delayFor(todo.length) : startDelay,
  };
}

/** Pure: unique, valid property codes from a newline/comma separated body. */
export function parseCodeList(text) {
  return [...new Set(String(text).split(/[\n,]/).map((s) => s.trim()).filter((s) => /^[A-Za-z0-9]{6}$/.test(s)))];
}

/** Consumer for one code: enrich and store. `enrich` and `saveProperty` come from index.js. */
export async function handleCode(env, { cb_code }, enrich, saveProperty) {
  const p = await enrich(cb_code);
  const status = !p ? "no-jsonld" : p.country === "US" ? "us" : "non-us";
  if (p) await saveProperty(env, p, "commoncrawl");
  await env.DB.prepare(
    `UPDATE cc_codes SET status=?, enriched_at=datetime('now') WHERE cb_code=?`
  ).bind(status, cb_code).run();
  return status;
}
