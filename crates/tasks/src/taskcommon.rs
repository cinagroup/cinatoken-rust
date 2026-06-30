//! Shared task helpers ported from
//! `relay/channel/task/taskcommon/helpers.go`.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::Value;

/// Encode an upstream operation name to a URL-safe, unpadded base64 local task
/// id — Go `EncodeLocalTaskID` (`base64.RawURLEncoding`). Used by providers
/// (e.g. Gemini/Veo) whose upstream "task id" is a long operation name.
pub fn encode_local_task_id(name: &str) -> String {
    URL_SAFE_NO_PAD.encode(name.as_bytes())
}

/// Decode a local task id back to the upstream operation name — Go
/// `DecodeLocalTaskID`. Errors on malformed base64 or non-UTF-8 bytes.
pub fn decode_local_task_id(id: &str) -> Result<String, String> {
    let bytes = URL_SAFE_NO_PAD
        .decode(id.as_bytes())
        .map_err(|err| format!("decode local task id failed: {err}"))?;
    String::from_utf8(bytes).map_err(|err| format!("decode local task id failed: {err}"))
}

/// Go `taskcommon.DefaultString`: `value` unless it is empty, then `fallback`.
pub fn default_string<'a>(value: &'a str, fallback: &'a str) -> &'a str {
    if value.is_empty() {
        fallback
    } else {
        value
    }
}

/// Go `taskcommon.DefaultInt`: `value` unless it is zero, then `fallback`.
pub fn default_int(value: i64, fallback: i64) -> i64 {
    if value == 0 {
        fallback
    } else {
        value
    }
}

/// Merge a provider's passthrough `metadata` into a `target` payload value — a
/// port of Go `taskcommon.UnmarshalMetadata`. The `model` key is dropped first
/// (Go deletes it to prevent a metadata-driven billing bypass), then metadata's
/// top-level fields are shallow-merged onto the target object (Go unmarshals the
/// metadata JSON into the already-populated target, setting present keys).
///
/// Apply this to the payload-as-`Value`, then deserialize back into the typed
/// provider payload — the deserialize step drops metadata keys that aren't real
/// payload fields, matching Go's typed `json.Unmarshal`. No-op when either side
/// isn't a JSON object or when `metadata` is null/absent.
pub fn merge_metadata(target: &mut Value, metadata: &Value) {
    let Some(meta) = metadata.as_object() else {
        return;
    };
    let Some(target) = target.as_object_mut() else {
        return;
    };
    for (key, value) in meta {
        if key == "model" {
            continue;
        }
        target.insert(key.clone(), value.clone());
    }
}

/// Recursively merge `source` into `target`: nested objects are deep-merged
/// (source keys override or recurse into matching target keys), and scalars or
/// arrays replace. This mirrors Go's `json.Unmarshal` into an already-populated
/// struct — which sets present fields and recurses into nested structs — and is
/// what Ali's metadata merge needs (it unmarshals raw metadata into the nested
/// request without stripping `model`, unlike [`merge_metadata`]).
pub fn merge_value_deep(target: &mut Value, source: &Value) {
    match (target, source) {
        (Value::Object(target), Value::Object(source)) => {
            for (key, value) in source {
                merge_value_deep(target.entry(key.clone()).or_insert(Value::Null), value);
            }
        }
        (target, source) => *target = source.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_matches_raw_url_base64() {
        // base64.RawURLEncoding of "hello" (standard "aGVsbG8=" without padding).
        assert_eq!(encode_local_task_id("hello"), "aGVsbG8");
    }

    #[test]
    fn round_trips_operation_names() {
        for name in [
            "operations/abc-123",
            "models/veo-3.0/operations/9f8e?x=1",
            "",
        ] {
            let id = encode_local_task_id(name);
            // URL-safe + unpadded: never contains +, /, or =.
            assert!(!id.contains(['+', '/', '=']), "{id}");
            assert_eq!(decode_local_task_id(&id).unwrap(), name);
        }
    }

    #[test]
    fn decode_rejects_invalid_base64() {
        // '!' is not in the base64url alphabet.
        assert!(decode_local_task_id("not!valid").is_err());
    }

    #[test]
    fn merge_value_deep_recurses_objects() {
        use serde_json::json;
        let mut target = json!({"model": "m", "parameters": {"size": "1080", "duration": 5}});
        // Nested object deep-merges (size kept, seed added); scalar overrides.
        merge_value_deep(
            &mut target,
            &json!({"parameters": {"seed": 42, "duration": 8}, "extra": true}),
        );
        assert_eq!(
            target,
            json!({"model": "m", "parameters": {"size": "1080", "duration": 8, "seed": 42}, "extra": true})
        );
    }

    #[test]
    fn default_helpers() {
        assert_eq!(default_string("x", "fb"), "x");
        assert_eq!(default_string("", "fb"), "fb");
        assert_eq!(default_int(7, 5), 7);
        assert_eq!(default_int(0, 5), 5);
    }

    #[test]
    fn merge_metadata_strips_model_and_shallow_merges() {
        use serde_json::json;

        // model is dropped; other keys are merged/overwritten.
        let mut target = json!({"a": 1, "resolution": "720p"});
        merge_metadata(
            &mut target,
            &json!({"model": "evil", "ratio": "16:9", "a": 2}),
        );
        assert_eq!(
            target,
            json!({"a": 2, "resolution": "720p", "ratio": "16:9"})
        );

        // Null / non-object metadata is a no-op.
        let mut target = json!({"a": 1});
        merge_metadata(&mut target, &Value::Null);
        assert_eq!(target, json!({"a": 1}));
    }
}
