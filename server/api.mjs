// RyftTiers Public API.
//
// A read-only JSON API over the RyftTiers tier data, modelled on the
// PrimeTiers Public API (https://github.com/PrimeTiers/Public-API) so tools
// written for one are easy to point at the other. It runs as a Cloudflare
// Pages Function (see functions/api/[[path]].js) next to the website, so it
// is served at https://ryfttiers.pages.dev/api/...
//
// Data comes from the same Supabase tables the website reads, through the
// public anon key. Row Level Security only allows public reads on these
// tables, so the API can never change anything.
//
// Everything in this file is plain fetch/Response code with no Cloudflare
// specific imports, so it can be unit tested in Node (see tests/).

export const API_VERSION = "1.1.0";

// Same public project the website uses (js/supabase-client.js). The anon key
// is safe to ship: it only grants what RLS allows, which is public reads.
// Override with the SUPABASE_URL / SUPABASE_ANON_KEY environment variables.
const DEFAULT_SUPABASE_URL = "https://flifswwrhevzjwwhqitc.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZsaWZzd3dyaGV2emp3d2hxaXRjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA5MjcwOTUsImV4cCI6MjEwNjUwMzA5NX0.DaCk-tXyVMPWtfNz9_sq0BIlY2wWYtXT3Epbg_JdiBQ";

// Every gamemode RyftTiers tests. Keep in sync with GAMEMODES in the bot's
// src/config.js and js/tiers.js on the website.
export const GAMEMODES = [
  "vanilla", "uhc", "pot", "nethop", "smp", "sword", "axe", "mace", "cart",
  "spearmace",
];

// Best to worst, and the points each tier is worth (same as js/tiers.js).
export const TIER_ORDER = ["HT1", "LT1", "HT2", "LT2", "HT3", "LT3", "HT4", "LT4", "HT5", "LT5"];
export const TIER_POINTS = {
  HT1: 100, LT1: 90,
  HT2: 80, LT2: 70,
  HT3: 60, LT3: 50,
  HT4: 40, LT4: 30,
  HT5: 20, LT5: 10,
};

export const CACHE_SECONDS = 300; // responses are cached for 5 minutes
export const BATCH_MAX = 50; // most names per /api/players?names= request
export const RATE_LIMIT = { requests: 120, windowSeconds: 60 }; // per IP

// Minecraft Java names are 3-16 of [A-Za-z0-9_]. Bedrock (Floodgate) names
// are prefixed with "." and may contain spaces, and cracked names are looser,
// so accept a slightly wider set. Anything else is rejected before any
// database call.
const USERNAME_RE = /^[A-Za-z0-9_.\- ]{1,32}$/;

