# Route And Provider Parity Runbook

Date: 2026-06-22

Status: G3 production readiness runbook for relay route coverage, provider
adapter parity, request/response body modes, streaming behavior, usage parsing,
error mapping, and live smoke evidence.

## Purpose

Use this runbook to prove that Rust/Cloudflare relay routes behave closely
enough to the Go/VPS deployment before customer relay traffic moves to Rust.

This runbook supports G3 in `docs/production-migration-execution-plan.md` and
feeds:

- `docs/production-readiness-matrices.md`
- `docs/staging-smoke-runbook.md`
- `docs/billing-parity-runbook.md`
- `docs/observability-slo-security-runbook.md`
- `docs/cutover-rollback-runbook.md`

Official Cloudflare references checked on 2026-06-22:

- Workers best practices:
  <https://developers.cloudflare.com/workers/best-practices/workers-best-practices/>
- Workers Streams:
  <https://developers.cloudflare.com/workers/runtime-apis/streams/>
- Workers Fetch:
  <https://developers.cloudflare.com/workers/runtime-apis/fetch/>
- Workers limits:
  <https://developers.cloudflare.com/workers/platform/limits/>

Current Workers types check:

```text
@cloudflare/workers-types@4.20260621.1
```

Re-verify these references and generated binding/types evidence before a real
production canary. Platform limits and runtime APIs are operational contracts
that can change.

## G3 Principles

- Route parity is route-family plus provider-family plus body-mode parity.
- A local unit test is implementation evidence, not production readiness.
- A route is not canary-ready until the first-canary provider family has live
  smoke evidence.
- Any route that can receive unbounded or large bodies must stay blocked until
  it uses an explicit raw, multipart, or stream policy.
- Streaming routes must prove both client passthrough and audit/settlement
  completion.
- Billing shadow must run against the same live smoke requests used for G3.

## Worker Platform Guardrails

Record these facts in every route/provider parity report:

| Guardrail | Current Official Value Or Rule | Route Impact |
| --- | --- | --- |
| Memory | 128 MB per isolate | Never buffer unknown-size request/response bodies. |
| Response body size | No enforced Worker response body limit, but cache/product limits may still apply | Large responses must stream or have an endpoint-specific bounded transform. |
| Request body size | Depends on the Cloudflare account plan | File/multipart routes need explicit size policy and canary limit. |
| Outgoing connections | 6 simultaneous outgoing connections per request | Avoid fan-out provider retries inside one relay request. |
| Subrequests | Paid plan supports more than Free but remains bounded | Count D1/cache/provider calls in smoke and load tests. |
| `waitUntil` | For work that does not affect the client response; post-response work has limits | Audit/settlement work must be customer-safe if delayed or missing. |
| Streaming best practice | Stream large/unknown data instead of buffering | SSE, audio, image, file, and task artifacts must not use unbounded `.text()` or `.json()`. |

## Source Inventory

The canonical, already-extracted route list is `docs/source-route-inventory.md`,
the canonical channel-type -> adapter mapping is
`docs/source-provider-channel-matrix.md`, and the canonical channel-selection
algorithm (priority/weight/smoothing, affinity, auto cross-group retry) is
`docs/source-channel-selection-parity.md`. Start from those; the commands below
are for re-verifying or extending them against the live source.

Before changing G3 status, inspect source route and provider code:

```powershell
rg -n "Register|Handle|relay|video|dashboard|/v1|/mj|/suno|/videos" C:\cinagroup\cinatoken\router
rg -n "ChannelType|const .*Channel|relayMode|GetRequestURL|Convert|Usage" C:\cinagroup\cinatoken\relay C:\cinagroup\cinatoken\constant
```

Minimum source files:

- `C:\cinagroup\cinatoken\router\relay-router.go`
- `C:\cinagroup\cinatoken\router\video-router.go`
- `C:\cinagroup\cinatoken\router\api-router.go`
- `C:\cinagroup\cinatoken\router\dashboard.go`
- `C:\cinagroup\cinatoken\constant\channel.go`
- `C:\cinagroup\cinatoken\relay\channel`
- `C:\cinagroup\cinatoken\relay\relaymode`

Record each route with:

```text
Route family:
Method/path:
Source file:
Source handler:
Auth mode:
Provider family:
Source channel types:
Request body mode:
Response body mode:
Streaming support:
Usage parser:
Billing mode:
Current Rust file/test:
Live smoke status:
Rollback/defer decision:
```

## Body Mode Policy

Every route must declare exactly one request-body mode and one response-body
mode.

