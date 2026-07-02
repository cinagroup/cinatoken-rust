use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct StatusResponse {
    pub service: &'static str,
    pub version: &'static str,
    pub environment: String,
    pub features: Vec<RuntimeFeature>,
}

#[derive(Debug, Serialize)]
pub struct RuntimeFeature {
    pub name: &'static str,
    pub enabled: bool,
}

impl StatusResponse {
    pub fn new(environment: impl Into<String>) -> Self {
        Self {
            service: "cinatoken-rust",
            version: env!("CARGO_PKG_VERSION"),
            environment: environment.into(),
            features: vec![
                RuntimeFeature {
                    name: "worker",
                    enabled: true,
                },
                RuntimeFeature {
                    name: "relay_mvp",
                    enabled: true,
                },
                RuntimeFeature {
                    name: "d1",
                    enabled: false,
                },
                RuntimeFeature {
                    name: "upstash_redis",
                    enabled: false,
                },
                RuntimeFeature {
                    name: "relay_rate_limit",
                    enabled: false,
                },
                RuntimeFeature {
                    name: "relay_read_cache",
                    enabled: false,
                },
                RuntimeFeature {
                    name: "session_auth",
                    enabled: false,
                },
                RuntimeFeature {
                    name: "workers_ai",
                    enabled: false,
                },
                RuntimeFeature {
                    name: "ai_gateway",
                    enabled: false,
                },
            ],
        }
    }
}
