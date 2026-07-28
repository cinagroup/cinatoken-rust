//! Verification for short-lived, staging-only shard placement mutation permits.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use worker::Env;

pub(crate) const PLACEMENT_MUTATION_AUTHORIZATION_CONTRACT: &str =
    "cinatoken-relay-shard-placement-mutation-authorization-v1";

const SIGNATURE_DOMAIN: &[u8] = b"cinatoken-relay-shard-placement-mutation-authorization-v1";
const STAGING_ENVIRONMENT: &str = "staging";
const STAGING_CONTROLLER_SERVICE_NAME: &str = "cinatoken-container-controller-staging";
const TRUST_ISSUER_ENV: &str = "CONTAINER_SHARD_PLACEMENT_AUTHORIZATION_ISSUER";
const TRUST_KEY_ID_ENV: &str = "CONTAINER_SHARD_PLACEMENT_AUTHORIZATION_KEY_ID";
const TRUST_SPKI_BASE64URL_ENV: &str = "CONTAINER_SHARD_PLACEMENT_AUTHORIZATION_SPKI_BASE64URL";
const TRUST_SPKI_SHA256_ENV: &str = "CONTAINER_SHARD_PLACEMENT_AUTHORIZATION_SPKI_SHA256";
const ED25519_SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];
const MINIMUM_PERMIT_LIFETIME_SECONDS: i64 = 60;
const MAXIMUM_PERMIT_LIFETIME_SECONDS: i64 = 600;
const MAXIMUM_CLOCK_SKEW_SECONDS: i64 = 120;
const MINIMUM_REMAINING_SECONDS: i64 = 60;
const MINIMUM_CAMPAIGN_LIFETIME_SECONDS: i64 = 60;
const MAXIMUM_CAMPAIGN_LIFETIME_SECONDS: i64 = 3_600;
const MAXIMUM_RING_GENERATION: u64 = 1_000_000;
const MAXIMUM_SHARD_COUNT: u16 = 1_024;
const MAXIMUM_RAW_NONCE_BYTES: usize = 1_024;
const MAXIMUM_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ShardPlacementMutationAuthorizationPermit {
    pub(crate) schema_version: u32,
    pub(crate) contract: String,
    pub(crate) issuer: String,
    pub(crate) key_id: String,
    pub(crate) environment: String,
    pub(crate) authorization_id_sha256: String,
    pub(crate) execution_nonce_sha256: String,
    pub(crate) campaign_id: String,
    pub(crate) campaign_nonce_sha256: String,
    pub(crate) controller_service_name: String,
    pub(crate) controller_version_id: String,
    pub(crate) action_gate_inventory_sha256: String,
    pub(crate) foundation_manifest_sha256: String,
    pub(crate) runtime_build_id: String,
    pub(crate) ring_generation: u64,
    pub(crate) shard_count: u16,
    pub(crate) campaign_lifetime_seconds: i64,
    pub(crate) issued_at: i64,
    pub(crate) expires_at: i64,
    pub(crate) signature_base64url: String,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct ExpectedShardPlacementMutationAuthorization<'a> {
    pub(crate) authorization_id_sha256: &'a str,
    pub(crate) execution_nonce_sha256: &'a str,
    pub(crate) campaign_id: &'a str,
    pub(crate) campaign_nonce: &'a str,
    pub(crate) controller_version_id: &'a str,
    pub(crate) action_gate_inventory_sha256: &'a str,
    pub(crate) foundation_manifest_sha256: &'a str,
    pub(crate) runtime_build_id: &'a str,
    pub(crate) ring_generation: u64,
    pub(crate) shard_count: u16,
    pub(crate) campaign_lifetime_seconds: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct VerifiedShardPlacementMutationAuthorization {
    pub(crate) schema_version: u32,
    pub(crate) contract: String,
    pub(crate) issuer: String,
    pub(crate) key_id: String,
    pub(crate) signer_spki_sha256: String,
    pub(crate) environment: String,
    pub(crate) authorization_id_sha256: String,
    pub(crate) execution_nonce_sha256: String,
    pub(crate) campaign_id: String,
    pub(crate) campaign_nonce_sha256: String,
    pub(crate) subject_digest_sha256: String,
    pub(crate) controller_service_name: String,
    pub(crate) controller_version_id: String,
    pub(crate) action_gate_inventory_sha256: String,
    pub(crate) foundation_manifest_sha256: String,
    pub(crate) runtime_build_id: String,
    pub(crate) ring_generation: u64,
    pub(crate) shard_count: u16,
    pub(crate) campaign_lifetime_seconds: i64,
    pub(crate) issued_at: i64,
    pub(crate) expires_at: i64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ShardPlacementMutationAuthorizationError {
    MissingTrust,
    InvalidTrust,
    InvalidPermit,
    BindingMismatch,
    InvalidValidity,
    InvalidSignature,
}

impl ShardPlacementMutationAuthorizationError {
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::MissingTrust => "placement_mutation_authorization_trust_missing",
            Self::InvalidTrust => "placement_mutation_authorization_trust_invalid",
            Self::InvalidPermit => "placement_mutation_authorization_permit_invalid",
            Self::BindingMismatch => "placement_mutation_authorization_binding_mismatch",
            Self::InvalidValidity => "placement_mutation_authorization_validity_invalid",
            Self::InvalidSignature => "placement_mutation_authorization_signature_invalid",
        }
    }
}

