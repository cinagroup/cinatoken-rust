//! Narrow D1 Sessions API bridge for worker-rs 0.5.
//!
//! Cloudflare exposes `withSession` and `getBookmark` on the Worker binding,
//! but worker-rs did not add typed wrappers until a later release. Keep the
//! compatibility surface private and never return the opaque bookmark.

use js_sys::{Array, Object, Promise, Reflect};
use sha2::{Digest, Sha256};
use wasm_bindgen::{prelude::wasm_bindgen, JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use worker::{D1Database, D1PreparedStatement};
use worker_sys::types::D1PreparedStatement as D1PreparedStatementSys;
use worker_sys::types::D1Result as D1ResultSys;

pub(crate) const D1_FIRST_PRIMARY_CONSTRAINT: &str = "first-primary";
const MAXIMUM_D1_BOOKMARK_BYTES: usize = 4_096;
const MAXIMUM_D1_ERROR_BYTES: usize = 512;
const D1_ERROR_TRUNCATION_MARKER: &str = "...[truncated]";
const D1_JAVASCRIPT_MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum D1BridgeFailure {
    SessionCreation,
    StatementPreparation,
    StatementBinding,
    BatchInvocation,
    BatchPromise,
    ResultSuccessRead,
    ResultErrorRead,
    ResultMetadataRead,
    ResultChangesRead,
    BookmarkRead,
}

impl D1BridgeFailure {
    fn message(self) -> &'static str {
        match self {
            Self::SessionCreation => "D1 session creation failed",
            Self::StatementPreparation => "D1 session statement preparation failed",
            Self::StatementBinding => "D1 session statement binding failed",
            Self::BatchInvocation => "D1 session batch invocation failed",
            Self::BatchPromise => "D1 session batch execution failed",
            Self::ResultSuccessRead => "D1 session batch result success status is unreadable",
            Self::ResultErrorRead => "D1 session batch result error detail is unreadable",
            Self::ResultMetadataRead => "D1 session batch result metadata is unreadable",
            Self::ResultChangesRead => "D1 session batch result meta.changes is unreadable",
            Self::BookmarkRead => "D1 session bookmark retrieval failed",
        }
    }
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(extends = js_sys::Object)]
    #[derive(Clone, Debug)]
    type D1DatabaseBridge;

    #[wasm_bindgen(
        structural,
        method,
        catch,
        js_name = withSession
    )]
    fn with_session(
        this: &D1DatabaseBridge,
        constraint_or_bookmark: &str,
    ) -> Result<D1DatabaseSessionBridge, JsValue>;

    #[wasm_bindgen(extends = js_sys::Object)]
    #[derive(Clone, Debug)]
    type D1DatabaseSessionBridge;

    #[wasm_bindgen(
        structural,
        method,
        catch,
        js_name = prepare
    )]
    fn session_prepare(
        this: &D1DatabaseSessionBridge,
        query: &str,
    ) -> Result<D1PreparedStatementSys, JsValue>;

    #[wasm_bindgen(
        structural,
        method,
        catch,
        js_name = batch
    )]
    fn session_batch(this: &D1DatabaseSessionBridge, statements: Array)
        -> Result<Promise, JsValue>;

    #[wasm_bindgen(
        structural,
        method,
        catch,
        js_name = getBookmark
    )]
    fn get_bookmark(this: &D1DatabaseSessionBridge) -> Result<Option<String>, JsValue>;
}

#[derive(Debug)]
pub(crate) struct D1Session {
    inner: D1DatabaseSessionBridge,
}

pub(crate) struct D1SessionBatchStatement {
    inner: D1PreparedStatementSys,
    owner: D1DatabaseSessionBridge,
}

pub(crate) struct D1SessionBatchResult {
    inner: D1ResultSys,
}

impl D1SessionBatchStatement {
    pub(crate) fn bind(self, values: &[JsValue]) -> worker::Result<Self> {
        let raw_values = values.iter().collect::<Array>();
        let inner = self
            .inner
            .bind(raw_values)
            .map_err(|error| redacted_d1_bridge_error(D1BridgeFailure::StatementBinding, error))?;
        Ok(Self {
            inner,
            owner: self.owner,
        })
    }
}

