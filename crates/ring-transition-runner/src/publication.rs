use crate::release::{
    self, canonical_json, current_release_target, parse_canonical_json,
    parse_whole_second_timestamp, read_stable_regular_file, sha256_hex, VerifiedRelease,
    MAX_ARTIFACT_BYTES, MAX_CLOCK_SKEW_SECONDS, MAX_PACKET_BYTES, MAX_POLICY_BYTES,
    MAX_SAFE_INTEGER,
};
use crate::{
    EmbeddedReleaseTrust, PUBLICATION_PACKET_FILE_NAME, RELEASE_PACKET_FILE_NAME,
    RELEASE_POLICY_FILE_NAME, STAGING_AUTHORITY_ORIGIN,
};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

pub const PUBLICATION_MANIFEST_CONTRACT: &str =
    "cinatoken-relay-container-ring-transition-runner-publication-manifest-v1";
pub const PUBLICATION_PACKET_CONTRACT: &str =
    "cinatoken-relay-container-ring-transition-runner-publication-packet-v1";
pub const PUBLICATION_GENERATION_CONTRACT: &str =
    "cinatoken-relay-container-ring-transition-runner-publication-generation-v1";
pub const PUBLICATION_ACTIVATION_CONTRACT: &str =
    "cinatoken-relay-container-ring-transition-runner-publication-activation-v1";
pub const PUBLICATION_DSSE_PAYLOAD_TYPE: &str =
    "application/vnd.cinatoken.ring-transition-runner-publication.v1+json";
const MAX_PUBLICATION_PACKET_BYTES: usize = 512 * 1024;
const MAX_ACTIVATION_BYTES: usize = 16 * 1024;
const PUBLICATIONS_DIRECTORY_NAME: &str = "publications";
const ACTIVATIONS_DIRECTORY_NAME: &str = "activations";
const PUBLICATION_DIRECTORY_PREFIX: &str = "publication-";
const ACTIVATION_FILE_SUFFIX: &str = ".activation.json";
const ED25519_SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PublicationIdentity {
    pub release: VerifiedRelease,
    pub publication_manifest_sha256: String,
    pub publication_packet_sha256: String,
    pub generation_sha256: String,
    pub publication_directory_name: String,
    pub activation_sequence: u64,
    pub previous_publication_manifest_sha256: Option<String>,
    pub published_at: String,
    pub expires_at: String,
}

pub struct VerifiedPublication {
    identity: PublicationIdentity,
    trust: EmbeddedReleaseTrust,
    release_packet: Vec<u8>,
    release_policy: Vec<u8>,
    artifact: Vec<u8>,
    publication_packet: Vec<u8>,
}

pub(crate) struct ActivatedPublication {
    identity: PublicationIdentity,
}

impl ActivatedPublication {
    pub(crate) fn into_identity(self) -> PublicationIdentity {
        self.identity
    }
}

impl VerifiedPublication {
    pub fn identity(&self) -> &PublicationIdentity {
        &self.identity
    }

    pub fn into_identity(self) -> PublicationIdentity {
        self.identity
    }
}