// ------------------------------------------------------------------
// Responses
// ------------------------------------------------------------------

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function errorResponse(status, message, extraHeaders = {}) {
  return json({ error: { status, message } }, status, {
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
}

// ------------------------------------------------------------------
// Supabase (PostgREST) access
// ------------------------------------------------------------------

function supabase(env) {
  const url = (env && env.SUPABASE_URL) || DEFAULT_SUPABASE_URL;
  const key = (env && env.SUPABASE_ANON_KEY) || DEFAULT_SUPABASE_ANON_KEY;
  const headers = { apikey: key, Authorization: `Bearer ${key}` };

  async function get(path, extra = {}) {
    let res;
    try {
      res = await fetch(`${url}/rest/v1/${path}`, { headers: { ...headers, ...extra } });
    } catch (e) {
      throw new ApiError(502, "Could not reach the RyftTiers database");
    }
    if (!res.ok) throw new ApiError(502, `Database request failed (${res.status})`);
    return res.json();
  }

  // PostgREST caps each response (1000 rows on Supabase by default), so read
  // big tables page by page.
  async function getAll(path, pageSize = 1000) {
    const rows = [];
    for (let from = 0; ; from += pageSize) {
      const page = await get(path, {
        "Range-Unit": "items",
        Range: `${from}-${from + pageSize - 1}`,
      });
      rows.push(...page);
      if (page.length < pageSize) return rows;
    }
  }

  return { get, getAll };
}

// ------------------------------------------------------------------
// Shaping
// ------------------------------------------------------------------

const tierRank = (tier) => {
  const i = TIER_ORDER.indexOf(tier);
  return i === -1 ? TIER_ORDER.length : i;
};
const tierPoints = (tier) => TIER_POINTS[tier] || 0;
const byName = (a, b) => a.username.localeCompare(b.username, "en", { sensitivity: "base" });

function shapeTiers(rows) {
  return (rows || [])
    .map((t) => ({
      gamemode: t.gamemode,
      tier: t.tier,
      points: tierPoints(t.tier),
      updatedAt: t.updated_at || null,
    }))
    .sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || a.gamemode.localeCompare(b.gamemode));
}

function shapePlayer(row) {
  const tiers = shapeTiers(row.player_tiers);
  return {
    id: row.id,
    username: row.username,
    uuid: row.uuid || null,
    region: row.region || null,
    platform: row.platform || null,
    points: tiers.reduce((sum, t) => sum + t.points, 0),
    tiers,
  };
}

const PLAYER_SELECT = "id,username,uuid,region,platform,player_tiers(gamemode,tier,updated_at)";

// ------------------------------------------------------------------
// Query parameter helpers
// ------------------------------------------------------------------

function parseLimit(params, { min, max, fallback }) {
  const raw = params.get("limit");
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new ApiError(400, `limit must be a whole number from ${min} to ${max}`);
  const n = Number(raw);
  if (n < min || n > max) throw new ApiError(400, `limit must be a whole number from ${min} to ${max}`);
  return n;
}

function requireGamemode(gamemode) {
  const gm = String(gamemode || "").toLowerCase();
  if (!GAMEMODES.includes(gm)) {
    throw new ApiError(404, `Unknown gamemode "${gamemode}". Known gamemodes: ${GAMEMODES.join(", ")}`);
  }
  return gm;
}

// Accepts a Minecraft UUID with or without dashes, in any case, and returns
// it in the dashed lower-case form RyftTiers stores. Null if it isn't one.
export function normalizeUUID(raw) {
  const hex = String(raw || "").trim().toLowerCase().replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function requireUsername(name) {
  if (!USERNAME_RE.test(name)) throw new ApiError(400, `Invalid username "${name}"`);
  return name;
}

// PostgREST in.(...) list. Names are already validated against USERNAME_RE,
// so they hold no quotes, commas or parentheses; quoting covers the spaces.
const inList = (values) => `in.(${values.map((v) => `"${v}"`).join(",")})`;

// ------------------------------------------------------------------
// Endpoints
// ------------------------------------------------------------------

async function getPlayer(db, username) {
  requireUsername(username);
  const rows = await db.get(
    `players?select=${PLAYER_SELECT}&username_lower=eq.${encodeURIComponent(username.toLowerCase())}&limit=1`
  );
  if (!rows.length) throw new ApiError(404, `Player "${username}" is not on RyftTiers`);
  return shapePlayer(rows[0]);
}

async function getPlayerByUUID(db, raw) {
  const uuid = normalizeUUID(raw);
  if (!uuid) throw new ApiError(400, `Invalid UUID "${raw}"`);
  const rows = await db.get(`players?select=${PLAYER_SELECT}&uuid=eq.${uuid}&limit=1`);
  if (!rows.length) throw new ApiError(404, `No RyftTiers player has UUID ${uuid}`);
  return shapePlayer(rows[0]);
}

// ?uuids=a,b,c: same { count, items, missing } shape as ?names=. "missing"
// echoes each UUID exactly as it was sent.
async function getPlayersByUUID(db, raw) {
  const seen = new Map(); // normalized (or raw if invalid) -> as sent
  for (const u of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const key = normalizeUUID(u) || `invalid:${u}`;
    if (!seen.has(key)) seen.set(key, u);
  }
  if (seen.size > BATCH_MAX) throw new ApiError(400, `At most ${BATCH_MAX} UUIDs per request`);
  const lookup = [...seen.keys()].filter((k) => !k.startsWith("invalid:"));
  const rows = lookup.length
    ? await db.get(`players?select=${PLAYER_SELECT}&uuid=${encodeURIComponent(inList(lookup))}`)
    : [];
  const found = new Map(rows.map((r) => [r.uuid, shapePlayer(r)]));
  const items = [];
  const missing = [];
  for (const [key, original] of seen) {
    if (found.has(key)) items.push(found.get(key));
    else missing.push(original);
  }
  return { count: items.length, items, missing };
}

async function getPlayers(db, params) {
  const uuids = params.get("uuids");
  if (uuids !== null && uuids.trim() !== "") return getPlayersByUUID(db, uuids);
  const raw = params.get("names");
  if (raw === null || raw.trim() === "") {
    throw new ApiError(400, "names or uuids is required, e.g. ?names=Steve,Alex");
  }
  // Dedupe case-insensitively but keep the caller's spelling for "missing".
  // A name that can't be a username can't be on RyftTiers either, so it is
  // reported as missing instead of failing the whole batch.
  const seen = new Map();
  for (const n of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!seen.has(n.toLowerCase())) seen.set(n.toLowerCase(), n);
  }
  if (seen.size > BATCH_MAX) throw new ApiError(400, `At most ${BATCH_MAX} names per request`);

  const lookup = [...seen.keys()].filter((n) => USERNAME_RE.test(n));
  const rows = lookup.length
    ? await db.get(`players?select=${PLAYER_SELECT}&username_lower=${encodeURIComponent(inList(lookup))}`)
    : [];
  const found = new Map(rows.map((r) => [r.username.toLowerCase(), shapePlayer(r)]));
  // Same shape as PrimeTiers' batch endpoint ({ count, items, missing }), so
  // clients built for PrimeTiers (e.g. Global Tier Tagger) can read it as-is:
  // every requested name is in exactly one of items or missing, once.
  const items = [];
  const missing = [];
  for (const [lower, original] of seen) {
    if (found.has(lower)) items.push(found.get(lower));
    else missing.push(original);
  }
  return { count: items.length, items, missing };
}

// Every player with at least one tier, with their tiers, from two paged
// reads. Used by the leaderboards, which are then cached for 5 minutes.
async function loadAllRankedPlayers(db) {
  const [players, tiers] = await Promise.all([
    db.getAll("players?select=id,username,uuid,region,platform&order=id.asc"),
    db.getAll("player_tiers?select=player_id,gamemode,tier,updated_at&order=player_id.asc,gamemode.asc"),
  ]);
  const tiersByPlayer = new Map();
  for (const t of tiers) {
    if (!tiersByPlayer.has(t.player_id)) tiersByPlayer.set(t.player_id, []);
    tiersByPlayer.get(t.player_id).push(t);
  }
  return players
    .filter((p) => tiersByPlayer.has(p.id))
    .map((p) => shapePlayer({ ...p, player_tiers: tiersByPlayer.get(p.id) }));
}

function gamemodeEntries(players, gamemode) {
  return players
    .map((p) => ({ p, t: p.tiers.find((t) => t.gamemode === gamemode) }))
    .filter(({ t }) => t)
    .sort((a, b) => tierRank(a.t.tier) - tierRank(b.t.tier) || byName(a.p, b.p))
    .map(({ p, t }, i) => ({
      rank: i + 1,
      id: p.id,
      username: p.username,
      uuid: p.uuid,
      region: p.region,
      platform: p.platform,
      tier: t.tier,
      points: t.points,
      updatedAt: t.updatedAt,
    }));
}

async function getLeaderboard(db, params) {
  const players = await loadAllRankedPlayers(db);
  const gamemode = params.get("gamemode");
  if (gamemode !== null) return gamemodeEntries(players, requireGamemode(gamemode));
  const all = {};
  for (const gm of GAMEMODES) all[gm] = gamemodeEntries(players, gm);
  return all;
}

async function getGlobalLeaderboard(db, params) {
  const limit = parseLimit(params, { min: 1, max: 500, fallback: 100 });
  const players = await loadAllRankedPlayers(db);
  return players
    .sort((a, b) => b.points - a.points || byName(a, b))
    .slice(0, limit)
    .map((p, i) => ({
      rank: i + 1,
      id: p.id,
      username: p.username,
      uuid: p.uuid,
      region: p.region,
      platform: p.platform,
      points: p.points,
      tiers: Object.fromEntries(p.tiers.map((t) => [t.gamemode, t.tier])),
    }));
}

async function getGamemodeTiers(db, gamemode, params) {
  const gm = requireGamemode(gamemode);
  const limit = parseLimit(params, { min: 1, max: 100, fallback: 50 });
  const rows = await db.get(
    `player_tiers?select=tier,updated_at,players(id,username,uuid,region,platform)` +
      `&gamemode=eq.${gm}&order=updated_at.desc&limit=${limit}`
  );
  return rows
    .filter((r) => r.players)
    .map((r) => ({
      id: r.players.id,
      username: r.players.username,
      uuid: r.players.uuid || null,
      region: r.players.region || null,
      platform: r.players.platform || null,
      gamemode: gm,
      tier: r.tier,
      points: tierPoints(r.tier),
      updatedAt: r.updated_at,
    }));
}

async function getRecent(db, params) {
  const limit = parseLimit(params, { min: 1, max: 100, fallback: 20 });
  const rows = await db.get(
    `test_log?select=id,gamemode,tier,previous_tier,tester_names,region,created_at,` +
      `players!test_log_player_id_fkey(username,uuid)&order=created_at.desc&limit=${limit}`
  );
  return rows.map((r) => ({
    id: r.id,
    username: r.players ? r.players.username : null,
    uuid: r.players ? r.players.uuid || null : null,
    gamemode: r.gamemode,
    tier: r.tier,
    previousTier: r.previous_tier || null,
    region: r.region || null,
    testers: r.tester_names || [],
    testedAt: r.created_at,
  }));
}

async function getHealth(db) {
  try {
    await db.get("players?select=id&limit=1");
    return json({ ok: true, version: API_VERSION }, 200, { "Cache-Control": "no-store" });
  } catch {
    return json({ ok: false, version: API_VERSION }, 503, { "Cache-Control": "no-store" });
  }
}

function getIndex() {
  return {
    name: "RyftTiers Public API",
    version: API_VERSION,
    docs: "https://github.com/napatc1/RyftTiers/blob/main/API.md",
    endpoints: [
      "GET /api/players/{username}",
      "GET /api/players?names=a,b,c",
      "GET /api/players/uuid/{uuid}",
      "GET /api/players?uuids=a,b,c",
      "GET /api/leaderboard",
      "GET /api/leaderboard?gamemode={gamemode}",
      "GET /api/leaderboard/global?limit=1-500",
      "GET /api/gamemodes",
      "GET /api/gamemodes/{gamemode}/tiers?limit=1-100",
      "GET /api/recent?limit=1-100",
      "GET /api/health",
    ],
  };
}

// Returns a body to JSON-encode (cached), or a Response (sent as-is).
async function route(db, segments, params) {
  const [a, b, c, ...rest] = segments;
  if (rest.length) return null;
  if (a === undefined) return getIndex();
  if (a === "health" && !b) return getHealth(db);
  if (a === "players" && !b) return getPlayers(db, params);
  if (a === "players" && b === "uuid" && c) return getPlayerByUUID(db, c);
  if (a === "players" && b && !c) return getPlayer(db, b);
  if (a === "leaderboard" && !b) return getLeaderboard(db, params);
  if (a === "leaderboard" && b === "global" && !c) return getGlobalLeaderboard(db, params);
  if (a === "gamemodes" && !b) return GAMEMODES;
  if (a === "gamemodes" && b && c === "tiers") return getGamemodeTiers(db, b, params);
  if (a === "recent" && !b) return getRecent(db, params);
  return null;
}

// ------------------------------------------------------------------
// Rate limiting
// ------------------------------------------------------------------

// Fixed window per client IP. Kept in the isolate's memory, so it is a
// best-effort guard against a single client hammering the API rather than a
// global quota (each Cloudflare location keeps its own counts). Cache hits
// are counted too, so a client cannot dodge it by repeating one URL.
export function createRateLimiter({ requests, windowSeconds }, now = () => Date.now()) {
  const hits = new Map();
  return function check(ip) {
    const t = now();
    const windowMs = windowSeconds * 1000;
    let entry = hits.get(ip);
    if (!entry || t >= entry.reset) {
      entry = { count: 0, reset: t + windowMs };
      hits.set(ip, entry);
    }
    entry.count++;
    if (hits.size > 10000) {
      for (const [k, v] of hits) if (t >= v.reset) hits.delete(k);
    }
    return {
      allowed: entry.count <= requests,
      remaining: Math.max(0, requests - entry.count),
      retryAfter: Math.max(1, Math.ceil((entry.reset - t) / 1000)),
    };
  };
}

const defaultLimiter = createRateLimiter(RATE_LIMIT);

// ------------------------------------------------------------------
// Entry point
// ------------------------------------------------------------------

/**
 * Handle one API request.
 * @param {Request} request
 * @param {object} [env]   SUPABASE_URL / SUPABASE_ANON_KEY overrides
 * @param {object} [opts]  { cache, limiter, waitUntil } — injected by the
 *                         Pages Function, and by tests.
 */
export async function handleRequest(request, env = {}, opts = {}) {
  const { cache = null, limiter = defaultLimiter, waitUntil = (p) => p } = opts;

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse(405, "Only GET requests are supported", { Allow: "GET, HEAD, OPTIONS" });
  }

  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
  const rl = limiter(ip);
  const rlHeaders = {
    "X-RateLimit-Limit": String(RATE_LIMIT.requests),
    "X-RateLimit-Remaining": String(rl.remaining),
  };
  if (!rl.allowed) {
    return errorResponse(429, "Too many requests, slow down", { ...rlHeaders, "Retry-After": String(rl.retryAfter) });
  }

  const url = new URL(request.url);
  // Cache key ignores the method so HEAD can be answered from a GET entry.
  const cacheKey = new Request(url.toString(), { method: "GET" });
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const res = new Response(request.method === "HEAD" ? null : hit.body, hit);
      for (const [k, v] of Object.entries(rlHeaders)) res.headers.set(k, v);
      res.headers.set("X-Cache", "HIT");
      return res;
    }
  }

  const segments = url.pathname
    .replace(/^\/api\/?/, "")
    .split("/")
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });

  let result;
  try {
    result = await route(supabase(env), segments, url.searchParams);
  } catch (e) {
    if (e instanceof ApiError) return errorResponse(e.status, e.message, rlHeaders);
    return errorResponse(500, "Internal error", rlHeaders);
  }
  if (result === null) return errorResponse(404, `No such endpoint: ${url.pathname}`, rlHeaders);
  if (result instanceof Response) {
    for (const [k, v] of Object.entries(rlHeaders)) result.headers.set(k, v);
    return result;
  }

  const res = json(result, 200, {
    "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
    ...rlHeaders,
    "X-Cache": "MISS",
  });
  if (cache) waitUntil(cache.put(cacheKey, res.clone()));
  if (request.method === "HEAD") return new Response(null, res);
  return res;
}
