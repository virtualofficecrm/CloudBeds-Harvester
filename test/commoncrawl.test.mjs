// Run: node --experimental-sqlite test/commoncrawl.test.mjs   (Node 22+)
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { extractCodes } from "../commoncrawl.js";
import worker from "../index.js";

/* --- pure parsing --- */
const sample = [
  '{"url": "https://hotels.cloudbeds.com/reservation/AbC123"}',
  '{"url": "https://hotels.cloudbeds.com/en/reservation/AbC123?currency=usd"}', // dup
  '{"url": "https://us2.cloudbeds.com/reservation/XyZ789#rooms"}',
  '{"url": "https://uticaproperties.cloudbeds.com/pt-br/reservation/Qq11Rr"}',
  '{"url": "https://www.cloudbeds.com/reservation/"}',                      // no code
  '{"url": "https://hotels.cloudbeds.com/reservation/TOOLONG1"}',           // 8 chars
  'not json',
  "",
].join("\n");
assert.deepEqual(extractCodes(sample).sort(), ["AbC123", "Qq11Rr", "XyZ789"].sort());

/* --- D1 shim over node:sqlite --- */
const sql = new DatabaseSync(":memory:");
sql.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
const DB = {
  prepare(q) {
    let args = [];
    const st = {
      bind: (...a) => ((args = a.map((v) => (v === undefined ? null : v))), st),
      run: async () => ({ meta: { changes: Number(sql.prepare(q).run(...args).changes) } }),
      first: async () => sql.prepare(q).get(...args) ?? null,
      all: async () => ({ results: sql.prepare(q).all(...args) }),
    };
    return st;
  },
};
const sent = [];
const env = { DB, SCAN_QUEUE: { sendBatch: async (m) => sent.push(...m) }, GHL_LOCATION_ID: "loc", GHL_TOKEN: "t" };

/* --- fake network --- */
const ldjson = (name, country, email, phone, url) => `<script type="application/ld+json">${JSON.stringify({
  "@type": "LodgingBusiness", name, email, telephone: phone, url,
  address: { addressCountry: country, addressRegion: "WY", addressLocality: "Saratoga" },
  description: `The 15 room ${name}`, containsPlace: [{ "@type": "HotelRoom", name: "Queen" }],
})}</script>`;
const pages = {
  AbC123: ldjson("Pine Motel", "US", "pine@gmail.com", "(307) 555-0101"),
  XyZ789: ldjson("Casa Lisboa", "PT", "a@b.pt", "+351 1"),
  Qq11Rr: ldjson("Snowy Mountain Inn", "US", "owner@snowy.com", "307-555-0199"),
};
const ghlCalls = [];
const statuses = {}; // code -> forced HTTP status for its booking page
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  const ok = (t) => new Response(t, { status: 200 });
  if (url.endsWith("/collinfo.json")) return ok(JSON.stringify([{ id: "CC-MAIN-2026-40" }]));
  if (url.includes("showNumPages")) return ok('{"pages": 1, "pageSize": 5, "blocks": 3}');
  if (url.includes("-index?")) {
    const u = new URL(url);
    assert.equal(u.searchParams.get("matchType"), "domain");
    assert.equal(u.searchParams.get("filter"), "~url:/reservation/");
    return ok(sample);
  }
  const m = url.match(/reservation\/(\w{6})$/);
  if (m && statuses[m[1]]) return new Response("", { status: statuses[m[1]] });
  if (m) return ok(pages[m[1]] || "");
  if (url.includes("/contacts/upsert")) { ghlCalls.push(JSON.parse(opts.body)); return ok('{"contact":{}}'); }
  throw new Error("unexpected fetch " + url);
};
globalThis.setTimeout = ((orig) => (fn, ms) => orig(fn, 0))(globalThis.setTimeout); // skip sleeps

const call = (path, method = "GET", body) =>
  worker.fetch(new Request("https://w" + path, { method, body }), env).then((r) => r.json());
const drain = async () => {
  while (sent.length) {
    const batch = sent.splice(0).map((m) => ({ body: m.body, ack() {}, retry() { throw new Error("retry " + JSON.stringify(m.body)); } }));
    await worker.queue({ messages: batch }, env);
  }
};

/* --- flow --- */
const h = await call("/cc/harvest?crawls=1", "POST");
assert.equal(h.pages_queued, 1);
await drain();
assert.deepEqual(await call("/cc/stats"), { us: 2, "non-us": 1 });

// Exclude Snowy Mountain Inn by website-less email, and re-harvest is idempotent.
assert.deepEqual(await call("/exclude", "POST", "owner@snowy.com\n307 555 0199"), { added: 2 });
await call("/cc/harvest?crawls=1", "POST"); await drain();
assert.equal((await call("/cc/stats")).us, 2);

// Sync must stay hard-disabled.
const sr = await worker.fetch(new Request("https://w/sync", { method: "POST" }), env);
assert.equal(sr.status, 403);
assert.equal(ghlCalls.length, 0);

// CSV export: US only, Snowy excluded, Portugal dropped.
const csv = await (await worker.fetch(new Request("https://w/cc/export"), env)).text();
const lines = csv.trim().split("\n");
assert.equal(lines.length, 2, csv);
assert.ok(lines[1].includes("Pine Motel") && lines[1].includes('"WY"') && lines[1].includes('"there"'));
assert.ok(!csv.includes("Snowy") && !csv.includes("Lisboa"));

