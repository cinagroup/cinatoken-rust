//! Model-string classification predicates — faithful ports of the model lists
//! in Go `common/model.go`. These branch behavior (e.g. token estimation,
//! routing) by inspecting the model name. Only the predicates needed so far are
//! ported; add siblings (`IsImageGenerationModel`, `IsOpenAIResponseOnlyModel`)
//! here as they are wired.

/// Go `common.OpenAITextModels` — substrings that mark a model as an OpenAI
/// text model. In Go these gate real tiktoken counting; here they gate the
/// `image_tokens` patch/tile estimator (non-OpenAI images use a flat fallback).
const OPENAI_TEXT_MODELS: &[&str] = &["gpt-", "o1", "o3", "o4", "chatgpt"];

/// Faithful port of Go `common.IsOpenAITextModel`: lowercase the name and test
/// whether it *contains* any `OPENAI_TEXT_MODELS` entry (substring, not prefix —
/// matching Go's `strings.Contains`).
pub fn is_openai_text_model(model: &str) -> bool {
    let lower = model.to_ascii_lowercase();
    OPENAI_TEXT_MODELS.iter().any(|needle| lower.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::is_openai_text_model as is_oa;

    #[test]
    fn openai_models_match() {
        assert!(is_oa("gpt-4o"));
        assert!(is_oa("gpt-4.1-mini"));
        assert!(is_oa("o1-preview"));
        assert!(is_oa("o3-mini"));
        assert!(is_oa("o4-mini"));
        assert!(is_oa("chatgpt-4o-latest"));
        // Case-insensitive, matching Go's ToLower.
        assert!(is_oa("GPT-4O"));
    }

    #[test]
    fn non_openai_models_do_not_match() {
        assert!(!is_oa("claude-3-5-sonnet"));
        assert!(!is_oa("gemini-2.0-flash"));
        assert!(!is_oa("deepseek-chat"));
        assert!(!is_oa(""));
    }
}