impl std::fmt::Display for ShardPlacementMutationAuthorizationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for ShardPlacementMutationAuthorizationError {}

#[derive(Clone, Debug)]
struct ShardPlacementMutationAuthorizationTrust {
    issuer: String,
    key_id: String,
    spki_base64url: String,
    spki_sha256: String,
}

pub(crate) fn verify_shard_placement_mutation_authorization(
    env: &Env,
    permit: &ShardPlacementMutationAuthorizationPermit,
    expected: &ExpectedShardPlacementMutationAuthorization<'_>,
    now: i64,
) -> Result<VerifiedShardPlacementMutationAuthorization, ShardPlacementMutationAuthorizationError> {
    let trust = ShardPlacementMutationAuthorizationTrust::from_env(env)?;
    verify_with_trust(permit, expected, &trust, now)
}

impl ShardPlacementMutationAuthorizationTrust {
    fn from_env(env: &Env) -> Result<Self, ShardPlacementMutationAuthorizationError> {
        Ok(Self {
            issuer: required_env(env, TRUST_ISSUER_ENV)?,
            key_id: required_env(env, TRUST_KEY_ID_ENV)?,
            spki_base64url: required_env(env, TRUST_SPKI_BASE64URL_ENV)?,
            spki_sha256: required_env(env, TRUST_SPKI_SHA256_ENV)?,
        })
    }
}

fn required_env(
    env: &Env,
    name: &'static str,
) -> Result<String, ShardPlacementMutationAuthorizationError> {
    let value = env
        .var(name)
        .map_err(|_| ShardPlacementMutationAuthorizationError::MissingTrust)?
        .to_string();
    if value.is_empty() {
        return Err(ShardPlacementMutationAuthorizationError::MissingTrust);
    }
    Ok(value)
}

fn verify_with_trust(
    permit: &ShardPlacementMutationAuthorizationPermit,
    expected: &ExpectedShardPlacementMutationAuthorization<'_>,
    trust: &ShardPlacementMutationAuthorizationTrust,
    now: i64,
) -> Result<VerifiedShardPlacementMutationAuthorization, ShardPlacementMutationAuthorizationError> {
    let verifying_key = validate_trust(trust)?;
    validate_permit_shape(permit, trust)?;
    validate_bindings(permit, expected)?;
    validate_validity(permit, now)?;

    let message = authorization_message(permit)?;
    let signature_bytes = decode_canonical_base64url(&permit.signature_base64url, 64)
        .map_err(|_| ShardPlacementMutationAuthorizationError::InvalidPermit)?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| ShardPlacementMutationAuthorizationError::InvalidPermit)?;
    verifying_key
        .verify_strict(&message, &signature)
        .map_err(|_| ShardPlacementMutationAuthorizationError::InvalidSignature)?;

    Ok(VerifiedShardPlacementMutationAuthorization {
        schema_version: permit.schema_version,
        contract: permit.contract.clone(),
        issuer: permit.issuer.clone(),
        key_id: permit.key_id.clone(),
        signer_spki_sha256: trust.spki_sha256.clone(),
        environment: permit.environment.clone(),
        authorization_id_sha256: permit.authorization_id_sha256.clone(),
        execution_nonce_sha256: permit.execution_nonce_sha256.clone(),
        campaign_id: permit.campaign_id.clone(),
        campaign_nonce_sha256: permit.campaign_nonce_sha256.clone(),
        subject_digest_sha256: sha256_hex(&message),
        controller_service_name: permit.controller_service_name.clone(),
        controller_version_id: permit.controller_version_id.clone(),
        action_gate_inventory_sha256: permit.action_gate_inventory_sha256.clone(),
        foundation_manifest_sha256: permit.foundation_manifest_sha256.clone(),
        runtime_build_id: permit.runtime_build_id.clone(),
        ring_generation: permit.ring_generation,
        shard_count: permit.shard_count,
        campaign_lifetime_seconds: permit.campaign_lifetime_seconds,
        issued_at: permit.issued_at,
        expires_at: permit.expires_at,
    })
}