impl D1SessionBatchResult {
    pub(crate) fn success(&self) -> worker::Result<bool> {
        self.inner
            .success()
            .map_err(|error| redacted_d1_bridge_error(D1BridgeFailure::ResultSuccessRead, error))
    }

    pub(crate) fn error(&self) -> worker::Result<Option<String>> {
        self.inner
            .error()
            .map(|error| error.map(|message| bounded_d1_error_message(&message)))
            .map_err(|error| redacted_d1_bridge_error(D1BridgeFailure::ResultErrorRead, error))
    }

    pub(crate) fn meta_changes(&self) -> worker::Result<u64> {
        let meta = self.inner.meta().map_err(|error| {
            redacted_d1_bridge_error(D1BridgeFailure::ResultMetadataRead, error)
        })?;
        let changes = Reflect::get(meta.as_ref(), &JsValue::from_str("changes"))
            .map_err(|error| redacted_d1_bridge_error(D1BridgeFailure::ResultChangesRead, error))?;
        let changes = if changes.is_undefined() || changes.is_null() {
            None
        } else {
            changes.as_f64()
        };
        validate_d1_meta_changes(changes)
    }
}

impl D1Session {
    pub(crate) fn first_primary(database: &D1Database) -> worker::Result<Self> {
        let bridge = database
            .as_ref()
            .unchecked_ref::<D1DatabaseBridge>()
            .with_session(D1_FIRST_PRIMARY_CONSTRAINT)
            .map_err(|error| redacted_d1_bridge_error(D1BridgeFailure::SessionCreation, error))?;
        Ok(Self { inner: bridge })
    }

    pub(crate) fn prepare(&self, query: impl Into<String>) -> worker::Result<D1PreparedStatement> {
        self.inner
            .session_prepare(&query.into())
            .map(D1PreparedStatement::from)
            .map_err(|error| redacted_d1_bridge_error(D1BridgeFailure::StatementPreparation, error))
    }

    pub(crate) fn prepare_batch_statement(
        &self,
        query: impl Into<String>,
    ) -> worker::Result<D1SessionBatchStatement> {
        let inner = self.inner.session_prepare(&query.into()).map_err(|error| {
            redacted_d1_bridge_error(D1BridgeFailure::StatementPreparation, error)
        })?;
        Ok(D1SessionBatchStatement {
            inner,
            owner: self.inner.clone(),
        })
    }

    pub(crate) async fn batch(
        &self,
        statements: Vec<D1SessionBatchStatement>,
    ) -> worker::Result<Vec<D1SessionBatchResult>> {
        let expected_count = validate_batch_statement_count(statements.len())?;
        let raw_statements = Array::new_with_length(expected_count);
        for (index, statement) in statements.into_iter().enumerate() {
            if !Object::is(self.inner.as_ref(), statement.owner.as_ref()) {
                return Err(worker::Error::RustError(
                    "D1 session batch statement belongs to a different session".to_string(),
                ));
            }
            raw_statements.set(index as u32, statement.inner.into());
        }

        let raw_results = self
            .inner
            .session_batch(raw_statements)
            .map_err(|error| redacted_d1_bridge_error(D1BridgeFailure::BatchInvocation, error))?;
        let raw_results = JsFuture::from(raw_results)
            .await
            .map_err(|error| redacted_d1_bridge_error(D1BridgeFailure::BatchPromise, error))?;
        if !Array::is_array(&raw_results) {
            return Err(worker::Error::RustError(
                "D1 session batch returned a non-array result".to_string(),
            ));
        }
        let raw_results = raw_results.unchecked_into::<Array>();
        validate_batch_result_count(expected_count, raw_results.length())?;

        let results = raw_results
            .iter()
            .map(|result| D1SessionBatchResult {
                inner: result.unchecked_into::<D1ResultSys>(),
            })
            .collect::<Vec<_>>();
        for (index, result) in results.iter().enumerate() {
            let success = result.success().map_err(|_| {
                worker::Error::RustError(format!(
                    "D1 session batch result {index} has no readable success status"
                ))
            })?;
            if !success {
                let error = match result.error() {
                    Ok(Some(error)) if !error.is_empty() => error,
                    Ok(_) => "D1 returned no error detail".to_string(),
                    Err(_) => "D1 error detail is unreadable".to_string(),
                };
                return Err(worker::Error::RustError(format!(
                    "D1 session batch result {index} failed: {error}"
                )));
            }
        }
        Ok(results)
    }

