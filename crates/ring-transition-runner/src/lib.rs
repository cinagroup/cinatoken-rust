use serde::Serialize;
use std::fmt;

pub mod orchestrator;

pub const RELEASE_TRUST_CONTRACT: &str =
    "cinatoken-relay-container-ring-transition-runner-release-trust-v1";
pub const EXECUTION_CONTRACT: &str =
    "cinatoken-relay-container-ring-transition-runner-execution-v1";
pub const STAGING_AUTHORITY_ORIGIN: &str =
    "https://ring-transition-authority-staging.cinatoken.com";
pub const RELEASE_PACKET_FILE_NAME: &str = "cinatoken-ring-transition-runner.release.json";
pub const RELEASE_POLICY_FILE_NAME: &str = "cinatoken-ring-transition-runner.release-policy.json";

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedReleaseTrust {
    pub schema_version: u8,
    pub contract: &'static str,
    pub enabled: bool,
    pub environment: &'static str,
    pub packet_file_name: &'static str,
    pub policy_file_name: &'static str,
    pub release_policy_sha256: Option<&'static str>,
    pub release_key_spki_sha256: Option<&'static str>,
    pub authority_origin: Option<&'static str>,
}

impl EmbeddedReleaseTrust {
    pub const fn checked_in() -> Self {
        Self {
            schema_version: 1,
            contract: RELEASE_TRUST_CONTRACT,
            enabled: false,
            environment: "staging",
            packet_file_name: RELEASE_PACKET_FILE_NAME,
            policy_file_name: RELEASE_POLICY_FILE_NAME,
            release_policy_sha256: None,
            release_key_spki_sha256: None,
            authority_origin: None,
        }
    }

    pub fn validate_for_execution(&self) -> Result<(), ReleaseValidationError> {
        if !self.enabled {
            return Err(ReleaseValidationError::Disabled);
        }
        if self.schema_version != 1
            || self.contract != RELEASE_TRUST_CONTRACT
            || self.environment != "staging"
            || self.packet_file_name != RELEASE_PACKET_FILE_NAME
            || self.policy_file_name != RELEASE_POLICY_FILE_NAME
        {
            return Err(ReleaseValidationError::ContractMismatch);
        }
        for (name, value) in [
            ("release_policy_sha256", self.release_policy_sha256),
            ("release_key_spki_sha256", self.release_key_spki_sha256),
        ] {
            let Some(value) = value else {
                return Err(ReleaseValidationError::MissingField(name));
            };
            if value.len() != 64
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err(ReleaseValidationError::InvalidField(name));
            }
        }
        let Some(origin) = self.authority_origin else {
            return Err(ReleaseValidationError::MissingField("authority_origin"));
        };
        if origin != STAGING_AUTHORITY_ORIGIN {
            return Err(ReleaseValidationError::InvalidField("authority_origin"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReleaseValidationError {
    Disabled,
    ContractMismatch,
    MissingField(&'static str),
    InvalidField(&'static str),
}

impl fmt::Display for ReleaseValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Disabled => formatter.write_str("embedded release is disabled"),
            Self::ContractMismatch => formatter.write_str("embedded release contract mismatch"),
            Self::MissingField(field) => {
                write!(formatter, "embedded release field missing: {field}")
            }
            Self::InvalidField(field) => {
                write!(formatter, "embedded release field invalid: {field}")
            }
        }
    }
}

impl std::error::Error for ReleaseValidationError {}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerDescription {
    pub ok: bool,
    pub schema_version: u8,
    pub contract: &'static str,
    pub environment: &'static str,
    pub execution_mode: &'static str,
    pub immutable_launcher_compiled: bool,
    pub release_published: bool,
    pub credentials_read: bool,
    pub network_requests_performed: bool,
    pub mutation_performed: bool,
    pub customer_traffic_authorized: bool,
    pub production_cutover_authorized: bool,
    pub release_trust: EmbeddedReleaseTrust,
}

pub fn describe() -> RunnerDescription {
    let release_trust = EmbeddedReleaseTrust::checked_in();
    RunnerDescription {
        ok: true,
        schema_version: 1,
        contract: EXECUTION_CONTRACT,
        environment: "staging",
        execution_mode: "compiled-release-only",
        immutable_launcher_compiled: true,
        release_published: release_trust.enabled,
        credentials_read: false,
        network_requests_performed: false,
        mutation_performed: false,
        customer_traffic_authorized: false,
        production_cutover_authorized: false,
        release_trust,
    }
}

pub fn authorize_execution() -> Result<(), ReleaseValidationError> {
    EmbeddedReleaseTrust::checked_in().validate_for_execution()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checked_in_launcher_is_deterministic_and_disabled() {
        assert_eq!(describe(), describe());
        assert!(!describe().release_published);
        assert!(!describe().credentials_read);
        assert!(!describe().network_requests_performed);
        assert_eq!(authorize_execution(), Err(ReleaseValidationError::Disabled));
    }

    #[test]
    fn enabled_identity_requires_every_release_and_authority_pin() {
        let mut release = EmbeddedReleaseTrust::checked_in();
        release.enabled = true;
        assert_eq!(
            release.validate_for_execution(),
            Err(ReleaseValidationError::MissingField(
                "release_policy_sha256"
            ))
        );
    }

    #[test]
    fn enabled_identity_rejects_an_unpinned_authority_origin() {
        let mut release = fully_pinned_release();
        release.authority_origin = Some("https://unreviewed.example.com");
        assert_eq!(
            release.validate_for_execution(),
            Err(ReleaseValidationError::InvalidField("authority_origin"))
        );
        release.authority_origin = Some(STAGING_AUTHORITY_ORIGIN);
        assert_eq!(release.validate_for_execution(), Ok(()));
    }

    fn fully_pinned_release() -> EmbeddedReleaseTrust {
        const SHA256: &str = "2222222222222222222222222222222222222222222222222222222222222222";
        EmbeddedReleaseTrust {
            enabled: true,
            release_policy_sha256: Some(SHA256),
            release_key_spki_sha256: Some(SHA256),
            authority_origin: Some(STAGING_AUTHORITY_ORIGIN),
            ..EmbeddedReleaseTrust::checked_in()
        }
    }
}