fn validate_trust(
    trust: &ShardPlacementMutationAuthorizationTrust,
) -> Result<VerifyingKey, ShardPlacementMutationAuthorizationError> {
    if !valid_issuer(&trust.issuer)
        || !valid_key_id(&trust.key_id)
        || !valid_sha256(&trust.spki_sha256)
    {
        return Err(ShardPlacementMutationAuthorizationError::InvalidTrust);
    }
    let spki = decode_canonical_base64url(&trust.spki_base64url, ED25519_SPKI_PREFIX.len() + 32)
        .map_err(|_| ShardPlacementMutationAuthorizationError::InvalidTrust)?;
    if sha256_hex(&spki) != trust.spki_sha256 {
        return Err(ShardPlacementMutationAuthorizationError::InvalidTrust);
    }
    let key_bytes: &[u8; 32] = spki
        .strip_prefix(&ED25519_SPKI_PREFIX)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(ShardPlacementMutationAuthorizationError::InvalidTrust)?;
    VerifyingKey::from_bytes(key_bytes)
        .map_err(|_| ShardPlacementMutationAuthorizationError::InvalidTrust)
}

fn validate_permit_shape(
    permit: &ShardPlacementMutationAuthorizationPermit,
    trust: &ShardPlacementMutationAuthorizationTrust,
) -> Result<(), ShardPlacementMutationAuthorizationError> {
    if permit.schema_version != 1
        || permit.contract != PLACEMENT_MUTATION_AUTHORIZATION_CONTRACT
        || permit.issuer != trust.issuer
        || permit.key_id != trust.key_id
        || permit.environment != STAGING_ENVIRONMENT
        || permit.controller_service_name != STAGING_CONTROLLER_SERVICE_NAME
        || !valid_sha256(&permit.authorization_id_sha256)
        || !valid_sha256(&permit.execution_nonce_sha256)
        || permit.authorization_id_sha256 == permit.execution_nonce_sha256
        || !valid_sha256(&permit.campaign_id)
        || !valid_sha256(&permit.campaign_nonce_sha256)
        || permit.authorization_id_sha256 == permit.campaign_nonce_sha256
        || permit.execution_nonce_sha256 == permit.campaign_nonce_sha256
        || !valid_version_id(&permit.controller_version_id)
        || !valid_sha256(&permit.action_gate_inventory_sha256)
        || !valid_sha256(&permit.foundation_manifest_sha256)
        || !valid_sha256(&permit.runtime_build_id)
        || permit.ring_generation == 0
        || permit.ring_generation > MAXIMUM_RING_GENERATION
        || permit.shard_count == 0
        || permit.shard_count > MAXIMUM_SHARD_COUNT
        || !(MINIMUM_CAMPAIGN_LIFETIME_SECONDS..=MAXIMUM_CAMPAIGN_LIFETIME_SECONDS)
            .contains(&permit.campaign_lifetime_seconds)
    {
        return Err(ShardPlacementMutationAuthorizationError::InvalidPermit);
    }
    Ok(())
}

