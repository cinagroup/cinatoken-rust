# Source Usage Parsing And SSE Settlement Parity (G3/G4)

Date: 2026-06-25

Status: canonical, source-derived specification of how Go extracts upstream
token usage from streaming (SSE) and non-stream responses, what it does when
usage is missing, and how the resulting `Usage` maps to billing. This is the
bridge between the relay response and settlement: wrong usage extraction means
wrong charges. Ties `docs/source-billing-expr-parity.md` (settlement) and
`docs/source-token-estimation-parity.md` (estimate fallback).

## Source Of Truth

- `dto/openai_response.go` — `Usage`, `InputTokenDetails`, `OutputTokenDetails`.
- `relay/channel/openai/relay-openai.go` — `OaiStreamHandler`, `OpenaiHandler`.
- `relay/channel/openai/{helper,usage,adaptor}.go` — `handleLastResponse`,
  `HandleFinalResponse`, `applyUsagePostProcessing`, stream-options injection.
- `service/usage_helpr.go` — `ResponseText2Usage`, `ValidUsage`.

## Usage Shape And Billing Mapping

`dto.Usage` carries the fields that become billing variables (see
`docs/source-billing-expr-parity.md` `BuildTieredTokenParams`):

| Usage field | Billing var |
| --- | --- |
| `prompt_tokens` | `p` (base, minus separately-priced subcategories) |
| `completion_tokens` | `c` |
| `prompt_tokens_details.cached_tokens` | `cr` (cache read) |
| `prompt_tokens_details.cached_creation_tokens` | `cc` |
| `claude_cache_creation_5_m_tokens` / `_1_h_tokens` | `cc` / `cc1h` |
| `prompt_tokens_details.image_tokens` / `audio_tokens` | `img` / `ai` |
| `completion_tokens_details.image_tokens` / `audio_tokens` | `img_o` / `ao` |
| `input_tokens` / `output_tokens` | Claude-format text-only base |

`len` is derived per `docs/source-billing-expr-parity.md` (Claude adds cache
back). `usage_semantic`/`usage_source` flag Claude-vs-OpenAI semantics and
local-estimate provenance.

## SSE Usage Extraction (`OaiStreamHandler`)

1. Scan the stream; accumulate streamed text in `responseTextBuilder` and count
   tool calls in `toolCount` (`processTokenData`).
2. Track `lastStreamData` (final chunk, usually carries usage) and
   `secondLastStreamData`.
3. **Audio models** (`model` contains "audio"): usage is read from the
   **second-to-last** chunk, not the last.
4. `handleLastResponse` parses usage from the final chunk and sets
   `containStreamUsage` when a valid usage object is present.
5. **Missing usage fallback** — if `!containStreamUsage`:
   `usage = ResponseText2Usage(streamedText, model, estimatedPromptTokens)` and
   `usage.CompletionTokens += toolCount * 7`.
6. `applyUsagePostProcessing` then `HandleFinalResponse`.

`ResponseText2Usage`: `PromptTokens = estimatedPromptTokens` (from pre-consume),
`CompletionTokens = EstimateTokenByModel(model, streamedText)`,
`TotalTokens = sum`, and marks `ContextKeyLocalCountTokens = true` (usage was
locally estimated, not upstream-reported).

`ValidUsage(u) = u != nil && (u.PromptTokens != 0 || u.CompletionTokens != 0)` —
a both-zero usage is invalid and triggers the fallback.

## stream_options Matrix (forward / strip / synthesize)

Two independent flags plus whether upstream actually sent usage:

- `SupportStreamOptions` (channel): the upstream supports `stream_options`. When
  true and streaming, the adaptor injects `stream_options:{include_usage:true}`
  into the upstream request to make it emit the final usage chunk. Channels that
  do not support it have `StreamOptions` stripped (`= nil`).
- `ShouldIncludeUsage` (client): the **client** asked for usage
  (`stream_options.include_usage`).
- `containStreamUsage`: upstream actually returned usage.

Behavior:

| upstream usage | client wants usage | client-facing action |
| --- | --- | --- |
| yes | yes | forward the usage chunk |
| yes | no | **strip** the usage chunk before forwarding (`handleLastResponse` when `!ShouldIncludeUsage`) |
| no | yes | **synthesize** a usage chunk from estimated usage (`HandleFinalResponse` when `ShouldIncludeUsage && !containStreamUsage`) |
| no | no | nothing extra; billing still uses estimated usage |

Billing always settles on the resolved `usage` (real or estimated), independent
of what the client sees.

## Parity-Critical Findings

1. **Missing-usage fallback is mandatory.** Many channels/clients stream without
   usage. If Rust does not estimate (`EstimateTokenByModel` over accumulated
   streamed text + `toolCount*7`), those requests settle to 0 or wrong quota.
   This is the single most important SSE settlement rule.
2. **Audio models read usage from the second-to-last chunk**, not the last.
   Missing this under-bills audio streams.
3. **`toolCount * 7` completion overhead** is added only on the estimate path;
   `toolCount` is accumulated during the stream. Match the constant and the
   counting.
4. **`ValidUsage` gate**: both-zero usage must be treated as absent. A provider
   that emits an empty usage object must still hit the estimate fallback.
5. **Client-vs-upstream `stream_options` are different axes.** Rust must inject
   `include_usage` upstream only when the channel supports it, and independently
   strip/forward/synthesize the client-facing usage chunk based on what the
   client asked for. Conflating them leaks or hides usage chunks.
6. **`usage_source`/`ContextKeyLocalCountTokens`** must be recorded so logs and
   shadow billing can distinguish upstream-reported vs locally-estimated usage.
7. **Subcategory details** (`cached_tokens`, image/audio token details, Claude
   5m/1h cache) must be parsed into the billing token params, and only excluded
   from `p`/`c` when the expression references them (AST exclusion in
   `docs/source-billing-expr-parity.md`).
8. **Non-stream** (`OpenaiHandler`) parses usage directly from the JSON body;
   same `ValidUsage` gate and same estimate fallback when absent.

## Rust Status And Checklist

Implementation status (verified 2026-06-25): usage parsing is implemented, but
the **missing-usage behavior diverges from Go**. When `usage.total_tokens <= 0`,
`crates/worker/src/relay.rs::refund_reason` classifies it `missing_usage` /
`missing_stream_usage` and **refunds the reserved quota** (settles to 0). Go
instead **estimates completion from the accumulated streamed text**
(`ResponseText2Usage` + `toolCount*7`) and bills that. So Rust currently
**under-bills** streams/responses that omit usage. Decide: match Go's
estimate-and-bill, or keep refund-on-missing as an intentional (customer-friendly)
divergence — and document it. Gaps to close:

1. Implement the missing-usage estimate fallback (prompt-estimate +
   `EstimateTokenByModel` over streamed text + `toolCount*7`) and the
   `ValidUsage` gate.
2. Implement audio-model second-to-last-chunk usage extraction.
3. Implement the `SupportStreamOptions` upstream injection and the
   client-facing strip/forward/synthesize matrix keyed on `ShouldIncludeUsage`.
4. Record `usage_source` (upstream vs local estimate) in audit/logs.
5. Map all subcategory details into billing token params with AST-gated
   exclusion; add Go<->Rust usage-parse golden fixtures per provider family.
6. Add live SSE smoke per family proving first byte, final usage (or estimate),
   stream completion, `[DONE]`, and mid-stream abort settlement.

## Wire-In

- `docs/route-provider-parity-runbook.md` Provider Adapter Contract "Usage
  parser" row consumes this spec.
- `docs/billing-parity-runbook.md` "Streaming/Non-stream usage reconciliation"
  rows and the `docs/production-readiness-matrices.md` Billing matrix reference
  this file.
- The estimate fallback uses `docs/source-token-estimation-parity.md`; the
  usage->billing mapping uses `docs/source-billing-expr-parity.md`.
