use crate::{EmbeddedReleaseTrust, ReleaseValidationError, STAGING_AUTHORITY_ORIGIN};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use ed25519_dalek::{Signature, VerifyingKey};
use same_file::Handle;
use serde::de::{DeserializeOwned, Error as _, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs::{self, File, Metadata};
use std::io::Read;
use std::path::Path;

pub const RELEASE_MANIFEST_CONTRACT: &str =
    "cinatoken-relay-container-ring-transition-runner-release-manifest-v1";
pub const RELEASE_PACKET_CONTRACT: &str =
    "cinatoken-relay-container-ring-transition-runner-release-packet-v1";
pub const RELEASE_POLICY_CONTRACT: &str =
    "cinatoken-relay-container-ring-transition-runner-release-policy-v1";
pub const MODULE_INVENTORY_CONTRACT: &str =
    "cinatoken-relay-container-ring-transition-runner-module-inventory-v1";
pub const DSSE_PAYLOAD_TYPE: &str =
    "application/vnd.cinatoken.ring-transition-runner-release.v1+json";

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_PACKET_BYTES: usize = 2 * 1024 * 1024;
const MAX_POLICY_BYTES: usize = 256 * 1024;
const MAX_ARTIFACT_BYTES: usize = 64 * 1024 * 1024;
const MAX_INVENTORY_FILES: usize = 2048;
const MAX_INVENTORY_BYTES: u64 = 64 * 1024 * 1024;
const MAX_RELEASE_LIFETIME_SECONDS: u64 = 24 * 60 * 60;
const MAX_CLOCK_SKEW_SECONDS: u64 = 300;
const ARTIFACT_BASENAME: &str = "cinatoken-ring-transition-runner";
const ED25519_SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

pub const REQUIRED_MODULE_PATHS: [&str; 18] = [
    ".gitattributes",
    "Cargo.lock",
    "Cargo.toml",
    "bun.lock",
    "crates/ring-transition-runner/Cargo.toml",
    "crates/ring-transition-runner/src/lib.rs",
    "crates/ring-transition-runner/src/main.rs",
    "crates/ring-transition-runner/src/orchestrator.rs",
    "crates/ring-transition-runner/src/release.rs",
    "crates/ring-transition-runner/tests/cli.rs",
    "package.json",
    "tests/relay-container-ring-transition-release-source.test.mjs",
    "tests/relay-container-ring-transition-release.test.mjs",
    "tools/collect_ring_transition_runner_release_source.mjs",
    "tools/relay_container_p5_evidence_contract.mjs",
    "tools/relay_container_ring_transition_contract.mjs",
    "tools/relay_container_ring_transition_release_contract.mjs",
    "tools/verify_relay_container_ring_transition_release.mjs",
];

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedRelease {
    pub source_commit: String,
    pub git_tree_sha: String,
    pub target_triple: String,
    pub manifest_sha256: String,
    pub packet_sha256: String,
    pub policy_sha256: String,
    pub release_key_spki_sha256: String,
    pub artifact_file_name: String,
    pub artifact_sha256: String,
    pub module_inventory_sha256: String,
    pub module_count: u64,
    pub module_bytes: u64,
    pub authority_version_id: String,
    pub issued_at: String,
    pub expires_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReleaseVerificationError {
    Trust(ReleaseValidationError),
    InvalidJson(&'static str),
    NonCanonicalJson(&'static str),
    InvalidField(&'static str),
    DigestMismatch(&'static str),
    SignatureInvalid,
    FileInvalid(&'static str),
    CurrentExecutableUnavailable,
}

impl fmt::Display for ReleaseVerificationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Trust(error) => error.fmt(formatter),
            Self::InvalidJson(label) => write!(formatter, "{label} JSON is invalid"),
            Self::NonCanonicalJson(label) => write!(formatter, "{label} JSON is not canonical"),
            Self::InvalidField(field) => write!(formatter, "release field is invalid: {field}"),
            Self::DigestMismatch(field) => write!(formatter, "release digest mismatch: {field}"),
            Self::SignatureInvalid => formatter.write_str("release DSSE signature is invalid"),
            Self::FileInvalid(label) => write!(formatter, "{label} file is invalid"),
            Self::CurrentExecutableUnavailable => {
                formatter.write_str("current runner executable is unavailable")
            }
        }
    }
}

impl std::error::Error for ReleaseVerificationError {}

impl From<ReleaseValidationError> for ReleaseVerificationError {
    fn from(error: ReleaseValidationError) -> Self {
        Self::Trust(error)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ReleasePolicy {
    schema_version: u8,
    contract: String,
    environment: String,
    payload_type: String,
    key_id: String,
    release_key_spki_base64url: String,
    release_key_spki_sha256: String,
    valid_from: String,
    valid_until: String,
    maximum_release_lifetime_seconds: u64,
    forbidden_key_spki_sha256: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ReleasePacket {
    schema_version: u8,
    contract: String,
    envelope: DsseEnvelope,
    module_inventory: ModuleInventory,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DsseEnvelope {
    payload_type: String,
    payload: String,
    signatures: Vec<DsseSignature>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct DsseSignature {
    keyid: String,
    sig: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ModuleInventory {
    schema_version: u8,
    contract: String,
    files: Vec<ModuleRecord>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ModuleRecord {
    path: String,
    byte_length: u64,
    sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ReleaseManifest {
    schema_version: u8,
    contract: String,
    environment: String,
    issued_at: String,
    expires_at: String,
    source_date_epoch: u64,
    source: ReleaseSource,
    build: ReleaseBuild,
    trust: ReleaseTrust,
    evidence: ReleaseEvidence,
    artifact: ReleaseArtifact,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ReleaseSource {
    commit_sha: String,
    git_tree_sha: String,
    source_archive_sha256: String,
    cargo_lock_sha256: String,
    bun_lock_sha256: String,
    package_json_sha256: String,
    module_inventory_sha256: String,
    module_count: u64,
    module_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ReleaseBuild {
    target_triple: String,
    profile: String,
    rustc_version: String,
    cargo_version: String,
    bun_version: String,
    build_arguments_sha256: String,
    build_environment_allowlist_sha256: String,
    runner_build_sha256: String,
    first_build_sha256: String,
    second_build_sha256: String,
    reproducible_build_sha256: String,
    two_builds_identical: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ReleaseTrust {
    trust_config_sha256: String,
    release_policy_sha256: String,
    release_key_spki_sha256: String,
    authority_origin: String,
    authority_version_id: String,
    permit_spki_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ReleaseEvidence {
    test_evidence_sha256: String,
    fault_evidence_sha256: String,
    security_evidence_sha256: String,
    no_secret_evidence_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ReleaseArtifact {
    file_name: String,
    byte_length: u64,
    sha256: String,
}

struct ValidatedPolicy {
    policy: ReleasePolicy,
    policy_sha256: String,
    valid_from: u64,
    valid_until: u64,
    verifying_key: VerifyingKey,
}

struct InventoryFacts {
    digest_sha256: String,
    module_count: u64,
    module_bytes: u64,
    by_path: BTreeMap<String, ModuleRecord>,
}

pub fn verify_release_bytes(
    trust: &EmbeddedReleaseTrust,
    packet_json: &[u8],
    policy_json: &[u8],
    artifact_file_name: &str,
    artifact_bytes: &[u8],
    now: u64,
) -> Result<VerifiedRelease, ReleaseVerificationError> {
    trust.validate_for_execution()?;
    if now == 0 || now > MAX_SAFE_INTEGER {
        return Err(ReleaseVerificationError::InvalidField("verifier_time"));
    }

    let policy: ReleasePolicy = parse_canonical_json(policy_json, MAX_POLICY_BYTES, "policy")?;
    let validated_policy = validate_policy(policy, policy_json, trust, now)?;

    let packet: ReleasePacket = parse_canonical_json(packet_json, MAX_PACKET_BYTES, "packet")?;
    if packet.schema_version != 1 || packet.contract != RELEASE_PACKET_CONTRACT {
        return Err(ReleaseVerificationError::InvalidField("packet_contract"));
    }
    let inventory = validate_inventory(&packet.module_inventory)?;
    validate_envelope(&packet.envelope, &validated_policy.policy)?;
    let manifest_bytes = decode_base64(
        &packet.envelope.payload,
        2,
        MAX_PACKET_BYTES,
        "manifest_payload",
    )?;
    let manifest: ReleaseManifest =
        parse_canonical_json(&manifest_bytes, MAX_PACKET_BYTES, "manifest")?;
    validate_manifest(
        &manifest,
        &inventory,
        &validated_policy,
        trust,
        artifact_file_name,
        artifact_bytes,
        now,
    )?;

    let signature_bytes =
        decode_base64(&packet.envelope.signatures[0].sig, 64, 64, "dsse_signature")?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| ReleaseVerificationError::SignatureInvalid)?;
    let pae = dsse_pre_authentication_encoding(&packet.envelope.payload_type, &manifest_bytes)?;
    validated_policy
        .verifying_key
        .verify_strict(&pae, &signature)
        .map_err(|_| ReleaseVerificationError::SignatureInvalid)?;

    Ok(VerifiedRelease {
        source_commit: manifest.source.commit_sha,
        git_tree_sha: manifest.source.git_tree_sha,
        target_triple: manifest.build.target_triple,
        manifest_sha256: sha256_hex(&manifest_bytes),
        packet_sha256: sha256_hex(packet_json),
        policy_sha256: validated_policy.policy_sha256,
        release_key_spki_sha256: validated_policy.policy.release_key_spki_sha256,
        artifact_file_name: manifest.artifact.file_name,
        artifact_sha256: manifest.artifact.sha256,
        module_inventory_sha256: inventory.digest_sha256,
        module_count: inventory.module_count,
        module_bytes: inventory.module_bytes,
        authority_version_id: manifest.trust.authority_version_id,
        issued_at: manifest.issued_at,
        expires_at: manifest.expires_at,
    })
}

pub fn verify_current_release(
    trust: &EmbeddedReleaseTrust,
    now: u64,
) -> Result<VerifiedRelease, ReleaseVerificationError> {
    trust.validate_for_execution()?;
    let executable = std::env::current_exe()
        .map_err(|_| ReleaseVerificationError::CurrentExecutableUnavailable)?;
    verify_installed_release_at(trust, &executable, now)
}

fn verify_installed_release_at(
    trust: &EmbeddedReleaseTrust,
    executable: &Path,
    now: u64,
) -> Result<VerifiedRelease, ReleaseVerificationError> {
    trust.validate_for_execution()?;
    let parent = executable
        .parent()
        .ok_or(ReleaseVerificationError::CurrentExecutableUnavailable)?;
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|_| ReleaseVerificationError::CurrentExecutableUnavailable)?;
    let artifact_file_name = executable
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or(ReleaseVerificationError::CurrentExecutableUnavailable)?;
    let packet_path = parent.join(trust.packet_file_name);
    let policy_path = parent.join(trust.policy_file_name);
    let artifact_bytes = read_stable_regular_file(
        executable,
        MAX_ARTIFACT_BYTES,
        &canonical_parent,
        "artifact",
    )?;
    let packet_bytes =
        read_stable_regular_file(&packet_path, MAX_PACKET_BYTES, &canonical_parent, "packet")?;
    let policy_bytes =
        read_stable_regular_file(&policy_path, MAX_POLICY_BYTES, &canonical_parent, "policy")?;
    let verified = verify_release_bytes(
        trust,
        &packet_bytes,
        &policy_bytes,
        artifact_file_name,
        &artifact_bytes,
        now,
    )?;
    if current_release_target() != Some(verified.target_triple.as_str()) {
        return Err(ReleaseVerificationError::InvalidField(
            "installed_target_triple",
        ));
    }
    Ok(verified)
}

fn current_release_target() -> Option<&'static str> {
    if cfg!(all(
        target_arch = "x86_64",
        target_os = "windows",
        target_env = "msvc"
    )) {
        Some("x86_64-pc-windows-msvc")
    } else if cfg!(all(
        target_arch = "x86_64",
        target_os = "linux",
        target_env = "musl"
    )) {
        Some("x86_64-unknown-linux-musl")
    } else {
        None
    }
}

fn validate_policy(
    policy: ReleasePolicy,
    policy_json: &[u8],
    trust: &EmbeddedReleaseTrust,
    now: u64,
) -> Result<ValidatedPolicy, ReleaseVerificationError> {
    if policy.schema_version != 1
        || policy.contract != RELEASE_POLICY_CONTRACT
        || policy.environment != "staging"
        || policy.payload_type != DSSE_PAYLOAD_TYPE
        || !valid_key_id(&policy.key_id)
    {
        return Err(ReleaseVerificationError::InvalidField("policy_contract"));
    }
    require_sha256(&policy.release_key_spki_sha256, "release_key_spki_sha256")?;
    let spki = decode_base64url(
        &policy.release_key_spki_base64url,
        32,
        512,
        "release_key_spki",
    )?;
    if sha256_hex(&spki) != policy.release_key_spki_sha256 {
        return Err(ReleaseVerificationError::DigestMismatch("release_key_spki"));
    }
    if Some(policy.release_key_spki_sha256.as_str()) != trust.release_key_spki_sha256 {
        return Err(ReleaseVerificationError::DigestMismatch(
            "compiled_release_key_pin",
        ));
    }
    let policy_sha256 = sha256_hex(policy_json);
    if Some(policy_sha256.as_str()) != trust.release_policy_sha256 {
        return Err(ReleaseVerificationError::DigestMismatch(
            "compiled_policy_pin",
        ));
    }
    let valid_from = parse_whole_second_timestamp(&policy.valid_from, "policy_valid_from")?;
    let valid_until = parse_whole_second_timestamp(&policy.valid_until, "policy_valid_until")?;
    if valid_until <= valid_from
        || now.saturating_add(MAX_CLOCK_SKEW_SECONDS) < valid_from
        || now > valid_until.saturating_add(MAX_CLOCK_SKEW_SECONDS)
        || !(60..=MAX_RELEASE_LIFETIME_SECONDS).contains(&policy.maximum_release_lifetime_seconds)
    {
        return Err(ReleaseVerificationError::InvalidField("policy_validity"));
    }
    if !(3..=32).contains(&policy.forbidden_key_spki_sha256.len()) {
        return Err(ReleaseVerificationError::InvalidField(
            "forbidden_key_inventory",
        ));
    }
    let mut previous: Option<&str> = None;
    for fingerprint in &policy.forbidden_key_spki_sha256 {
        require_sha256(fingerprint, "forbidden_key_spki_sha256")?;
        if fingerprint == &policy.release_key_spki_sha256
            || previous.is_some_and(|value| fingerprint.as_str() <= value)
        {
            return Err(ReleaseVerificationError::InvalidField(
                "forbidden_key_inventory",
            ));
        }
        previous = Some(fingerprint);
    }
    let public_key_bytes: &[u8; 32] = spki
        .strip_prefix(&ED25519_SPKI_PREFIX)
        .and_then(|value| value.try_into().ok())
        .ok_or(ReleaseVerificationError::InvalidField("release_public_key"))?;
    let verifying_key = VerifyingKey::from_bytes(public_key_bytes)
        .map_err(|_| ReleaseVerificationError::InvalidField("release_public_key"))?;
    Ok(ValidatedPolicy {
        policy,
        policy_sha256,
        valid_from,
        valid_until,
        verifying_key,
    })
}

fn validate_envelope(
    envelope: &DsseEnvelope,
    policy: &ReleasePolicy,
) -> Result<(), ReleaseVerificationError> {
    if envelope.payload_type != policy.payload_type
        || envelope.payload_type != DSSE_PAYLOAD_TYPE
        || envelope.signatures.len() != 1
        || envelope.signatures[0].keyid != policy.key_id
    {
        return Err(ReleaseVerificationError::InvalidField("dsse_envelope"));
    }
    decode_base64(&envelope.payload, 2, MAX_PACKET_BYTES, "manifest_payload")?;
    decode_base64(&envelope.signatures[0].sig, 64, 64, "dsse_signature")?;
    Ok(())
}

fn validate_inventory(
    inventory: &ModuleInventory,
) -> Result<InventoryFacts, ReleaseVerificationError> {
    if inventory.schema_version != 1
        || inventory.contract != MODULE_INVENTORY_CONTRACT
        || inventory.files.len() < REQUIRED_MODULE_PATHS.len()
        || inventory.files.len() > MAX_INVENTORY_FILES
    {
        return Err(ReleaseVerificationError::InvalidField("module_inventory"));
    }
    let mut by_path = BTreeMap::new();
    let mut previous: Option<&str> = None;
    let mut module_bytes = 0_u64;
    for record in &inventory.files {
        if !valid_module_path(&record.path)
            || previous.is_some_and(|value| record.path.as_str() <= value)
            || record.byte_length == 0
            || record.byte_length > MAX_INVENTORY_BYTES
        {
            return Err(ReleaseVerificationError::InvalidField(
                "module_inventory_record",
            ));
        }
        require_sha256(&record.sha256, "module_sha256")?;
        module_bytes = module_bytes.checked_add(record.byte_length).ok_or(
            ReleaseVerificationError::InvalidField("module_inventory_bytes"),
        )?;
        if module_bytes > MAX_INVENTORY_BYTES {
            return Err(ReleaseVerificationError::InvalidField(
                "module_inventory_bytes",
            ));
        }
        previous = Some(&record.path);
        by_path.insert(record.path.clone(), record.clone());
    }
    for required in REQUIRED_MODULE_PATHS {
        if !by_path.contains_key(required) {
            return Err(ReleaseVerificationError::InvalidField(
                "required_module_missing",
            ));
        }
    }
    Ok(InventoryFacts {
        digest_sha256: canonical_sha256(inventory)?,
        module_count: inventory.files.len() as u64,
        module_bytes,
        by_path,
    })
}

fn validate_manifest(
    manifest: &ReleaseManifest,
    inventory: &InventoryFacts,
    policy: &ValidatedPolicy,
    trust: &EmbeddedReleaseTrust,
    artifact_file_name: &str,
    artifact_bytes: &[u8],
    now: u64,
) -> Result<(), ReleaseVerificationError> {
    if manifest.schema_version != 1
        || manifest.contract != RELEASE_MANIFEST_CONTRACT
        || manifest.environment != "staging"
    {
        return Err(ReleaseVerificationError::InvalidField("manifest_contract"));
    }
    let issued_at = parse_whole_second_timestamp(&manifest.issued_at, "manifest_issued_at")?;
    let expires_at = parse_whole_second_timestamp(&manifest.expires_at, "manifest_expires_at")?;
    let lifetime = expires_at.saturating_sub(issued_at);
    if lifetime == 0
        || lifetime > policy.policy.maximum_release_lifetime_seconds
        || issued_at < policy.valid_from
        || expires_at > policy.valid_until
        || issued_at > now.saturating_add(MAX_CLOCK_SKEW_SECONDS)
        || now > expires_at.saturating_add(MAX_CLOCK_SKEW_SECONDS)
        || manifest.source_date_epoch == 0
        || manifest.source_date_epoch > issued_at
    {
        return Err(ReleaseVerificationError::InvalidField("manifest_validity"));
    }
    validate_source(&manifest.source, inventory)?;
    validate_build(&manifest.build)?;
    validate_manifest_trust(&manifest.trust, policy, trust)?;
    validate_evidence(&manifest.evidence)?;
    validate_artifact(
        &manifest.artifact,
        &manifest.build,
        artifact_file_name,
        artifact_bytes,
    )
}

fn validate_source(
    source: &ReleaseSource,
    inventory: &InventoryFacts,
) -> Result<(), ReleaseVerificationError> {
    if !valid_lower_hex(&source.commit_sha, 40) || !valid_lower_hex(&source.git_tree_sha, 40) {
        return Err(ReleaseVerificationError::InvalidField("git_identity"));
    }
    for (field, value) in [
        (
            "source_archive_sha256",
            source.source_archive_sha256.as_str(),
        ),
        ("cargo_lock_sha256", source.cargo_lock_sha256.as_str()),
        ("bun_lock_sha256", source.bun_lock_sha256.as_str()),
        ("package_json_sha256", source.package_json_sha256.as_str()),
        (
            "module_inventory_sha256",
            source.module_inventory_sha256.as_str(),
        ),
    ] {
        require_sha256(value, field)?;
    }
    if source.module_inventory_sha256 != inventory.digest_sha256
        || source.module_count != inventory.module_count
        || source.module_bytes != inventory.module_bytes
    {
        return Err(ReleaseVerificationError::DigestMismatch("module_inventory"));
    }
    for (value, path) in [
        (&source.cargo_lock_sha256, "Cargo.lock"),
        (&source.bun_lock_sha256, "bun.lock"),
        (&source.package_json_sha256, "package.json"),
    ] {
        if inventory.by_path.get(path).map(|record| &record.sha256) != Some(value) {
            return Err(ReleaseVerificationError::DigestMismatch("source_module"));
        }
    }
    Ok(())
}

fn validate_build(build: &ReleaseBuild) -> Result<(), ReleaseVerificationError> {
    if !matches!(
        build.target_triple.as_str(),
        "x86_64-pc-windows-msvc" | "x86_64-unknown-linux-musl"
    ) || build.profile != "release"
        || !valid_bounded_ascii(&build.rustc_version, 1, 256)
        || !valid_bounded_ascii(&build.cargo_version, 1, 256)
        || !valid_bounded_ascii(&build.bun_version, 1, 256)
        || !build.two_builds_identical
    {
        return Err(ReleaseVerificationError::InvalidField("build"));
    }
    for (field, value) in [
        (
            "build_arguments_sha256",
            build.build_arguments_sha256.as_str(),
        ),
        (
            "build_environment_allowlist_sha256",
            build.build_environment_allowlist_sha256.as_str(),
        ),
        ("runner_build_sha256", build.runner_build_sha256.as_str()),
        ("first_build_sha256", build.first_build_sha256.as_str()),
        ("second_build_sha256", build.second_build_sha256.as_str()),
        (
            "reproducible_build_sha256",
            build.reproducible_build_sha256.as_str(),
        ),
    ] {
        require_sha256(value, field)?;
    }
    if build.runner_build_sha256 != build.first_build_sha256
        || build.runner_build_sha256 != build.second_build_sha256
        || build.runner_build_sha256 != build.reproducible_build_sha256
    {
        return Err(ReleaseVerificationError::DigestMismatch(
            "reproducible_build",
        ));
    }
    Ok(())
}

fn validate_manifest_trust(
    manifest_trust: &ReleaseTrust,
    policy: &ValidatedPolicy,
    trust: &EmbeddedReleaseTrust,
) -> Result<(), ReleaseVerificationError> {
    for (field, value) in [
        (
            "trust_config_sha256",
            manifest_trust.trust_config_sha256.as_str(),
        ),
        (
            "release_policy_sha256",
            manifest_trust.release_policy_sha256.as_str(),
        ),
        (
            "release_key_spki_sha256",
            manifest_trust.release_key_spki_sha256.as_str(),
        ),
        (
            "permit_spki_sha256",
            manifest_trust.permit_spki_sha256.as_str(),
        ),
    ] {
        require_sha256(value, field)?;
    }
    if manifest_trust.release_policy_sha256 != policy.policy_sha256
        || manifest_trust.release_key_spki_sha256 != policy.policy.release_key_spki_sha256
    {
        return Err(ReleaseVerificationError::DigestMismatch("manifest_trust"));
    }
    if manifest_trust.permit_spki_sha256 == policy.policy.release_key_spki_sha256
        || !policy
            .policy
            .forbidden_key_spki_sha256
            .contains(&manifest_trust.permit_spki_sha256)
    {
        return Err(ReleaseVerificationError::InvalidField(
            "permit_key_separation",
        ));
    }
    if manifest_trust.authority_origin != STAGING_AUTHORITY_ORIGIN
        || Some(manifest_trust.authority_origin.as_str()) != trust.authority_origin
        || !valid_version_id(&manifest_trust.authority_version_id)
    {
        return Err(ReleaseVerificationError::InvalidField("manifest_authority"));
    }
    Ok(())
}

fn validate_evidence(evidence: &ReleaseEvidence) -> Result<(), ReleaseVerificationError> {
    for (field, value) in [
        (
            "test_evidence_sha256",
            evidence.test_evidence_sha256.as_str(),
        ),
        (
            "fault_evidence_sha256",
            evidence.fault_evidence_sha256.as_str(),
        ),
        (
            "security_evidence_sha256",
            evidence.security_evidence_sha256.as_str(),
        ),
        (
            "no_secret_evidence_sha256",
            evidence.no_secret_evidence_sha256.as_str(),
        ),
    ] {
        require_sha256(value, field)?;
    }
    Ok(())
}

fn validate_artifact(
    artifact: &ReleaseArtifact,
    build: &ReleaseBuild,
    artifact_file_name: &str,
    artifact_bytes: &[u8],
) -> Result<(), ReleaseVerificationError> {
    let expected_name = if build.target_triple == "x86_64-pc-windows-msvc" {
        format!("{ARTIFACT_BASENAME}.exe")
    } else {
        ARTIFACT_BASENAME.to_owned()
    };
    if artifact.file_name != expected_name
        || artifact_file_name != expected_name
        || artifact.byte_length == 0
        || artifact.byte_length > MAX_ARTIFACT_BYTES as u64
        || artifact_bytes.len() as u64 != artifact.byte_length
    {
        return Err(ReleaseVerificationError::InvalidField("artifact"));
    }
    require_sha256(&artifact.sha256, "artifact_sha256")?;
    if artifact.sha256 != build.runner_build_sha256 || artifact.sha256 != sha256_hex(artifact_bytes)
    {
        return Err(ReleaseVerificationError::DigestMismatch("artifact"));
    }
    Ok(())
}

fn parse_canonical_json<T>(
    bytes: &[u8],
    maximum_bytes: usize,
    label: &'static str,
) -> Result<T, ReleaseVerificationError>
where
    T: DeserializeOwned + Serialize,
{
    reject_duplicate_json(bytes, maximum_bytes)
        .map_err(|_| ReleaseVerificationError::InvalidJson(label))?;
    let parsed: T =
        serde_json::from_slice(bytes).map_err(|_| ReleaseVerificationError::InvalidJson(label))?;
    let canonical = canonical_json(&parsed)?;
    if canonical.as_bytes() != bytes {
        return Err(ReleaseVerificationError::NonCanonicalJson(label));
    }
    Ok(parsed)
}

fn dsse_pre_authentication_encoding(
    payload_type: &str,
    payload: &[u8],
) -> Result<Vec<u8>, ReleaseVerificationError> {
    if payload_type != DSSE_PAYLOAD_TYPE {
        return Err(ReleaseVerificationError::InvalidField("dsse_payload_type"));
    }
    let mut output = Vec::with_capacity(payload.len() + payload_type.len() + 64);
    output.extend_from_slice(b"DSSEv1 ");
    output.extend_from_slice(payload_type.len().to_string().as_bytes());
    output.push(b' ');
    output.extend_from_slice(payload_type.as_bytes());
    output.push(b' ');
    output.extend_from_slice(payload.len().to_string().as_bytes());
    output.push(b' ');
    output.extend_from_slice(payload);
    Ok(output)
}

fn decode_base64(
    value: &str,
    minimum_bytes: usize,
    maximum_bytes: usize,
    field: &'static str,
) -> Result<Vec<u8>, ReleaseVerificationError> {
    if value.is_empty() || value.len() % 4 != 0 || !value.is_ascii() {
        return Err(ReleaseVerificationError::InvalidField(field));
    }
    let bytes = STANDARD
        .decode(value)
        .map_err(|_| ReleaseVerificationError::InvalidField(field))?;
    if bytes.len() < minimum_bytes
        || bytes.len() > maximum_bytes
        || STANDARD.encode(&bytes) != value
    {
        return Err(ReleaseVerificationError::InvalidField(field));
    }
    Ok(bytes)
}

fn decode_base64url(
    value: &str,
    minimum_bytes: usize,
    maximum_bytes: usize,
    field: &'static str,
) -> Result<Vec<u8>, ReleaseVerificationError> {
    if value.is_empty() || value.contains('=') || !value.is_ascii() {
        return Err(ReleaseVerificationError::InvalidField(field));
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| ReleaseVerificationError::InvalidField(field))?;
    if bytes.len() < minimum_bytes
        || bytes.len() > maximum_bytes
        || URL_SAFE_NO_PAD.encode(&bytes) != value
    {
        return Err(ReleaseVerificationError::InvalidField(field));
    }
    Ok(bytes)
}

fn parse_whole_second_timestamp(
    value: &str,
    field: &'static str,
) -> Result<u64, ReleaseVerificationError> {
    let bytes = value.as_bytes();
    if bytes.len() != 24
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || &bytes[19..24] != b".000Z"
    {
        return Err(ReleaseVerificationError::InvalidField(field));
    }
    let year = parse_digits(bytes, 0, 4, field)? as i64;
    let month = parse_digits(bytes, 5, 7, field)?;
    let day = parse_digits(bytes, 8, 10, field)?;
    let hour = parse_digits(bytes, 11, 13, field)?;
    let minute = parse_digits(bytes, 14, 16, field)?;
    let second = parse_digits(bytes, 17, 19, field)?;
    if !(1970..=9999).contains(&year)
        || !(1..=12).contains(&month)
        || day == 0
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return Err(ReleaseVerificationError::InvalidField(field));
    }
    let days = days_from_civil(year, month, day);
    let seconds = days
        .checked_mul(86_400)
        .and_then(|value| value.checked_add(i64::from(hour * 3_600 + minute * 60 + second)))
        .ok_or(ReleaseVerificationError::InvalidField(field))?;
    let seconds =
        u64::try_from(seconds).map_err(|_| ReleaseVerificationError::InvalidField(field))?;
    if seconds > MAX_SAFE_INTEGER {
        return Err(ReleaseVerificationError::InvalidField(field));
    }
    Ok(seconds)
}

fn parse_digits(
    bytes: &[u8],
    start: usize,
    end: usize,
    field: &'static str,
) -> Result<u32, ReleaseVerificationError> {
    let mut value = 0_u32;
    for byte in &bytes[start..end] {
        if !byte.is_ascii_digit() {
            return Err(ReleaseVerificationError::InvalidField(field));
        }
        value = value * 10 + u32::from(byte - b'0');
    }
    Ok(value)
}

fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        _ => 0,
    }
}

fn days_from_civil(mut year: i64, month: u32, day: u32) -> i64 {
    year -= i64::from(month <= 2);
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let adjusted_month = i64::from(month) + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * adjusted_month + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn valid_key_id(value: &str) -> bool {
    valid_token(value, 1, 64, |index, byte| {
        byte.is_ascii_lowercase()
            || byte.is_ascii_digit()
            || (index > 0 && matches!(byte, b'.' | b'_' | b'-'))
    })
}

fn valid_version_id(value: &str) -> bool {
    valid_token(value, 1, 128, |index, byte| {
        byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b':' | b'-'))
    })
}

fn valid_token(
    value: &str,
    minimum: usize,
    maximum: usize,
    predicate: impl Fn(usize, u8) -> bool,
) -> bool {
    value.len() >= minimum
        && value.len() <= maximum
        && value
            .bytes()
            .enumerate()
            .all(|(index, byte)| predicate(index, byte))
}

fn valid_bounded_ascii(value: &str, minimum: usize, maximum: usize) -> bool {
    value.len() >= minimum
        && value.len() <= maximum
        && value.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
}

fn valid_module_path(value: &str) -> bool {
    if value.is_empty()
        || value.len() > 240
        || value.starts_with('/')
        || value.ends_with('/')
        || value.contains('\\')
        || value.contains("//")
    {
        return false;
    }
    if !value.bytes().enumerate().all(|(index, byte)| {
        if index == 0 {
            byte.is_ascii_alphanumeric() || byte == b'.'
        } else {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'/' | b'-')
        }
    }) {
        return false;
    }
    !value
        .split('/')
        .any(|component| component == "." || component == "..")
}

fn require_sha256(value: &str, field: &'static str) -> Result<(), ReleaseVerificationError> {
    if !valid_lower_hex(value, 64) {
        return Err(ReleaseVerificationError::InvalidField(field));
    }
    Ok(())
}

fn valid_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn read_stable_regular_file(
    path: &Path,
    maximum_bytes: usize,
    canonical_parent: &Path,
    label: &'static str,
) -> Result<Vec<u8>, ReleaseVerificationError> {
    let initial =
        fs::symlink_metadata(path).map_err(|_| ReleaseVerificationError::FileInvalid(label))?;
    if !initial.file_type().is_file()
        || initial.file_type().is_symlink()
        || initial.len() == 0
        || initial.len() > maximum_bytes as u64
        || has_multiple_links(&initial)
    {
        return Err(ReleaseVerificationError::FileInvalid(label));
    }
    let canonical =
        fs::canonicalize(path).map_err(|_| ReleaseVerificationError::FileInvalid(label))?;
    if canonical.parent() != Some(canonical_parent) {
        return Err(ReleaseVerificationError::FileInvalid(label));
    }
    let initial_handle =
        Handle::from_path(path).map_err(|_| ReleaseVerificationError::FileInvalid(label))?;
    let mut file = File::open(path).map_err(|_| ReleaseVerificationError::FileInvalid(label))?;
    let opened = file
        .metadata()
        .map_err(|_| ReleaseVerificationError::FileInvalid(label))?;
    if !metadata_snapshot_matches(&initial, &opened) {
        return Err(ReleaseVerificationError::FileInvalid(label));
    }
    let handle = Handle::from_file(
        file.try_clone()
            .map_err(|_| ReleaseVerificationError::FileInvalid(label))?,
    )
    .map_err(|_| ReleaseVerificationError::FileInvalid(label))?;
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    (&mut file)
        .take(maximum_bytes as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ReleaseVerificationError::FileInvalid(label))?;
    let after = file
        .metadata()
        .map_err(|_| ReleaseVerificationError::FileInvalid(label))?;
    let final_metadata =
        fs::symlink_metadata(path).map_err(|_| ReleaseVerificationError::FileInvalid(label))?;
    let final_handle =
        Handle::from_path(path).map_err(|_| ReleaseVerificationError::FileInvalid(label))?;
    let final_canonical =
        fs::canonicalize(path).map_err(|_| ReleaseVerificationError::FileInvalid(label))?;
    if handle != initial_handle
        || bytes.len() != opened.len() as usize
        || !metadata_snapshot_matches(&opened, &after)
        || !metadata_snapshot_matches(&opened, &final_metadata)
        || handle != final_handle
        || canonical != final_canonical
        || has_multiple_links(&final_metadata)
    {
        return Err(ReleaseVerificationError::FileInvalid(label));
    }
    Ok(bytes)
}

fn metadata_snapshot_matches(left: &Metadata, right: &Metadata) -> bool {
    left.file_type().is_file()
        && right.file_type().is_file()
        && left.len() == right.len()
        && left.modified().ok() == right.modified().ok()
        && left.created().ok() == right.created().ok()
}

#[cfg(unix)]
fn has_multiple_links(metadata: &Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    metadata.nlink() != 1
}

#[cfg(not(unix))]
fn has_multiple_links(_metadata: &Metadata) -> bool {
    false
}

fn canonical_sha256<T: Serialize>(value: &T) -> Result<String, ReleaseVerificationError> {
    Ok(sha256_hex(canonical_json(value)?.as_bytes()))
}

fn canonical_json<T: Serialize>(value: &T) -> Result<String, ReleaseVerificationError> {
    let value = serde_json::to_value(value)
        .map_err(|_| ReleaseVerificationError::InvalidField("canonical_json"))?;
    let mut output = String::new();
    write_canonical(&value, &mut output)?;
    Ok(output)
}

fn write_canonical(value: &Value, output: &mut String) -> Result<(), ReleaseVerificationError> {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::Number(number) => {
            let valid = number
                .as_u64()
                .map(|value| value <= MAX_SAFE_INTEGER)
                .or_else(|| {
                    number
                        .as_i64()
                        .map(|value| value >= -(MAX_SAFE_INTEGER as i64))
                })
                .unwrap_or(false);
            if !valid || number.as_f64().is_some_and(|value| value.fract() != 0.0) {
                return Err(ReleaseVerificationError::InvalidField("canonical_number"));
            }
            output.push_str(&number.to_string());
        }
        Value::String(value) => output.push_str(
            &serde_json::to_string(value)
                .map_err(|_| ReleaseVerificationError::InvalidField("canonical_string"))?,
        ),
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_canonical(value, output)?;
            }
            output.push(']');
        }
        Value::Object(values) => {
            output.push('{');
            let mut entries = values.iter().collect::<Vec<_>>();
            entries.sort_unstable_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
            for (index, (key, value)) in entries.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(
                    &serde_json::to_string(key)
                        .map_err(|_| ReleaseVerificationError::InvalidField("canonical_key"))?,
                );
                output.push(':');
                write_canonical(value, output)?;
            }
            output.push('}');
        }
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex_lower(&Sha256::digest(bytes))
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[usize::from(byte >> 4)] as char);
        output.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    output
}

struct NoDuplicateJson;

impl<'de> Deserialize<'de> for NoDuplicateJson {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(NoDuplicateJsonVisitor)?;
        Ok(Self)
    }
}

struct NoDuplicateJsonVisitor;

impl<'de> Visitor<'de> for NoDuplicateJsonVisitor {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("JSON without duplicate object fields")
    }

    fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_i64<E>(self, _value: i64) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_u64<E>(self, _value: u64) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_str<E>(self, _value: &str) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_string<E>(self, _value: String) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        NoDuplicateJson::deserialize(deserializer)?;
        Ok(())
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        while sequence.next_element::<NoDuplicateJson>()?.is_some() {}
        Ok(())
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut fields = BTreeSet::new();
        while let Some(field) = map.next_key::<String>()? {
            if !fields.insert(field) {
                return Err(A::Error::custom("duplicate JSON field"));
            }
            map.next_value::<NoDuplicateJson>()?;
        }
        Ok(())
    }
}

fn reject_duplicate_json(bytes: &[u8], maximum_bytes: usize) -> Result<(), ()> {
    if bytes.is_empty() || bytes.len() > maximum_bytes {
        return Err(());
    }
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    NoDuplicateJson::deserialize(&mut deserializer).map_err(|_| ())?;
    deserializer.end().map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{RELEASE_PACKET_FILE_NAME, RELEASE_POLICY_FILE_NAME};
    use ed25519_dalek::{Signer, SigningKey};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    const TEST_SEED: [u8; 32] = [7; 32];

    #[test]
    fn verifies_canonical_detached_release_against_compiled_pins() {
        let fixture = release_fixture();
        let verified = verify(&fixture).unwrap();
        assert_eq!(verified.source_commit, "1".repeat(40));
        assert_eq!(verified.git_tree_sha, "2".repeat(40));
        assert_eq!(verified.policy_sha256, sha256_hex(&fixture.policy_json));
        assert_eq!(verified.artifact_sha256, sha256_hex(&fixture.artifact));
        assert_eq!(verified.module_count, REQUIRED_MODULE_PATHS.len() as u64);
        assert_eq!(verified.authority_version_id, "authority-version-001");
        assert_eq!(
            verified.release_key_spki_sha256,
            "324be2dea8bc44461b0233e51fa48902ed6b1cc671e7739af2551e0bfe68f54e"
        );
        assert_eq!(
            verified.policy_sha256,
            "9b12c3dd50812180f2122311480876bd6508a81618082c615ca52d4701ec3856"
        );
        assert_eq!(
            verified.module_inventory_sha256,
            "686c6dedb4686bed7e33290ec3ce087e07c581c70eff35222f32581062009370"
        );
        assert_eq!(
            verified.manifest_sha256,
            "01d1f22f04245c8e467421e43aa25b5dbd4b5166fdf29819f518e01af455dda3"
        );
        assert_eq!(
            verified.packet_sha256,
            "48c0f232106474c489109982de470737c69c63acee984f68d373e486819885bc"
        );
        let packet: ReleasePacket = serde_json::from_slice(&fixture.packet_json).unwrap();
        assert_eq!(
            packet.envelope.signatures[0].sig,
            "xd572FoAEqiTiFWTL9nFgUc9CYvbyIPJyD8ehNXUEvF9He5Zq7yt54H994eQ/lk1pRNfepK97z9vqwMRP39MCQ=="
        );
    }

    #[test]
    fn rejects_noncanonical_duplicate_pinned_and_signed_drift() {
        let fixture = release_fixture();

        let mut noncanonical_policy = fixture.policy_json.clone();
        noncanonical_policy.push(b'\n');
        assert_eq!(
            verify_release_bytes(
                &fixture.trust,
                &fixture.packet_json,
                &noncanonical_policy,
                &fixture.artifact_file_name,
                &fixture.artifact,
                fixture.now,
            ),
            Err(ReleaseVerificationError::NonCanonicalJson("policy"))
        );

        let packet_text = String::from_utf8(fixture.packet_json.clone()).unwrap();
        let duplicate_packet = format!(
            "{{\"contract\":\"{RELEASE_PACKET_CONTRACT}\",{}",
            &packet_text[1..]
        );
        assert_eq!(
            verify_release_bytes(
                &fixture.trust,
                duplicate_packet.as_bytes(),
                &fixture.policy_json,
                &fixture.artifact_file_name,
                &fixture.artifact,
                fixture.now,
            ),
            Err(ReleaseVerificationError::InvalidJson("packet"))
        );

        let mut wrong_pin = fixture.trust.clone();
        wrong_pin.release_policy_sha256 = Some("0".repeat(64).leak());
        assert_eq!(
            verify_release_bytes(
                &wrong_pin,
                &fixture.packet_json,
                &fixture.policy_json,
                &fixture.artifact_file_name,
                &fixture.artifact,
                fixture.now,
            ),
            Err(ReleaseVerificationError::DigestMismatch(
                "compiled_policy_pin"
            ))
        );

        let mut packet: Value = serde_json::from_slice(&fixture.packet_json).unwrap();
        packet["envelope"]["signatures"][0]["sig"] = Value::String(STANDARD.encode([0_u8; 64]));
        let packet = canonical_json(&packet).unwrap();
        assert_eq!(
            verify_release_bytes(
                &fixture.trust,
                packet.as_bytes(),
                &fixture.policy_json,
                &fixture.artifact_file_name,
                &fixture.artifact,
                fixture.now,
            ),
            Err(ReleaseVerificationError::SignatureInvalid)
        );
    }

    #[test]
    fn rejects_inventory_build_authority_artifact_and_time_drift() {
        let fixture = release_fixture();

        let mut packet: Value = serde_json::from_slice(&fixture.packet_json).unwrap();
        packet["moduleInventory"]["files"]
            .as_array_mut()
            .unwrap()
            .remove(0);
        let packet = canonical_json(&packet).unwrap();
        assert_eq!(
            verify_release_bytes(
                &fixture.trust,
                packet.as_bytes(),
                &fixture.policy_json,
                &fixture.artifact_file_name,
                &fixture.artifact,
                fixture.now,
            ),
            Err(ReleaseVerificationError::InvalidField("module_inventory"))
        );

        let build_drift = resign_manifest(&fixture, |manifest| {
            manifest["build"]["secondBuildSha256"] = Value::String("f".repeat(64));
        });
        assert_eq!(
            verify_release_bytes(
                &fixture.trust,
                &build_drift,
                &fixture.policy_json,
                &fixture.artifact_file_name,
                &fixture.artifact,
                fixture.now,
            ),
            Err(ReleaseVerificationError::DigestMismatch(
                "reproducible_build"
            ))
        );

        let authority_drift = resign_manifest(&fixture, |manifest| {
            manifest["trust"]["authorityOrigin"] =
                Value::String("https://unreviewed.example.com".to_owned());
        });
        assert_eq!(
            verify_release_bytes(
                &fixture.trust,
                &authority_drift,
                &fixture.policy_json,
                &fixture.artifact_file_name,
                &fixture.artifact,
                fixture.now,
            ),
            Err(ReleaseVerificationError::InvalidField("manifest_authority"))
        );

        let permit_drift = resign_manifest(&fixture, |manifest| {
            manifest["trust"]["permitSpkiSha256"] = Value::String("4".repeat(64));
        });
        assert_eq!(
            verify_release_bytes(
                &fixture.trust,
                &permit_drift,
                &fixture.policy_json,
                &fixture.artifact_file_name,
                &fixture.artifact,
                fixture.now,
            ),
            Err(ReleaseVerificationError::InvalidField(
                "permit_key_separation"
            ))
        );

        let mut artifact_drift = fixture.artifact.clone();
        artifact_drift[0] ^= 1;
        assert_eq!(
            verify_release_bytes(
                &fixture.trust,
                &fixture.packet_json,
                &fixture.policy_json,
                &fixture.artifact_file_name,
                &artifact_drift,
                fixture.now,
            ),
            Err(ReleaseVerificationError::DigestMismatch("artifact"))
        );

        assert_eq!(
            verify_release_bytes(
                &fixture.trust,
                &fixture.packet_json,
                &fixture.policy_json,
                &fixture.artifact_file_name,
                &fixture.artifact,
                parse_whole_second_timestamp("2026-07-25T00:10:00.000Z", "test").unwrap(),
            ),
            Err(ReleaseVerificationError::InvalidField("policy_validity"))
        );
    }

    #[test]
    fn fixed_installation_reads_only_sibling_regular_files() {
        let target_triple = current_release_target().unwrap_or("x86_64-pc-windows-msvc");
        let fixture = release_fixture_for_target(target_triple);
        let directory = temporary_directory();
        fs::create_dir_all(&directory).unwrap();
        let executable = directory.join(&fixture.artifact_file_name);
        let packet = directory.join(RELEASE_PACKET_FILE_NAME);
        let policy = directory.join(RELEASE_POLICY_FILE_NAME);
        fs::write(&executable, &fixture.artifact).unwrap();
        fs::write(&packet, &fixture.packet_json).unwrap();
        fs::write(&policy, &fixture.policy_json).unwrap();

        let result = verify_installed_release_at(&fixture.trust, &executable, fixture.now);
        if current_release_target().is_some() {
            assert_eq!(
                result.unwrap().artifact_sha256,
                sha256_hex(&fixture.artifact)
            );
        } else {
            assert_eq!(
                result,
                Err(ReleaseVerificationError::InvalidField(
                    "installed_target_triple"
                ))
            );
        }

        fs::remove_file(&policy).unwrap();
        assert_eq!(
            verify_installed_release_at(&fixture.trust, &executable, fixture.now),
            Err(ReleaseVerificationError::FileInvalid("policy"))
        );
        fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn installed_release_rejects_a_valid_foreign_target() {
        let foreign_target = match current_release_target() {
            Some("x86_64-pc-windows-msvc") => "x86_64-unknown-linux-musl",
            _ => "x86_64-pc-windows-msvc",
        };
        let fixture = release_fixture_for_target(foreign_target);
        let directory = temporary_directory();
        fs::create_dir_all(&directory).unwrap();
        let executable = directory.join(&fixture.artifact_file_name);
        fs::write(&executable, &fixture.artifact).unwrap();
        fs::write(
            directory.join(RELEASE_PACKET_FILE_NAME),
            &fixture.packet_json,
        )
        .unwrap();
        fs::write(
            directory.join(RELEASE_POLICY_FILE_NAME),
            &fixture.policy_json,
        )
        .unwrap();

        assert_eq!(
            verify_installed_release_at(&fixture.trust, &executable, fixture.now),
            Err(ReleaseVerificationError::InvalidField(
                "installed_target_triple"
            ))
        );
        fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn disabled_launcher_stops_before_current_executable_or_sidecar_reads() {
        assert_eq!(
            verify_current_release(&EmbeddedReleaseTrust::checked_in(), 1),
            Err(ReleaseVerificationError::Trust(
                ReleaseValidationError::Disabled
            ))
        );
        let source = include_str!("release.rs");
        for forbidden in [
            ["std::env", "::var"].concat(),
            ["std::process", "::Command"].concat(),
            ["req", "west"].concat(),
            ["hy", "per::"].concat(),
            ["wrang", "ler"].concat(),
        ] {
            assert!(!source.contains(&forbidden));
        }
    }

    #[test]
    fn whole_second_parser_matches_leap_and_epoch_boundaries() {
        assert_eq!(
            parse_whole_second_timestamp("1970-01-01T00:00:00.000Z", "test"),
            Ok(0)
        );
        assert!(parse_whole_second_timestamp("2024-02-29T23:59:59.000Z", "test").is_ok());
        assert!(parse_whole_second_timestamp("2023-02-29T00:00:00.000Z", "test").is_err());
        assert!(parse_whole_second_timestamp("2026-07-23T00:00:00.001Z", "test").is_err());
    }

    struct ReleaseFixture {
        trust: EmbeddedReleaseTrust,
        packet_json: Vec<u8>,
        policy_json: Vec<u8>,
        artifact_file_name: String,
        artifact: Vec<u8>,
        now: u64,
    }

    fn release_fixture() -> ReleaseFixture {
        release_fixture_for_target("x86_64-pc-windows-msvc")
    }

    fn release_fixture_for_target(target_triple: &str) -> ReleaseFixture {
        let signing_key = signing_key();
        let mut spki = ED25519_SPKI_PREFIX.to_vec();
        spki.extend_from_slice(signing_key.verifying_key().as_bytes());
        let release_key_sha256 = sha256_hex(&spki);
        let policy = ReleasePolicy {
            schema_version: 1,
            contract: RELEASE_POLICY_CONTRACT.to_owned(),
            environment: "staging".to_owned(),
            payload_type: DSSE_PAYLOAD_TYPE.to_owned(),
            key_id: "release-test-v1".to_owned(),
            release_key_spki_base64url: URL_SAFE_NO_PAD.encode(&spki),
            release_key_spki_sha256: release_key_sha256.clone(),
            valid_from: "2026-07-22T00:00:00.000Z".to_owned(),
            valid_until: "2026-07-24T00:00:00.000Z".to_owned(),
            maximum_release_lifetime_seconds: 86_400,
            forbidden_key_spki_sha256: vec!["1".repeat(64), "2".repeat(64), "8".repeat(64)],
        };
        let policy_json = canonical_json(&policy).unwrap().into_bytes();
        let policy_sha256 = sha256_hex(&policy_json);

        let files = REQUIRED_MODULE_PATHS
            .iter()
            .map(|path| {
                let contents = format!("fixture:{path}");
                ModuleRecord {
                    path: (*path).to_owned(),
                    byte_length: contents.len() as u64,
                    sha256: sha256_hex(contents.as_bytes()),
                }
            })
            .collect::<Vec<_>>();
        let inventory = ModuleInventory {
            schema_version: 1,
            contract: MODULE_INVENTORY_CONTRACT.to_owned(),
            files,
        };
        let inventory_digest = canonical_sha256(&inventory).unwrap();
        let module_bytes = inventory
            .files
            .iter()
            .map(|record| record.byte_length)
            .sum();
        let by_path = inventory
            .files
            .iter()
            .map(|record| (record.path.as_str(), record.sha256.as_str()))
            .collect::<BTreeMap<_, _>>();

        let artifact = b"cinatoken-ring-transition-runner-rust-release-fixture".to_vec();
        let artifact_sha256 = sha256_hex(&artifact);
        let artifact_file_name = if target_triple == "x86_64-pc-windows-msvc" {
            format!("{ARTIFACT_BASENAME}.exe")
        } else {
            ARTIFACT_BASENAME.to_owned()
        };
        let manifest = ReleaseManifest {
            schema_version: 1,
            contract: RELEASE_MANIFEST_CONTRACT.to_owned(),
            environment: "staging".to_owned(),
            issued_at: "2026-07-23T00:00:00.000Z".to_owned(),
            expires_at: "2026-07-23T12:00:00.000Z".to_owned(),
            source_date_epoch: parse_whole_second_timestamp("2026-07-23T00:00:00.000Z", "test")
                .unwrap(),
            source: ReleaseSource {
                commit_sha: "1".repeat(40),
                git_tree_sha: "2".repeat(40),
                source_archive_sha256: "4".repeat(64),
                cargo_lock_sha256: by_path["Cargo.lock"].to_owned(),
                bun_lock_sha256: by_path["bun.lock"].to_owned(),
                package_json_sha256: by_path["package.json"].to_owned(),
                module_inventory_sha256: inventory_digest,
                module_count: inventory.files.len() as u64,
                module_bytes,
            },
            build: ReleaseBuild {
                target_triple: target_triple.to_owned(),
                profile: "release".to_owned(),
                rustc_version: "rustc test fixture".to_owned(),
                cargo_version: "cargo test fixture".to_owned(),
                bun_version: "bun test fixture".to_owned(),
                build_arguments_sha256: "5".repeat(64),
                build_environment_allowlist_sha256: "6".repeat(64),
                runner_build_sha256: artifact_sha256.clone(),
                first_build_sha256: artifact_sha256.clone(),
                second_build_sha256: artifact_sha256.clone(),
                reproducible_build_sha256: artifact_sha256.clone(),
                two_builds_identical: true,
            },
            trust: ReleaseTrust {
                trust_config_sha256: "7".repeat(64),
                release_policy_sha256: policy_sha256.clone(),
                release_key_spki_sha256: release_key_sha256.clone(),
                authority_origin: STAGING_AUTHORITY_ORIGIN.to_owned(),
                authority_version_id: "authority-version-001".to_owned(),
                permit_spki_sha256: "8".repeat(64),
            },
            evidence: ReleaseEvidence {
                test_evidence_sha256: "9".repeat(64),
                fault_evidence_sha256: "a".repeat(64),
                security_evidence_sha256: "b".repeat(64),
                no_secret_evidence_sha256: "c".repeat(64),
            },
            artifact: ReleaseArtifact {
                file_name: artifact_file_name.clone(),
                byte_length: artifact.len() as u64,
                sha256: artifact_sha256,
            },
        };
        let manifest_json = canonical_json(&manifest).unwrap().into_bytes();
        let pae = dsse_pre_authentication_encoding(DSSE_PAYLOAD_TYPE, &manifest_json).unwrap();
        let signature = signing_key.sign(&pae);
        let packet = ReleasePacket {
            schema_version: 1,
            contract: RELEASE_PACKET_CONTRACT.to_owned(),
            envelope: DsseEnvelope {
                payload_type: DSSE_PAYLOAD_TYPE.to_owned(),
                payload: STANDARD.encode(&manifest_json),
                signatures: vec![DsseSignature {
                    keyid: policy.key_id.clone(),
                    sig: STANDARD.encode(signature.to_bytes()),
                }],
            },
            module_inventory: inventory,
        };
        let packet_json = canonical_json(&packet).unwrap().into_bytes();
        let trust = EmbeddedReleaseTrust {
            enabled: true,
            release_policy_sha256: Some(policy_sha256.leak()),
            release_key_spki_sha256: Some(release_key_sha256.leak()),
            authority_origin: Some(STAGING_AUTHORITY_ORIGIN),
            ..EmbeddedReleaseTrust::checked_in()
        };
        ReleaseFixture {
            trust,
            packet_json,
            policy_json,
            artifact_file_name,
            artifact,
            now: parse_whole_second_timestamp("2026-07-23T06:00:00.000Z", "test").unwrap(),
        }
    }

    fn verify(fixture: &ReleaseFixture) -> Result<VerifiedRelease, ReleaseVerificationError> {
        verify_release_bytes(
            &fixture.trust,
            &fixture.packet_json,
            &fixture.policy_json,
            &fixture.artifact_file_name,
            &fixture.artifact,
            fixture.now,
        )
    }

    fn resign_manifest(fixture: &ReleaseFixture, mutate: impl FnOnce(&mut Value)) -> Vec<u8> {
        let mut packet: Value = serde_json::from_slice(&fixture.packet_json).unwrap();
        let payload = packet["envelope"]["payload"].as_str().unwrap();
        let manifest_bytes = STANDARD.decode(payload).unwrap();
        let mut manifest: Value = serde_json::from_slice(&manifest_bytes).unwrap();
        mutate(&mut manifest);
        let manifest_bytes = canonical_json(&manifest).unwrap().into_bytes();
        let pae = dsse_pre_authentication_encoding(DSSE_PAYLOAD_TYPE, &manifest_bytes).unwrap();
        packet["envelope"]["payload"] = Value::String(STANDARD.encode(&manifest_bytes));
        packet["envelope"]["signatures"][0]["sig"] =
            Value::String(STANDARD.encode(signing_key().sign(&pae).to_bytes()));
        canonical_json(&packet).unwrap().into_bytes()
    }

    fn signing_key() -> SigningKey {
        SigningKey::from_bytes(&TEST_SEED)
    }

    fn temporary_directory() -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "cinatoken-ring-release-rust-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
    }
}