fn validate_bindings(
    permit: &ShardPlacementMutationAuthorizationPermit,
    expected: &ExpectedShardPlacementMutationAuthorization<'_>,
) -> Result<(), ShardPlacementMutationAuthorizationError> {
    if expected.campaign_nonce.is_empty()
        || expected.campaign_nonce.len() > MAXIMUM_RAW_NONCE_BYTES
        || permit.authorization_id_sha256 != expected.authorization_id_sha256
        || permit.execution_nonce_sha256 != expected.execution_nonce_sha256
        || permit.campaign_id != expected.campaign_id
        || permit.campaign_nonce_sha256 != sha256_hex(expected.campaign_nonce.as_bytes())
        || permit.controller_version_id != expected.controller_version_id
        || permit.action_gate_inventory_sha256 != expected.action_gate_inventory_sha256
        || permit.foundation_manifest_sha256 != expected.foundation_manifest_sha256
        || permit.runtime_build_id != expected.runtime_build_id
        || permit.ring_generation != expected.ring_generation
        || permit.shard_count != expected.shard_count
        || permit.campaign_lifetime_seconds != expected.campaign_lifetime_seconds
    {
        return Err(ShardPlacementMutationAuthorizationError::BindingMismatch);
    }
    Ok(())
}

fn validate_validity(
    permit: &ShardPlacementMutationAuthorizationPermit,
    now: i64,
) -> Result<(), ShardPlacementMutationAuthorizationError> {
    let lifetime = permit.expires_at.checked_sub(permit.issued_at);
    if now <= 0
        || permit.issued_at <= 0
        || permit.expires_at <= 0
        || !matches!(
            lifetime,
            Some(MINIMUM_PERMIT_LIFETIME_SECONDS..=MAXIMUM_PERMIT_LIFETIME_SECONDS)
        )
        || permit.issued_at > now.saturating_add(MAXIMUM_CLOCK_SKEW_SECONDS)
        || permit.expires_at < now.saturating_add(MINIMUM_REMAINING_SECONDS)
        || permit.issued_at > MAXIMUM_SAFE_INTEGER
        || permit.expires_at > MAXIMUM_SAFE_INTEGER
    {
        return Err(ShardPlacementMutationAuthorizationError::InvalidValidity);
    }
    Ok(())
}

fn authorization_message(
    permit: &ShardPlacementMutationAuthorizationPermit,
) -> Result<Vec<u8>, ShardPlacementMutationAuthorizationError> {
    let fields = [
        permit.schema_version.to_string(),
        permit.contract.clone(),
        permit.issuer.clone(),
        permit.key_id.clone(),
        permit.environment.clone(),
        permit.authorization_id_sha256.clone(),
        permit.execution_nonce_sha256.clone(),
        permit.campaign_id.clone(),
        permit.campaign_nonce_sha256.clone(),
        permit.controller_service_name.clone(),
        permit.controller_version_id.clone(),
        permit.action_gate_inventory_sha256.clone(),
        permit.foundation_manifest_sha256.clone(),
        permit.runtime_build_id.clone(),
        permit.ring_generation.to_string(),
        permit.shard_count.to_string(),
        permit.campaign_lifetime_seconds.to_string(),
        permit.issued_at.to_string(),
        permit.expires_at.to_string(),
    ];
    let payload_bytes = fields.iter().try_fold(0usize, |total, field| {
        u32::try_from(field.len())
            .ok()
            .and_then(|_| total.checked_add(4 + field.len()))
            .ok_or(ShardPlacementMutationAuthorizationError::InvalidPermit)
    })?;
    let mut message = Vec::with_capacity(SIGNATURE_DOMAIN.len() + payload_bytes);
    message.extend_from_slice(SIGNATURE_DOMAIN);
    for field in fields {
        let length = u32::try_from(field.len())
            .map_err(|_| ShardPlacementMutationAuthorizationError::InvalidPermit)?;
        message.extend_from_slice(&length.to_be_bytes());
        message.extend_from_slice(field.as_bytes());
    }
    Ok(message)
}

fn decode_canonical_base64url(value: &str, expected_bytes: usize) -> Result<Vec<u8>, ()> {
    let expected_encoded_bytes = expected_bytes
        .checked_mul(4)
        .and_then(|value| value.checked_add(2))
        .map(|value| value / 3)
        .ok_or(())?;
    if value.len() != expected_encoded_bytes
        || value.contains('=')
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(());
    }
    let decoded = URL_SAFE_NO_PAD.decode(value).map_err(|_| ())?;
    if decoded.len() != expected_bytes || URL_SAFE_NO_PAD.encode(&decoded) != value {
        return Err(());
    }
    Ok(decoded)
}

