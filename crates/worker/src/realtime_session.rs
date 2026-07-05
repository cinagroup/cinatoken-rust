//! Durable Object foundation for realtime/session-heavy relay flows.
//!
//! The current relay does not yet implement OpenAI Realtime protocol parity.
//! This object establishes the Cloudflare-native stateful WebSocket substrate:
//! hibernatable accepts through `State::accept_web_socket`, socket attachments
//! for resume metadata, and a tiny control protocol for smoke testing.

use serde::{Deserialize, Serialize};
use serde_json::json;
use worker::{
    durable_object, Env, Request, Response, Result as WorkerResult, State, WebSocket,
    WebSocketIncomingMessage, WebSocketPair,
};

use crate::platform_gateway::env_flag;

pub const REALTIME_SESSIONS_BINDING: &str = "REALTIME_SESSIONS";
pub const REALTIME_SESSION_GATEWAY_ENABLED_ENV: &str = "REALTIME_SESSION_GATEWAY_ENABLED";
pub const REALTIME_SESSION_GATEWAY_PREFIX: &str = "/api/platform/realtime/";

const SESSION_TAG_PREFIX: &str = "session:";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SocketAttachment {
    session: String,
    connected_at_ms: f64,
    protocol: Option<String>,
}

#[derive(Debug, Serialize)]
struct RealtimeSessionStatus {
    session: String,
    active_websockets: usize,
    restored_attachments: usize,
    hibernation: bool,
}

#[durable_object]
pub struct RealtimeSession {
    state: State,
}

#[durable_object]
impl DurableObject for RealtimeSession {
    fn new(state: State, _env: Env) -> Self {
        Self { state }
    }

    async fn fetch(&mut self, req: Request) -> WorkerResult<Response> {
        let session = session_from_url_path(&req.path()).unwrap_or_else(|| "default".to_string());
        if wants_websocket(&req) {
            return self.accept_websocket(req, session);
        }

        let sockets = self.state.get_websockets();
        let restored_attachments = sockets
            .iter()
            .filter_map(|ws| {
                ws.deserialize_attachment::<SocketAttachment>()
                    .ok()
                    .flatten()
            })
            .count();
        Response::from_json(&RealtimeSessionStatus {
            session,
            active_websockets: sockets.len(),
            restored_attachments,
            hibernation: true,
        })
    }

    async fn websocket_message(
        &mut self,
        ws: WebSocket,
        message: WebSocketIncomingMessage,
    ) -> WorkerResult<()> {
        let attachment = ws
            .deserialize_attachment::<SocketAttachment>()
            .ok()
            .flatten();
        match message {
            WebSocketIncomingMessage::String(message) if message.trim() == "ping" => {
                ws.send(&json!({
                    "type": "pong",
                    "session": attachment.as_ref().map(|item| item.session.as_str()),
                    "time_ms": js_sys::Date::now()
                }))?;
            }
            WebSocketIncomingMessage::String(message) => {
                ws.send(&json!({
                    "type": "realtime_session_control",
                    "status": "bridge_not_wired",
                    "session": attachment.as_ref().map(|item| item.session.as_str()),
                    "received": message
                }))?;
            }
            WebSocketIncomingMessage::Binary(bytes) => {
                ws.send(&json!({
                    "type": "realtime_session_control",
                    "status": "bridge_not_wired",
                    "session": attachment.as_ref().map(|item| item.session.as_str()),
                    "binary_bytes": bytes.len()
                }))?;
            }
        }
        Ok(())
    }

    async fn websocket_close(
        &mut self,
        _ws: WebSocket,
        _code: usize,
        _reason: String,
        _was_clean: bool,
    ) -> WorkerResult<()> {
        Ok(())
    }

    async fn websocket_error(&mut self, _ws: WebSocket, error: worker::Error) -> WorkerResult<()> {
        worker::console_warn!("RealtimeSession websocket error: {}", error);
        Ok(())
    }
}

