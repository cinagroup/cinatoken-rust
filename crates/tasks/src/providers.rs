//! Per-provider upstream-response parsers — the pure half of each
//! `relay/channel/task/<provider>` adaptor's `ParseTaskResult`. Each maps a
//! provider's poll response onto the shared [`crate::TaskInfo`]; the I/O half
//! (request building, HTTP) lives in the Worker adaptor that calls these.
pub mod hailuo;
pub mod jimeng;
pub mod kling;
pub mod sora;
pub mod vidu;
