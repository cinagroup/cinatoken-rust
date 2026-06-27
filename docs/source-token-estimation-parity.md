# Source Request-Time Token Estimation Parity (G4)

Date: 2026-06-25

Status: canonical, source-derived specification of how Go estimates request
tokens **before** the upstream call. This is the open `TokenCountMeta` gap called
out across the billing docs. Estimation feeds the pre-consume quota reservation;
final settlement uses actual upstream usage (see
`docs/source-billing-expr-parity.md`). Estimation parity therefore governs how
much quota is reserved/held, request admission under low balance, and abuse
controls — not the final charge.

## Source Of Truth

- `service/token_counter.go` — `EstimateRequestToken`, `getImageToken`,
  `CountTextToken`, `CountTokenInput`, `CountAudioToken{Input,Output}`,
  `CountTokenRealtime`.
- `service/tokenizer.go` — tiktoken encoder map (`cl100k_base` default).
- `types.TokenCountMeta` — the per-request count inputs.

## Gating (must replicate)

- `CountToken == false` -> estimate is `0` (no estimation at all).
- `RelayFormatOpenAIRealtime` -> `0` (realtime counted separately).
- Audio transcription/translation -> duration-based (below), not text.
- `GetMediaToken == false` -> do not fetch/measure media files.
- `GetMediaTokenNotStream == false && !stream` -> do not fetch/measure media.

## Text Estimation

`CountTextToken(text, model)`:

- If `IsOpenAITextModel(model)` -> tiktoken: `getTokenEncoder(model)` =
  `tokenizer.ForModel(model)` falling back to **`cl100k_base`** on error. Note
  `ForModel` returns **`o200k_base`** for the gpt-4o/o-series family, so the Rust
  side needs **both `cl100k_base` and `o200k_base`** encoders for parity.
- Else (non-OpenAI model) -> `EstimateTokenByModel(model, text)` heuristic (no
  tiktoken, to save resources). Rust must port the same heuristic, not tiktoken.
- `TokenTypeTextNumber` meta -> `utf8.RuneCountInString(text)` (rune count, not
  tokens) instead of tiktoken — a special case Rust must preserve.

`CountTokenInput(input, model)` accepts `string`, `[]string` (concatenated),
`[]interface{}` (each `fmt.Sprintf("%v")` then concatenated), else
`fmt.Sprintf("%v")` of the whole.

## OpenAI Chat Formatting Overhead (`RelayFormatOpenAI` only)

Added on top of text tokens:

```
+ ToolsCount    * 8
+ MessagesCount * 3      # per-message formatting
+ NameCount     * 3
+ 3                      # reply priming
```

These exact constants must match; they are not present for non-OpenAI relay
formats (Claude/Gemini/etc.).

## Image Token Estimation (`getImageToken`)

Only applied when `IsOpenAITextModel(model)`; otherwise each image file adds a
flat `520`. Algorithm:

- `glm-4*` -> fixed `1047`.
- Defaults: `baseTokens=85`, `tileTokens=170`.
- **Patch-based models** (32x32 patches, cap 1536, then `round(tokens *
  multiplier)`): `gpt-4.1-mini` x1.62, `gpt-4.1-nano` x2.46, `o4-mini` x1.72,
  `gpt-5-mini` x1.62, `gpt-5-nano` x2.46. Over-cap uses the scale-down formula in
  source (sqrt area fit + floor-patch adjustment).
- **Tile-based models** (fit within 2048x2048, scale shortest side to 768, count
  512px tiles -> `tiles*tileTokens + baseTokens`) with per-family base/tile:
  - `gpt-4o-mini` -> base 2833, tile 5667
  - `gpt-5` / `gpt-5-chat-latest` (non-mini/nano) -> base 70, tile 140
  - `o1` / `o3` / `o1-pro` -> base 75, tile 150
  - `computer-use-preview` -> base 65, tile 129
  - `4.1` / `4o` / `4.5` -> base 85, tile 170
- `detail == "low"` (non-patch) -> `baseTokens`.
- `GetMediaToken == false` -> `3 * baseTokens`.
- `GetMediaTokenNotStream == false && !stream` -> `3 * baseTokens`.
- `detail` empty/"auto" -> normalized to "high".
- Non-decodable but valid file type -> `3 * baseTokens`; width/height 0 and no
  format -> error.

## Audio Token Estimation

- **Transcription/translation (multipart)**: per file,
  `round(ceil(duration_seconds) / 60 * 1000)` (1 minute = 1000 tokens).
- **Realtime input**: `int(duration / 60 * 100 / 0.06)`.
- **Realtime output**: `int(duration / 60 * 200 / 0.24)`.

