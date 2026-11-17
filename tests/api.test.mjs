// Run with: node --test tests/
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { handleRequest, createRateLimiter } from "../server/api.mjs";

// --- fake Supabase -------------------------------------------------
const PLAYERS = [
  { id: 1, username: "Steve", region: "NA", platform: "premium" },
  { id: 2, username: "Alex", region: "EU", platform: "premium" },
  { id: 3, username: ".BedrockGuy", region: "AS", platform: "bedrock" },
  { id: 4, username: "NoTiers", region: "NA", platform: "cracked" },
];
const TIERS = [
  { player_id: 1, gamemode: "vanilla", tier: "LT2", updated_at: "2026-11-01T00:00:00Z" },
  { player_id: 1, gamemode: "sword", tier: "HT1", updated_at: "2026-11-03T00:00:00Z" },
  { player_id: 2, gamemode: "vanilla", tier: "HT1", updated_at: "2026-11-02T00:00:00Z" },
  { player_id: 2, gamemode: "spearmace", tier: "LT5", updated_at: "2026-11-05T00:00:00Z" },
  { player_id: 3, gamemode: "vanilla", tier: "LT2", updated_at: "2026-11-04T00:00:00Z" },
];
const LOG = [
  { id: 9, gamemode: "sword", tier: "HT1", previous_tier: "LT1", tester_names: ["Tester"], region: "NA", created_at: "2026-11-03T00:00:00Z", players: { username: "Steve" } },
];

const withTiers = (p) => ({ ...p, player_tiers: TIERS.filter((t) => t.player_id === p.id).map(({ player_id, ...t }) => t) });
let calls;

