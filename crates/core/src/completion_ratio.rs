//! Hardcoded completion-ratio table — faithful port of Go
//! `setting/ratio_setting.getHardcodedCompletionModelRatio`
//! (`model_ratio.go:505`).
//!
//! Go `GetCompletionRatio` applies this precedence (after
//! `format_matching_model_name`):
//! 1. if the name contains `/`, an options-map hit wins;
//! 2. `hardcoded_completion_ratio(name)` — if its bool (`authoritative`) is
//!    true, that value wins;
//! 3. otherwise an options-map hit wins;
//! 4. otherwise the hardcoded value (a soft default).
//!
//! This module provides only step 2 (the pure, options-free table). The caller
//! (billing `pricing.rs::completion_ratio`, which owns the options map) wires
//! the precedence. The current `pricing.rs` defaults completion ratio to `1.0`
//! with no table — this fills that documented gap. See
//! `docs/source-pricing-ratio-parity.md`.

/// Return `(ratio, authoritative)` for a model name. `authoritative == true`
/// means the hardcoded value wins over the operator's completion-ratio map;
/// `false` means it is a soft default the map may override. Branch order is
/// significant and mirrors Go exactly.
//
// Several adjacent branches return the same value but are kept distinct to mirror
// the Go source 1:1 (e.g. gemini-1.5 and gemini-2.0 both -> 4), so the
// collapsible-branch lints are intentionally allowed here.
#[allow(clippy::if_same_then_else)]
pub fn hardcoded_completion_ratio(name: &str) -> (f64, bool) {
    // Reserved/wildcard models (e.g. `*-all`, normalized `*-gizmo-*`).
    if name.ends_with("-all") || name.ends_with("-gizmo-*") {
        return (2.0, false);
    }

    if name.starts_with("gpt-") {
        if name.starts_with("gpt-4o") {
            if name == "gpt-4o-2024-05-13" {
                return (3.0, true);
            }
            if name.starts_with("gpt-4o-mini-tts") {
                return (20.0, false);
            }
            return (4.0, false);
        }
        if name.starts_with("gpt-5") {
            if name.starts_with("gpt-5.5") {
                return (6.0, true);
            }
            if name.starts_with("gpt-5.4") {
                if name.starts_with("gpt-5.4-nano") {
                    return (6.25, true);
                }
                return (6.0, true);
            }
            return (8.0, true);
        }
        if name.starts_with("gpt-4.5-preview") {
            return (2.0, true);
        }
        if name.starts_with("gpt-4-turbo")
            || name.ends_with("gpt-4-1106")
            || name.ends_with("gpt-4-1105")
        {
            return (3.0, true);
        }
        // Plain gpt-4 family default.
        return (2.0, false);
    }

    if name.starts_with("o1") || name.starts_with("o3") {
        return (4.0, true);
    }
    if name == "chatgpt-4o-latest" {
        return (3.0, true);
    }

    if name.contains("claude-3") {
        return (5.0, true);
    } else if name.contains("claude-sonnet-4")
        || name.contains("claude-opus-4")
        || name.contains("claude-haiku-4")
    {
        return (5.0, true);
    }

    // NOTE: this `gpt-3.5` block is unreachable for any `gpt-3.5*` name because
    // the `gpt-` prefix block above already returns `(2.0, false)` for every
    // name starting with `gpt-`. It is dead code in Go too; ported verbatim so
    // the table stays a faithful 1:1 mirror, but `gpt-3.5*` resolves to
    // `(2.0, false)` in practice (see the `gpt_35_hits_the_gpt_prefix_default`
    // test).
    if name.starts_with("gpt-3.5") {
        if name == "gpt-3.5-turbo" || name.ends_with("0125") {
            return (3.0, true);
        }
        if name.ends_with("1106") {
            return (2.0, true);
        }
        return (4.0 / 3.0, true);
    }
    if name.starts_with("mistral-") {
        return (3.0, true);
    }
    if name.starts_with("gemini-") {
        if name.starts_with("gemini-1.5") {
            return (4.0, true);
        } else if name.starts_with("gemini-2.0") {
            return (4.0, true);
        } else if name.starts_with("gemini-2.5-pro") {
            return (8.0, false);
        } else if name.starts_with("gemini-2.5-flash") {
            if name.starts_with("gemini-2.5-flash-preview") {
                if name.ends_with("-nothinking") {
                    return (4.0, false);
                }
                return (3.5 / 0.15, false);
            }
            if name.starts_with("gemini-2.5-flash-lite") {
                return (4.0, false);
            }
            return (2.5 / 0.3, false);
        } else if name.starts_with("gemini-robotics-er-1.5") {
            return (2.5 / 0.3, false);
        } else if name.starts_with("gemini-3-pro") {
            if name.starts_with("gemini-3-pro-image") {
                return (60.0, false);
            }
            return (6.0, false);
        }
        // Other gemini default.
        return (4.0, false);
    }
    if name.starts_with("command") {
        return match name {
            "command-r" => (3.0, true),
            "command-r-plus" => (5.0, true),
            "command-r-08-2024" => (4.0, true),
            "command-r-plus-08-2024" => (4.0, true),
            _ => (4.0, false),
        };
    }
    if name.starts_with("ERNIE-Speed-")
        || name.starts_with("ERNIE-Lite-")
        || name.starts_with("ERNIE-Character")
        || name.starts_with("ERNIE-Functions")
    {
        return (2.0, true);
    }
    match name {
        "llama2-70b-4096" => (0.8 / 0.64, true),
        "llama3-8b-8192" => (2.0, true),
        "llama3-70b-8192" => (0.79 / 0.59, true),
        _ => (1.0, false),
    }
}

