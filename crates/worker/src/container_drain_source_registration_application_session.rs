//! Redacted Root-session authority for the route-free registration caller.
//!
//! The caller must supply claims returned by the existing live-user session
//! recheck. Raw Cookie bytes, username, group, and the undecoded `sid` never
//! cross this boundary.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use cinatoken_auth::{ROLE_ROOT_USER, USER_STATUS_ENABLED};
use cinatoken_session::{SessionClaims, SESSION_ID_BYTES};
use sha2::{Digest, Sha256};

use crate::container_drain_source_registration_coordinator::DrainSourceRegistrationRootSessionAnchorV1;

const ROOT_SESSION_ID_DOMAIN: &[u8] = b"cinatoken-drain-source-registration-root-session-id-v1";
const ROOT_SESSION_BINDING_DOMAIN: &[u8] =
    b"cinatoken-drain-source-registration-root-session-binding-v1";
const MAXIMUM_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Clone, PartialEq, Eq)]
pub(crate) enum ApplicationRootSessionAnchorError {
    InvalidClaims,
}

impl ApplicationRootSessionAnchorError {
    pub(crate) const fn code(&self) -> &'static str {
        match self {
            Self::InvalidClaims => "registration_root_session_claims_invalid",
        }
    }
}

impl std::fmt::Display for ApplicationRootSessionAnchorError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::fmt::Debug for ApplicationRootSessionAnchorError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for ApplicationRootSessionAnchorError {}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct VerifiedApplicationRootSessionV1 {
    anchor: DrainSourceRegistrationRootSessionAnchorV1,
}

impl VerifiedApplicationRootSessionV1 {
    pub(crate) fn from_live_root_claims(
        claims: &SessionClaims,
    ) -> Result<Self, ApplicationRootSessionAnchorError> {
        if claims.id <= 0
            || claims.id > MAXIMUM_SAFE_INTEGER
            || claims.role != ROLE_ROOT_USER
            || claims.status != USER_STATUS_ENABLED
            || claims.session_epoch < 0
            || claims.session_epoch > MAXIMUM_SAFE_INTEGER
            || claims.iat <= 0
            || claims.iat > MAXIMUM_SAFE_INTEGER
            || claims.exp <= claims.iat
            || claims.exp > MAXIMUM_SAFE_INTEGER
        {
            return Err(ApplicationRootSessionAnchorError::InvalidClaims);
        }

        let session_id = URL_SAFE_NO_PAD
            .decode(claims.session_id.as_bytes())
            .map_err(|_| ApplicationRootSessionAnchorError::InvalidClaims)?;
        if session_id.len() != SESSION_ID_BYTES
            || URL_SAFE_NO_PAD.encode(&session_id) != claims.session_id
        {
            return Err(ApplicationRootSessionAnchorError::InvalidClaims);
        }

        let root_admin_id = claims.id.to_be_bytes();
        let root_role = claims.role.to_be_bytes();
        let root_status = claims.status.to_be_bytes();
        let root_session_epoch = claims.session_epoch.to_be_bytes();
        let root_session_issued_at = claims.iat.to_be_bytes();
        let root_session_expires_at = claims.exp.to_be_bytes();
        let root_session_id_sha256 = framed_sha256(ROOT_SESSION_ID_DOMAIN, &[&session_id])?;
        let root_session_binding_sha256 = framed_sha256(
            ROOT_SESSION_BINDING_DOMAIN,
            &[
                &root_admin_id,
                &root_role,
                &root_status,
                &root_session_epoch,
                &root_session_issued_at,
                &root_session_expires_at,
                &session_id,
            ],
        )?;
        if root_session_binding_sha256 == root_session_id_sha256 {
            return Err(ApplicationRootSessionAnchorError::InvalidClaims);
        }

        let anchor = DrainSourceRegistrationRootSessionAnchorV1::new(
            claims.id,
            claims.role,
            claims.status,
            None,
            claims.session_epoch,
            claims.iat,
            claims.exp,
            root_session_binding_sha256,
            root_session_id_sha256,
        )
        .map_err(|_| ApplicationRootSessionAnchorError::InvalidClaims)?;
        Ok(Self { anchor })
    }

    pub(crate) fn anchor(&self) -> &DrainSourceRegistrationRootSessionAnchorV1 {
        &self.anchor
    }
}

fn framed_sha256(
    domain: &[u8],
    fields: &[&[u8]],
) -> Result<String, ApplicationRootSessionAnchorError> {
    let mut hasher = Sha256::new();
    append_field(&mut hasher, domain)?;
    for field in fields {
        append_field(&mut hasher, field)?;
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn append_field(
    hasher: &mut Sha256,
    field: &[u8],
) -> Result<(), ApplicationRootSessionAnchorError> {
    let length =
        u32::try_from(field.len()).map_err(|_| ApplicationRootSessionAnchorError::InvalidClaims)?;
    hasher.update(length.to_be_bytes());
    hasher.update(field);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000;

    fn claims() -> SessionClaims {
        SessionClaims {
            id: 1,
            username: "root".to_string(),
            role: ROLE_ROOT_USER,
            status: USER_STATUS_ENABLED,
            group: "default".to_string(),
            session_epoch: 7,
            session_id: URL_SAFE_NO_PAD.encode([0x5a; SESSION_ID_BYTES]),
            iat: NOW - 60,
            exp: NOW + 600,
        }
    }

    #[test]
    fn live_root_claims_become_a_redacted_domain_separated_anchor() {
        let verified = VerifiedApplicationRootSessionV1::from_live_root_claims(&claims()).unwrap();
        let anchor = verified.anchor();

        assert_eq!(anchor.root_admin_id(), 1);
        assert_eq!(anchor.root_role(), ROLE_ROOT_USER);
        assert_eq!(anchor.root_status(), USER_STATUS_ENABLED);
        assert_eq!(anchor.root_deleted_at(), None);
        assert_eq!(anchor.root_session_epoch(), 7);
        assert_eq!(anchor.root_session_issued_at(), NOW - 60);
        assert_eq!(anchor.root_session_expires_at(), NOW + 600);
        assert_ne!(
            anchor.root_session_binding_sha256(),
            anchor.root_session_id_sha256()
        );
        assert_eq!(
            anchor.root_session_id_sha256(),
            "421e48d9548b08431b92011ebdbf58da9a2ce0f6cb2cdf6769928edfc1867a71"
        );
        assert_eq!(
            anchor.root_session_binding_sha256(),
            "bc2502f598204fbb1f138292eeb6b96d76b77eeb38fdacf07c03fc1916352794"
        );
    }

    #[test]
    fn role_status_epoch_time_and_sid_drift_fail_closed() {
        let baseline = claims();
        for invalid in [
            SessionClaims {
                role: ROLE_ROOT_USER - 1,
                ..baseline.clone()
            },
            SessionClaims {
                status: USER_STATUS_ENABLED + 1,
                ..baseline.clone()
            },
            SessionClaims {
                session_epoch: -1,
                ..baseline.clone()
            },
            SessionClaims {
                exp: baseline.iat,
                ..baseline.clone()
            },
            SessionClaims {
                session_id: URL_SAFE_NO_PAD.encode([0x5a; SESSION_ID_BYTES - 1]),
                ..baseline
            },
        ] {
            assert!(matches!(
                VerifiedApplicationRootSessionV1::from_live_root_claims(&invalid),
                Err(ApplicationRootSessionAnchorError::InvalidClaims)
            ));
        }
    }
}
