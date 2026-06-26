//! Shared model-name normalization for matching against ratio/price/ability
//! maps.
//!
//! Mirrors Go `setting/ratio_setting.FormatMatchingModelName`
//! (`model_ratio.go:731`). The Go gateway applies this normalizer in three
//! places that must agree: pricing/ratio lookup, channel/ability selection, and
//! token model-limit matching. Centralizing it here (every crate depends on
//! `cinatoken-core`) keeps those three call sites consistent, per
//! `docs/parity-implementation-backlog.md` item 0.5.

/// Normalize a model name to its matching key.
///
/// Faithful port of Go `FormatMatchingModelName`:
/// - `gemini-2.5-{flash-lite,flash,pro}` names that carry a `-thinking-` budget
///   suffix collapse to the corresponding `-thinking-*` wildcard. The
///   most-specific prefix is checked first (`flash-lite` before `flash`), so a
///   `flash-lite` name never matches the `flash` branch.
/// - `gpt-4-gizmo*` / `gpt-4o-gizmo*` collapse to their `-*` wildcards.
/// - everything else is returned unchanged.
pub fn format_matching_model_name(name: &str) -> String {
    // gemini-2.5 thinking-budget wildcards. `else if` preserves the Go ordering:
    // "gemini-2.5-flash-lite" must be tested before "gemini-2.5-flash" because
    // the former is also a prefix-superset of the latter's test string.
    if name.starts_with("gemini-2.5-flash-lite") {
        return thinking_budget_wildcard(name, "gemini-2.5-flash-lite-thinking-*");
    } else if name.starts_with("gemini-2.5-flash") {
        return thinking_budget_wildcard(name, "gemini-2.5-flash-thinking-*");
    } else if name.starts_with("gemini-2.5-pro") {
        return thinking_budget_wildcard(name, "gemini-2.5-pro-thinking-*");
    }

    // gpt gizmo wildcards (independent `if`s in Go; gpt-4o-gizmo does not match
    // the gpt-4-gizmo prefix, so order between them is immaterial).
    if name.starts_with("gpt-4-gizmo") {
        return "gpt-4-gizmo-*".to_string();
    }
    if name.starts_with("gpt-4o-gizmo") {
        return "gpt-4o-gizmo-*".to_string();
    }

    name.to_string()
}

/// Go `handleThinkingBudgetModel`: the caller's prefix check already passed, so
/// only the `-thinking-` budget marker decides whether to collapse to the
/// wildcard.
fn thinking_budget_wildcard(name: &str, wildcard: &str) -> String {
    if name.contains("-thinking-") {
        wildcard.to_string()
    } else {
        name.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::format_matching_model_name as f;

    #[test]
    fn gemini_thinking_budget_collapses_to_wildcard() {
        assert_eq!(
            f("gemini-2.5-flash-lite-thinking-24576"),
            "gemini-2.5-flash-lite-thinking-*"
        );
        assert_eq!(
            f("gemini-2.5-flash-thinking-8192"),
            "gemini-2.5-flash-thinking-*"
        );
        assert_eq!(
            f("gemini-2.5-pro-thinking-32768"),
            "gemini-2.5-pro-thinking-*"
        );
    }

    #[test]
    fn gemini_without_thinking_is_unchanged() {
        assert_eq!(f("gemini-2.5-flash-lite"), "gemini-2.5-flash-lite");
        assert_eq!(f("gemini-2.5-flash"), "gemini-2.5-flash");
        assert_eq!(f("gemini-2.5-pro"), "gemini-2.5-pro");
        assert_eq!(f("gemini-2.5-flash-002"), "gemini-2.5-flash-002");
    }

    #[test]
    fn flash_lite_checked_before_flash() {
        // A flash-lite thinking name must collapse to the flash-lite wildcard,
        // never the flash one (most-specific-first ordering).
        assert_eq!(
            f("gemini-2.5-flash-lite-thinking-1"),
            "gemini-2.5-flash-lite-thinking-*"
        );
    }

    #[test]
    fn gpt_gizmo_wildcards() {
        assert_eq!(f("gpt-4-gizmo-g-abc123"), "gpt-4-gizmo-*");
        assert_eq!(f("gpt-4o-gizmo-g-xyz789"), "gpt-4o-gizmo-*");
        // gpt-4o-gizmo must not be swallowed by the gpt-4-gizmo branch.
        assert_ne!(f("gpt-4o-gizmo-g-1"), "gpt-4-gizmo-*");
    }

    #[test]
    fn plain_models_and_empty_unchanged() {
        assert_eq!(f("gpt-4o"), "gpt-4o");
        assert_eq!(f("claude-3-5-sonnet"), "claude-3-5-sonnet");
        assert_eq!(f(""), "");
    }
}
