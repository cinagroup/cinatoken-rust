//! Image input token estimation — pure port of Go
//! `service.getImageToken` (`service/token_counter.go:22`).
//!
//! The Go function also decodes the image to get width/height and consults
//! upstream feature flags; that I/O is the caller's job. This module is the
//! pure arithmetic: given the decoded `width`/`height`, the model name, the
//! `detail` hint, the stream flag, and the two media-token flags, return the
//! token count. Only applied for OpenAI text models (the caller gates that and
//! uses a flat fallback otherwise). Parity target:
//! `docs/source-token-estimation-parity.md`.

/// Media-token feature flags (Go `constant.GetMediaToken` /
/// `GetMediaTokenNotStream`).
#[derive(Debug, Clone, Copy)]
pub struct MediaTokenFlags {
    pub get_media_token: bool,
    pub get_media_token_not_stream: bool,
}

struct ModelImageProfile {
    base_tokens: i64,
    tile_tokens: i64,
    patch_multiplier: Option<f64>,
}

fn classify(model: &str) -> ModelImageProfile {
    let m = model.to_ascii_lowercase();

    // Patch-based models (32x32 patches, cap 1536, then * multiplier).
    let patch_multiplier = if m.contains("gpt-4.1-mini") {
        Some(1.62)
    } else if m.contains("gpt-4.1-nano") {
        Some(2.46)
    } else if m.starts_with("o4-mini") {
        Some(1.72)
    } else if m.starts_with("gpt-5-mini") {
        Some(1.62)
    } else if m.starts_with("gpt-5-nano") {
        Some(2.46)
    } else {
        None
    };

    if patch_multiplier.is_some() {
        return ModelImageProfile {
            base_tokens: 85,
            tile_tokens: 170,
            patch_multiplier,
        };
    }

    // Tile-based bases (default 85/170 for the 4o/4.1/4.5 family).
    let (base_tokens, tile_tokens) = if m.starts_with("gpt-4o-mini") {
        (2833, 5667)
    } else if m.starts_with("gpt-5-chat-latest")
        || (m.starts_with("gpt-5") && !m.contains("mini") && !m.contains("nano"))
    {
        (70, 140)
    } else if m.starts_with("o1") || m.starts_with("o3") || m.starts_with("o1-pro") {
        (75, 150)
    } else if m.contains("computer-use-preview") {
        (65, 129)
    } else {
        // 4.1 / 4o / 4.5 and the default.
        (85, 170)
    };
    ModelImageProfile {
        base_tokens,
        tile_tokens,
        patch_multiplier: None,
    }
}

/// Estimate image input tokens. `width`/`height` are the decoded pixel
/// dimensions (caller guarantees > 0). `detail` is the OpenAI `detail` hint
/// (`"low"`/`"high"`/`"auto"`/`""`).
pub fn image_tokens(
    width: i64,
    height: i64,
    model: &str,
    detail: &str,
    stream: bool,
    flags: MediaTokenFlags,
) -> i64 {
    match pre_dimension_result(model, detail, stream, flags) {
        Ok(tokens) => tokens,
        Err(profile) => {
            if let Some(multiplier) = profile.patch_multiplier {
                patch_based_tokens(width, height, multiplier)
            } else {
                tile_based_tokens(width, height, profile.base_tokens, profile.tile_tokens)
            }
        }
    }
}

/// Whether `image_tokens` would reach the patch/tile computation, i.e. whether
/// the result genuinely depends on the decoded `width`/`height`. Mirrors which
/// Go `getImageToken` short-circuits run *before* `GetImageConfig`: a `false`
/// result means Go produces the count without decoding the image, so a caller
/// that lacks decoded dimensions can still match Go exactly by calling
/// `image_tokens` with any dimensions; a `true` result means the count requires
/// the real pixels (and Go would fetch/decode to get them).
pub fn image_tokens_needs_dimensions(
    model: &str,
    detail: &str,
    stream: bool,
    flags: MediaTokenFlags,
) -> bool {
    pre_dimension_result(model, detail, stream, flags).is_err()
}

