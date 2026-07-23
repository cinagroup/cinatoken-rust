use serde::Serialize;
use std::fmt;

pub const RELEASE_CONTRACT: &str = "cinatoken-relay-container-ring-transition-runner-release-v1";
pub const EXECUTION_CONTRACT: &str =
    "cinatoken-relay-container-ring-transition-runner-execution-v1";
pub const STAGING_AUTHORITY_ORIGIN: &str =
    "https://ring-transition-authority-staging.cinatoken.com";

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedReleaseIdentity {
    pub schema_version: u8,
    pub contract: &'static str,
    pub enabled: bool,
    pub environment: &'static str,
    pub source_commit: Option<&'static str>,
    pub git_tree_sha: Option<&'static str>,
    pub source_archive_sha256: Option<&'static str>,
    pub cargo_lock_sha256: Option<&'static str>,
    pub bun_lock_sha256: Option<&'static str>,
    pub package_json_sha256: Option<&'static str>,
    pub runner_build_sha256: Option<&'static str>,
    pub bundle_sha256: Option<&'static str>,
    pub reproducible_build_sha256: Option<&'static str>,
    pub trust_config_sha256: Option<&'static str>,
    pub release_evidence_sha256: Option<&'static str>,
    pub release_policy_sha256: Option<&'static str>,
    pub release_key_spki_sha256: Option<&'static str>,
    pub authority_origin: Option<&'static str>,
    pub authority_version_id: Option<&'static str>,
    pub permit_spki_sha256: Option<&'static str>,
}

impl EmbeddedReleaseIdentity {
    pub const fn checked_in() -> Self {
        Self {
            schema_version: 1,
            contract: RELEASE_CONTRACT,
            enabled: false,
            environment: "staging",
            source_commit: None,
            git_tree_sha: None,
            source_archive_sha256: None,
            cargo_lock_sha256: None,
            bun_lock_sha256: None,
            package_json_sha256: None,
            runner_build_sha256: None,
            bundle_sha256: None,
            reproducible_build_sha256: None,
            trust_config_sha256: None,
            release_evidence_sha256: None,
            release_policy_sha256: None,
            release_key_spki_sha256: None,
            authority_origin: None,
            authority_version_id: None,
            permit_spki_sha256: None,
        }
    }

    pub fn validate_for_execution(&self) -> Result<(), ReleaseValidationError> {
        if !self.enabled {
            return Err(ReleaseValidationError::Disabled);
        }
        if self.schema_version != 1
            || self.contract != RELEASE_CONTRACT
            || self.environment != "staging"
        {
            return Err(ReleaseValidationError::ContractMismatch);
        }
        for (name, value, length) in [
            ("source_commit", self.source_commit, 40),
            ("git_tree_sha", self.git_tree_sha, 40),
            ("source_archive_sha256", self.source_archive_sha256, 64),
            ("cargo_lock_sha256", self.cargo_lock_sha256, 64),
            ("bun_lock_sha256", self.bun_lock_sha256, 64),
            ("package_json_sha256", self.package_json_sha256, 64),
            ("runner_build_sha256", self.runner_build_sha256, 64),
            ("bundle_sha256", self.bundle_sha256, 64),
            (
                "reproducible_build_sha256",
                self.reproducible_build_sha256,
                64,
            ),
            ("trust_config_sha256", self.trust_config_sha256, 64),
            ("release_evidence_sha256", self.release_evidence_sha256, 64),
            ("release_policy_sha256", self.release_policy_sha256, 64),
            ("release_key_spki_sha256", self.release_key_spki_sha256, 64),
            ("permit_spki_sha256", self.permit_spki_sha256, 64),
        ] {
            let Some(value) = value else {
                return Err(ReleaseValidationError::MissingField(name));
            };
            if value.len() != length
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
        let Some(version_id) = self.authority_version_id else {
            return Err(ReleaseValidationError::MissingField("authority_version_id"));
        };
        if version_id.is_empty()
            || version_id.len() > 128
            || !version_id.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')
            })
        {
            return Err(ReleaseValidationError::InvalidField("authority_version_id"));
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
    pub release: EmbeddedReleaseIdentity,
}

pub fn describe() -> RunnerDescription {
    let release = EmbeddedReleaseIdentity::checked_in();
    RunnerDescription {
        ok: true,
        schema_version: 1,
        contract: EXECUTION_CONTRACT,
        environment: "staging",
        execution_mode: "compiled-release-only",
        immutable_launcher_compiled: true,
        release_published: release.enabled,
        credentials_read: false,
        network_requests_performed: false,
        mutation_performed: false,
        customer_traffic_authorized: false,
        production_cutover_authorized: false,
        release,
    }
}

pub fn authorize_execution() -> Result<(), ReleaseValidationError> {
    EmbeddedReleaseIdentity::checked_in().validate_for_execution()
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
        let mut release = EmbeddedReleaseIdentity::checked_in();
        release.enabled = true;
        assert_eq!(
            release.validate_for_execution(),
            Err(ReleaseValidationError::MissingField("source_commit"))
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

    fn fully_pinned_release() -> EmbeddedReleaseIdentity {
        const GIT_SHA: &str = "1111111111111111111111111111111111111111";
        const SHA256: &str = "2222222222222222222222222222222222222222222222222222222222222222";
        EmbeddedReleaseIdentity {
            enabled: true,
            source_commit: Some(GIT_SHA),
            git_tree_sha: Some(GIT_SHA),
            source_archive_sha256: Some(SHA256),
            cargo_lock_sha256: Some(SHA256),
            bun_lock_sha256: Some(SHA256),
            package_json_sha256: Some(SHA256),
            runner_build_sha256: Some(SHA256),
            bundle_sha256: Some(SHA256),
            reproducible_build_sha256: Some(SHA256),
            trust_config_sha256: Some(SHA256),
            release_evidence_sha256: Some(SHA256),
            release_policy_sha256: Some(SHA256),
            release_key_spki_sha256: Some(SHA256),
            authority_origin: Some(STAGING_AUTHORITY_ORIGIN),
            authority_version_id: Some("authority-version-001"),
            permit_spki_sha256: Some(SHA256),
            ..EmbeddedReleaseIdentity::checked_in()
        }
    }
}