    pub(crate) fn bookmark_sha256(&self) -> worker::Result<String> {
        let bookmark = self
            .inner
            .get_bookmark()
            .map_err(|error| redacted_d1_bridge_error(D1BridgeFailure::BookmarkRead, error))?
            .ok_or_else(|| {
                worker::Error::RustError(
                    "D1 first-primary session returned no bookmark after query".to_string(),
                )
            })?;
        bookmark_sha256(&bookmark)
    }
}

fn validate_batch_statement_count(statement_count: usize) -> worker::Result<u32> {
    if statement_count == 0 {
        return Err(worker::Error::RustError(
            "D1 session batch requires at least one statement".to_string(),
        ));
    }
    u32::try_from(statement_count).map_err(|_| {
        worker::Error::RustError("D1 session batch exceeds JavaScript array bounds".to_string())
    })
}

fn validate_batch_result_count(expected: u32, actual: u32) -> worker::Result<()> {
    if actual != expected {
        return Err(worker::Error::RustError(format!(
            "D1 session batch result count mismatch: expected {expected}, received {actual}"
        )));
    }
    Ok(())
}

fn validate_d1_meta_changes(changes: Option<f64>) -> worker::Result<u64> {
    let Some(changes) = changes else {
        return Err(worker::Error::RustError(
            "D1 session batch meta.changes is missing or not a number".to_string(),
        ));
    };
    if !changes.is_finite()
        || changes < 0.0
        || changes.fract() != 0.0
        || changes > D1_JAVASCRIPT_MAX_SAFE_INTEGER
    {
        return Err(worker::Error::RustError(
            "D1 session batch meta.changes is outside the non-negative safe-integer contract"
                .to_string(),
        ));
    }
    Ok(changes as u64)
}

fn redacted_d1_bridge_error<T>(failure: D1BridgeFailure, _untrusted_error: T) -> worker::Error {
    // The generic input has no formatting bound, so JS exception details cannot cross this bridge.
    let message = failure.message();
    debug_assert!(message.len() <= MAXIMUM_D1_ERROR_BYTES);
    worker::Error::RustError(message.to_string())
}

fn bounded_d1_error_message(message: &str) -> String {
    if message.len() <= MAXIMUM_D1_ERROR_BYTES {
        return message.to_string();
    }

    let mut prefix_end = MAXIMUM_D1_ERROR_BYTES - D1_ERROR_TRUNCATION_MARKER.len();
    while prefix_end > 0 && !message.is_char_boundary(prefix_end) {
        prefix_end -= 1;
    }
    let mut bounded = String::with_capacity(MAXIMUM_D1_ERROR_BYTES);
    bounded.push_str(&message[..prefix_end]);
    bounded.push_str(D1_ERROR_TRUNCATION_MARKER);
    bounded
}

