# RyftTiers Public API

A free, read-only JSON API for RyftTiers player tiers, leaderboards and
recent tests. It follows the conventions of the
[PrimeTiers Public API](https://github.com/PrimeTiers/Public-API), so tools
that already read PrimeTiers (such as Global Tier Tagger's PrimeTiers
adapter) can read RyftTiers with only a base URL change.

- **Base URL:** `https://ryfttiers.pages.dev/api`
- **Auth:** none. No API key needed.
- **Format:** JSON, UTF-8. CORS is open (`Access-Control-Allow-Origin: *`).
- **Caching:** successful responses are cached for 5 minutes
  (`Cache-Control: public, max-age=300`, `X-Cache: HIT|MISS`). New tiers can
  take up to 5 minutes to show up.
- **Rate limit:** about 120 requests per minute per IP. Over that you get
  `429` with a `Retry-After` header (seconds). `X-RateLimit-Limit` and
  `X-RateLimit-Remaining` are on every response.
- **User-Agent:** please send one that names your project.

## Data

**Gamemodes:** `vanilla`, `uhc`, `pot`, `nethop`, `smp`, `sword`, `axe`,
`mace`, `cart`, `spearmace` (also at `GET /api/gamemodes`).

**Tiers**, best first, with points: `HT1` 100, `LT1` 90, `HT2` 80, `LT2` 70,
`HT3` 60, `LT3` 50, `HT4` 40, `LT4` 30, `HT5` 20, `LT5` 10. A player's
`points` is the sum over all their gamemodes, the same score the website
uses.

**Regions:** `NA`, `EU`, `AS`, `ME`, `AU`, or `null`.
**Platforms:** `premium`, `bedrock`, `cracked`, or `null`.

**UUIDs:** every player object has a `uuid`: the Minecraft (Java) account
UUID, dashed and lower case. It is saved when a premium player verifies, by
resolving the name they verified with through Mojang at that moment. After
that RyftTiers follows the account by UUID, so a rename updates `username`
(checked every 12 hours) and the ranks stay with the account that earned
them. `uuid` is `null` for Bedrock and cracked players, and for premium
players who haven't verified yet (for example a name a tester typed in);
RyftTiers never guesses a UUID from an old name.

Usernames are matched case-insensitively.

## Endpoints

### `GET /api/players/{username}`

One player. `404` if they are not on RyftTiers.

```json
{
  "id": 1,
  "username": "Steve",
  "uuid": "8667ba71-b85a-4004-af54-457a9734eed7",
  "region": "NA",
  "platform": "premium",
  "points": 170,
  "tiers": [
    { "gamemode": "sword", "tier": "HT1", "points": 100, "updatedAt": "2026-11-03T00:00:00+00:00" },
    { "gamemode": "vanilla", "tier": "LT2", "points": 70, "updatedAt": "2026-11-01T00:00:00+00:00" }
  ]
}
```

`tiers` is sorted best tier first. A player with no tiers has `"tiers": []`.

### `GET /api/players?names=Steve,Alex,Ghost`

Batch lookup, up to 50 names. Every requested name appears exactly once,
either in `items` (found) or `missing` (not on RyftTiers, or not a valid
username). Duplicate names are only looked up once.

```json
{
  "count": 2,
  "items": [ { "id": 1, "username": "Steve", "...": "same as above" }, { "id": 2, "username": "Alex", "...": "" } ],
  "missing": ["Ghost"]
}
```

### `GET /api/players/uuid/{uuid}`

One player by Minecraft UUID, with or without dashes. Same response as
`/api/players/{username}`. `404` if no RyftTiers player has that UUID, `400`
if it isn't a UUID.

### `GET /api/players?uuids=uuid1,uuid2`

Batch lookup by UUID, up to 50, with the same `{ count, items, missing }`
shape as `?names=`. Each UUID that isn't found is echoed in `missing` exactly
as it was sent.

### `GET /api/leaderboard`

Every gamemode's leaderboard, as an object keyed by gamemode.

### `GET /api/leaderboard?gamemode=vanilla`

One gamemode, best tier first (ties by name).

```json
[
  { "rank": 1, "id": 2, "username": "Alex", "uuid": "ec561538-f3fd-461d-aff5-086b22154bce", "region": "EU", "platform": "premium", "tier": "HT1", "points": 100, "updatedAt": "2026-11-02T00:00:00+00:00" }
]
```

### `GET /api/leaderboard/global?limit=100`

Overall ranking by total points. `limit` 1-500, default 100.

```json
[
  { "rank": 1, "id": 1, "username": "Steve", "uuid": "8667ba71-b85a-4004-af54-457a9734eed7", "region": "NA", "platform": "premium", "points": 170, "tiers": { "sword": "HT1", "vanilla": "LT2" } }
]
```

### `GET /api/gamemodes`

```json
["vanilla", "uhc", "pot", "nethop", "smp", "sword", "axe", "mace", "cart", "spearmace"]
```

### `GET /api/gamemodes/{gamemode}/tiers?limit=50`

Most recently updated tiers in one gamemode, newest first. `limit` 1-100,
default 50.

```json
[
  { "id": 3, "username": ".BedrockGuy", "uuid": null, "region": "AS", "platform": "bedrock", "gamemode": "vanilla", "tier": "LT2", "points": 70, "updatedAt": "2026-11-04T00:00:00+00:00" }
]
```

### `GET /api/recent?limit=20`

Most recent tests, newest first. `limit` 1-100, default 20.

```json
[
  { "id": 9, "username": "Steve", "uuid": "8667ba71-b85a-4004-af54-457a9734eed7", "gamemode": "sword", "tier": "HT1", "previousTier": "LT1", "region": "NA", "testers": ["Tester"], "testedAt": "2026-11-03T00:00:00+00:00" }
]
```

### `GET /api/health`

`200 {"ok": true, "version": "1.1.0"}` when the database is reachable,
`503 {"ok": false, ...}` when it is not. Never cached.

### `GET /api`

Lists the endpoints above.

## Errors

Errors are JSON with the HTTP status repeated in the body, and are never
cached:

```json
{ "error": { "status": 404, "message": "Player \"Ghost\" is not on RyftTiers" } }
```

| Status | When |
| --- | --- |
| 400 | Bad username or UUID, missing `names`/`uuids`, more than 50 of them, bad `limit` |
| 404 | Unknown player, gamemode or endpoint |
| 405 | Anything other than GET, HEAD or OPTIONS |
| 429 | Rate limited, see `Retry-After` |
| 502 | The database could not be reached |

## For Global Tier Tagger

The simplest fit is the UUID lookup: `GET /api/players?uuids=...` for the
players in view, then show `tiers` for items whose `platform` is `premium`.
The `uuid` in each item is the account that earned the ranks, so there's no
need to resolve names with Mojang. `?names=` returns the same shape as
PrimeTiers' batch endpoint, if that adapter is easier to reuse.

RyftTiers gamemode names map onto the mod's modes: `vanilla` to crystal,
`nethop` to nethpot, `cart` to minecart, `spearmace` to spear-mace.

## Running it

The API is a Cloudflare Pages Function in this repo, deployed with the
website:

- `functions/api/[[path]].js` is the Pages entry point.
- `server/api.mjs` has all the logic.
- `_routes.json` makes only `/api/*` run the function, so the static site is
  untouched.

It reads Supabase through the public anon key, which Row Level Security
limits to public reads. To point it at another project, set
`SUPABASE_URL` and `SUPABASE_ANON_KEY` in the Pages project's environment
variables.

Tests: `node --test tests/api.test.mjs` (Node 18+, no install needed).
