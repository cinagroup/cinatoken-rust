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

Per the readiness matrices, request-time estimation is `Partial` with heuristic
counts. Gaps to close for G4:

1. Port `cl100k_base` + `o200k_base` tiktoken; golden-compare token counts for
   representative prompts vs Go (`tokenizer` crate already present).
2. Port the non-OpenAI `EstimateTokenByModel` heuristic and the
   `TokenTypeTextNumber` rune-count path.
3. Port the OpenAI formatting overhead constants (8/3/3/3) gated on
   `RelayFormatOpenAI`.
4. Port `getImageToken` exactly (model table, patch/tile, multipliers, caps,
   flags); choose an image-dimension source (header parser).
5. Port audio duration formulas; choose a duration source (header parse / size
   estimate / Container).
6. Port media fallback constants and the feature-flag gating.
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
