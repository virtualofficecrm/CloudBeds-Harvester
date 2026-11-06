/**
 * Standalone local test: run detect() + enrich() against real sites.
 *
 *   node test-detect.js
 *
 * Reports hit rate on known Cloudbeds domains, false positives on chains,
 * which of the PATHS actually produce hits, and whether enrich() pulls a
 * usable LodgingBusiness record for every detected code.
 */
import { detect, enrich, PATHS, CODE_RE, WIDGET_RE } from "./index.js";

// Fingerprint fixtures captured from live sites during the first test run.
// These cost no network and must always pass.
const FIXTURES = [
  ["plain reservation url", CODE_RE,
   `href="https://hotels.cloudbeds.com/en/reservation/SUKhZR"`, "SUKhZR"],
  ["custom subdomain", CODE_RE,
   `href="https://uticaproperties.cloudbeds.com/reservation/aBc123"`, "aBc123"],
  ["google-sites encoded redirect (roscoemotel.com)", CODE_RE,
   `href="https://www.google.com/url?q=https%3A%2F%2Fhotels.cloudbeds.com%2Freservation%2FQnKGa5&amp;sa=D"`, "QnKGa5"],
  ["booking widget embed (taosyellowstone.com)", WIDGET_RE,
   `<script src="https://hotels.cloudbeds.com/en/widget/load/ti1FhQ/horiz?newWindow=1"></script>`, "ti1FhQ"],
];

let fixtureFails = 0;
for (const [name, re, html, want] of FIXTURES) {
  const got = html.match(re)?.[1];
  if (got !== want) {
    fixtureFails++;
    console.log(`FIXTURE FAIL: ${name} — wanted ${want}, got ${got}`);
  }
}
console.log(`fixtures: ${FIXTURES.length - fixtureFails}/${FIXTURES.length} pass\n`);

const KNOWN_GOOD = [
  "roscoemotel.com", "pinebrookmotel.com", "shoremeadows.com",
  "thegrahamandco.com", "shorehaminn.com", "wells-ogunquit.com",
  "innatcorolla.com", "oceanisleinn.com", "rhetthouseinn.com",
  "classeninn.com", "fullmooninn.com", "wrigleyhostel.com",
  "coloradobearcreekcabins.com", "kinshiplanding.com", "11thavenuehostel.com",
  "bigsurriverinn.com", "innatmountshasta.com", "nwportlandhostel.com",
  "a-lodge.com", "wolfhotel.com", "snowymountaininn.com",
  "taosyellowstone.com", "thestevensmotel.com", "abovethecloudshostel.com",
  "olympicsuitesinn.com", "travelersmotelaz.com", "parkflorence.com",
];

const KNOWN_BAD = ["marriott.com", "hilton.com", "choicehotels.com"];

const CONCURRENCY = 5; // polite to the hotel sites and to cloudbeds.com

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

function hitPath(hit) {
  const p = hit.found_on.slice(hit.domain.length);
  return p === "" ? "/" : p;
}

async function timedDetect(domain) {
  const t = Date.now();
  const hit = await detect(domain);
  return { domain, hit, ms: Date.now() - t };
}

const t0 = Date.now();
console.log(`detect(): ${KNOWN_GOOD.length} known-Cloudbeds domains, ${KNOWN_BAD.length} negatives, concurrency ${CONCURRENCY}\n`);

const good = await mapPool(KNOWN_GOOD, CONCURRENCY, timedDetect);
const bad = await mapPool(KNOWN_BAD, CONCURRENCY, timedDetect);

console.log("── known-good domains ──────────────────────────────────────────────");
for (const r of good) {
  const s = r.hit
    ? `HIT   ${(r.hit.cb_code || "------").padEnd(6)} ${hitPath(r.hit).padEnd(15)} ${r.hit.marker}`
    : "MISS";
  console.log(`  ${r.domain.padEnd(28)} ${s}  (${r.ms}ms)`);
}

console.log("\n── negatives (chains) ──────────────────────────────────────────────");
for (const r of bad) {
  const s = r.hit ? `FALSE POSITIVE  ${JSON.stringify(r.hit)}` : "clean";
  console.log(`  ${r.domain.padEnd(28)} ${s}  (${r.ms}ms)`);
}

const hits = good.filter((r) => r.hit);
const withCode = hits.filter((r) => r.hit.cb_code);
const falsePos = bad.filter((r) => r.hit);

console.log("\n── path distribution (first path that hit) ─────────────────────────");
const dist = {};
for (const r of hits) dist[hitPath(r.hit)] = (dist[hitPath(r.hit)] || 0) + 1;
for (const p of PATHS) {
  const key = p === "" ? "/" : p;
  console.log(`  ${key.padEnd(17)} ${dist[key] || 0}`);
}

console.log("\n── marker distribution ─────────────────────────────────────────────");
const mdist = {};
for (const r of hits) mdist[r.hit.marker] = (mdist[r.hit.marker] || 0) + 1;
for (const [m, n] of Object.entries(mdist)) console.log(`  ${m.padEnd(17)} ${n}`);

// enrich() every detected code, sequentially and spaced out — this hammers
// hotels.cloudbeds.com, the one host we must not upset.
console.log(`\nenrich(): ${withCode.length} codes, sequential, 300ms apart\n`);
console.log("── enrichment ──────────────────────────────────────────────────────");
let enrichOk = 0;
for (const r of withCode) {
  const p = await enrich(r.hit.cb_code);
  if (p && p.name) {
    enrichOk++;
    const bits = [
      `${p.city}, ${p.state}`.replace(/^, |, $/g, "") || "no address",
      p.phone ? "phone" : "NO PHONE",
      p.email ? "email" : "NO EMAIL",
      `${p.room_type_count} room types`,
      p.room_count ? `${p.room_count} rooms` : "rooms n/a",
      p.has_24h_desk ? "24H DESK" : "",
    ].filter(Boolean).join(" | ");
    console.log(`  ${r.domain.padEnd(28)} ${r.hit.cb_code}  ${p.name}  [${bits}]`);
  } else {
    console.log(`  ${r.domain.padEnd(28)} ${r.hit.cb_code}  ENRICH FAILED`);
  }
  await new Promise((res) => setTimeout(res, 300));
}

console.log("\n── summary ─────────────────────────────────────────────────────────");
console.log(`  detection hit rate   ${hits.length}/${KNOWN_GOOD.length} (${Math.round((hits.length / KNOWN_GOOD.length) * 100)}%)`);
console.log(`  with property code   ${withCode.length}/${hits.length}`);
console.log(`  false positives      ${falsePos.length}/${KNOWN_BAD.length}`);
console.log(`  enrich success       ${enrichOk}/${withCode.length}`);
console.log(`  wall time            ${((Date.now() - t0) / 1000).toFixed(1)}s`);

if (hits.length < KNOWN_GOOD.length) {
  console.log("\n  misses:");
  for (const r of good.filter((x) => !x.hit)) console.log(`    ${r.domain}`);
}