fn bookmark_sha256(bookmark: &str) -> worker::Result<String> {
    if bookmark.is_empty()
        || bookmark.len() > MAXIMUM_D1_BOOKMARK_BYTES
        || bookmark.as_bytes().contains(&0)
    {
        return Err(worker::Error::RustError(
            "D1 session bookmark is outside the opaque bounded contract".to_string(),
        ));
    }
    Ok(format!("{:x}", Sha256::digest(bookmark.as_bytes())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_primary_constraint_is_exact() {
        assert_eq!(D1_FIRST_PRIMARY_CONSTRAINT, "first-primary");
    }

    #[test]
    fn bookmark_is_only_exposed_as_a_digest() {
        assert_eq!(
            bookmark_sha256("opaque-d1-bookmark-v1").unwrap(),
            "1b51cf4a299845f12b9234f6d1cb03c6a29bd4bdd5694c484b6f59ca891198e0"
        );
        let source = include_str!("d1_session.rs");
        let implementation = source.split("#[cfg(test)]").next().unwrap();
        let raw_bookmark_method = ["pub(crate) fn ", "bookmark("].concat();
        let log_primitive = ["console", "_log"].concat();
        let debug_primitive = ["console", "_debug"].concat();
        assert!(!implementation.contains(&raw_bookmark_method));
        assert!(!implementation.contains(&log_primitive));
        assert!(!implementation.contains(&debug_primitive));
    }

    #[test]
    fn bookmark_validation_is_bounded_without_interpreting_the_opaque_value() {
        assert!(bookmark_sha256("").is_err());
        assert!(bookmark_sha256(&"a".repeat(MAXIMUM_D1_BOOKMARK_BYTES + 1)).is_err());
        assert!(bookmark_sha256("bookmark\0suffix").is_err());
        assert!(bookmark_sha256("opaque:/+=_-\u{2603}").is_ok());
    }

    #[test]
    fn bridge_uses_only_the_documented_session_methods() {
        let source = include_str!("d1_session.rs");
        assert!(source.contains("js_name = withSession"));
        assert!(source.contains("js_name = prepare"));
        assert!(source.contains("js_name = batch"));
        assert!(source.contains("js_name = getBookmark"));
        let unconstrained = ["first", "-unconstrained"].concat();
        let fetch_primitive = ["fet", "ch("].concat();
        assert!(!source.contains(&unconstrained));
        assert!(!source.contains(&fetch_primitive));
    }

    #[test]
    fn batch_cardinality_contract_is_strict() {
        assert!(validate_batch_statement_count(0).is_err());
        assert_eq!(validate_batch_statement_count(1).unwrap(), 1);
        assert_eq!(
            validate_batch_statement_count(u32::MAX as usize).unwrap(),
            u32::MAX
        );
        if usize::BITS > u32::BITS {
            assert!(validate_batch_statement_count(u32::MAX as usize + 1).is_err());
        }

        assert!(validate_batch_result_count(2, 2).is_ok());
        assert!(validate_batch_result_count(2, 1).is_err());
        assert!(validate_batch_result_count(2, 3).is_err());
    }

    #[test]
    fn batch_meta_changes_requires_a_non_negative_safe_integer() {
        for invalid in [
            None,
            Some(f64::NAN),
            Some(f64::INFINITY),
            Some(f64::NEG_INFINITY),
            Some(-1.0),
            Some(0.5),
            Some(D1_JAVASCRIPT_MAX_SAFE_INTEGER + 1.0),
        ] {
            assert!(validate_d1_meta_changes(invalid).is_err());
        }
        assert_eq!(validate_d1_meta_changes(Some(0.0)).unwrap(), 0);
        assert_eq!(validate_d1_meta_changes(Some(42.0)).unwrap(), 42);
        assert_eq!(
            validate_d1_meta_changes(Some(D1_JAVASCRIPT_MAX_SAFE_INTEGER)).unwrap(),
            9_007_199_254_740_991
        );
    }

    #[test]
    fn batch_error_text_is_utf8_safe_and_bounded() {
        let exact = "a".repeat(MAXIMUM_D1_ERROR_BYTES);
        assert_eq!(bounded_d1_error_message(&exact), exact);

        for oversized in [
            format!(
                "TypeError: {}\n    at batch (worker.js:1:1)",
                "\u{96ea}".repeat(MAXIMUM_D1_ERROR_BYTES)
            ),
            format!(
                "{{\"name\":\"Error\",\"message\":\"{}\"}}",
                "\u{1f512}".repeat(MAXIMUM_D1_ERROR_BYTES)
            ),
            format!(
                "[object Object]\0{}\r\nSELECT secret FROM token",
                "\u{754c}\u{301}".repeat(MAXIMUM_D1_ERROR_BYTES)
            ),
        ] {
            let bounded = bounded_d1_error_message(&oversized);
            assert!(bounded.len() <= MAXIMUM_D1_ERROR_BYTES);
            assert!(bounded.ends_with(D1_ERROR_TRUNCATION_MARKER));
            assert!(
                oversized.starts_with(bounded.strip_suffix(D1_ERROR_TRUNCATION_MARKER).unwrap())
            );
        }
    }

    #[test]
    fn bridge_exception_details_are_fixed_bounded_and_redacted() {
        struct UnformattableException;

        let failures = [
            (
                D1BridgeFailure::SessionCreation,
                "D1 session creation failed",
            ),
            (
                D1BridgeFailure::StatementPreparation,
                "D1 session statement preparation failed",
            ),
            (
                D1BridgeFailure::StatementBinding,
                "D1 session statement binding failed",
            ),
            (
                D1BridgeFailure::BatchInvocation,
                "D1 session batch invocation failed",
            ),
            (
                D1BridgeFailure::BatchPromise,
                "D1 session batch execution failed",
            ),
            (
                D1BridgeFailure::ResultSuccessRead,
                "D1 session batch result success status is unreadable",
            ),
            (
                D1BridgeFailure::ResultErrorRead,
                "D1 session batch result error detail is unreadable",
            ),
            (
                D1BridgeFailure::ResultMetadataRead,
                "D1 session batch result metadata is unreadable",
            ),
            (
                D1BridgeFailure::ResultChangesRead,
                "D1 session batch result meta.changes is unreadable",
            ),
            (
                D1BridgeFailure::BookmarkRead,
                "D1 session bookmark retrieval failed",
            ),
        ];
        let hostile_details = [
            "TypeError: SELECT secret FROM token\n    at bridge (worker.js:1:1)".to_string(),
            "[object Object]\0{\"sql\":\"private\"}".to_string(),
            "\u{1f512}\u{5f02}\u{5e38}".repeat(MAXIMUM_D1_ERROR_BYTES * 4),
        ];

        for (failure, expected_message) in failures {
            for hostile_detail in &hostile_details {
                let worker::Error::RustError(message) =
                    redacted_d1_bridge_error(failure, hostile_detail)
                else {
                    panic!("bridge exception did not become RustError");
                };
                assert_eq!(message, expected_message);
                assert!(message.is_ascii());
                assert!(message.len() <= MAXIMUM_D1_ERROR_BYTES);
                for untrusted_fragment in [
                    "TypeError",
                    "SELECT secret",
                    "worker.js",
                    "[object Object]",
                    "private",
                    "\u{1f512}",
                    "\u{5f02}\u{5e38}",
                ] {
                    assert!(!message.contains(untrusted_fragment));
                }
            }
        }

        let worker::Error::RustError(message) =
            redacted_d1_bridge_error(D1BridgeFailure::BatchPromise, UnformattableException)
        else {
            panic!("bridge exception did not become RustError");
        };
        assert_eq!(message, "D1 session batch execution failed");
    }

    #[test]
    fn batch_bridge_is_session_owned_exception_safe_and_row_opaque() {
        let source = include_str!("d1_session.rs");
        let implementation = source.split("#[cfg(test)]").next().unwrap();
        for fragment in [
            "struct D1SessionBatchStatement",
            "owner: D1DatabaseSessionBridge",
            "pub(crate) fn bind(self, values: &[JsValue])",
            "values.iter().collect::<Array>()",
            ".bind(raw_values)",
            "owner: self.owner",
            ".session_prepare(&query.into())",
            "Object::is(self.inner.as_ref(), statement.owner.as_ref())",
            "fn session_batch(",
            "Result<Promise, JsValue>",
            "JsFuture::from(raw_results)",
            "Array::is_array(&raw_results)",
            "validate_batch_result_count(expected_count, raw_results.length())",
            "inner: result.unchecked_into::<D1ResultSys>()",
            "pub(crate) fn success(&self) -> worker::Result<bool>",
            "redacted_d1_bridge_error(D1BridgeFailure::ResultSuccessRead, error)",
            "pub(crate) fn error(&self) -> worker::Result<Option<String>>",
            "bounded_d1_error_message(&message)",
            "pub(crate) fn meta_changes(&self) -> worker::Result<u64>",
            "Reflect::get(meta.as_ref(), &JsValue::from_str(\"changes\"))",
            "validate_d1_meta_changes(changes)",
            "for (index, result) in results.iter().enumerate()",
            "if !success",
            "D1 session batch result {index} failed: {error}",
        ] {
            assert!(
                implementation.contains(fragment),
                "missing strict D1 session batch contract: {fragment}"
            );
        }
        for forbidden in [
            "serde_wasm_bindgen",
            ".results::<",
            "console_log",
            "console_debug",
            "pub fn batch",
            "pub async fn batch",
            ".results(",
            ".map_err(worker::Error::from)",
            "JsValue::as_string",
            ".as_string()",
            "JSON.stringify",
            "unwrap",
            "console",
        ] {
            assert!(
                !implementation.contains(forbidden),
                "D1 session batch bridge widened its boundary: {forbidden}"
            );
        }
        assert_eq!(
            implementation
                .matches("redacted_d1_bridge_error(D1BridgeFailure::")
                .count(),
            11,
            "every synchronous bridge exception and Promise rejection must be redacted"
        );
    }
}