/// The part of Go `getImageToken` that runs before `GetImageConfig`. Returns
/// `Ok(tokens)` for the dimension-independent short-circuits (glm-4, `detail=low`
/// on non-patch models, the media-token flags / non-stream gate) or
/// `Err(profile)` when the patch/tile computation — which needs width/height —
/// must run.
fn pre_dimension_result(
    model: &str,
    detail: &str,
    stream: bool,
    flags: MediaTokenFlags,
) -> Result<i64, ModelImageProfile> {
    if model.to_ascii_lowercase().starts_with("glm-4") {
        return Ok(1047);
    }

    let profile = classify(model);
    let is_patch = profile.patch_multiplier.is_some();

    // detail=low short-circuit (non-patch only), matching Go.
    if detail == "low" && !is_patch {
        return Ok(profile.base_tokens);
    }
    // Media-token flags: when disabled, Go returns 3 * base.
    if !flags.get_media_token {
        return Ok(3 * profile.base_tokens);
    }
    if !flags.get_media_token_not_stream && !stream {
        return Ok(3 * profile.base_tokens);
    }

    Err(profile)
}

fn ceil_div(a: i64, b: i64) -> i64 {
    (a + b - 1) / b
}

fn patch_based_tokens(width: i64, height: i64, multiplier: f64) -> i64 {
    let raw_patches = ceil_div(width, 32) * ceil_div(height, 32);
    if raw_patches <= 1536 {
        return (raw_patches as f64 * multiplier).round() as i64;
    }
    // Scale down to fit 1536 patches, mirroring Go exactly.
    let area = (width * height) as f64;
    let mut r = ((32.0 * 32.0 * 1536.0) / area).sqrt();
    let w_scaled = width as f64 * r;
    let h_scaled = height as f64 * r;
    let adj_w = (w_scaled / 32.0).floor() / (w_scaled / 32.0);
    let adj_h = (h_scaled / 32.0).floor() / (h_scaled / 32.0);
    let adj = adj_w.min(adj_h);
    if !adj.is_nan() && adj > 0.0 {
        r *= adj;
    }
    let w_scaled = width as f64 * r;
    let h_scaled = height as f64 * r;
    let patches_w = (w_scaled / 32.0).ceil();
    let patches_h = (h_scaled / 32.0).ceil();
    let mut image_tokens = (patches_w * patches_h) as i64;
    if image_tokens > 1536 {
        image_tokens = 1536;
    }
    (image_tokens as f64 * multiplier).round() as i64
}

fn tile_based_tokens(width: i64, height: i64, base_tokens: i64, tile_tokens: i64) -> i64 {
    // Step 1: fit within a 2048x2048 square.
    let max_side = (width.max(height)) as f64;
    let fit_scale = if max_side > 2048.0 {
        max_side / 2048.0
    } else {
        1.0
    };
    let fit_w = (width as f64 / fit_scale).round() as i64;
    let fit_h = (height as f64 / fit_scale).round() as i64;

    // Step 2: scale so the shortest side is exactly 768.
    let min_side = fit_w.min(fit_h) as f64;
    if min_side == 0.0 {
        return base_tokens;
    }
    let short_scale = 768.0 / min_side;
    let final_w = (fit_w as f64 * short_scale).round() as i64;
    let final_h = (fit_h as f64 * short_scale).round() as i64;

    // Step 3: count 512px tiles.
    let tiles = ceil_div(final_w, 512) * ceil_div(final_h, 512);
    tiles * tile_tokens + base_tokens
}

#[cfg(test)]
mod tests {
    use super::*;

    const ON: MediaTokenFlags = MediaTokenFlags {
        get_media_token: true,
        get_media_token_not_stream: true,
    };