#[cfg(test)]
mod tests {
    use super::hardcoded_completion_ratio as r;

    #[test]
    fn reserved_models() {
        assert_eq!(r("deepseek-all"), (2.0, false));
        assert_eq!(r("gpt-4o-gizmo-*"), (2.0, false)); // normalized gizmo wildcard
    }

    #[test]
    fn gpt_family() {
        assert_eq!(r("gpt-4o-2024-05-13"), (3.0, true));
        assert_eq!(r("gpt-4o-mini-tts-preview"), (20.0, false));
        assert_eq!(r("gpt-4o-mini"), (4.0, false));
        assert_eq!(r("gpt-5.4-nano"), (6.25, true));
        assert_eq!(r("gpt-5.4-turbo"), (6.0, true));
        assert_eq!(r("gpt-5.5"), (6.0, true));
        assert_eq!(r("gpt-5-pro"), (8.0, true));
        assert_eq!(r("gpt-4.5-preview"), (2.0, true));
        assert_eq!(r("gpt-4-turbo-2024"), (3.0, true));
        assert_eq!(r("gpt-4-1106"), (3.0, true)); // suffix branch
        assert_eq!(r("gpt-4"), (2.0, false));
    }

    #[test]
    fn o_series_and_chatgpt() {
        assert_eq!(r("o1-preview"), (4.0, true));
        assert_eq!(r("o3-mini"), (4.0, true));
        assert_eq!(r("chatgpt-4o-latest"), (3.0, true));
    }

    #[test]
    fn claude() {
        assert_eq!(r("claude-3-5-sonnet"), (5.0, true));
        assert_eq!(r("claude-sonnet-4"), (5.0, true));
        assert_eq!(r("claude-opus-4-1"), (5.0, true));
    }

    #[test]
    fn gpt_35_hits_the_gpt_prefix_default() {
        // The dedicated gpt-3.5 block is unreachable in Go: the `gpt-` prefix
        // block returns (2.0, false) first. Faithful behavior is (2.0, false)
        // for every gpt-3.5* name, NOT the values in the dead block.
        assert_eq!(r("gpt-3.5-turbo"), (2.0, false));
        assert_eq!(r("gpt-3.5-turbo-0125"), (2.0, false));
        assert_eq!(r("gpt-3.5-turbo-1106"), (2.0, false));
        assert_eq!(r("gpt-3.5-turbo-16k"), (2.0, false));
    }

    #[test]
    fn gemini() {
        assert_eq!(r("gemini-1.5-pro"), (4.0, true));
        assert_eq!(r("gemini-2.0-flash"), (4.0, true));
        assert_eq!(r("gemini-2.5-pro"), (8.0, false));
        assert_eq!(r("gemini-2.5-flash-preview-05-20"), (3.5 / 0.15, false));
        assert_eq!(r("gemini-2.5-flash-preview-05-20-nothinking"), (4.0, false));
        assert_eq!(r("gemini-2.5-flash-lite"), (4.0, false));
        assert_eq!(r("gemini-2.5-flash"), (2.5 / 0.3, false));
        assert_eq!(r("gemini-3-pro-image"), (60.0, false));
        assert_eq!(r("gemini-3-pro"), (6.0, false));
        assert_eq!(r("gemini-experimental"), (4.0, false));
    }

    #[test]
    fn command_ernie_llama_and_default() {
        assert_eq!(r("command-r-plus"), (5.0, true));
        assert_eq!(r("command-light"), (4.0, false));
        assert_eq!(r("ERNIE-Speed-128K"), (2.0, true));
        assert_eq!(r("llama3-8b-8192"), (2.0, true));
        assert_eq!(r("llama3-70b-8192"), (0.79 / 0.59, true));
        assert_eq!(r("mistral-large"), (3.0, true));
        assert_eq!(r("deepseek-chat"), (1.0, false)); // unknown default
    }
}
