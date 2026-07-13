use serde_json::Value;

/// Ports the route-specific request behavior from Go's Jina adapter.
pub fn apply_jina_request(body: &mut Value, endpoint_path: &str) {
    if endpoint_path != "embeddings" {
        return;
    }
    if let Some(request) = body.as_object_mut() {
        request.remove("encoding_format");
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn embeddings_remove_openai_encoding_format_and_preserve_jina_fields() {
        let mut body = json!({
            "model": "jina-embeddings-v4",
            "input": ["hello"],
            "encoding_format": "base64",
            "dimensions": 512,
            "task": "retrieval.query",
            "normalized": true,
            "truncate": true,
            "embedding_type": "float"
        });

        apply_jina_request(&mut body, "embeddings");

        assert!(body.get("encoding_format").is_none());
        assert_eq!(body["model"], "jina-embeddings-v4");
        assert_eq!(body["input"], json!(["hello"]));
        assert_eq!(body["dimensions"], 512);
        assert_eq!(body["task"], "retrieval.query");
        assert_eq!(body["normalized"], true);
        assert_eq!(body["truncate"], true);
        assert_eq!(body["embedding_type"], "float");
    }

    #[test]
    fn non_embedding_routes_and_non_object_bodies_are_unchanged() {
        let mut rerank = json!({
            "model": "jina-reranker-v2-base-multilingual",
            "encoding_format": "preserved"
        });
        let original = rerank.clone();
        apply_jina_request(&mut rerank, "rerank");
        assert_eq!(rerank, original);

        let mut non_object = json!(["hello"]);
        apply_jina_request(&mut non_object, "embeddings");
        assert_eq!(non_object, json!(["hello"]));
    }
}
