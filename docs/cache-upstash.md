# Cache and Upstash Redis

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
```

`GET /api/status` reports `upstash_redis: true` when both values are present.

## Relay Rate Limiting

Relay rate limiting is disabled by default. It becomes active only when Upstash
Redis is configured and at least one relay limit is set:

```text
RELAY_TOKEN_RATE_LIMIT_PER_WINDOW=120
RELAY_IP_RATE_LIMIT_PER_WINDOW=300
RELAY_RATE_LIMIT_WINDOW_SECONDS=60
```

- `RELAY_TOKEN_RATE_LIMIT_PER_WINDOW` limits requests per token ID.
- `RELAY_IP_RATE_LIMIT_PER_WINDOW` limits requests per client IP when an IP is
  available from `cf-connecting-ip` or `x-forwarded-for`.
- `RELAY_RATE_LIMIT_WINDOW_SECONDS` defaults to `60`; it must be greater than
  `0` when set.

If limits are configured but Upstash Redis is not configured, the Worker logs a
warning and keeps the relay path open. `GET /api/status` reports
`relay_rate_limit: true` only when both Redis and a limit are configured.

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

This keeps increment and TTL update together for rate limiting and quota-cache
bookkeeping.

## Current Boundary

The cache layer is implemented and Worker-compatible, but relay auth/channel
lookups still read directly from D1. The next integration step is to use
`KeyValueCache` for token/channel read-through caching and `RateLimiter` for
token/IP throttling.