impl fmt::Debug for VerifiedPublication {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("VerifiedPublication")
            .field("identity", &self.identity)
            .field("release_packet_bytes", &self.release_packet.len())
            .field("release_policy_bytes", &self.release_policy.len())
            .field("artifact_bytes", &self.artifact.len())
            .field("publication_packet_bytes", &self.publication_packet.len())
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstalledPublication {
    pub identity: PublicationIdentity,
    pub publication_directory: PathBuf,
    pub activation_file: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PublicationError {
    Release(release::ReleaseVerificationError),
    InvalidJson(&'static str),
    NonCanonicalJson(&'static str),
    InvalidField(&'static str),
    DigestMismatch(&'static str),
    SignatureInvalid,
    FileInvalid(&'static str),
    InstallConflict(&'static str),
    Io(&'static str),
}

impl fmt::Display for PublicationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Release(error) => error.fmt(formatter),
            Self::InvalidJson(label) => write!(formatter, "publication {label} JSON is invalid"),
            Self::NonCanonicalJson(label) => {
                write!(formatter, "publication {label} JSON is not canonical")
            }
            Self::InvalidField(field) => write!(formatter, "publication field is invalid: {field}"),
            Self::DigestMismatch(field) => {
                write!(formatter, "publication digest mismatch: {field}")
            }
            Self::SignatureInvalid => formatter.write_str("publication DSSE signature is invalid"),
            Self::FileInvalid(label) => write!(formatter, "publication {label} file is invalid"),
            Self::InstallConflict(label) => {
                write!(formatter, "publication installation conflicts at {label}")
            }
            Self::Io(label) => write!(
                formatter,
                "publication filesystem operation failed: {label}"
            ),
        }
    }
}

impl std::error::Error for PublicationError {}

impl From<release::ReleaseVerificationError> for PublicationError {
    fn from(error: release::ReleaseVerificationError) -> Self {
        Self::Release(error)
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PublicationPacket {
    schema_version: u8,
    contract: String,
    envelope: PublicationEnvelope,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PublicationEnvelope {
    payload_type: String,
    payload: String,
    signatures: Vec<PublicationSignature>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PublicationSignature {
    keyid: String,
    sig: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PublicationManifest {
    schema_version: u8,
    contract: String,
    environment: String,
    published_at: String,
    expires_at: String,
    release: PublicationRelease,
    generation: PublicationGeneration,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PublicationRelease {
    source_commit: String,
    git_tree_sha: String,
    manifest_sha256: String,
    packet_sha256: String,
    policy_sha256: String,
    release_key_spki_sha256: String,
    authority_origin: String,
    authority_version_id: String,
    target_triple: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PublicationGeneration {
    generation_sha256: String,
    activation_sequence: u64,
    previous_publication_manifest_sha256: Option<String>,
    packet_file_name: String,
    policy_file_name: String,
    publication_file_name: String,
    files: Vec<PublicationFile>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PublicationFile {
    file_name: String,
    byte_length: u64,
    sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GenerationSubject<'a> {
    schema_version: u8,
    contract: &'static str,
    target_triple: &'a str,
    files: &'a [PublicationFile],
}

#[derive(Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActivationRecord {
    schema_version: u8,
    contract: String,
    activation_sequence: u64,
    publication_manifest_sha256: String,
    publication_packet_sha256: String,
    previous_publication_manifest_sha256: Option<String>,
    generation_sha256: String,
}

pub fn verify_publication_bytes(
    trust: &EmbeddedReleaseTrust,
    release_packet: &[u8],
    release_policy: &[u8],
    artifact_file_name: &str,
    artifact: &[u8],
    publication_packet: &[u8],
    now: u64,
) -> Result<VerifiedPublication, PublicationError> {
    let release = release::verify_release_bytes(
        trust,
        release_packet,
        release_policy,
        artifact_file_name,
        artifact,
        now,
    )?;
    let packet: PublicationPacket = parse_publication_json(
        publication_packet,
        MAX_PUBLICATION_PACKET_BYTES,
        "publication_packet",
    )?;
    if packet.schema_version != 1 || packet.contract != PUBLICATION_PACKET_CONTRACT {
        return Err(PublicationError::InvalidField("packet_contract"));
    }
    if packet.envelope.payload_type != PUBLICATION_DSSE_PAYLOAD_TYPE
        || packet.envelope.signatures.len() != 1
        || packet.envelope.signatures[0].keyid != release.release_key_id
    {
        return Err(PublicationError::InvalidField("dsse_envelope"));
    }
    let manifest_bytes = decode_base64(
        &packet.envelope.payload,
        2,
        MAX_PUBLICATION_PACKET_BYTES,
        "manifest_payload",
    )?;
    let signature_bytes =
        decode_base64(&packet.envelope.signatures[0].sig, 64, 64, "dsse_signature")?;
    let manifest: PublicationManifest = parse_publication_json(
        &manifest_bytes,
        MAX_PUBLICATION_PACKET_BYTES,
        "publication_manifest",
    )?;
    validate_publication_manifest(
        &manifest,
        &release,
        release_packet,
        release_policy,
        artifact,
        now,
    )?;
    let verifying_key = release_verifying_key(&release)?;
    let signature =
        Signature::from_slice(&signature_bytes).map_err(|_| PublicationError::SignatureInvalid)?;
    let pae = dsse_pre_authentication_encoding(&manifest_bytes);
    verifying_key
        .verify_strict(&pae, &signature)
        .map_err(|_| PublicationError::SignatureInvalid)?;

    let publication_manifest_sha256 = sha256_hex(&manifest_bytes);
    let identity = PublicationIdentity {
        release,
        publication_packet_sha256: sha256_hex(publication_packet),
        generation_sha256: manifest.generation.generation_sha256,
        publication_directory_name: format!(
            "{PUBLICATION_DIRECTORY_PREFIX}{publication_manifest_sha256}"
        ),
        activation_sequence: manifest.generation.activation_sequence,
        previous_publication_manifest_sha256: manifest
            .generation
            .previous_publication_manifest_sha256,
        published_at: manifest.published_at,
        expires_at: manifest.expires_at,
        publication_manifest_sha256,
    };
    Ok(VerifiedPublication {
        identity,
        trust: trust.clone(),
        release_packet: release_packet.to_vec(),
        release_policy: release_policy.to_vec(),
        artifact: artifact.to_vec(),
        publication_packet: publication_packet.to_vec(),
    })
}

pub(crate) fn verify_current_publication(
    now: u64,
) -> Result<ActivatedPublication, PublicationError> {
    let trust = EmbeddedReleaseTrust::checked_in();
    trust
        .validate_for_execution()
        .map_err(release::ReleaseVerificationError::Trust)?;
    let executable =
        std::env::current_exe().map_err(|_| PublicationError::FileInvalid("artifact"))?;
    Ok(ActivatedPublication {
        identity: verify_installed_publication_at(&trust, &executable, now, true, true)?,
    })
}

pub fn install_verified_publication(
    installation_root: &Path,
    verified: VerifiedPublication,
) -> Result<InstalledPublication, PublicationError> {
    let canonical_root = validate_installation_root(installation_root)?;
    let publications = create_fixed_directory(
        installation_root,
        &canonical_root,
        PUBLICATIONS_DIRECTORY_NAME,
    )?;
    let activations = create_fixed_directory(
        installation_root,
        &canonical_root,
        ACTIVATIONS_DIRECTORY_NAME,
    )?;
    validate_predecessor(&activations, &verified.identity)?;

    let publication_directory = publications.join(&verified.identity.publication_directory_name);
    fs::create_dir(&publication_directory).map_err(|error| match error.kind() {
        std::io::ErrorKind::AlreadyExists => {
            PublicationError::InstallConflict("publication_directory")
        }
        _ => PublicationError::Io("create_publication_directory"),
    })?;
    let canonical_publications =
        fs::canonicalize(&publications).map_err(|_| PublicationError::Io("publications"))?;
    let canonical_publication = fs::canonicalize(&publication_directory)
        .map_err(|_| PublicationError::Io("publication_directory"))?;
    if canonical_publication.parent() != Some(canonical_publications.as_path()) {
        return Err(PublicationError::InstallConflict(
            "publication_directory_parent",
        ));
    }

    write_create_new(
        &publication_directory.join(&verified.identity.release.artifact_file_name),
        &verified.artifact,
        "artifact",
    )?;
    write_create_new(
        &publication_directory.join(RELEASE_PACKET_FILE_NAME),
        &verified.release_packet,
        "release_packet",
    )?;
    write_create_new(
        &publication_directory.join(RELEASE_POLICY_FILE_NAME),
        &verified.release_policy,
        "release_policy",
    )?;
    write_create_new(
        &publication_directory.join(PUBLICATION_PACKET_FILE_NAME),
        &verified.publication_packet,
        "publication_packet",
    )?;

    verify_installed_publication_at(
        &verified.trust,
        &publication_directory.join(&verified.identity.release.artifact_file_name),
        parse_whole_second_timestamp(&verified.identity.published_at, "published_at")?,
        false,
        false,
    )?;
    set_publication_read_only(&publication_directory, &verified.identity)?;

    let activation_file =
        activations.join(activation_file_name(verified.identity.activation_sequence));
    let activation_bytes = activation_bytes(&verified.identity)?;
    write_create_new(&activation_file, &activation_bytes, "activation")?;
    set_file_read_only(&activation_file)?;

    Ok(InstalledPublication {
        identity: verified.identity,
        publication_directory,
        activation_file,
    })
}

pub(crate) fn verify_installed_publication_at(
    trust: &EmbeddedReleaseTrust,
    executable: &Path,
    now: u64,
    require_current_target: bool,
    require_activation: bool,
) -> Result<PublicationIdentity, PublicationError> {
    trust
        .validate_for_execution()
        .map_err(release::ReleaseVerificationError::Trust)?;
    let publication_directory = executable
        .parent()
        .ok_or(PublicationError::FileInvalid("artifact"))?;
    let directory_metadata = fs::symlink_metadata(publication_directory)
        .map_err(|_| PublicationError::FileInvalid("publication_directory"))?;
    if !directory_metadata.is_dir() || directory_metadata.file_type().is_symlink() {
        return Err(PublicationError::FileInvalid("publication_directory"));
    }
    let canonical_publication = fs::canonicalize(publication_directory)
        .map_err(|_| PublicationError::FileInvalid("publication_directory"))?;
    let artifact_file_name = executable
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or(PublicationError::FileInvalid("artifact"))?;
    let artifact = read_stable_regular_file(
        executable,
        MAX_ARTIFACT_BYTES,
        &canonical_publication,
        "artifact",
    )?;
    let release_packet = read_stable_regular_file(
        &publication_directory.join(RELEASE_PACKET_FILE_NAME),
        MAX_PACKET_BYTES,
        &canonical_publication,
        "release_packet",
    )?;
    let release_policy = read_stable_regular_file(
        &publication_directory.join(RELEASE_POLICY_FILE_NAME),
        MAX_POLICY_BYTES,
        &canonical_publication,
        "release_policy",
    )?;
    let publication_packet = read_stable_regular_file(
        &publication_directory.join(PUBLICATION_PACKET_FILE_NAME),
        MAX_PUBLICATION_PACKET_BYTES,
        &canonical_publication,
        "publication_packet",
    )?;
    let verified = verify_publication_bytes(
        trust,
        &release_packet,
        &release_policy,
        artifact_file_name,
        &artifact,
        &publication_packet,
        now,
    )?;
    if require_current_target
        && current_release_target() != Some(verified.identity.release.target_triple.as_str())
    {
        return Err(PublicationError::InvalidField("installed_target_triple"));
    }
    if publication_directory
        .file_name()
        .and_then(|value| value.to_str())
        != Some(verified.identity.publication_directory_name.as_str())
    {
        return Err(PublicationError::InvalidField("publication_directory_name"));
    }
    let publications = publication_directory
        .parent()
        .ok_or(PublicationError::FileInvalid("publications_directory"))?;
    if publications.file_name().and_then(|value| value.to_str())
        != Some(PUBLICATIONS_DIRECTORY_NAME)
    {
        return Err(PublicationError::FileInvalid("publications_directory"));
    }
    let root = publications
        .parent()
        .ok_or(PublicationError::FileInvalid("installation_root"))?;
    let canonical_root =
        fs::canonicalize(root).map_err(|_| PublicationError::FileInvalid("installation_root"))?;
    let canonical_publications = fs::canonicalize(publications)
        .map_err(|_| PublicationError::FileInvalid("publications_directory"))?;
    if canonical_publications.parent() != Some(canonical_root.as_path())
        || canonical_publication.parent() != Some(canonical_publications.as_path())
    {
        return Err(PublicationError::FileInvalid("publication_layout"));
    }
    if require_activation {
        let activations = root.join(ACTIVATIONS_DIRECTORY_NAME);
        let canonical_activations = fs::canonicalize(&activations)
            .map_err(|_| PublicationError::FileInvalid("activations_directory"))?;
        if canonical_activations.parent() != Some(canonical_root.as_path()) {
            return Err(PublicationError::FileInvalid("activations_directory"));
        }
        let activation = read_stable_regular_file(
            &activations.join(activation_file_name(verified.identity.activation_sequence)),
            MAX_ACTIVATION_BYTES,
            &canonical_activations,
            "activation",
        )?;
        if activation != activation_bytes(&verified.identity)? {
            return Err(PublicationError::DigestMismatch("activation_record"));
        }
    }
    Ok(verified.into_identity())
}

fn validate_publication_manifest(
    manifest: &PublicationManifest,
    release: &VerifiedRelease,
    release_packet: &[u8],
    release_policy: &[u8],
    artifact: &[u8],
    now: u64,
) -> Result<(), PublicationError> {
    if manifest.schema_version != 1
        || manifest.contract != PUBLICATION_MANIFEST_CONTRACT
        || manifest.environment != "staging"
    {
        return Err(PublicationError::InvalidField("manifest_contract"));
    }
    let published_at = parse_whole_second_timestamp(&manifest.published_at, "published_at")?;
    let expires_at = parse_whole_second_timestamp(&manifest.expires_at, "expires_at")?;
    let release_issued_at = parse_whole_second_timestamp(&release.issued_at, "release_issued_at")?;
    let release_expires_at =
        parse_whole_second_timestamp(&release.expires_at, "release_expires_at")?;
    if published_at < release_issued_at
        || published_at >= expires_at
        || published_at > now.saturating_add(MAX_CLOCK_SKEW_SECONDS)
        || expires_at != release_expires_at
        || now > expires_at.saturating_add(MAX_CLOCK_SKEW_SECONDS)
    {
        return Err(PublicationError::InvalidField("publication_validity"));
    }
    let expected_release = PublicationRelease {
        source_commit: release.source_commit.clone(),
        git_tree_sha: release.git_tree_sha.clone(),
        manifest_sha256: release.manifest_sha256.clone(),
        packet_sha256: release.packet_sha256.clone(),
        policy_sha256: release.policy_sha256.clone(),
        release_key_spki_sha256: release.release_key_spki_sha256.clone(),
        authority_origin: STAGING_AUTHORITY_ORIGIN.to_owned(),
        authority_version_id: release.authority_version_id.clone(),
        target_triple: release.target_triple.clone(),
    };
    if canonical_json(&manifest.release)? != canonical_json(&expected_release)? {
        return Err(PublicationError::DigestMismatch("release_identity"));
    }
    validate_generation(
        &manifest.generation,
        release,
        release_packet,
        release_policy,
        artifact,
    )
}

fn validate_generation(
    generation: &PublicationGeneration,
    release: &VerifiedRelease,
    release_packet: &[u8],
    release_policy: &[u8],
    artifact: &[u8],
) -> Result<(), PublicationError> {
    if generation.activation_sequence == 0
        || generation.activation_sequence > MAX_SAFE_INTEGER
        || generation.packet_file_name != RELEASE_PACKET_FILE_NAME
        || generation.policy_file_name != RELEASE_POLICY_FILE_NAME
        || generation.publication_file_name != PUBLICATION_PACKET_FILE_NAME
        || generation.files.len() != 3
    {
        return Err(PublicationError::InvalidField("generation"));
    }
    match (
        generation.activation_sequence,
        &generation.previous_publication_manifest_sha256,
    ) {
        (1, None) => {}
        (1, Some(_)) | (_, None) => {
            return Err(PublicationError::InvalidField(
                "previous_publication_manifest_sha256",
            ));
        }
        (_, Some(value)) if !valid_sha256(value) => {
            return Err(PublicationError::InvalidField(
                "previous_publication_manifest_sha256",
            ));
        }
        _ => {}
    }
    let mut files = vec![
        PublicationFile {
            file_name: release.artifact_file_name.clone(),
            byte_length: artifact.len() as u64,
            sha256: sha256_hex(artifact),
        },
        PublicationFile {
            file_name: RELEASE_PACKET_FILE_NAME.to_owned(),
            byte_length: release_packet.len() as u64,
            sha256: sha256_hex(release_packet),
        },
        PublicationFile {
            file_name: RELEASE_POLICY_FILE_NAME.to_owned(),
            byte_length: release_policy.len() as u64,
            sha256: sha256_hex(release_policy),
        },
    ];
    files.sort_unstable_by(|left, right| left.file_name.cmp(&right.file_name));
    if generation.files != files {
        return Err(PublicationError::DigestMismatch("generation_files"));
    }
    if files.iter().any(|file| {
        file.byte_length == 0 || !valid_file_name(&file.file_name) || !valid_sha256(&file.sha256)
    }) {
        return Err(PublicationError::InvalidField("generation_files"));
    }
    let generation_sha256 = generation_sha256(&release.target_triple, &files)?;
    if generation.generation_sha256 != generation_sha256 {
        return Err(PublicationError::DigestMismatch("generation"));
    }
    Ok(())
}

fn release_verifying_key(release: &VerifiedRelease) -> Result<VerifyingKey, PublicationError> {
    let spki = URL_SAFE_NO_PAD
        .decode(&release.release_key_spki_base64url)
        .map_err(|_| PublicationError::InvalidField("release_public_key"))?;
    if URL_SAFE_NO_PAD.encode(&spki) != release.release_key_spki_base64url
        || sha256_hex(&spki) != release.release_key_spki_sha256
    {
        return Err(PublicationError::DigestMismatch("release_public_key"));
    }
    let key_bytes: &[u8; 32] = spki
        .strip_prefix(&ED25519_SPKI_PREFIX)
        .and_then(|value| value.try_into().ok())
        .ok_or(PublicationError::InvalidField("release_public_key"))?;
    VerifyingKey::from_bytes(key_bytes)
        .map_err(|_| PublicationError::InvalidField("release_public_key"))
}

fn dsse_pre_authentication_encoding(payload: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(payload.len() + PUBLICATION_DSSE_PAYLOAD_TYPE.len() + 64);
    output.extend_from_slice(b"DSSEv1 ");
    output.extend_from_slice(PUBLICATION_DSSE_PAYLOAD_TYPE.len().to_string().as_bytes());
    output.push(b' ');
    output.extend_from_slice(PUBLICATION_DSSE_PAYLOAD_TYPE.as_bytes());
    output.push(b' ');
    output.extend_from_slice(payload.len().to_string().as_bytes());
    output.push(b' ');
    output.extend_from_slice(payload);
    output
}

fn decode_base64(
    value: &str,
    minimum: usize,
    maximum: usize,
    field: &'static str,
) -> Result<Vec<u8>, PublicationError> {
    if value.is_empty() || value.len() % 4 != 0 || !value.is_ascii() {
        return Err(PublicationError::InvalidField(field));
    }
    let bytes = STANDARD
        .decode(value)
        .map_err(|_| PublicationError::InvalidField(field))?;
    if bytes.len() < minimum || bytes.len() > maximum || STANDARD.encode(&bytes) != value {
        return Err(PublicationError::InvalidField(field));
    }
    Ok(bytes)
}

fn parse_publication_json<T>(
    bytes: &[u8],
    maximum: usize,
    label: &'static str,
) -> Result<T, PublicationError>
where
    T: DeserializeOwned + Serialize,
{
    parse_canonical_json(bytes, maximum, label).map_err(|error| match error {
        release::ReleaseVerificationError::InvalidJson(_) => PublicationError::InvalidJson(label),
        release::ReleaseVerificationError::NonCanonicalJson(_) => {
            PublicationError::NonCanonicalJson(label)
        }
        other => PublicationError::Release(other),
    })
}

fn generation_sha256(
    target_triple: &str,
    files: &[PublicationFile],
) -> Result<String, PublicationError> {
    Ok(sha256_hex(
        canonical_json(&GenerationSubject {
            schema_version: 1,
            contract: PUBLICATION_GENERATION_CONTRACT,
            target_triple,
            files,
        })?
        .as_bytes(),
    ))
}

fn activation_bytes(identity: &PublicationIdentity) -> Result<Vec<u8>, PublicationError> {
    Ok(canonical_json(&ActivationRecord {
        schema_version: 1,
        contract: PUBLICATION_ACTIVATION_CONTRACT.to_owned(),
        activation_sequence: identity.activation_sequence,
        publication_manifest_sha256: identity.publication_manifest_sha256.clone(),
        publication_packet_sha256: identity.publication_packet_sha256.clone(),
        previous_publication_manifest_sha256: identity.previous_publication_manifest_sha256.clone(),
        generation_sha256: identity.generation_sha256.clone(),
    })?
    .into_bytes())
}

fn activation_file_name(sequence: u64) -> String {
    format!("{sequence:020}{ACTIVATION_FILE_SUFFIX}")
}

fn validate_installation_root(root: &Path) -> Result<PathBuf, PublicationError> {
    let metadata = fs::symlink_metadata(root)
        .map_err(|_| PublicationError::FileInvalid("installation_root"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(PublicationError::FileInvalid("installation_root"));
    }
    fs::canonicalize(root).map_err(|_| PublicationError::FileInvalid("installation_root"))
}

fn create_fixed_directory(
    root: &Path,
    canonical_root: &Path,
    name: &'static str,
) -> Result<PathBuf, PublicationError> {
    let directory = root.join(name);
    match fs::create_dir(&directory) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(PublicationError::Io(name)),
    }
    let metadata = fs::symlink_metadata(&directory).map_err(|_| PublicationError::Io(name))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(PublicationError::InstallConflict(name));
    }
    let canonical = fs::canonicalize(&directory).map_err(|_| PublicationError::Io(name))?;
    if canonical.parent() != Some(canonical_root) {
        return Err(PublicationError::InstallConflict(name));
    }
    Ok(directory)
}

fn validate_predecessor(
    activations: &Path,
    identity: &PublicationIdentity,
) -> Result<(), PublicationError> {
    if identity.activation_sequence == 1 {
        return Ok(());
    }
    let previous_sequence = identity.activation_sequence - 1;
    let canonical_activations =
        fs::canonicalize(activations).map_err(|_| PublicationError::Io("activations"))?;
    let previous_bytes = read_stable_regular_file(
        &activations.join(activation_file_name(previous_sequence)),
        MAX_ACTIVATION_BYTES,
        &canonical_activations,
        "previous_activation",
    )?;
    let previous: ActivationRecord =
        parse_publication_json(&previous_bytes, MAX_ACTIVATION_BYTES, "previous_activation")?;
    if previous.schema_version != 1
        || previous.contract != PUBLICATION_ACTIVATION_CONTRACT
        || previous.activation_sequence != previous_sequence
        || Some(previous.publication_manifest_sha256)
            != identity.previous_publication_manifest_sha256
    {
        return Err(PublicationError::InstallConflict("previous_activation"));
    }
    Ok(())
}

fn write_create_new(
    path: &Path,
    bytes: &[u8],
    label: &'static str,
) -> Result<(), PublicationError> {
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::AlreadyExists => PublicationError::InstallConflict(label),
            _ => PublicationError::Io(label),
        })?;
    file.write_all(bytes)
        .map_err(|_| PublicationError::Io(label))?;
    file.sync_all().map_err(|_| PublicationError::Io(label))
}

fn set_publication_read_only(
    directory: &Path,
    identity: &PublicationIdentity,
) -> Result<(), PublicationError> {
    for file_name in [
        identity.release.artifact_file_name.as_str(),
        RELEASE_PACKET_FILE_NAME,
        RELEASE_POLICY_FILE_NAME,
        PUBLICATION_PACKET_FILE_NAME,
    ] {
        set_file_read_only(&directory.join(file_name))?;
    }
    set_directory_read_only(directory)
}

#[cfg(unix)]
fn set_file_read_only(path: &Path) -> Result<(), PublicationError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o444))
        .map_err(|_| PublicationError::Io("file_permissions"))
}

#[cfg(not(unix))]
fn set_file_read_only(path: &Path) -> Result<(), PublicationError> {
    let mut permissions = fs::metadata(path)
        .map_err(|_| PublicationError::Io("file_permissions"))?
        .permissions();
    permissions.set_readonly(true);
    fs::set_permissions(path, permissions).map_err(|_| PublicationError::Io("file_permissions"))
}

#[cfg(unix)]
fn set_directory_read_only(path: &Path) -> Result<(), PublicationError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o555))
        .map_err(|_| PublicationError::Io("directory_permissions"))
}

#[cfg(not(unix))]
fn set_directory_read_only(path: &Path) -> Result<(), PublicationError> {
    let mut permissions = fs::metadata(path)
        .map_err(|_| PublicationError::Io("directory_permissions"))?
        .permissions();
    permissions.set_readonly(true);
    fs::set_permissions(path, permissions)
        .map_err(|_| PublicationError::Io("directory_permissions"))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_file_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !value.contains('/')
        && !value.contains('\\')
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::release::tests::{release_fixture, signing_key, ReleaseFixture};
    use ed25519_dalek::Signer;
    use serde_json::Value;
    use std::sync::atomic::{AtomicU64, Ordering};

    #[test]
    fn verifies_and_installs_one_create_new_publication() {
        let fixture = publication_fixture(1, None);
        let verified = verify_fixture(&fixture).unwrap();
        assert_eq!(verified.identity().activation_sequence, 1);
        assert_eq!(
            verified.identity().release.artifact_sha256,
            sha256_hex(&fixture.release.artifact)
        );
        let packet: PublicationPacket = serde_json::from_slice(&fixture.packet_json).unwrap();
        assert_eq!(
            verified.identity().generation_sha256,
            "9bbec7fb3934ce364f27b54a79ccae62c423e6d01f4ff5fe187d0f61ca620234"
        );
        assert_eq!(
            verified.identity().publication_manifest_sha256,
            "8beca6784152e2034d2b3e4866efe1f9892dfa7bc252ed87dd6a1397f8b211f2"
        );
        assert_eq!(
            verified.identity().publication_packet_sha256,
            "49ae3ccac08abd1c9fa3e205d7444ef260c50956f55a06f80f9f622f3b459f89"
        );
        assert_eq!(
            packet.envelope.signatures[0].sig,
            "I3wT6H82lVOz5VvPDHWRT21aozvFOuQoVEBGsVZEqYMKJ48QQCXGySLZrj0vJRvwo1LLQ7Hu3y97+FAIrbkVDQ=="
        );
        assert_eq!(
            sha256_hex(&activation_bytes(verified.identity()).unwrap()),
            "10bd518fe1fc5935672ea01696f2b80c719f8ce535f7d6711d6890c6452efff8"
        );

        let root = temporary_directory();
        fs::create_dir_all(&root).unwrap();
        let installed = install_verified_publication(&root, verified).unwrap();
        let executable = installed
            .publication_directory
            .join(&installed.identity.release.artifact_file_name);
        let readback = verify_installed_publication_at(
            &fixture.release.trust,
            &executable,
            fixture.release.now,
            false,
            true,
        )
        .unwrap();
        assert_eq!(readback, installed.identity);
        assert_eq!(
            install_verified_publication(&root, verify_fixture(&fixture).unwrap()),
            Err(PublicationError::InstallConflict("publication_directory"))
        );
        make_tree_writable(&root);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn rejects_mixed_release_signature_sequence_and_time_drift() {
        let fixture = publication_fixture(1, None);
        let mut artifact = fixture.release.artifact.clone();
        artifact.push(0);
        assert!(matches!(
            verify_publication_bytes(
                &fixture.release.trust,
                &fixture.release.packet_json,
                &fixture.release.policy_json,
                &fixture.release.artifact_file_name,
                &artifact,
                &fixture.packet_json,
                fixture.release.now,
            ),
            Err(PublicationError::Release(_))
        ));

        let tampered = mutate_packet(&fixture.packet_json, |manifest| {
            manifest["generation"]["activationSequence"] = Value::from(2);
        });
        assert!(matches!(
            verify_publication_bytes(
                &fixture.release.trust,
                &fixture.release.packet_json,
                &fixture.release.policy_json,
                &fixture.release.artifact_file_name,
                &fixture.release.artifact,
                &tampered,
                fixture.release.now,
            ),
            Err(PublicationError::InvalidField(
                "previous_publication_manifest_sha256"
            ))
        ));

        let mixed_release = mutate_packet(&fixture.packet_json, |manifest| {
            manifest["release"]["packetSha256"] = Value::String("f".repeat(64));
        });
        assert_eq!(
            verify_with_packet(&fixture, &mixed_release).unwrap_err(),
            PublicationError::DigestMismatch("release_identity")
        );

        let mixed_generation = mutate_packet(&fixture.packet_json, |manifest| {
            manifest["generation"]["files"][0]["sha256"] = Value::String("e".repeat(64));
        });
        assert_eq!(
            verify_with_packet(&fixture, &mixed_generation).unwrap_err(),
            PublicationError::DigestMismatch("generation_files")
        );

        assert_eq!(
            verify_publication_bytes(
                &fixture.release.trust,
                &fixture.release.packet_json,
                &fixture.release.policy_json,
                &fixture.release.artifact_file_name,
                &fixture.release.artifact,
                &fixture.packet_json,
                parse_whole_second_timestamp("2026-07-25T00:00:00.000Z", "test").unwrap(),
            )
            .unwrap_err(),
            PublicationError::Release(release::ReleaseVerificationError::InvalidField(
                "policy_validity"
            ))
        );
    }

    #[test]
    fn rejects_noncanonical_unknown_duplicate_and_signature_drift() {
        let fixture = publication_fixture(1, None);
        let spaced: Value = serde_json::from_slice(&fixture.packet_json).unwrap();
        let spaced = serde_json::to_string_pretty(&spaced).unwrap();
        assert!(matches!(
            verify_with_packet(&fixture, spaced.as_bytes()),
            Err(PublicationError::NonCanonicalJson("publication_packet"))
        ));

        let mut unknown: Value = serde_json::from_slice(&fixture.packet_json).unwrap();
        unknown["unreviewed"] = Value::Bool(true);
        let unknown = canonical_json(&unknown).unwrap();
        assert!(verify_with_packet(&fixture, unknown.as_bytes()).is_err());

        let duplicate = fixture
            .packet_json
            .strip_prefix(b"{")
            .map(|tail| [br#"{"schemaVersion":1,"schemaVersion":1,"#.as_slice(), tail].concat())
            .unwrap();
        assert!(verify_with_packet(&fixture, &duplicate).is_err());

        let mut signature: Value = serde_json::from_slice(&fixture.packet_json).unwrap();
        signature["envelope"]["signatures"][0]["sig"] = Value::String(STANDARD.encode([0_u8; 64]));
        let signature = canonical_json(&signature).unwrap();
        assert_eq!(
            verify_with_packet(&fixture, signature.as_bytes()).unwrap_err(),
            PublicationError::SignatureInvalid
        );
    }

    #[test]
    fn activation_sequence_is_a_create_new_predecessor_cas() {
        let first = publication_fixture(1, None);
        let first_verified = verify_fixture(&first).unwrap();
        let first_manifest_sha = first_verified
            .identity()
            .publication_manifest_sha256
            .clone();
        let root = temporary_directory();
        fs::create_dir_all(&root).unwrap();
        install_verified_publication(&root, first_verified).unwrap();

        let wrong = publication_fixture(2, Some("f".repeat(64)));
        assert_eq!(
            install_verified_publication(&root, verify_fixture(&wrong).unwrap()),
            Err(PublicationError::InstallConflict("previous_activation"))
        );

        let second = publication_fixture(2, Some(first_manifest_sha));
        let installed =
            install_verified_publication(&root, verify_fixture(&second).unwrap()).unwrap();
        assert_eq!(installed.identity.activation_sequence, 2);
        assert!(installed.activation_file.ends_with(activation_file_name(2)));
        make_tree_writable(&root);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn static_source_has_no_credentials_network_subprocess_or_destructive_cleanup() {
        let source = include_str!("publication.rs");
        assert!(source.contains("pub(crate) fn verify_current_publication("));
        assert!(!source.contains("\npub fn verify_current_publication("));
        assert!(source.contains("pub(crate) struct ActivatedPublication"));
        for forbidden in [
            ["std::env", "::var"].concat(),
            ["std::process", "::Command"].concat(),
            ["req", "west"].concat(),
            ["hy", "per::"].concat(),
            ["wrang", "ler"].concat(),
            ["remove", "_file"].concat(),
        ] {
            assert!(!source.contains(&forbidden));
        }
    }

    struct PublicationFixture {
        release: ReleaseFixture,
        packet_json: Vec<u8>,
    }

    fn publication_fixture(
        activation_sequence: u64,
        previous_publication_manifest_sha256: Option<String>,
    ) -> PublicationFixture {
        let release_fixture = release_fixture();
        let release = release::verify_release_bytes(
            &release_fixture.trust,
            &release_fixture.packet_json,
            &release_fixture.policy_json,
            &release_fixture.artifact_file_name,
            &release_fixture.artifact,
            release_fixture.now,
        )
        .unwrap();
        let mut files = vec![
            PublicationFile {
                file_name: release.artifact_file_name.clone(),
                byte_length: release_fixture.artifact.len() as u64,
                sha256: sha256_hex(&release_fixture.artifact),
            },
            PublicationFile {
                file_name: RELEASE_PACKET_FILE_NAME.to_owned(),
                byte_length: release_fixture.packet_json.len() as u64,
                sha256: sha256_hex(&release_fixture.packet_json),
            },
            PublicationFile {
                file_name: RELEASE_POLICY_FILE_NAME.to_owned(),
                byte_length: release_fixture.policy_json.len() as u64,
                sha256: sha256_hex(&release_fixture.policy_json),
            },
        ];
        files.sort_unstable_by(|left, right| left.file_name.cmp(&right.file_name));
        let manifest = PublicationManifest {
            schema_version: 1,
            contract: PUBLICATION_MANIFEST_CONTRACT.to_owned(),
            environment: "staging".to_owned(),
            published_at: "2026-07-23T01:00:00.000Z".to_owned(),
            expires_at: release.expires_at.clone(),
            release: PublicationRelease {
                source_commit: release.source_commit.clone(),
                git_tree_sha: release.git_tree_sha.clone(),
                manifest_sha256: release.manifest_sha256.clone(),
                packet_sha256: release.packet_sha256.clone(),
                policy_sha256: release.policy_sha256.clone(),
                release_key_spki_sha256: release.release_key_spki_sha256.clone(),
                authority_origin: STAGING_AUTHORITY_ORIGIN.to_owned(),
                authority_version_id: release.authority_version_id.clone(),
                target_triple: release.target_triple.clone(),
            },
            generation: PublicationGeneration {
                generation_sha256: generation_sha256(&release.target_triple, &files).unwrap(),
                activation_sequence,
                previous_publication_manifest_sha256,
                packet_file_name: RELEASE_PACKET_FILE_NAME.to_owned(),
                policy_file_name: RELEASE_POLICY_FILE_NAME.to_owned(),
                publication_file_name: PUBLICATION_PACKET_FILE_NAME.to_owned(),
                files,
            },
        };
        let manifest_bytes = canonical_json(&manifest).unwrap().into_bytes();
        let signature = signing_key().sign(&dsse_pre_authentication_encoding(&manifest_bytes));
        let packet = PublicationPacket {
            schema_version: 1,
            contract: PUBLICATION_PACKET_CONTRACT.to_owned(),
            envelope: PublicationEnvelope {
                payload_type: PUBLICATION_DSSE_PAYLOAD_TYPE.to_owned(),
                payload: STANDARD.encode(&manifest_bytes),
                signatures: vec![PublicationSignature {
                    keyid: release.release_key_id,
                    sig: STANDARD.encode(signature.to_bytes()),
                }],
            },
        };
        PublicationFixture {
            release: release_fixture,
            packet_json: canonical_json(&packet).unwrap().into_bytes(),
        }
    }

    fn verify_fixture(
        fixture: &PublicationFixture,
    ) -> Result<VerifiedPublication, PublicationError> {
        verify_with_packet(fixture, &fixture.packet_json)
    }

    fn verify_with_packet(
        fixture: &PublicationFixture,
        packet: &[u8],
    ) -> Result<VerifiedPublication, PublicationError> {
        verify_publication_bytes(
            &fixture.release.trust,
            &fixture.release.packet_json,
            &fixture.release.policy_json,
            &fixture.release.artifact_file_name,
            &fixture.release.artifact,
            packet,
            fixture.release.now,
        )
    }

    fn mutate_packet(packet: &[u8], mutate: impl FnOnce(&mut Value)) -> Vec<u8> {
        let mut packet: Value = serde_json::from_slice(packet).unwrap();
        let payload = packet["envelope"]["payload"].as_str().unwrap();
        let mut manifest: Value =
            serde_json::from_slice(&STANDARD.decode(payload).unwrap()).unwrap();
        mutate(&mut manifest);
        let manifest_bytes = canonical_json(&manifest).unwrap().into_bytes();
        packet["envelope"]["payload"] = Value::String(STANDARD.encode(&manifest_bytes));
        let signature = signing_key().sign(&dsse_pre_authentication_encoding(&manifest_bytes));
        packet["envelope"]["signatures"][0]["sig"] =
            Value::String(STANDARD.encode(signature.to_bytes()));
        canonical_json(&packet).unwrap().into_bytes()
    }

    fn temporary_directory() -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "cinatoken-publication-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[allow(clippy::permissions_set_readonly_false)]
    fn make_tree_writable(root: &Path) {
        if let Ok(entries) = fs::read_dir(root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    make_tree_writable(&path);
                }
                if let Ok(metadata) = fs::metadata(&path) {
                    let mut permissions = metadata.permissions();
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        permissions.set_mode(if path.is_dir() { 0o755 } else { 0o644 });
                    }
                    #[cfg(not(unix))]
                    permissions.set_readonly(false);
                    let _ = fs::set_permissions(&path, permissions);
                }
            }
        }
    }
}