Duration comes from `common.GetAudioDuration` / `parseAudio` (decodes the audio
container).

## Other Media Fallbacks (per file in `meta.Files`)

| FileType | Tokens added |
| --- | --- |
| Image (OpenAI model) | `getImageToken(...)` |
| Image (non-OpenAI model) | 520 |
| Audio | 256 |
| Video | 4096 * 2 |
| File | 4096 |
| Unknown/default | 4096 |

## Parity-Critical Findings

1. **Two tiktoken vocabularies are required**: `cl100k_base` (default/older) and
   `o200k_base` (gpt-4o/o-series). Both vocab/merge tables increase the Worker
   bundle (Paid 10MB compressed cap, §21.7). Load large vocab from KV/R2 or embed
   carefully; measure bundle and CPU.
2. **Audio duration parsing decodes the audio container** — not WASM-friendly.
   Options: parse only the header/metadata for duration (lightweight, format-
   specific), estimate from byte size, or offload to a Cloudflare Container
   (§21.4). Pick one and document the accuracy tradeoff.
3. **Image dimension decoding** needs width/height. A lightweight image-header
   parser (PNG/JPEG/WebP/GIF) in WASM is feasible and preferable to full decode;
   the algorithm only needs dimensions, not pixels.
4. **Non-OpenAI text uses a heuristic, not tiktoken** (`EstimateTokenByModel`);
   porting tiktoken for those models would diverge from Go. Port the heuristic.
5. **These are estimates, not the charge.** Final settlement uses upstream usage.
   Over-estimation can wrongly reject low-balance requests; under-estimation
   weakens abuse protection. Define an acceptable estimate-vs-actual tolerance
   band per route family in the billing runbook.
6. **The OpenAI overhead constants and image base/tile tables are model-string
   matched** (prefix/contains). Rust must use the same matching order and
   precedence (patch-based checked before tile-based; specific before generic).

## Rust Status And Checklist

Implementation status (verified 2026-06-25): `crates/tokenizer/src/lib.rs`
implements the **heuristic** `EstimateToken` family dispatch (gemini/claude/
openai) — intentionally approximate (±20-30% vs real BPE). **Real tiktoken
(cl100k/o200k) is NOT implemented**; OpenAI models currently use the heuristic
too (the crate comment defers real `tiktoken` to a native-server build). Image
and audio token algorithms are not in the crate. So the OpenAI text path diverges
from Go (which uses real BPE for GPT/o-series). Gaps to close for G4:

1. Real `cl100k_base`/`o200k_base` tiktoken. The **BPE merge core** is ported as
   pure `cinatoken_core::bpe::bpe_token_count` (ranks injected). **cl100k_base
   encoder DONE 2026-06-27**: `cinatoken_core::tiktoken` adds the hand-rolled
   `cl100k_base` GPT pre-tokenizer (`pre_tokenize_cl100k` — a faithful
   ordered-alternative scanner for the published regex, avoiding a look-ahead
   regex dependency), a `.tiktoken` mergeable-rank parser (`parse_mergeable_ranks`),
   and the glue (`count_bpe_tokens_cl100k`). Adversarially verified against real
   Python `tiktoken` 0.13.0 + the real 100,256-entry cl100k vocab: 0 count
   mismatches over ~15.7k strings and millions of pre-tokenizer fuzz inputs (the
   one bug found — `U+017F` long-s case-folding in the contraction rule — is
   fixed). Documented approximation: `\p{L}`/`\p{N}` ↔ `char::is_alphabetic`/
   `is_numeric` (differs only on exotic `Nl`/`No` code points like Roman
   numerals; acceptable for a reserve estimate). **o200k_base pre-tokenizer DONE
   2026-06-27** (`pre_tokenize_o200k`/`count_bpe_tokens_o200k`): the case-split
   A/B word rule (camelCase boundaries) with attached contractions and the `/`
   trailing class; `\p{L}`/`\p{N}`/`\p{M}` and the upper/lower letter classes are
   now resolved from **exact Unicode general categories** (`unicode-general-category`
   crate, no_std/WASM-ok), which also removed the cl100k `is_alphabetic`/
   `is_numeric` approximation. 17 unit tests; cl100k was differentially verified
   vs real Python `tiktoken` earlier. CAVEAT: the o200k adversarial differential
   verification vs real `tiktoken` o200k_base did not finish (session limit) —
   **re-run it** before wiring o200k into billing. Remaining: load the
   mergeable-rank vocab from KV/R2 at runtime (do not embed ~1.7 MB, §21.7) and
   wire `count_bpe_tokens_*` into the request text estimator for OpenAI models,
   replacing the heuristic there.
