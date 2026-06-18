use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ApiError {
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("unauthorized")]
    Unauthorized,
    #[error("forbidden")]
    Forbidden,
    #[error("not implemented: {0}")]
    NotImplemented(String),
    #[error("internal error: {0}")]
    Internal(String),
}

impl ApiError {
    pub fn status_code(&self) -> u16 {
        match self {
            Self::BadRequest(_) => 400,
            Self::Unauthorized => 401,
            Self::Forbidden => 403,
            Self::NotImplemented(_) => 501,
            Self::Internal(_) => 500,
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::BadRequest(_) => "bad_request",
            Self::Unauthorized => "unauthorized",
            Self::Forbidden => "forbidden",
            Self::NotImplemented(_) => "not_implemented",
            Self::Internal(_) => "internal_error",
        }
    }
}

#[derive(Debug, Serialize)]
pub struct ApiErrorBody {
    pub error: ApiErrorItem,
}

#[derive(Debug, Serialize)]
pub struct ApiErrorItem {
    pub message: String,
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub code: &'static str,
}

impl From<&ApiError> for ApiErrorBody {
    fn from(value: &ApiError) -> Self {
        Self {
            error: ApiErrorItem {
                message: value.to_string(),
                kind: "cinatoken_error",
                code: value.code(),
            },
        }
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