    #[test]
    fn glm4_is_fixed() {
        assert_eq!(image_tokens(1024, 1024, "glm-4v", "high", true, ON), 1047);
    }

    #[test]
    fn detail_low_returns_base_for_tile_models() {
        assert_eq!(image_tokens(2000, 2000, "gpt-4o", "low", true, ON), 85);
        assert_eq!(
            image_tokens(2000, 2000, "gpt-4o-mini", "low", true, ON),
            2833
        );
    }

    #[test]
    fn media_token_flag_disabled_returns_three_base() {
        let off = MediaTokenFlags {
            get_media_token: false,
            get_media_token_not_stream: true,
        };
        assert_eq!(
            image_tokens(2000, 2000, "gpt-4o", "high", true, off),
            3 * 85
        );
        // non-stream + not_stream disabled -> 3*base too.
        let nostream = MediaTokenFlags {
            get_media_token: true,
            get_media_token_not_stream: false,
        };
        assert_eq!(
            image_tokens(2000, 2000, "gpt-4o", "high", false, nostream),
            3 * 85
        );
    }

    #[test]
    fn tile_based_small_image() {
        // 512x512: fit (<=2048) -> 512x512; shortest side 768 -> scale 1.5 ->
        // 768x768; tiles ceil(768/512)=2 each -> 4 tiles; 4*170+85 = 765.
        assert_eq!(
            image_tokens(512, 512, "gpt-4o", "high", true, ON),
            4 * 170 + 85
        );
        // gpt-4o-mini uses 2833/5667.
        assert_eq!(
            image_tokens(512, 512, "gpt-4o-mini", "high", true, ON),
            4 * 5667 + 2833
        );
    }

    #[test]
    fn tile_based_o_series_base() {
        // o1: base 75, tile 150. 512x512 -> 4 tiles -> 4*150+75 = 675.
        assert_eq!(
            image_tokens(512, 512, "o1-preview", "high", true, ON),
            4 * 150 + 75
        );
    }

    #[test]
    fn patch_based_below_cap() {
        // gpt-4.1-mini x1.62. 64x64 -> ceil(64/32)=2 each -> 4 patches (<=1536)
        // -> round(4*1.62)=round(6.48)=6.
        assert_eq!(image_tokens(64, 64, "gpt-4.1-mini", "high", true, ON), 6);
        // detail=low does NOT short-circuit patch models -> still computed.
        assert_eq!(image_tokens(64, 64, "gpt-4.1-mini", "low", true, ON), 6);
    }

    #[test]
    fn needs_dimensions_matches_short_circuits() {
        // Streaming, high detail, flags on -> tile path needs pixels.
        assert!(image_tokens_needs_dimensions("gpt-4o", "high", true, ON));
        // Non-stream with not_stream flag off -> 3*base, no pixels needed.
        let not_stream_off = MediaTokenFlags {
            get_media_token: true,
            get_media_token_not_stream: false,
        };
        assert!(!image_tokens_needs_dimensions(
            "gpt-4o",
            "high",
            false,
            not_stream_off
        ));
        // detail=low on a tile model -> base, no pixels needed.
        assert!(!image_tokens_needs_dimensions("gpt-4o", "low", true, ON));
        // detail=low on a PATCH model still needs pixels (no low short-circuit).
        assert!(image_tokens_needs_dimensions("gpt-4.1-mini", "low", true, ON));
        // glm-4 is a fixed value -> no pixels needed.
        assert!(!image_tokens_needs_dimensions("glm-4v", "high", true, ON));
    }

    #[test]
    fn patch_based_over_cap_is_bounded() {
        // A very large image forces the scale-down path; result is capped at
        // 1536 patches then * multiplier, so it stays bounded.
        let t = image_tokens(8000, 8000, "gpt-5-nano", "high", true, ON);
        assert!(t > 0 && t <= (1536.0_f64 * 2.46).round() as i64, "got {t}");
    }
}