impl RealtimeSession {
    fn accept_websocket(&mut self, req: Request, session: String) -> WorkerResult<Response> {
        let pair = WebSocketPair::new()?;
        let client = pair.client;
        let server = pair.server;
        let protocol = req.headers().get("Sec-WebSocket-Protocol").ok().flatten();
        server.serialize_attachment(SocketAttachment {
            session: session.clone(),
            connected_at_ms: js_sys::Date::now(),
            protocol,
        })?;
        let tag = format!("{SESSION_TAG_PREFIX}{session}");
        self.state
            .accept_websocket_with_tags(&server, &[tag.as_str()]);
        Response::from_websocket(client)
    }
}

pub fn realtime_gateway_candidate(path: &str) -> bool {
    path.starts_with(REALTIME_SESSION_GATEWAY_PREFIX)
}

pub async fn handle_gateway(req: Request, env: Env) -> WorkerResult<Response> {
    if !env_flag(&env, REALTIME_SESSION_GATEWAY_ENABLED_ENV) {
        return crate::json_with_status(
            &json!({
                "error": {
                    "code": "realtime_session_gateway_disabled",
                    "message": "Realtime session gateway is disabled",
                    "type": "platform_gateway_error"
                }
            }),
            501,
        );
    }

    let session = match session_from_gateway_path(&req.path()) {
        Some(session) => session,
        None => {
            return crate::json_with_status(
                &json!({
                    "error": {
                        "code": "invalid_realtime_session",
                        "message": "Realtime session name is invalid",
                        "type": "platform_gateway_error"
                    }
                }),
                400,
            );
        }
    };

    let namespace = match env.durable_object(REALTIME_SESSIONS_BINDING) {
        Ok(namespace) => namespace,
        Err(err) => {
            worker::console_error!("RealtimeSession binding unavailable: {}", err);
            return crate::json_with_status(
                &json!({
                    "error": {
                        "code": "realtime_session_unavailable",
                        "message": "Realtime session Durable Object is not configured",
                        "type": "platform_gateway_error"
                    }
                }),
                503,
            );
        }
    };
    let id = namespace.id_from_name(&session)?;
    let stub = id.get_stub()?;
    stub.fetch_with_request(req).await
}

fn wants_websocket(req: &Request) -> bool {
    req.headers()
        .get("Upgrade")
        .ok()
        .flatten()
        .map(|value| value.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false)
}

fn session_from_gateway_path(path: &str) -> Option<String> {
    let rest = path.strip_prefix(REALTIME_SESSION_GATEWAY_PREFIX)?;
    let session = rest.split('/').next().unwrap_or_default();
    normalize_session_name(session)
}

fn session_from_url_path(path: &str) -> Option<String> {
    session_from_gateway_path(path).or_else(|| {
        path.trim_start_matches('/')
            .split('/')
            .next()
            .and_then(normalize_session_name)
    })
}

fn normalize_session_name(value: &str) -> Option<String> {
    let value = value.trim().to_ascii_lowercase();
    if value.is_empty() || value.len() > 96 {
        return None;
    }
    value
        .chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-' || ch == '_')
        .then_some(value)
}

pub(crate) fn realtime_gateway_enabled(env: &Env) -> bool {
    env_flag(env, REALTIME_SESSION_GATEWAY_ENABLED_ENV)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_candidate_matches_platform_realtime_prefix() {
        assert!(realtime_gateway_candidate(
            "/api/platform/realtime/session-a"
        ));
        assert!(realtime_gateway_candidate(
            "/api/platform/realtime/session-a/status"
        ));
        assert!(!realtime_gateway_candidate("/v1/realtime"));
    }

    #[test]
    fn gateway_session_name_is_sanitized() {
        assert_eq!(
            session_from_gateway_path("/api/platform/realtime/Session_1/status").as_deref(),
            Some("session_1")
        );
        assert!(session_from_gateway_path("/api/platform/realtime/../bad").is_none());
        assert!(session_from_gateway_path("/api/platform/realtime/").is_none());
    }
}