| Mode | Use For | Production Rule |
| --- | --- | --- |
| Bounded JSON request | Chat, completions, responses, embeddings, rerank, Anthropic Messages, Gemini generate/embed/count | Must enforce content-type policy, byte limit, JSON parse errors, and request snapshot rules. |
| Multipart request | Audio transcription/translation, image edits/variations, file upload style routes | Block until multipart extraction and upstream forwarding are implemented and live-smoked. |
| Raw bytes request | Binary/audio/file pass-through | Block until raw body size/streaming policy and upstream forwarding are implemented. |
| Pass-through stream request | Large uploads where buffering is unsafe | Block until streaming upload implementation exists and canary limits are documented. |
| Bounded JSON response | Non-stream transforms and usage parsers | Must have endpoint-specific limit and over-limit behavior. |
| Pass-through stream response | SSE, audio, image/task streams, unknown-size upstream responses | Must prove client stream and audit branch behavior. |
| Binary response passthrough | Audio speech and generated artifacts | Must not parse or log raw payload; record audit policy. |
| WebSocket | Realtime routes | Requires Durable Object/service decision before G7. |

Blocked routes must return explicit unsupported/501-style behavior and must not
fall through to an unbounded parser.

## Provider Adapter Contract

Each provider family must have an adapter report before canary:

| Area | Required Evidence |
| --- | --- |
| Channel selection | Source channel types, Rust provider-family filter, ability/group/model matching, fallback behavior. Priority/weight/smoothing, affinity, and auto cross-group retry parity per `docs/source-channel-selection-parity.md`. |
| Credential handling | Which header/query/body field carries the upstream key, and proof it is redacted. |
| URL mapping | Base URL normalization, path mapping, query preservation/removal, provider-specific aliases. |
| Header mapping | Required upstream headers, forbidden downstream headers, content-type handling. |
| Model mapping | Source model, mapped upstream model, nested request-body fields if applicable. |
| Request transform | Passthrough or provider-specific transform with fixtures. |
| Response transform | Passthrough, unified response transform, or binary/SSE pass-through policy. |
| Usage parser | JSON/SSE usage fields, cached/cache-creation/image/audio/rerank units, no-usage behavior. Final-chunk extraction, audio second-to-last chunk, `ValidUsage` gate, missing-usage estimate fallback, and the stream_options strip/forward/synthesize matrix per `docs/source-usage-parsing-parity.md`. |
| Error mapping | Upstream 4xx/5xx shape, timeout, invalid credentials, rate limits, provider unavailable. Retry decision, auto-ban (status + keyword, per-key), and recovery per `docs/source-retry-autoban-parity.md`. |
| Billing hook | Request estimate, frozen snapshot, actual usage, reserve/refund/additional delta. |
| Observability | Request ID, upstream request ID, provider family, channel ID, model, latency, quota delta. |
| Rollback | How to route the provider family back to Go/VPS or disable the channel group. |

## First-Canary Scope

Default Scenario A first-canary scope:

| Route | Provider Family | Required Before Canary |
| --- | --- | --- |
| `POST /v1/chat/completions` JSON | OpenAI-compatible | Auth rejection, channel selection, model mapping, usage parser, billing shadow, live smoke. |
| `POST /v1/chat/completions` SSE | OpenAI-compatible | First chunk, final usage or missing-usage refund, stream completion, client disconnect behavior. |
| `POST /v1/embeddings` | OpenAI-compatible | Batch-size policy, bounded response, usage parser, billing shadow. |
| `POST /v1/rerank` | Jina or Cohere | Request validation/transform, response transform if Cohere, billed unit parser. |
| `POST /v1/messages` JSON/SSE | Anthropic native | Header mapping, cache token usage, stream usage merge, billing shadow. |
| `POST /v1beta/models/{model}:generateContent` | Gemini native | Path parser, query handling, usageMetadata parser, model mapping. |
| `POST /v1beta/models/{model}:streamGenerateContent` | Gemini native | SSE passthrough, latest usageMetadata capture, stream completion. |

Do not add file upload, audio transcription/translation, realtime, Midjourney,
Suno, video, or payment routes to Scenario A unless their body/task mode has
separate live evidence and rollback ownership.

## Route Parity Checklist

For each route family:

1. Source route exists in the Go route inventory.
2. Rust route path/method matching is documented.
3. Auth behavior matches or intentionally differs with owner approval.
4. Request body mode is explicit.
5. Response body mode is explicit.
6. Streaming behavior is explicit.
7. Provider family selection is explicit.
8. Model mapping is fixture-tested.
9. Upstream URL/header/key mapping is fixture-tested.
10. Usage parser is fixture-tested.
11. Error mapping is fixture-tested.
12. Billing shadow runs for successful and failure-mode requests.
13. Structured logs include required G6 fields.
14. Live staging smoke records request IDs and upstream IDs where available.
15. Rollback/defer behavior is documented.

## Provider Smoke Matrix

