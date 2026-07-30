//! Narrow D1 Sessions API bridge for worker-rs 0.5.
//!
//! Cloudflare exposes `withSession` and `getBookmark` on the Worker binding,
//! but worker-rs did not add typed wrappers until a later release. Keep the
//! compatibility surface private and never return the opaque bookmark.

use sha2::{Digest, Sha256};
use wasm_bindgen::{prelude::wasm_bindgen, JsCast, JsValue};
use worker::{D1Database, D1PreparedStatement};
use worker_sys::types::D1PreparedStatement as D1PreparedStatementSys;

pub(crate) const D1_FIRST_PRIMARY_CONSTRAINT: &str = "first-primary";
const MAXIMUM_D1_BOOKMARK_BYTES: usize = 4_096;

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
        js_name = getBookmark
    )]
    fn get_bookmark(this: &D1DatabaseSessionBridge) -> Result<Option<String>, JsValue>;
}

#[derive(Debug)]
pub(crate) struct D1Session {
    inner: D1DatabaseSessionBridge,
}

impl D1Session {
    pub(crate) fn first_primary(database: &D1Database) -> worker::Result<Self> {
        let bridge = database
            .as_ref()
            .unchecked_ref::<D1DatabaseBridge>()
            .with_session(D1_FIRST_PRIMARY_CONSTRAINT)
            .map_err(worker::Error::from)?;
        Ok(Self { inner: bridge })
    }

    pub(crate) fn prepare(&self, query: impl Into<String>) -> worker::Result<D1PreparedStatement> {
        self.inner
            .session_prepare(&query.into())
            .map(D1PreparedStatement::from)
            .map_err(worker::Error::from)
    }

    pub(crate) fn bookmark_sha256(&self) -> worker::Result<String> {
        let bookmark = self
            .inner
            .get_bookmark()
            .map_err(worker::Error::from)?
            .ok_or_else(|| {
                worker::Error::RustError(
                    "D1 first-primary session returned no bookmark after query".to_string(),
                )
            })?;
        bookmark_sha256(&bookmark)
    }
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
        let raw_bookmark_method = ["pub(crate) fn ", "bookmark("].concat();
        let log_primitive = ["console", "_log"].concat();
        let debug_primitive = ["console", "_debug"].concat();
        assert!(!source.contains(&raw_bookmark_method));
        assert!(!source.contains(&log_primitive));
        assert!(!source.contains(&debug_primitive));
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
        assert!(source.contains("js_name = getBookmark"));
        let unconstrained = ["first", "-unconstrained"].concat();
        let fetch_primitive = ["fet", "ch("].concat();
        assert!(!source.contains(&unconstrained));
        assert!(!source.contains(&fetch_primitive));
    }
}