function fakeSupabase(url, init) {
  const u = new URL(url);
  const table = u.pathname.replace("/rest/v1/", "");
  const q = u.searchParams;
  calls.push({ table, query: u.search, headers: init.headers });
  assert.ok(init.headers.apikey, "sends apikey");
  let rows;
  if (table === "players") {
    rows = PLAYERS;
    const eq = q.get("username_lower");
    if (eq && eq.startsWith("eq.")) rows = rows.filter((p) => p.username.toLowerCase() === eq.slice(3));
    if (eq && eq.startsWith("in.(")) {
      const names = eq.slice(4, -1).split(",").map((s) => s.replace(/^"|"$/g, ""));
      rows = rows.filter((p) => names.includes(p.username.toLowerCase()));
    }
    if (q.get("select").includes("player_tiers")) rows = rows.map(withTiers);
  } else if (table === "player_tiers") {
    rows = TIERS;
    const gm = q.get("gamemode");
    if (gm) {
      rows = rows
        .filter((t) => t.gamemode === gm.slice(3))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .map((t) => ({ tier: t.tier, updated_at: t.updated_at, players: PLAYERS.find((p) => p.id === t.player_id) }));
    }
  } else if (table === "test_log") {
    rows = LOG;
  } else {
    return new Response("nope", { status: 404 });
  }
  const range = init.headers.Range;
  if (range) {
    const [from, to] = range.split("-").map(Number);
    rows = rows.slice(from, to + 1);
  }
  const limit = q.get("limit");
  if (limit) rows = rows.slice(0, Number(limit));
  return new Response(JSON.stringify(rows), { headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  calls = [];
  globalThis.fetch = async (url, init) => fakeSupabase(url, init);
});

const noLimit = () => ({ allowed: true, remaining: 99, retryAfter: 1 });
async function get(path, opts = {}) {
  const res = await handleRequest(new Request(`https://ryfttiers.pages.dev${path}`, opts.init), {}, { limiter: noLimit, ...opts });
  const text = await res.text();
  return { res, status: res.status, body: text ? JSON.parse(text) : null };
}

// --- tests ---------------------------------------------------------
test("single player, case-insensitive, tiers best first with points", async () => {
  const { status, body, res } = await get("/api/players/steve");
  assert.equal(status, 200);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  assert.match(res.headers.get("Cache-Control"), /max-age=300/);
  assert.deepEqual(body, {
    id: 1, username: "Steve", region: "NA", platform: "premium", points: 170,
    tiers: [
      { gamemode: "sword", tier: "HT1", points: 100, updatedAt: "2026-11-03T00:00:00Z" },
      { gamemode: "vanilla", tier: "LT2", points: 70, updatedAt: "2026-11-01T00:00:00Z" },
    ],
  });
});

test("unknown player is 404 with an error body", async () => {
  const { status, body } = await get("/api/players/Nobody");
  assert.equal(status, 404);
  assert.equal(body.error.status, 404);
});

test("bedrock-style names work", async () => {
  const { status, body } = await get("/api/players/" + encodeURIComponent(".BedrockGuy"));
  assert.equal(status, 200);
  assert.equal(body.platform, "bedrock");
});

test("invalid username is 400", async () => {
  const { status } = await get("/api/players/" + encodeURIComponent('a"b'));
  assert.equal(status, 400);
  assert.equal(calls.length, 0);
});

test("batch lookup matches the PrimeTiers { count, items, missing } shape", async () => {
  const { status, body } = await get("/api/players?names=STEVE,alex,Ghost,steve,bad%22name");
  assert.equal(status, 200);
  assert.equal(body.count, 2);
  assert.equal(body.count, body.items.length);
  assert.deepEqual(body.items.map((p) => p.username), ["Steve", "Alex"]);
  assert.deepEqual(body.missing, ["Ghost", 'bad"name']);
  assert.equal(calls.length, 1);
});

test("batch lookup is what Global Tier Tagger's PrimeTiers adapter accepts", async () => {
  // Mirrors the checks in its PrimeClient.parseBatch / ProviderParsers.prime.
  const requested = ["Steve", "Alex", "Ghost"];
  const { body } = await get("/api/players?names=" + requested.join(","));
  const expected = new Set(requested.map((n) => n.toLowerCase()));
  const seen = new Set();
  for (const p of body.items) {
    const n = p.username.toLowerCase();
    assert.ok(expected.has(n) && !seen.has(n));
    seen.add(n);
    assert.equal(typeof p.platform, "string");
    const modes = new Set();
    for (const t of p.tiers) {
      assert.match(t.tier, /^(?:R)?(?:[HML]T[1-6]|ST6)$/);
      assert.ok(!modes.has(t.gamemode));
      modes.add(t.gamemode);
    }
  }
  for (const m of body.missing) {
    const n = m.toLowerCase();
    assert.ok(expected.has(n) && !seen.has(n));
    seen.add(n);
  }
  assert.equal(seen.size, requested.length);
});

test("batch needs names and caps at 50", async () => {
  assert.equal((await get("/api/players")).status, 400);
  const many = Array.from({ length: 51 }, (_, i) => "p" + i).join(",");
  assert.equal((await get("/api/players?names=" + many)).status, 400);
});

test("gamemode leaderboard ranks by tier then name", async () => {
  const { body } = await get("/api/leaderboard?gamemode=vanilla");
  assert.deepEqual(body.map((e) => [e.rank, e.username, e.tier]), [
    [1, "Alex", "HT1"], [2, ".BedrockGuy", "LT2"], [3, "Steve", "LT2"],
  ]);
});

test("full leaderboard has every gamemode", async () => {
  const { body } = await get("/api/leaderboard");
  assert.ok(Array.isArray(body.vanilla) && Array.isArray(body.cart));
  assert.equal(body.spearmace[0].username, "Alex");
});

test("unknown gamemode is 404", async () => {
  assert.equal((await get("/api/leaderboard?gamemode=crystal")).status, 404);
  assert.equal((await get("/api/gamemodes/nope/tiers")).status, 404);
});

test("global leaderboard sums points and respects limit", async () => {
  const { body } = await get("/api/leaderboard/global?limit=2");
  assert.deepEqual(body.map((e) => [e.rank, e.username, e.points]), [[1, "Steve", 170], [2, "Alex", 110]]);
  assert.deepEqual(body[0].tiers, { sword: "HT1", vanilla: "LT2" });
  assert.equal((await get("/api/leaderboard/global?limit=0")).status, 400);
  assert.equal((await get("/api/leaderboard/global?limit=501")).status, 400);
  assert.equal((await get("/api/leaderboard/global?limit=abc")).status, 400);
});

test("leaderboards page through big tables", async () => {
  const big = Array.from({ length: 2500 }, (_, i) => ({ id: 100 + i, username: "u" + i, region: "NA", platform: "premium" }));
  const bigTiers = big.map((p) => ({ player_id: p.id, gamemode: "uhc", tier: "LT5", updated_at: "2026-01-01T00:00:00Z" }));
  PLAYERS.push(...big);
  TIERS.push(...bigTiers);
  try {
    const { body } = await get("/api/leaderboard/global?limit=500");
    assert.equal(body.length, 500);
    const { body: uhc } = await get("/api/leaderboard?gamemode=uhc");
    assert.equal(uhc.length, 2500);
  } finally {
    PLAYERS.splice(4);
    TIERS.splice(5);
  }
});

test("gamemodes and gamemode tiers", async () => {
  const { body } = await get("/api/gamemodes");
  assert.ok(body.includes("vanilla") && body.includes("spearmace"));
  const { body: recent } = await get("/api/gamemodes/vanilla/tiers?limit=2");
  assert.deepEqual(recent.map((r) => r.username), [".BedrockGuy", "Alex"]);
});

test("recent tests", async () => {
  const { body } = await get("/api/recent");
  assert.deepEqual(body[0], {
    id: 9, username: "Steve", gamemode: "sword", tier: "HT1", previousTier: "LT1",
    region: "NA", testers: ["Tester"], testedAt: "2026-11-03T00:00:00Z",
  });
});

test("health reports database reachability", async () => {
  assert.deepEqual((await get("/api/health")).body.ok, true);
  globalThis.fetch = async () => { throw new Error("down"); };
  const { status, body } = await get("/api/health");
  assert.equal(status, 503);
  assert.equal(body.ok, false);
});

test("database errors become 502", async () => {
  globalThis.fetch = async () => new Response("boom", { status: 500 });
  assert.equal((await get("/api/players/Steve")).status, 502);
});

test("index, unknown routes, methods, CORS preflight", async () => {
  assert.equal((await get("/api")).body.name, "RyftTiers Public API");
  assert.equal((await get("/api/nope")).status, 404);
  assert.equal((await get("/api/players/Steve", { init: { method: "POST" } })).status, 405);
  const pre = await get("/api/players/Steve", { init: { method: "OPTIONS" } });
  assert.equal(pre.status, 204);
});

test("responses are cached and served from cache", async () => {
  const store = new Map();
  const cache = {
    match: async (req) => store.get(req.url)?.clone(),
    put: async (req, res) => { store.set(req.url, res); },
  };
  const first = await get("/api/players/Steve", { cache });
  assert.equal(first.res.headers.get("X-Cache"), "MISS");
  const second = await get("/api/players/Steve", { cache });
  assert.equal(second.res.headers.get("X-Cache"), "HIT");
  assert.deepEqual(second.body, first.body);
  assert.equal(calls.length, 1);
  // errors are not cached
  await get("/api/players/Nobody", { cache });
  await get("/api/players/Nobody", { cache });
  assert.equal(calls.length, 3);
});

test("rate limiter returns 429 with Retry-After", async () => {
  let now = 0;
  const limiter = createRateLimiter({ requests: 2, windowSeconds: 60 }, () => now);
  const req = () => handleRequest(new Request("https://x/api/gamemodes", { headers: { "CF-Connecting-IP": "1.2.3.4" } }), {}, { limiter });
  assert.equal((await req()).status, 200);
  assert.equal((await req()).status, 200);
  const limited = await req();
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("Retry-After"), "60");
  now = 60_000;
  assert.equal((await req()).status, 200);
});