/* --- POST /cc/codes: load codes collected off-worker (e.g. Wayback Machine) --- */
pages.WbCod1 = ldjson("Wayback Lodge", "US", "wb1@gmail.com", "(307) 555-0111", "https://hotels.cloudbeds.com/en/reservation/WbCod1");
pages.WbCod2 = ldjson("Wayback Inn", "US", "wb2@gmail.com", "(307) 555-0122");
pages.WbCod3 = ldjson("Scanner Motel", "US", "wb3@gmail.com", "(307) 555-0133");
sql.prepare(`INSERT INTO properties (cb_code, name, source_domain) VALUES ('WbCod3', 'Scanner Motel', 'scanner.example')`).run();

// Junk is dropped, codes seen before are not re-queued, known properties are not re-fetched.
const up = await call("/cc/codes?delay=100&source=wayback", "POST", "WbCod1\nWbCod2\nWbCod3\nAbC123\nnot-a-code\nTOOLONG1\n\nWbCod1");
assert.deepEqual(up, { received: 4, fresh: 3, known: 1, queued: 2, next_delay: 104 });
assert.deepEqual(sent.map((m) => [m.body.type, m.body.cb_code, m.delaySeconds]), [
  ["cc-code", "WbCod1", 100],
  ["cc-code", "WbCod2", 102],
]);
assert.equal(sql.prepare(`SELECT crawl FROM cc_codes WHERE cb_code='WbCod1'`).get().crawl, "wayback");
await drain();
assert.equal((await call("/cc/stats")).known, 1);

// Re-upload is idempotent.
assert.deepEqual(await call("/cc/codes", "POST", "WbCod1\nWbCod2"), { received: 2, fresh: 0, known: 0, queued: 0, next_delay: 0 });
assert.equal(sent.length, 0);

// One request stays under the Workers subrequest limit.
const big = Array.from({ length: 101 }, (_, i) => "Zz" + String(i).padStart(4, "0")).join("\n");
const tooBig = await worker.fetch(new Request("https://w/cc/codes", { method: "POST", body: big }), env);
assert.equal(tooBig.status, 413);
assert.equal(sent.length, 0);

// Uploaded properties export like any other; exclusions still win; sync still off.
const csv2 = await (await worker.fetch(new Request("https://w/cc/export"), env)).text();
assert.ok(csv2.includes("Wayback Lodge") && csv2.includes("Wayback Inn"));
assert.ok(!csv2.includes("Snowy") && !csv2.includes("Scanner Motel"));
assert.equal((await worker.fetch(new Request("https://w/sync", { method: "POST" }), env)).status, 403);
assert.equal(ghlCalls.length, 0);

/* --- a Cloudbeds-hosted "website" must never exclude other properties --- */
assert.ok(sql.prepare(`SELECT website FROM properties WHERE cb_code='WbCod1'`).get().website.includes("cloudbeds.com"));
// Exactly what the runbook's script loaded: stale row must be ignored...
sql.prepare(`INSERT INTO exclusions (key, added_at) VALUES ('host:hotels.cloudbeds.com', 'x')`).run();
// ...and new uploads of such URLs must not add one, while real hosts still do.
assert.deepEqual(
  await call("/exclude", "POST", "https://us2.cloudbeds.com/reservation/WbCod9\nhttps://uticaproperties.cloudbeds.com/x\nhttps://realhotel.example/"),
  { added: 1 }
);
const csv3 = await (await worker.fetch(new Request("https://w/cc/export"), env)).text();
assert.ok(csv3.includes("Wayback Lodge"), "cloudbeds host wrongly excluded a property");
assert.ok(!csv3.includes("Snowy"), "real exclusions still apply");

/* --- failed fetches stay retryable; only a real 404 means the page is gone --- */
pages.Tr4ns1 = ldjson("Flaky Lodge", "US", "flaky@gmail.com", "(307) 555-0144");
statuses.Tr4ns1 = 503;
statuses.De4d01 = 404;
await call("/cc/codes?source=wayback", "POST", "Tr4ns1\nDe4d01");
const retried = [];
const msgs = sent.splice(0).map((m) => ({ body: m.body, ack() {}, retry() { retried.push(m.body.cb_code); } }));
await worker.queue({ messages: msgs }, env);
assert.deepEqual(retried, ["Tr4ns1"]);
const st = (c) => sql.prepare(`SELECT status FROM cc_codes WHERE cb_code=?`).get(c).status;
assert.equal(st("Tr4ns1"), null, "transient failure must stay pending");
assert.equal(st("De4d01"), "no-jsonld");

// ?retry=1 re-queues pending and no-jsonld codes, never finished ones; plain upload does not.
delete statuses.Tr4ns1;
assert.equal((await call("/cc/codes", "POST", "Tr4ns1\nDe4d01\nWbCod1")).queued, 0);
const re = await call("/cc/codes?retry=1", "POST", "Tr4ns1\nDe4d01\nWbCod1");
assert.equal(re.queued, 2);
assert.deepEqual(sent.map((m) => m.body.cb_code).sort(), ["De4d01", "Tr4ns1"]);
const msgs2 = sent.splice(0).map((m) => ({ body: m.body, ack() {}, retry() { throw new Error("retry"); } }));
await worker.queue({ messages: msgs2 }, env);
assert.equal(st("Tr4ns1"), "us");
assert.equal(st("De4d01"), "no-jsonld");
console.log("all tests passed");
