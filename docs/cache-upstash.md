# Cache, Native Rate Limiting, and Upstash Redis

`cinatoken-cache` now defines the cache boundary used by the Worker runtime.
The REST request format follows the Upstash Redis REST API:
<https://upstash.com/docs/redis/features/restapi>.

- `KeyValueCache` for string get/set/delete;
- `CounterStore` for expiring counters;
- `RateLimiter` for request throttling decisions;
- `UpstashRedis<T>` for Upstash Redis REST command execution through an
  injected transport.

The Worker crate provides `WorkerRedisRestTransport`, which sends Redis commands
with `fetch` and `Authorization: Bearer <token>`.

## Configuration

Configure these bindings as Wrangler vars or secrets:

```powershell
wrangler secret put UPSTASH_REDIS_REST_URL
wrangler secret put UPSTASH_REDIS_REST_TOKEN
```

Local development can use `.dev.vars`:

```text
UPSTASH_REDIS_REST_URL=https://example.upstash.io
UPSTASH_REDIS_REST_TOKEN=replace-with-real-token
RELAY_CACHE_TTL_SECONDS=60
```

`GET /api/status` reports `upstash_redis: true` when both values are present.
`RELAY_CACHE_TTL_SECONDS` controls relay token/channel read-through cache TTL;
it defaults to `60`, and `0` disables relay read-through caching.

## Relay Rate Limiting

The tracked Wrangler environments use Cloudflare's native Rate Limiting
bindings by default:

```text
RELAY_RATE_LIMIT_BACKEND=native
RELAY_TOKEN_RATE_LIMITER=120 requests / 60 seconds
RELAY_IP_RATE_LIMITER=600 requests / 60 seconds
```

- Token and IP bindings use separate namespace IDs in development, staging,
  and production because Wrangler bindings do not inherit into named
  environments.
- Keys are scoped by route family. Token keys use the internal token/user ID;
  IP keys use a SHA-256 fingerprint rather than storing the raw address.
- Binding configuration is the limit authority. The Worker fails closed with
  a structured 503 when `native` is selected but either binding is missing or
  malformed.
- Cloudflare's binding is location-local, permissive, and eventually
  consistent. It is an admission-control mechanism, not quota accounting.
- `bun run check:cf:native-rate-limits` verifies all environment bindings,
  limits, periods, namespace separation, and backend vars.

The legacy Upstash counter path remains available only for an explicit
transition configuration:

```text
RELAY_RATE_LIMIT_BACKEND=upstash
RELAY_TOKEN_RATE_LIMIT_PER_WINDOW=120
RELAY_IP_RATE_LIMIT_PER_WINDOW=300
RELAY_RATE_LIMIT_WINDOW_SECONDS=60
```

An omitted backend preserves compatibility with old deployments: legacy limit
vars select Upstash; no limit vars disable rate limiting. New deployments must
use the explicit backend. `GET /api/status` reports `relay_rate_limit: true`
only when the selected backend and required bindings/credentials are usable.

## REST Command Shape

The Upstash client posts commands as JSON arrays:

```json
["GET", "token:1"]
```

Expiring counters use the Upstash transaction endpoint `/multi-exec`:

```json
[
  ["INCRBY", "rate:token", 1],
  ["EXPIRE", "rate:token", 60]
]
```

This keeps increment and TTL update together for legacy counter and cache
bookkeeping. Native relay admission does not issue these REST commands.

## Relay Cache Records

`cinatoken-relay` owns stable cache key helpers and versioned payload wrappers
for token/channel read-through caching.

- Token auth cache keys use `relay:auth:{fingerprint}:{model}:{client_ip}` so
  raw client API keys are not stored in Redis key names while model/IP-scoped
  auth decisions remain isolated.
- Channel cache keys use `relay:channel:{group}:{model}` with normalized
  lowercase components.
- Cached token and channel records include `schema_version`; readers reject
  future schema versions instead of silently accepting incompatible data.

The token fingerprint is deterministic key hygiene, not a cryptographic proof.
Redis contents and transport secrecy still depend on the Upstash REST token and
Cloudflare secret handling.

## Current Boundary

The cache layer is implemented and Worker-compatible. Relay token/IP/route
family admission uses native bindings, while relay token/channel read-through
caching continues to use `KeyValueCache` when Upstash Redis is configured and
`RELAY_CACHE_TTL_SECONDS` is not `0`.

Cache reads and writes are best-effort: Redis errors are logged as Worker
warnings and the relay falls back to D1. D1 remains the source of truth. Cache
invalidation is still TTL-based; explicit invalidation should be added when the
admin/dashboard mutation paths are ported.