2. Port the non-OpenAI `EstimateTokenByModel` heuristic and the
   `TokenTypeTextNumber` rune-count path — **DONE 2026-06-26**. `crates/tokenizer`
   is now a faithful per-rune port of Go `EstimateToken`: all 10 weighted
   classes per family (Word/Number/CJK/Symbol/MathSymbol/URLDelim/AtSign/Emoji/
   Newline/Space) with the exact Go multiplier values, the Latin↔Number
   word-type-transition state machine, the correct `is_url_delim`
   (`/:?&=;#%`, not the prior wrong set), `is_math_symbol` (explicit set + 3
   ranges), `is_emoji` (incl. `0x1F600-0x1F64F`), and `ceil(sum)` rounding.
   Previously the Rust estimator diverged algorithmically (word-boundary
   tokenization with heuristic `/4` `/3` divisions that don't exist in Go),
   had wrong multipliers, and misclassified url-delims/`@` — so missing-usage
   estimates were materially off.
3. OpenAI formatting overhead (8/3/3/3) — **done** as
   `cinatoken_core::request_tokens::openai_chat_format_overhead`, and **gated on
   `RelayFormatOpenAI` (DONE 2026-06-27)**: the request estimator now takes an
   `is_openai_chat` flag, set from `RelayEndpoint::uses_openai_chat_format()`
   (request route == OpenAI `chat/completions`). Previously the overhead was
   added whenever a `messages` array was present, which over-counted Anthropic
   `/v1/messages` requests (they also carry `messages`); now only OpenAI
   chat-format requests get it. Bounded to the preflight reserve; settlement
   uses upstream usage.
4. Port `getImageToken` exactly — **done** as the pure
   `cinatoken_core::image_tokens::image_tokens` (model table, patch/tile,
   multipliers, the 1536-cap scale-down, detail/media flags; 7 tests).
   Image-dimension source + wiring — **DONE 2026-06-27**. The lightweight
   header parser is `cinatoken_core::image_dims::image_dimensions`
   (PNG/JPEG/GIF/WebP, header-only, 8 tests) — the WASM substitute for Go's
   `image.DecodeConfig`/`webp.DecodeConfig` in `GetImageConfig`. It is wired
   into the request estimator (`relay.rs::image_token_estimate`): for OpenAI
   text models (`cinatoken_core::is_openai_text_model`, port of
   `common.IsOpenAITextModel`) it decodes inline images (base64 data URLs and
   raw base64 `data` fields) and calls `image_tokens` with Go's env-default
   media flags (`GetMediaToken=true`, `GetMediaTokenNotStream=false`), so
   streaming requests get the precise patch/tile count, non-stream requests get
   `3*baseTokens`, and `detail=low` gets `baseTokens` — matching Go. The
   dimension-independent short-circuits Go runs *before* `GetImageConfig`
   (`detail=low`, the media-token flags, the non-stream gate) are applied first
   (`image_tokens_needs_dimensions`), so they match Go even for remote/
   undecodable images that carry no inline bytes — no egress required.
   Non-OpenAI models add the flat `520` (Go's else branch). **Known divergence**:
   only when the count genuinely needs pixels (streaming + non-`low` detail) and
   the image is a *remote* URL or undecodable does Rust fall back to the flat
   `520`; Go fetches the URL (`LoadFileSource`) and decodes it. The preflight
   estimator skips that egress (ties into SSRF wiring, ssrf-parity 4.5). HEIF/
   HEIC inline images are also undecodable here and take the same fallback. This
   affects only the reserved-quota estimate — settlement uses upstream usage.
5. Audio duration formulas — **done** in `core::request_tokens`
   (`audio_transcription_tokens`, `realtime_audio_{input,output}_tokens`, with
   Go's round-vs-truncate). Remaining: a duration source (header parse / size
   estimate / Container).
6. Media fallback constants — **done** (`core::request_tokens` consts:
   `NON_OPENAI_IMAGE_TOKENS`/`AUDIO_FILE_TOKENS`/`VIDEO_FILE_TOKENS`/`FILE_TOKENS`);
   wire the per-file-type selection + feature-flag gating.
7. Add Go<->Rust golden fixtures for each of the above and wire into the billing
   shadow comparison.

## Wire-In

- `docs/source-billing-expr-parity.md` gap #4 (image/audio variables) depends on
  this estimation parity.
- `docs/billing-parity-runbook.md` Request-time estimate fixtures and the
  estimate tolerance band consume this spec.
- `docs/production-readiness-matrices.md` Billing matrix "Request-time token
  estimate" row references this file.
- The audio-duration / image-decode offload decision ties to Cloudflare
  Containers (`docs/cinatoken-rust-migration-plan.md` §21.4).