Fill this matrix for every provider family in scope. Source channel-type
assignments are de-duplicated in `docs/source-provider-channel-matrix.md`
(canonical). Only channel types served by the generic `openai.Adaptor` belong to
the OpenAI-compatible row; OpenAI-shaped types with dedicated Go adapters (e.g.
40, 42, 43, 48, 53) and Moonshot (25, Claude bridge) need their own rows and
fixtures.

| Provider Family | Route Cases | Source Channel Types | Rust Status | Live Smoke | Billing Shadow | Rollback |
| --- | --- | --- | --- | --- | --- | --- |
| OpenAI-compatible (generic adapter) | Chat JSON/SSE, completions JSON/SSE, responses JSON/SSE, embeddings, images, audio speech | 1, 3, 6-10, 12, 13, 19, 20, 22, 31, 47 | Partial | TBD | TBD | Token/group/channel route back to Go. |
| Dedicated OpenAI-like adapters | Per-adapter explicit routes; xAI: chat/completions JSON/SSE, legacy completions JSON/SSE, Responses JSON/SSE, image generations JSON | 27, 40, 42, 43, 44, 48, 53; 25 (Claude+OpenAI bridge) | Partial: DeepSeek(43) and xAI(48) have dedicated Rust adapters; all others fail closed | xAI TBD | xAI TBD | Per-adapter Rust group disable; route back to Go. |
| Anthropic native | Messages JSON/SSE | 14 | Partial | TBD | TBD | Disable Anthropic Rust channel group. |
| Gemini native | generate, stream, embed, batch embed, countTokens | 24 | Partial | TBD | TBD | Disable Gemini Rust channel group. |
| Jina rerank | Rerank JSON | 38 | Partial | TBD | TBD | Disable rerank Rust group. |
| Cohere rerank | Rerank JSON transform | 34 | Partial | TBD | TBD | Disable rerank Rust group. |
| Regional adapters | Baidu, Zhipu, Ali, Tencent, Xunfei, 360, VolcEngine | 15-19, 23, 45, 46 | Planned | Blocked | Blocked | Keep on Go. |
| Self-hosted/application APIs | Ollama, Xinference, Dify, Coze, FastGPT | 4, 22, 37, 47, 49 | Planned | Blocked | Blocked | Keep on Go or use service/Tunnel decision. |
| Task/media providers | Midjourney, Suno, Kling, Jimeng, Vidu, Sora, Replicate/video | 2, 5, 36, 50-56 | Planned | Blocked | Blocked | Keep on Go until Queue/R2 task plan passes. |

## Live Smoke Evidence

For each smoke request, record:

```text
Case ID:
Commit:
Environment:
Route:
Provider family:
Channel ID:
Source channel type:
Token fingerprint:
Requested model:
Mapped model:
Request body mode:
Response body mode:
Streaming:
Expected status:
Actual status:
Worker request ID:
Upstream request ID:
First byte latency:
Total latency:
Usage fields:
Billing estimate:
Billing final/shadow delta:
Log/traces link:
Pass/fail:
Rollback note:
```

Required failure-mode smoke:

| Case | Expected |
| --- | --- |
| Missing token | Rejected before upstream call. |
| Disabled/expired/exhausted token | Rejected before upstream call. |
| Unsupported model | Rejected before upstream call. |
| No provider channel | Compatible error and no quota corruption. |
| Upstream 401/403 | Error mapped, reserve refunded or pending as documented. |
| Upstream 429 | Error mapped, channel/rate-limit policy recorded. |
| Upstream 5xx | Error mapped, rollback trigger assessed. |
| Timeout | Customer-safe error, reserve refund/pending behavior recorded. |
| Missing final usage | Refund or pending behavior follows billing runbook. |
| Client disconnect on stream | No double charge; audit behavior recorded. |

## G3 Go/No-Go

G3 can pass for a selected route/provider scope only when:

- route and provider matrix rows are complete for the selected scope;
- all selected routes have explicit body modes;
- live staging smoke passes for JSON and SSE paths in scope;
- usage parsing is fixture-tested and live-smoked;
- error mapping is fixture-tested and failure-smoked;
- billing shadow report exists for the same live smoke window;
- G6 logs/traces can find every smoke request or approved sample;
- large-body routes are either implemented with bounded/streaming proof or
  explicitly blocked;
- rollback route/channel/token selection is documented.

## Redacted G3 Report Template

```text
Report:
Commit:
Environment:
Scenario:
Route scope:
Provider scope:
Workers types version:
Cloudflare references rechecked:
Route matrix result:
Provider matrix result:
JSON smoke result:
SSE smoke result:
Failure-mode smoke result:
Usage parser result:
Billing shadow link:
G6 log/trace link:
Blocked routes:
Known deviations:
Go/no-go decision:
Approvers:
```
