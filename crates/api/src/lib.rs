use cinatoken_core::{
    ChatCompletionRequest, ErrorBody, ModelListResponse, ModelObject, StatusResponse,
};

pub fn status(environment: impl Into<String>) -> StatusResponse {
    StatusResponse::new(environment)
}

pub fn models() -> ModelListResponse {
    ModelListResponse {
        object: "list",
        data: vec![
            ModelObject {
                id: "cinatoken-rust-placeholder".to_string(),
                object: "model",
                created: 1_781_654_400,
                owned_by: "cinagroup".to_string(),
            },
            ModelObject {
                id: "cf-workers-ai".to_string(),
                object: "model",
                created: 1_781_654_400,
                owned_by: "cloudflare".to_string(),
            },
        ],
    }
}

pub fn chat_completions_mvp(_request: ChatCompletionRequest) -> (u16, ErrorBody) {
    (
        501,
        ErrorBody::not_implemented(
            "chat completions relay, auth, quota, channel selection, and provider dispatch",
        ),
    )
}
