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

Implementation status (UPDATE 2026-06-28): the **product decision is to match
Go (estimate-and-bill)**, and the estimate fallback is now **implemented and
wired behind a flag**. `RELAY_MISSING_USAGE_ESTIMATE_ENABLED` (`true`/`1`) gates
the new behavior; **default off** preserves the prior refund-on-missing path, so
deploying the code changes nothing until the operator flips the flag (the
charge-affecting, staging-gated cutover). When on:

- **Streaming** (`streaming_usage_summary` → `resolve_stream_usage`): the SSE
  accumulator (`cinatoken_relay::SseUsageAccumulator`) now accumulates the OpenAI
  streamed completion text (`delta.content` + `delta.reasoning_content` + each
  tool call's `function.name`/`arguments`) and `tool_count = max(len(tool_calls))`
  — a faithful port of Go `ProcessStreamResponse` (running max, not a sum). When
  the stream carried no valid usage (`!ValidUsage`, both prompt and completion
  zero) it settles on `response_text_to_usage(text, model, estPrompt)` +
  `tool_count*7`.
- **Non-stream** (`response_usage_summary` → `resolve_non_stream_usage`): mirrors
  Go `OpenaiHandler` — when `prompt_tokens == 0`, set prompt to the pre-consume
  estimate and completion to the upstream completion if non-zero, else the
  char-class estimate over `openai_response_completion_text` (choices' content +
  reasoning); no tool bump (Go adds it only on the stream path).
- Both apply only to the OpenAI-compatible provider (the text shapes are
  OpenAI-specific; Anthropic/Gemini emit reliable usage). `estimated_prompt_tokens`
  is carried on `RelayAuditContext` (the tiered preflight's frozen value, else
  recomputed from the body). A `console_log` marks each estimated settlement.

Remaining gaps to close:

1. **DONE 2026-06-28 (flag-gated)** — the missing-usage estimate fallback and the
   `ValidUsage`-based estimate decision. Pure pieces (`response_text_to_usage`,
   `valid_usage`) plus the SSE text/tool accumulation and the worker wiring above
   are implemented and host-tested.
   - **DONE 2026-06-28** — the *settlement* billing gate and `refund_reason` now
     use Go's `ValidUsage` (prompt-or-completion non-zero) when the flag is on,
     and the legacy `total > 0` when off (so flipping the flag off is a no-op; no
     total-only-usage regression). `record_relay_audit` records a `usage_source`
     audit field (`local_estimate` vs `upstream`, Go `ContextKeyLocalCountTokens`)
     carried on `RelayAuditContext::usage_locally_estimated` (#4).
   - **Still open**: flip the flag on after staging verification (the
     charge-affecting cutover); Anthropic/Gemini streamed-text accumulation; and
     the **audio second-to-last-chunk** extraction (#2) — note the current
     last-valid-usage accumulator semantics already extract audio usage when the
     final chunk carries no usage; only an audio model that emits a *different*
     usage in both the last and second-to-last chunks would diverge.
2. Implement audio-model second-to-last-chunk usage extraction.
3. **Upstream `stream_options` injection DONE 2026-06-28 (flag-gated,
   `RELAY_STREAM_OPTIONS_INJECT_ENABLED`)** — `cinatoken_relay::openai_compatible::
   apply_stream_options` ports Go's `streamSupportedChannels` set + the
   `openai/adaptor.go` inject / `compatible_handler.go` strip: for an
   OpenAI-compatible streaming request to a supported channel type it forces
   `stream_options.include_usage=true` so the upstream emits a real usage chunk
   (making the local estimate a true fallback); for unsupported channels or
   non-streaming requests it strips `stream_options`. Wired in the relay attempt
   loop after the per-channel request transform. **Still open**: the
   *client-facing* strip/synthesize keyed on `ShouldIncludeUsage` — Go defaults
   `ShouldIncludeUsage=true`, so forwarding the usage chunk matches Go's default;
   only a client that explicitly sends `stream_options.include_usage=false` would
   still receive the chunk (no SSE-stream strip), and the synthesize-from-estimate
   case requires SSE response transformation (separate, heavier change).
4. Record `usage_source` (upstream vs local estimate) in audit/logs — **DONE
   2026-06-28** (see item 1).
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