fn valid_issuer(value: &str) -> bool {
    value.len() <= 128
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_key_id(value: &str) -> bool {
    value.len() <= 64
        && value
            .as_bytes()
            .first()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
}

fn valid_version_id(value: &str) -> bool {
    value.len() <= 128
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn sha256_hex(value: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(value.as_ref()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    const NOW: i64 = 2_000_000_000;

    struct Fixture {
        signing_key: SigningKey,
        permit: ShardPlacementMutationAuthorizationPermit,
        trust: ShardPlacementMutationAuthorizationTrust,
        campaign_nonce: String,
    }

    impl Fixture {
        fn expected(&self) -> ExpectedShardPlacementMutationAuthorization<'_> {
            ExpectedShardPlacementMutationAuthorization {
                authorization_id_sha256: &self.permit.authorization_id_sha256,
                execution_nonce_sha256: &self.permit.execution_nonce_sha256,
                campaign_id: &self.permit.campaign_id,
                campaign_nonce: &self.campaign_nonce,
                controller_version_id: &self.permit.controller_version_id,
                action_gate_inventory_sha256: &self.permit.action_gate_inventory_sha256,
                foundation_manifest_sha256: &self.permit.foundation_manifest_sha256,
                runtime_build_id: &self.permit.runtime_build_id,
                ring_generation: self.permit.ring_generation,
                shard_count: self.permit.shard_count,
                campaign_lifetime_seconds: self.permit.campaign_lifetime_seconds,
            }
        }

        fn resign(&mut self) {
            let message = authorization_message(&self.permit).unwrap();
            self.permit.signature_base64url =
                URL_SAFE_NO_PAD.encode(self.signing_key.sign(&message).to_bytes());
        }
    }

    fn fixture() -> Fixture {
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let mut spki = ED25519_SPKI_PREFIX.to_vec();
        spki.extend_from_slice(signing_key.verifying_key().as_bytes());
        let campaign_nonce = "campaign-nonce-kept-out-of-the-record".to_owned();
        let mut fixture = Fixture {
            signing_key,
            permit: ShardPlacementMutationAuthorizationPermit {
                schema_version: 1,
                contract: PLACEMENT_MUTATION_AUTHORIZATION_CONTRACT.to_owned(),
                issuer: "cinatoken-placement-authority-staging".to_owned(),
                key_id: "placement-authority-key-v1".to_owned(),
                environment: STAGING_ENVIRONMENT.to_owned(),
                authorization_id_sha256: "1".repeat(64),
                execution_nonce_sha256: "2".repeat(64),
                campaign_id: "3".repeat(64),
                campaign_nonce_sha256: sha256_hex(campaign_nonce.as_bytes()),
                controller_service_name: STAGING_CONTROLLER_SERVICE_NAME.to_owned(),
                controller_version_id: "controller-version-20260728".to_owned(),
                action_gate_inventory_sha256: "4".repeat(64),
                foundation_manifest_sha256: "5".repeat(64),
                runtime_build_id: "6".repeat(64),
                ring_generation: 7,
                shard_count: 8,
                campaign_lifetime_seconds: 300,
                issued_at: NOW - 1,
                expires_at: NOW + 120,
                signature_base64url: String::new(),
            },
            trust: ShardPlacementMutationAuthorizationTrust {
                issuer: "cinatoken-placement-authority-staging".to_owned(),
                key_id: "placement-authority-key-v1".to_owned(),
                spki_base64url: URL_SAFE_NO_PAD.encode(&spki),
                spki_sha256: sha256_hex(&spki),
            },
            campaign_nonce,
        };
        fixture.resign();
        fixture
    }

    #[test]
    fn verifies_exact_staging_permit_and_returns_persistable_record() {
        let fixture = fixture();
        let message = authorization_message(&fixture.permit).unwrap();
        let verified =
            verify_with_trust(&fixture.permit, &fixture.expected(), &fixture.trust, NOW).unwrap();

        assert_eq!(verified.contract, PLACEMENT_MUTATION_AUTHORIZATION_CONTRACT);
        assert_eq!(verified.environment, STAGING_ENVIRONMENT);
        assert_eq!(verified.campaign_id, fixture.permit.campaign_id);
        assert_eq!(
            verified.campaign_nonce_sha256,
            sha256_hex(fixture.campaign_nonce.as_bytes())
        );
        assert_eq!(verified.subject_digest_sha256, sha256_hex(message));
        assert_eq!(
            verified.subject_digest_sha256,
            "cbaf8b53492018463595298edf579600fd823caff96eb881afce1c7492bdab33"
        );
        assert_eq!(verified.signer_spki_sha256, fixture.trust.spki_sha256);

        let persisted = serde_json::to_value(&verified).unwrap();
        assert!(persisted.get("signature_base64url").is_none());
        assert!(persisted.get("spki_base64url").is_none());
        assert!(persisted.get("campaign_nonce").is_none());
        assert!(persisted.get("campaign_nonce_sha256").is_some());
        assert!(persisted.get("signer_spki_sha256").is_some());
    }

    #[test]
    fn matches_node_contract_fixed_vector() {
        let permit = ShardPlacementMutationAuthorizationPermit {
            schema_version: 1,
            contract: PLACEMENT_MUTATION_AUTHORIZATION_CONTRACT.to_owned(),
            issuer: "cinatoken-placement-authority-staging".to_owned(),
            key_id: "placement-authority-2026-07".to_owned(),
            environment: STAGING_ENVIRONMENT.to_owned(),
            authorization_id_sha256: "1".repeat(64),
            execution_nonce_sha256: "2".repeat(64),
            campaign_id: "3".repeat(64),
            campaign_nonce_sha256: "4".repeat(64),
            controller_service_name: STAGING_CONTROLLER_SERVICE_NAME.to_owned(),
            controller_version_id: "controller-version-2026-07-28-001".to_owned(),
            action_gate_inventory_sha256: "5".repeat(64),
            foundation_manifest_sha256: "6".repeat(64),
            runtime_build_id: "7".repeat(64),
            ring_generation: 7,
            shard_count: 32,
            campaign_lifetime_seconds: 600,
            issued_at: 1_800_000_000,
            expires_at: 1_800_000_600,
            signature_base64url:
                "wn6VVjgSSIc-XKjixmNzuCdyrtFYoGV83p9VdiYhMXOhp3xC3eSnFHJoDh8M88U_lD__vbxCkfzZRzzJmYsuCg"
                    .to_owned(),
        };
        let trust = ShardPlacementMutationAuthorizationTrust {
            issuer: permit.issuer.clone(),
            key_id: permit.key_id.clone(),
            spki_base64url: "MCowBQYDK2VwAyEA11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"
                .to_owned(),
            spki_sha256: "06e3fd8fda29bb60ab59557de61edb0aecdb231134be30e75b455f8e1b792fa9"
                .to_owned(),
        };

        let message = authorization_message(&permit).unwrap();
        assert_eq!(message.len(), 807);
        assert_eq!(&message[..SIGNATURE_DOMAIN.len()], SIGNATURE_DOMAIN);
        assert_eq!(
            sha256_hex(&message),
            "c3a518c5bb3e2d41f38e78eb121fb8ccb9b501ac9d95252c1a045f91cf334c02"
        );

        let signature = decode_canonical_base64url(&permit.signature_base64url, 64).unwrap();
        validate_trust(&trust)
            .unwrap()
            .verify_strict(&message, &Signature::from_slice(&signature).unwrap())
            .unwrap();
    }

    #[test]
    fn rejects_signed_field_tampering() {
        let mut fixture = fixture();
        fixture.permit.authorization_id_sha256 = "a".repeat(64);

        assert_eq!(
            verify_with_trust(&fixture.permit, &fixture.expected(), &fixture.trust, NOW),
            Err(ShardPlacementMutationAuthorizationError::InvalidSignature)
        );
    }

    #[test]
    fn rejects_campaign_id_tampering() {
        let fixture = fixture();
        let mut expected = fixture.expected();
        expected.campaign_id = "a";

        assert_eq!(
            verify_with_trust(&fixture.permit, &expected, &fixture.trust, NOW),
            Err(ShardPlacementMutationAuthorizationError::BindingMismatch)
        );
    }

    #[test]
    fn rejects_raw_campaign_nonce_tampering() {
        let fixture = fixture();
        let mut expected = fixture.expected();
        expected.campaign_nonce = "different-raw-campaign-nonce";

        assert_eq!(
            verify_with_trust(&fixture.permit, &expected, &fixture.trust, NOW),
            Err(ShardPlacementMutationAuthorizationError::BindingMismatch)
        );
    }

    #[test]
    fn rejects_replay_identity_digest_collisions() {
        for collision in [
            "authorization_execution",
            "authorization_campaign",
            "execution_campaign",
        ] {
            let mut fixture = fixture();
            match collision {
                "authorization_execution" => {
                    fixture.permit.execution_nonce_sha256 =
                        fixture.permit.authorization_id_sha256.clone();
                }
                "authorization_campaign" => {
                    fixture.permit.campaign_nonce_sha256 =
                        fixture.permit.authorization_id_sha256.clone();
                }
                "execution_campaign" => {
                    fixture.permit.campaign_nonce_sha256 =
                        fixture.permit.execution_nonce_sha256.clone();
                }
                _ => unreachable!(),
            }
            fixture.resign();

            assert_eq!(
                verify_with_trust(&fixture.permit, &fixture.expected(), &fixture.trust, NOW),
                Err(ShardPlacementMutationAuthorizationError::InvalidPermit),
                "{collision}"
            );
        }
    }

    #[test]
    fn rejects_expired_and_excessively_future_permits() {
        let mut expired = fixture();
        expired.permit.issued_at = NOW - 600;
        expired.permit.expires_at = NOW - 1;
        expired.resign();
        assert_eq!(
            verify_with_trust(&expired.permit, &expired.expected(), &expired.trust, NOW),
            Err(ShardPlacementMutationAuthorizationError::InvalidValidity)
        );

        let mut future = fixture();
        future.permit.issued_at = NOW + MAXIMUM_CLOCK_SKEW_SECONDS + 1;
        future.permit.expires_at = future.permit.issued_at + MINIMUM_PERMIT_LIFETIME_SECONDS;
        future.resign();
        assert_eq!(
            verify_with_trust(&future.permit, &future.expected(), &future.trust, NOW),
            Err(ShardPlacementMutationAuthorizationError::InvalidValidity)
        );

        let mut non_positive = fixture();
        non_positive.permit.issued_at = 0;
        non_positive.permit.expires_at = MINIMUM_PERMIT_LIFETIME_SECONDS;
        non_positive.resign();
        assert_eq!(
            verify_with_trust(
                &non_positive.permit,
                &non_positive.expected(),
                &non_positive.trust,
                NOW
            ),
            Err(ShardPlacementMutationAuthorizationError::InvalidValidity)
        );
    }

    #[test]
    fn rejects_non_ed25519_spki() {
        let fixture = fixture();
        let mut trust = fixture.trust.clone();
        let mut spki = URL_SAFE_NO_PAD.decode(&trust.spki_base64url).unwrap();
        spki[0] ^= 0x01;
        trust.spki_base64url = URL_SAFE_NO_PAD.encode(&spki);
        trust.spki_sha256 = sha256_hex(&spki);

        assert_eq!(
            verify_with_trust(&fixture.permit, &fixture.expected(), &trust, NOW),
            Err(ShardPlacementMutationAuthorizationError::InvalidTrust)
        );
    }

    #[test]
    fn rejects_spki_fingerprint_mismatch() {
        let fixture = fixture();
        let mut trust = fixture.trust.clone();
        trust.spki_sha256 = "f".repeat(64);

        assert_eq!(
            verify_with_trust(&fixture.permit, &fixture.expected(), &trust, NOW),
            Err(ShardPlacementMutationAuthorizationError::InvalidTrust)
        );
    }

    #[test]
    fn rejects_invalid_signature() {
        let mut fixture = fixture();
        let mut signature = URL_SAFE_NO_PAD
            .decode(&fixture.permit.signature_base64url)
            .unwrap();
        signature[0] ^= 0x01;
        fixture.permit.signature_base64url = URL_SAFE_NO_PAD.encode(signature);

        assert_eq!(
            verify_with_trust(&fixture.permit, &fixture.expected(), &fixture.trust, NOW),
            Err(ShardPlacementMutationAuthorizationError::InvalidSignature)
        );
    }
}
