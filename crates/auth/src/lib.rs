use async_trait::async_trait;
use serde::{Deserialize, Serialize};

pub mod password;
pub mod totp;

pub use password::{hash_password, verify_password};
pub use totp::{
    backup_code_from_bytes, normalize_backup_code, totp_code_at, validate_backup_code_format,
    validate_totp,
};

pub use cinatoken_session::SessionClaims;

/// User role constants. Values mirror the Go gateway's
/// `common/constants.go:187-192` exactly so that data exported from a Go
/// database remains semantically correct after import into D1.
pub const ROLE_GUEST: i32 = 0;
pub const ROLE_COMMON_USER: i32 = 1;
pub const ROLE_ADMIN_USER: i32 = 10;
pub const ROLE_ROOT_USER: i32 = 100;

/// User status constants. Mirror `common/constants.go:234-237`.
pub const USER_STATUS_ENABLED: i32 = 1;
pub const USER_STATUS_DISABLED: i32 = 2;

/// Return `true` when `role` is at least `ROLE_ADMIN_USER`. Used by the
/// admin route guards in the Worker.
pub fn is_admin(role: i32) -> bool {
    role >= ROLE_ADMIN_USER
}

/// Return `true` when `role` is `ROLE_ROOT_USER`. Used by the root-only
/// routes (`/api/option/*`, channel key reveal, fetch_models, custom OAuth
/// provider management).
pub fn is_root(role: i32) -> bool {
    role >= ROLE_ROOT_USER
}

/// Return `true` when `actor_role` outranks `target_role`. Root always
/// outranks everyone; admins outrank common users but not other admins;
/// common users never outrank admins. Mirrors the implicit hierarchy in
/// Go `controller/user.go` `ManageUser`/`UpdateUser`/`DeleteUser` guards.
pub fn outranks(actor_role: i32, target_role: i32) -> bool {
    if actor_role >= ROLE_ROOT_USER {
        return true;
    }
    if actor_role >= ROLE_ADMIN_USER {
        return target_role < ROLE_ADMIN_USER;
    }
    false
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthenticatedUser {
    pub id: i64,
    pub username: String,
    pub role: i32,
    pub status: i32,
    pub group: String,
}

impl AuthenticatedUser {
    pub fn is_admin(&self) -> bool {
        is_admin(self.role)
    }

    pub fn is_root(&self) -> bool {
        is_root(self.role)
    }

    pub fn outranks(&self, other_role: i32) -> bool {
        outranks(self.role, other_role)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthenticatedToken {
    pub id: i64,
    pub user_id: i64,
    pub name: String,
    pub group: String,
    pub remain_quota: i64,
    pub unlimited_quota: bool,
    pub model_limits_enabled: bool,
    pub model_limits: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct AuthContext {
    pub user: AuthenticatedUser,
    pub token: Option<AuthenticatedToken>,
}

#[async_trait(?Send)]
pub trait TokenAuthenticator {
    async fn authenticate_token(&self, api_key: &str) -> cinatoken_core::ApiResult<AuthContext>;
}

#[async_trait(?Send)]
pub trait SessionAuthenticator {
    async fn authenticate_session(
        &self,
        bearer_or_cookie: &str,
    ) -> cinatoken_core::ApiResult<AuthContext>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn role_helpers_match_go_hierarchy() {
        assert!(!is_admin(ROLE_GUEST));
        assert!(!is_admin(ROLE_COMMON_USER));
        assert!(is_admin(ROLE_ADMIN_USER));
        assert!(is_admin(ROLE_ROOT_USER));
        assert!(!is_root(ROLE_ADMIN_USER));
        assert!(is_root(ROLE_ROOT_USER));
    }

    #[test]
    fn outranks_enforces_root_admin_common_hierarchy() {
        // Root outranks everyone, including other roots.
        assert!(outranks(ROLE_ROOT_USER, ROLE_ROOT_USER));
        assert!(outranks(ROLE_ROOT_USER, ROLE_ADMIN_USER));
        assert!(outranks(ROLE_ROOT_USER, ROLE_COMMON_USER));
        // Admin outranks common users but not other admins.
        assert!(outranks(ROLE_ADMIN_USER, ROLE_COMMON_USER));
        assert!(!outranks(ROLE_ADMIN_USER, ROLE_ADMIN_USER));
        assert!(!outranks(ROLE_ADMIN_USER, ROLE_ROOT_USER));
        // Common users never outrank admins.
        assert!(!outranks(ROLE_COMMON_USER, ROLE_ADMIN_USER));
        assert!(!outranks(ROLE_GUEST, ROLE_COMMON_USER));
    }
}
