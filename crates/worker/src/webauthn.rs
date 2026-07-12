//! Pure Rust WebAuthn registration and assertion verification.
//!
//! The module deliberately has no Worker bindings or network I/O. Callers own
//! challenge lifecycle and persistence; this code only parses bounded browser
//! payloads and verifies the ceremony cryptography.

use std::fmt;
use std::io::Cursor;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ciborium::value::Value as CborValue;
use p256::ecdsa::{signature::Verifier as _, Signature as Es256Signature};
use rsa::{
    pkcs1v15::{Signature as Rs256Signature, VerifyingKey as Rs256VerifyingKey},
    traits::PublicKeyParts,
    BigUint, RsaPublicKey,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};

pub const MAX_CREDENTIAL_ID_BYTES: usize = 1_024;
pub const MAX_CLIENT_DATA_JSON_BYTES: usize = 16 * 1_024;
pub const MAX_ATTESTATION_OBJECT_BYTES: usize = 64 * 1_024;
pub const MAX_AUTHENTICATOR_DATA_BYTES: usize = 16 * 1_024;
pub const MAX_COSE_KEY_BYTES: usize = 8 * 1_024;
pub const MAX_SIGNATURE_BYTES: usize = 1_024;
pub const MAX_CHALLENGE_BYTES: usize = 1_024;
pub const MAX_ORIGIN_BYTES: usize = 2_048;
pub const MAX_RP_ID_BYTES: usize = 253;
pub const MAX_USER_HANDLE_BYTES: usize = 64;

const AUTH_DATA_HEADER_BYTES: usize = 37;
const ATTESTED_DATA_HEADER_BYTES: usize = 18;
const FLAG_UP: u8 = 0x01;
const FLAG_UV: u8 = 0x04;
const FLAG_BE: u8 = 0x08;
const FLAG_BS: u8 = 0x10;
const FLAG_AT: u8 = 0x40;
const FLAG_ED: u8 = 0x80;
const FLAG_RESERVED: u8 = 0x22;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistrationCredential {
    pub id: String,
    pub raw_id: String,
    #[serde(rename = "type")]
    pub credential_type: String,
    #[serde(default)]
    pub authenticator_attachment: Option<String>,
    pub response: RegistrationResponse,
    #[serde(default)]
    pub client_extension_results: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegistrationResponse {
    pub attestation_object: String,
    pub client_data_json: String,
    #[serde(default)]
    pub transports: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssertionCredential {
    pub id: String,
    pub raw_id: String,
    #[serde(rename = "type")]
    pub credential_type: String,
    #[serde(default)]
    pub authenticator_attachment: Option<String>,
    pub response: AssertionResponse,
    #[serde(default)]
    pub client_extension_results: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssertionResponse {
    pub authenticator_data: String,
    pub client_data_json: String,
    pub signature: String,
    #[serde(default)]
    pub user_handle: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct CeremonyExpectation<'a> {
    pub challenge: &'a str,
    pub origin: &'a str,
    pub rp_id: &'a str,
    pub require_user_verification: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct StoredCredential<'a> {
    pub credential_id: &'a [u8],
    pub public_key_cose: &'a [u8],
    pub sign_count: u32,
    pub backup_eligible: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoseAlgorithm {
    Es256,
    Rs256,
}

impl CoseAlgorithm {
    pub const fn cose_id(self) -> i64 {
        match self {
            Self::Es256 => -7,
            Self::Rs256 => -257,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedRegistration {
    pub credential_id: Vec<u8>,
    pub public_key_cose: Vec<u8>,
    pub algorithm: CoseAlgorithm,
    pub aaguid: [u8; 16],
    pub sign_count: u32,
    pub user_present: bool,
    pub user_verified: bool,
    pub backup_eligible: bool,
    pub backup_state: bool,
    pub transports: Vec<String>,
    pub authenticator_attachment: Option<String>,
    pub attestation_format: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedAssertion {
    pub credential_id: Vec<u8>,
    pub user_handle: Option<Vec<u8>>,
    pub sign_count: u32,
    pub clone_warning: bool,
    pub user_present: bool,
    pub user_verified: bool,
    pub backup_eligible: bool,
    pub backup_state: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebauthnError {
    PayloadTooLarge(&'static str),
    InvalidBase64Url(&'static str),
    InvalidJson(&'static str),
    InvalidStructure(&'static str),
    InvalidCredentialType,
    InvalidAuthenticatorAttachment,
    ClientDataTypeMismatch,
    ChallengeMismatch,
    OriginMismatch,
    CrossOriginNotAllowed,
    RpIdHashMismatch,
    UserPresenceRequired,
    UserVerificationRequired,
    BackupStateInvalid,
    BackupEligibilityChanged,
    CredentialIdMismatch,
    UnsupportedAlgorithm,
    InvalidPublicKey,
    InvalidSignature,
}

impl WebauthnError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::PayloadTooLarge(_) => "payload_too_large",
            Self::InvalidBase64Url(_) => "invalid_base64url",
            Self::InvalidJson(_) => "invalid_json",
            Self::InvalidStructure(_) => "invalid_structure",
            Self::InvalidCredentialType => "invalid_credential_type",
            Self::InvalidAuthenticatorAttachment => "invalid_authenticator_attachment",
            Self::ClientDataTypeMismatch => "client_data_type_mismatch",
            Self::ChallengeMismatch => "challenge_mismatch",
            Self::OriginMismatch => "origin_mismatch",
            Self::CrossOriginNotAllowed => "cross_origin_not_allowed",
            Self::RpIdHashMismatch => "rp_id_hash_mismatch",
            Self::UserPresenceRequired => "user_presence_required",
            Self::UserVerificationRequired => "user_verification_required",
            Self::BackupStateInvalid => "backup_state_invalid",
            Self::BackupEligibilityChanged => "backup_eligibility_changed",
            Self::CredentialIdMismatch => "credential_id_mismatch",
            Self::UnsupportedAlgorithm => "unsupported_algorithm",
            Self::InvalidPublicKey => "invalid_public_key",
            Self::InvalidSignature => "invalid_signature",
        }
    }
}

impl fmt::Display for WebauthnError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::PayloadTooLarge(field) => write!(f, "{field} exceeds the WebAuthn size limit"),
            Self::InvalidBase64Url(field) => write!(f, "{field} is not canonical base64url"),
            Self::InvalidJson(field) => write!(f, "{field} is not valid WebAuthn JSON"),
            Self::InvalidStructure(field) => write!(f, "{field} has an invalid WebAuthn structure"),
            _ => f.write_str(match self {
                Self::InvalidCredentialType => "credential type must be public-key",
                Self::InvalidAuthenticatorAttachment => "authenticator attachment is invalid",
                Self::ClientDataTypeMismatch => "client data ceremony type does not match",
                Self::ChallengeMismatch => "WebAuthn challenge does not match",
                Self::OriginMismatch => "WebAuthn origin does not match",
                Self::CrossOriginNotAllowed => "cross-origin WebAuthn ceremony is not allowed",
                Self::RpIdHashMismatch => "RP ID hash does not match",
                Self::UserPresenceRequired => "authenticator did not prove user presence",
                Self::UserVerificationRequired => "authenticator did not verify the user",
                Self::BackupStateInvalid => "authenticator backup flags are inconsistent",
                Self::BackupEligibilityChanged => "credential backup eligibility changed",
                Self::CredentialIdMismatch => "credential ID does not match",
                Self::UnsupportedAlgorithm => "credential algorithm is not supported",
                Self::InvalidPublicKey => "credential public key is invalid",
                Self::InvalidSignature => "assertion signature is invalid",
                Self::PayloadTooLarge(_)
                | Self::InvalidBase64Url(_)
                | Self::InvalidJson(_)
                | Self::InvalidStructure(_) => unreachable!(),
            }),
        }
    }
}

impl std::error::Error for WebauthnError {}

#[derive(Debug, Deserialize)]
struct CollectedClientData {
    #[serde(rename = "type")]
    ceremony_type: String,
    challenge: String,
    origin: String,
    #[serde(rename = "crossOrigin", default)]
    cross_origin: bool,
    #[serde(rename = "topOrigin", default)]
    top_origin: Option<String>,
}

#[derive(Debug)]
struct ParsedAuthenticatorData<'a> {
    raw: &'a [u8],
    flags: u8,
    sign_count: u32,
    attested: Option<AttestedCredentialData<'a>>,
}

#[derive(Debug)]
struct AttestedCredentialData<'a> {
    aaguid: [u8; 16],
    credential_id: &'a [u8],
    cose_key: &'a [u8],
    cose_value: CborValue,
}

#[derive(Debug)]
enum ParsedCoseKey {
    Es256(p256::ecdsa::VerifyingKey),
    Rs256(RsaPublicKey),
}

impl ParsedCoseKey {
    fn algorithm(&self) -> CoseAlgorithm {
        match self {
            Self::Es256(_) => CoseAlgorithm::Es256,
            Self::Rs256(_) => CoseAlgorithm::Rs256,
        }
    }
}

pub fn verify_registration(
    credential: &RegistrationCredential,
    expected: &CeremonyExpectation<'_>,
) -> Result<VerifiedRegistration, WebauthnError> {
    validate_credential_shell(
        &credential.id,
        &credential.raw_id,
        &credential.credential_type,
        credential.authenticator_attachment.as_deref(),
        &credential.client_extension_results,
    )?;
    let raw_id = decode_base64url(&credential.raw_id, MAX_CREDENTIAL_ID_BYTES, "rawId", false)?;
    let client_data = decode_base64url(
        &credential.response.client_data_json,
        MAX_CLIENT_DATA_JSON_BYTES,
        "clientDataJSON",
        false,
    )?;
    verify_client_data(&client_data, "webauthn.create", expected)?;

    let attestation_bytes = decode_base64url(
        &credential.response.attestation_object,
        MAX_ATTESTATION_OBJECT_BYTES,
        "attestationObject",
        false,
    )?;
    let auth_data_bytes = parse_none_attestation(&attestation_bytes)?;
    let auth_data = parse_authenticator_data(&auth_data_bytes, true)?;
    verify_authenticator_flags(&auth_data, expected, None)?;

    let attested = auth_data
        .attested
        .as_ref()
        .ok_or(WebauthnError::InvalidStructure("authenticatorData"))?;
    if !constant_time_eq(&raw_id, attested.credential_id) {
        return Err(WebauthnError::CredentialIdMismatch);
    }
    let parsed_key = parse_cose_key(&attested.cose_value)?;
    let transports = validate_transports(&credential.response.transports)?;

    Ok(VerifiedRegistration {
        credential_id: raw_id,
        public_key_cose: attested.cose_key.to_vec(),
        algorithm: parsed_key.algorithm(),
        aaguid: attested.aaguid,
        sign_count: auth_data.sign_count,
        user_present: true,
        user_verified: auth_data.flags & FLAG_UV != 0,
        backup_eligible: auth_data.flags & FLAG_BE != 0,
        backup_state: auth_data.flags & FLAG_BS != 0,
        transports,
        authenticator_attachment: credential.authenticator_attachment.clone(),
        attestation_format: "none",
    })
}

pub fn verify_assertion(
    credential: &AssertionCredential,
    expected: &CeremonyExpectation<'_>,
    stored: &StoredCredential<'_>,
) -> Result<VerifiedAssertion, WebauthnError> {
    validate_credential_shell(
        &credential.id,
        &credential.raw_id,
        &credential.credential_type,
        credential.authenticator_attachment.as_deref(),
        &credential.client_extension_results,
    )?;
    if stored.credential_id.is_empty() || stored.credential_id.len() > MAX_CREDENTIAL_ID_BYTES {
        return Err(WebauthnError::InvalidStructure("stored credential ID"));
    }
    if stored.public_key_cose.is_empty() || stored.public_key_cose.len() > MAX_COSE_KEY_BYTES {
        return Err(WebauthnError::InvalidStructure("stored COSE key"));
    }

    let raw_id = decode_base64url(&credential.raw_id, MAX_CREDENTIAL_ID_BYTES, "rawId", false)?;
    if !constant_time_eq(&raw_id, stored.credential_id) {
        return Err(WebauthnError::CredentialIdMismatch);
    }
    let client_data = decode_base64url(
        &credential.response.client_data_json,
        MAX_CLIENT_DATA_JSON_BYTES,
        "clientDataJSON",
        false,
    )?;
    verify_client_data(&client_data, "webauthn.get", expected)?;
    let authenticator_data = decode_base64url(
        &credential.response.authenticator_data,
        MAX_AUTHENTICATOR_DATA_BYTES,
        "authenticatorData",
        false,
    )?;
    let parsed_auth_data = parse_authenticator_data(&authenticator_data, false)?;
    verify_authenticator_flags(&parsed_auth_data, expected, Some(stored.backup_eligible))?;

    let signature = decode_base64url(
        &credential.response.signature,
        MAX_SIGNATURE_BYTES,
        "signature",
        false,
    )?;
    let user_handle = credential
        .response
        .user_handle
        .as_deref()
        .map(|value| decode_base64url(value, MAX_USER_HANDLE_BYTES, "userHandle", true))
        .transpose()?;

    let cose_value = parse_exact_cbor(stored.public_key_cose, "stored COSE key")?;
    let key = parse_cose_key(&cose_value)?;
    let mut signed_data = Vec::with_capacity(authenticator_data.len() + 32);
    signed_data.extend_from_slice(&authenticator_data);
    signed_data.extend_from_slice(&Sha256::digest(&client_data));
    verify_signature(&key, &signed_data, &signature)?;

    let sign_count = parsed_auth_data.sign_count;
    let clone_warning =
        (stored.sign_count != 0 || sign_count != 0) && sign_count <= stored.sign_count;
    Ok(VerifiedAssertion {
        credential_id: raw_id,
        user_handle,
        sign_count,
        clone_warning,
        user_present: true,
        user_verified: parsed_auth_data.flags & FLAG_UV != 0,
        backup_eligible: parsed_auth_data.flags & FLAG_BE != 0,
        backup_state: parsed_auth_data.flags & FLAG_BS != 0,
    })
}

fn validate_credential_shell(
    id: &str,
    raw_id: &str,
    credential_type: &str,
    attachment: Option<&str>,
    extensions: &serde_json::Value,
) -> Result<(), WebauthnError> {
    if credential_type != "public-key" {
        return Err(WebauthnError::InvalidCredentialType);
    }
    if !matches!(attachment, None | Some("platform") | Some("cross-platform")) {
        return Err(WebauthnError::InvalidAuthenticatorAttachment);
    }
    if !extensions.is_object() {
        return Err(WebauthnError::InvalidStructure("clientExtensionResults"));
    }
    let id_bytes = decode_base64url(id, MAX_CREDENTIAL_ID_BYTES, "id", false)?;
    let raw_id_bytes = decode_base64url(raw_id, MAX_CREDENTIAL_ID_BYTES, "rawId", false)?;
    if !constant_time_eq(&id_bytes, &raw_id_bytes) {
        return Err(WebauthnError::CredentialIdMismatch);
    }
    Ok(())
}

fn verify_client_data(
    bytes: &[u8],
    expected_type: &str,
    expected: &CeremonyExpectation<'_>,
) -> Result<(), WebauthnError> {
    if expected.origin.is_empty() || expected.origin.len() > MAX_ORIGIN_BYTES {
        return Err(WebauthnError::InvalidStructure("expected origin"));
    }
    if expected.rp_id.is_empty() || expected.rp_id.len() > MAX_RP_ID_BYTES {
        return Err(WebauthnError::InvalidStructure("expected RP ID"));
    }
    let expected_challenge = decode_base64url(
        expected.challenge,
        MAX_CHALLENGE_BYTES,
        "expected challenge",
        false,
    )?;
    let client: CollectedClientData =
        serde_json::from_slice(bytes).map_err(|_| WebauthnError::InvalidJson("clientDataJSON"))?;
    if client.ceremony_type != expected_type {
        return Err(WebauthnError::ClientDataTypeMismatch);
    }
    let actual_challenge = decode_base64url(
        &client.challenge,
        MAX_CHALLENGE_BYTES,
        "client challenge",
        false,
    )?;
    if !constant_time_eq(&actual_challenge, &expected_challenge) {
        return Err(WebauthnError::ChallengeMismatch);
    }
    if client.origin.as_bytes().len() > MAX_ORIGIN_BYTES
        || !constant_time_eq(client.origin.as_bytes(), expected.origin.as_bytes())
    {
        return Err(WebauthnError::OriginMismatch);
    }
    if client.cross_origin || client.top_origin.is_some() {
        return Err(WebauthnError::CrossOriginNotAllowed);
    }
    Ok(())
}

fn parse_none_attestation(bytes: &[u8]) -> Result<Vec<u8>, WebauthnError> {
    let value = parse_exact_cbor(bytes, "attestationObject")?;
    let CborValue::Map(entries) = value else {
        return Err(WebauthnError::InvalidStructure("attestationObject"));
    };
    let mut fmt = None;
    let mut att_stmt = None;
    let mut auth_data = None;
    for (key, value) in entries {
        let CborValue::Text(key) = key else {
            return Err(WebauthnError::InvalidStructure("attestationObject"));
        };
        match key.as_str() {
            "fmt" if fmt.is_none() => fmt = Some(value),
            "attStmt" if att_stmt.is_none() => att_stmt = Some(value),
            "authData" if auth_data.is_none() => auth_data = Some(value),
            _ => return Err(WebauthnError::InvalidStructure("attestationObject")),
        }
    }
    if !matches!(fmt, Some(CborValue::Text(value)) if value == "none") {
        return Err(WebauthnError::InvalidStructure("attestation format"));
    }
    if !matches!(att_stmt, Some(CborValue::Map(entries)) if entries.is_empty()) {
        return Err(WebauthnError::InvalidStructure("attestation statement"));
    }
    match auth_data {
        Some(CborValue::Bytes(bytes)) => Ok(bytes),
        _ => Err(WebauthnError::InvalidStructure("authenticatorData")),
    }
}

fn parse_authenticator_data(
    bytes: &[u8],
    require_attested_data: bool,
) -> Result<ParsedAuthenticatorData<'_>, WebauthnError> {
    if bytes.len() < AUTH_DATA_HEADER_BYTES || bytes.len() > MAX_AUTHENTICATOR_DATA_BYTES {
        return Err(WebauthnError::InvalidStructure("authenticatorData"));
    }
    let flags = bytes[32];
    if flags & FLAG_RESERVED != 0 {
        return Err(WebauthnError::InvalidStructure("authenticator flags"));
    }
    let sign_count = u32::from_be_bytes(
        bytes[33..37]
            .try_into()
            .map_err(|_| WebauthnError::InvalidStructure("signature counter"))?,
    );
    let has_attested_data = flags & FLAG_AT != 0;
    if require_attested_data != has_attested_data {
        return Err(WebauthnError::InvalidStructure("attested credential data"));
    }

    let mut offset = AUTH_DATA_HEADER_BYTES;
    let attested = if has_attested_data {
        if bytes.len() < offset + ATTESTED_DATA_HEADER_BYTES {
            return Err(WebauthnError::InvalidStructure("attested credential data"));
        }
        let aaguid: [u8; 16] = bytes[offset..offset + 16]
            .try_into()
            .map_err(|_| WebauthnError::InvalidStructure("AAGUID"))?;
        offset += 16;
        let credential_id_len = u16::from_be_bytes([bytes[offset], bytes[offset + 1]]) as usize;
        offset += 2;
        if credential_id_len == 0
            || credential_id_len > MAX_CREDENTIAL_ID_BYTES
            || bytes.len() < offset + credential_id_len
        {
            return Err(WebauthnError::InvalidStructure("credential ID"));
        }
        let credential_id = &bytes[offset..offset + credential_id_len];
        offset += credential_id_len;
        let (cose_value, consumed) = parse_cbor_prefix(&bytes[offset..], "credential public key")?;
        if consumed == 0 || consumed > MAX_COSE_KEY_BYTES {
            return Err(WebauthnError::PayloadTooLarge("credential public key"));
        }
        let cose_key = &bytes[offset..offset + consumed];
        offset += consumed;
        Some(AttestedCredentialData {
            aaguid,
            credential_id,
            cose_key,
            cose_value,
        })
    } else {
        None
    };

    if flags & FLAG_ED != 0 {
        if offset == bytes.len() {
            return Err(WebauthnError::InvalidStructure("authenticator extensions"));
        }
        let extensions = parse_exact_cbor(&bytes[offset..], "authenticator extensions")?;
        if !matches!(extensions, CborValue::Map(_)) {
            return Err(WebauthnError::InvalidStructure("authenticator extensions"));
        }
    } else if offset != bytes.len() {
        return Err(WebauthnError::InvalidStructure(
            "authenticatorData trailing bytes",
        ));
    }

    Ok(ParsedAuthenticatorData {
        raw: bytes,
        flags,
        sign_count,
        attested,
    })
}

fn verify_authenticator_flags(
    auth_data: &ParsedAuthenticatorData<'_>,
    expected: &CeremonyExpectation<'_>,
    stored_backup_eligible: Option<bool>,
) -> Result<(), WebauthnError> {
    let expected_rp_hash = Sha256::digest(expected.rp_id.as_bytes());
    if !constant_time_eq(&auth_data.raw[..32], expected_rp_hash.as_slice()) {
        return Err(WebauthnError::RpIdHashMismatch);
    }
    if auth_data.flags & FLAG_UP == 0 {
        return Err(WebauthnError::UserPresenceRequired);
    }
    if expected.require_user_verification && auth_data.flags & FLAG_UV == 0 {
        return Err(WebauthnError::UserVerificationRequired);
    }
    let backup_eligible = auth_data.flags & FLAG_BE != 0;
    let backup_state = auth_data.flags & FLAG_BS != 0;
    if backup_state && !backup_eligible {
        return Err(WebauthnError::BackupStateInvalid);
    }
    if stored_backup_eligible.is_some_and(|stored| stored != backup_eligible) {
        return Err(WebauthnError::BackupEligibilityChanged);
    }
    Ok(())
}

fn parse_cose_key(value: &CborValue) -> Result<ParsedCoseKey, WebauthnError> {
    let CborValue::Map(entries) = value else {
        return Err(WebauthnError::InvalidPublicKey);
    };
    let mut labels = Vec::with_capacity(entries.len());
    for (key, _) in entries {
        let CborValue::Integer(key) = key else {
            return Err(WebauthnError::InvalidPublicKey);
        };
        let label = i64::try_from(*key).map_err(|_| WebauthnError::InvalidPublicKey)?;
        if labels.contains(&label) {
            return Err(WebauthnError::InvalidPublicKey);
        }
        labels.push(label);
    }
    let kty = cose_integer(entries, 1)?.ok_or(WebauthnError::InvalidPublicKey)?;
    let alg = cose_integer(entries, 3)?.ok_or(WebauthnError::InvalidPublicKey)?;
    match (kty, alg) {
        (2, -7) => {
            let crv = cose_integer(entries, -1)?.ok_or(WebauthnError::InvalidPublicKey)?;
            let x = cose_bytes(entries, -2)?.ok_or(WebauthnError::InvalidPublicKey)?;
            let y = cose_bytes(entries, -3)?.ok_or(WebauthnError::InvalidPublicKey)?;
            if crv != 1 || x.len() != 32 || y.len() != 32 {
                return Err(WebauthnError::InvalidPublicKey);
            }
            let mut point = [0u8; 65];
            point[0] = 0x04;
            point[1..33].copy_from_slice(x);
            point[33..].copy_from_slice(y);
            let key = p256::ecdsa::VerifyingKey::from_sec1_bytes(&point)
                .map_err(|_| WebauthnError::InvalidPublicKey)?;
            Ok(ParsedCoseKey::Es256(key))
        }
        (3, -257) => {
            let n = cose_bytes(entries, -1)?.ok_or(WebauthnError::InvalidPublicKey)?;
            let e = cose_bytes(entries, -2)?.ok_or(WebauthnError::InvalidPublicKey)?;
            if n.len() < 256
                || n.len() > 512
                || e.is_empty()
                || e.len() > 4
                || n.first() == Some(&0)
                || e.first() == Some(&0)
            {
                return Err(WebauthnError::InvalidPublicKey);
            }
            let exponent_is_odd = e.last().is_some_and(|byte| byte & 1 == 1);
            let exponent = BigUint::from_bytes_be(e);
            if exponent < BigUint::from(3u8) || !exponent_is_odd {
                return Err(WebauthnError::InvalidPublicKey);
            }
            let key = RsaPublicKey::new(BigUint::from_bytes_be(n), exponent)
                .map_err(|_| WebauthnError::InvalidPublicKey)?;
            let bits = key.n().bits();
            if !(2_048..=4_096).contains(&bits) {
                return Err(WebauthnError::InvalidPublicKey);
            }
            Ok(ParsedCoseKey::Rs256(key))
        }
        (_, -7 | -257) => Err(WebauthnError::InvalidPublicKey),
        _ => Err(WebauthnError::UnsupportedAlgorithm),
    }
}

fn cose_integer(
    entries: &[(CborValue, CborValue)],
    label: i64,
) -> Result<Option<i64>, WebauthnError> {
    let value = cose_label(entries, label)?;
    value
        .map(|value| match value {
            CborValue::Integer(value) => {
                i64::try_from(*value).map_err(|_| WebauthnError::InvalidPublicKey)
            }
            _ => Err(WebauthnError::InvalidPublicKey),
        })
        .transpose()
}

fn cose_bytes<'a>(
    entries: &'a [(CborValue, CborValue)],
    label: i64,
) -> Result<Option<&'a [u8]>, WebauthnError> {
    let value = cose_label(entries, label)?;
    value
        .map(|value| match value {
            CborValue::Bytes(value) => Ok(value.as_slice()),
            _ => Err(WebauthnError::InvalidPublicKey),
        })
        .transpose()
}

fn cose_label<'a>(
    entries: &'a [(CborValue, CborValue)],
    label: i64,
) -> Result<Option<&'a CborValue>, WebauthnError> {
    let mut found = None;
    for (key, value) in entries {
        let CborValue::Integer(key) = key else {
            continue;
        };
        if i64::try_from(*key).ok() == Some(label) {
            if found.is_some() {
                return Err(WebauthnError::InvalidPublicKey);
            }
            found = Some(value);
        }
    }
    Ok(found)
}

fn verify_signature(
    key: &ParsedCoseKey,
    message: &[u8],
    signature: &[u8],
) -> Result<(), WebauthnError> {
    match key {
        ParsedCoseKey::Es256(key) => {
            let signature =
                Es256Signature::from_der(signature).map_err(|_| WebauthnError::InvalidSignature)?;
            key.verify(message, &signature)
                .map_err(|_| WebauthnError::InvalidSignature)
        }
        ParsedCoseKey::Rs256(key) => {
            if signature.len() != key.size() {
                return Err(WebauthnError::InvalidSignature);
            }
            let signature =
                Rs256Signature::try_from(signature).map_err(|_| WebauthnError::InvalidSignature)?;
            Rs256VerifyingKey::<Sha256>::new(key.clone())
                .verify(message, &signature)
                .map_err(|_| WebauthnError::InvalidSignature)
        }
    }
}

fn validate_transports(values: &[String]) -> Result<Vec<String>, WebauthnError> {
    if values.len() > 16 {
        return Err(WebauthnError::InvalidStructure("transports"));
    }
    let mut result = Vec::with_capacity(values.len());
    for value in values {
        if value.is_empty()
            || value.len() > 64
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err(WebauthnError::InvalidStructure("transports"));
        }
        if !result.contains(value) {
            result.push(value.clone());
        }
    }
    Ok(result)
}

fn decode_base64url(
    value: &str,
    max_decoded_len: usize,
    field: &'static str,
    allow_empty: bool,
) -> Result<Vec<u8>, WebauthnError> {
    let max_encoded_len = max_decoded_len.saturating_add(2) / 3 * 4;
    if value.len() > max_encoded_len {
        return Err(WebauthnError::PayloadTooLarge(field));
    }
    if (!allow_empty && value.is_empty())
        || value.contains('=')
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(WebauthnError::InvalidBase64Url(field));
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(value.as_bytes())
        .map_err(|_| WebauthnError::InvalidBase64Url(field))?;
    if decoded.len() > max_decoded_len || URL_SAFE_NO_PAD.encode(&decoded) != value {
        return Err(WebauthnError::InvalidBase64Url(field));
    }
    Ok(decoded)
}

fn parse_exact_cbor(bytes: &[u8], field: &'static str) -> Result<CborValue, WebauthnError> {
    let (value, consumed) = parse_cbor_prefix(bytes, field)?;
    if consumed != bytes.len() {
        return Err(WebauthnError::InvalidStructure(field));
    }
    Ok(value)
}

fn parse_cbor_prefix(
    bytes: &[u8],
    field: &'static str,
) -> Result<(CborValue, usize), WebauthnError> {
    if bytes.is_empty() {
        return Err(WebauthnError::InvalidStructure(field));
    }
    let mut cursor = Cursor::new(bytes);
    let value = ciborium::de::from_reader(&mut cursor)
        .map_err(|_| WebauthnError::InvalidStructure(field))?;
    Ok((value, cursor.position() as usize))
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    let max_len = left.len().max(right.len());
    for index in 0..max_len {
        let left_byte = left.get(index).copied().unwrap_or(0);
        let right_byte = right.get(index).copied().unwrap_or(0);
        difference |= usize::from(left_byte ^ right_byte);
    }
    difference == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::{signature::Signer as _, SigningKey as Es256SigningKey};
    use rsa::{
        pkcs1v15::SigningKey as Rs256SigningKey,
        rand_core::{CryptoRng, RngCore},
        traits::PublicKeyParts,
        RsaPrivateKey,
    };
    use serde_json::json;

    const CHALLENGE: &[u8] = b"0123456789abcdef0123456789abcdef";
    const ORIGIN: &str = "https://cinatoken.com";
    const RP_ID: &str = "cinatoken.com";

    fn expectation(require_uv: bool) -> CeremonyExpectation<'static> {
        CeremonyExpectation {
            challenge: Box::leak(URL_SAFE_NO_PAD.encode(CHALLENGE).into_boxed_str()),
            origin: ORIGIN,
            rp_id: RP_ID,
            require_user_verification: require_uv,
        }
    }

    fn client_data(
        ceremony_type: &str,
        challenge: &[u8],
        origin: &str,
        cross_origin: bool,
    ) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "type": ceremony_type,
            "challenge": URL_SAFE_NO_PAD.encode(challenge),
            "origin": origin,
            "crossOrigin": cross_origin,
        }))
        .unwrap()
    }

    fn cbor(value: &CborValue) -> Vec<u8> {
        let mut bytes = Vec::new();
        ciborium::ser::into_writer(value, &mut bytes).unwrap();
        bytes
    }

    fn integer(value: i64) -> CborValue {
        CborValue::Integer(value.into())
    }

    fn es256_fixture() -> (Es256SigningKey, Vec<u8>) {
        let signing_key = Es256SigningKey::from_bytes((&[7u8; 32]).into()).unwrap();
        let point = signing_key.verifying_key().to_encoded_point(false);
        let cose = CborValue::Map(vec![
            (integer(1), integer(2)),
            (integer(3), integer(-7)),
            (integer(-1), integer(1)),
            (integer(-2), CborValue::Bytes(point.x().unwrap().to_vec())),
            (integer(-3), CborValue::Bytes(point.y().unwrap().to_vec())),
        ]);
        (signing_key, cbor(&cose))
    }

    fn registration_auth_data(
        credential_id: &[u8],
        cose: &[u8],
        flags: u8,
        rp_id: &str,
    ) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&Sha256::digest(rp_id.as_bytes()));
        bytes.push(flags | FLAG_AT);
        bytes.extend_from_slice(&9u32.to_be_bytes());
        bytes.extend_from_slice(&[0x11; 16]);
        bytes.extend_from_slice(&(credential_id.len() as u16).to_be_bytes());
        bytes.extend_from_slice(credential_id);
        bytes.extend_from_slice(cose);
        bytes
    }

    fn registration_credential(
        credential_id: &[u8],
        cose: &[u8],
        flags: u8,
        rp_id: &str,
        client_data: &[u8],
    ) -> RegistrationCredential {
        let auth_data = registration_auth_data(credential_id, cose, flags, rp_id);
        let attestation = cbor(&CborValue::Map(vec![
            (
                CborValue::Text("fmt".into()),
                CborValue::Text("none".into()),
            ),
            (CborValue::Text("attStmt".into()), CborValue::Map(vec![])),
            (
                CborValue::Text("authData".into()),
                CborValue::Bytes(auth_data),
            ),
        ]));
        RegistrationCredential {
            id: URL_SAFE_NO_PAD.encode(credential_id),
            raw_id: URL_SAFE_NO_PAD.encode(credential_id),
            credential_type: "public-key".into(),
            authenticator_attachment: Some("platform".into()),
            response: RegistrationResponse {
                attestation_object: URL_SAFE_NO_PAD.encode(attestation),
                client_data_json: URL_SAFE_NO_PAD.encode(client_data),
                transports: vec!["internal".into(), "hybrid".into(), "internal".into()],
            },
            client_extension_results: json!({}),
        }
    }

    fn assertion_auth_data(flags: u8, sign_count: u32, rp_id: &str) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&Sha256::digest(rp_id.as_bytes()));
        bytes.push(flags);
        bytes.extend_from_slice(&sign_count.to_be_bytes());
        bytes
    }

    fn assertion_credential(
        credential_id: &[u8],
        auth_data: &[u8],
        client_data: &[u8],
        signature: &[u8],
    ) -> AssertionCredential {
        AssertionCredential {
            id: URL_SAFE_NO_PAD.encode(credential_id),
            raw_id: URL_SAFE_NO_PAD.encode(credential_id),
            credential_type: "public-key".into(),
            authenticator_attachment: Some("platform".into()),
            response: AssertionResponse {
                authenticator_data: URL_SAFE_NO_PAD.encode(auth_data),
                client_data_json: URL_SAFE_NO_PAD.encode(client_data),
                signature: URL_SAFE_NO_PAD.encode(signature),
                user_handle: Some(URL_SAFE_NO_PAD.encode(b"42")),
            },
            client_extension_results: json!({}),
        }
    }

    fn signed_message(auth_data: &[u8], client_data: &[u8]) -> Vec<u8> {
        let mut message = auth_data.to_vec();
        message.extend_from_slice(&Sha256::digest(client_data));
        message
    }

    #[test]
    fn verifies_none_attestation_with_es256_key() {
        let (_, cose) = es256_fixture();
        let client = client_data("webauthn.create", CHALLENGE, ORIGIN, false);
        let credential = registration_credential(
            b"credential-one",
            &cose,
            FLAG_UP | FLAG_UV | FLAG_BE | FLAG_BS,
            RP_ID,
            &client,
        );
        let verified = verify_registration(&credential, &expectation(true)).unwrap();
        assert_eq!(verified.algorithm, CoseAlgorithm::Es256);
        assert_eq!(verified.credential_id, b"credential-one");
        assert_eq!(verified.sign_count, 9);
        assert!(verified.backup_eligible);
        assert!(verified.backup_state);
        assert_eq!(verified.transports, vec!["internal", "hybrid"]);
        assert_eq!(verified.aaguid, [0x11; 16]);
    }

    #[test]
    fn verifies_es256_assertion_and_reports_counter_rollback() {
        let (signing_key, cose) = es256_fixture();
        let client = client_data("webauthn.get", CHALLENGE, ORIGIN, false);
        let auth_data = assertion_auth_data(FLAG_UP | FLAG_UV | FLAG_BE, 10, RP_ID);
        let signature: Es256Signature = signing_key.sign(&signed_message(&auth_data, &client));
        let credential = assertion_credential(
            b"credential-one",
            &auth_data,
            &client,
            signature.to_der().as_bytes(),
        );
        let stored = StoredCredential {
            credential_id: b"credential-one",
            public_key_cose: &cose,
            sign_count: 10,
            backup_eligible: true,
        };
        let verified = verify_assertion(&credential, &expectation(true), &stored).unwrap();
        assert_eq!(verified.sign_count, 10);
        assert!(verified.clone_warning);
        assert_eq!(verified.user_handle.as_deref(), Some(b"42".as_slice()));
    }

    #[test]
    fn verifies_rs256_assertion() {
        let mut rng = DeterministicRng::new(0x4f8a_2031_d991_773b);
        let private_key = RsaPrivateKey::new(&mut rng, 2_048).unwrap();
        let public_key = private_key.to_public_key();
        let cose = cbor(&CborValue::Map(vec![
            (integer(1), integer(3)),
            (integer(3), integer(-257)),
            (integer(-1), CborValue::Bytes(public_key.n().to_bytes_be())),
            (integer(-2), CborValue::Bytes(public_key.e().to_bytes_be())),
        ]));
        let client = client_data("webauthn.get", CHALLENGE, ORIGIN, false);
        let auth_data = assertion_auth_data(FLAG_UP | FLAG_UV, 11, RP_ID);
        let signature = rsa::signature::SignatureEncoding::to_vec(&rsa::signature::Signer::sign(
            &Rs256SigningKey::<Sha256>::new(private_key),
            &signed_message(&auth_data, &client),
        ));
        let credential = assertion_credential(b"rsa-credential", &auth_data, &client, &signature);
        let stored = StoredCredential {
            credential_id: b"rsa-credential",
            public_key_cose: &cose,
            sign_count: 10,
            backup_eligible: false,
        };
        let verified = verify_assertion(&credential, &expectation(true), &stored).unwrap();
        assert_eq!(verified.sign_count, 11);
        assert!(!verified.clone_warning);
    }

    #[test]
    fn rejects_client_data_mismatches() {
        let (_, cose) = es256_fixture();
        for (client, expected_error) in [
            (
                client_data("webauthn.get", CHALLENGE, ORIGIN, false),
                WebauthnError::ClientDataTypeMismatch,
            ),
            (
                client_data("webauthn.create", b"wrong", ORIGIN, false),
                WebauthnError::ChallengeMismatch,
            ),
            (
                client_data("webauthn.create", CHALLENGE, "https://evil.example", false),
                WebauthnError::OriginMismatch,
            ),
            (
                client_data("webauthn.create", CHALLENGE, ORIGIN, true),
                WebauthnError::CrossOriginNotAllowed,
            ),
        ] {
            let credential = registration_credential(
                b"credential-one",
                &cose,
                FLAG_UP | FLAG_UV,
                RP_ID,
                &client,
            );
            assert_eq!(
                verify_registration(&credential, &expectation(true)),
                Err(expected_error)
            );
        }

        let top_origin = serde_json::to_vec(&json!({
            "type": "webauthn.create",
            "challenge": URL_SAFE_NO_PAD.encode(CHALLENGE),
            "origin": ORIGIN,
            "crossOrigin": false,
            "topOrigin": "https://embedder.example",
        }))
        .unwrap();
        let credential = registration_credential(
            b"credential-one",
            &cose,
            FLAG_UP | FLAG_UV,
            RP_ID,
            &top_origin,
        );
        assert_eq!(
            verify_registration(&credential, &expectation(true)),
            Err(WebauthnError::CrossOriginNotAllowed)
        );
    }

    #[test]
    fn rejects_rp_flags_and_credential_id_mismatches() {
        let (_, cose) = es256_fixture();
        let client = client_data("webauthn.create", CHALLENGE, ORIGIN, false);
        let cases = [
            (0, RP_ID, WebauthnError::UserPresenceRequired),
            (FLAG_UP, RP_ID, WebauthnError::UserVerificationRequired),
            (
                FLAG_UP | FLAG_UV | FLAG_BS,
                RP_ID,
                WebauthnError::BackupStateInvalid,
            ),
            (
                FLAG_UP | FLAG_UV,
                "wrong.example",
                WebauthnError::RpIdHashMismatch,
            ),
        ];
        for (flags, rp_id, expected_error) in cases {
            let credential =
                registration_credential(b"credential-one", &cose, flags, rp_id, &client);
            assert_eq!(
                verify_registration(&credential, &expectation(true)),
                Err(expected_error)
            );
        }

        let mut credential =
            registration_credential(b"credential-one", &cose, FLAG_UP | FLAG_UV, RP_ID, &client);
        credential.raw_id = URL_SAFE_NO_PAD.encode(b"other");
        assert_eq!(
            verify_registration(&credential, &expectation(true)),
            Err(WebauthnError::CredentialIdMismatch)
        );
    }

    #[test]
    fn rejects_cbor_trailing_bytes_and_tampered_signature() {
        let (signing_key, cose) = es256_fixture();
        let client = client_data("webauthn.get", CHALLENGE, ORIGIN, false);
        let auth_data = assertion_auth_data(FLAG_UP | FLAG_UV, 1, RP_ID);
        let signature: Es256Signature = signing_key.sign(&signed_message(&auth_data, &client));
        let mut credential = assertion_credential(
            b"credential-one",
            &auth_data,
            &client,
            signature.to_der().as_bytes(),
        );
        credential.response.signature.push('A');
        let stored = StoredCredential {
            credential_id: b"credential-one",
            public_key_cose: &cose,
            sign_count: 0,
            backup_eligible: false,
        };
        assert!(matches!(
            verify_assertion(&credential, &expectation(true), &stored),
            Err(WebauthnError::InvalidBase64Url("signature"))
                | Err(WebauthnError::InvalidSignature)
        ));

        let mut trailing_cose = cose.clone();
        trailing_cose.push(0);
        let stored = StoredCredential {
            public_key_cose: &trailing_cose,
            ..stored
        };
        let valid_credential = assertion_credential(
            b"credential-one",
            &auth_data,
            &client,
            signature.to_der().as_bytes(),
        );
        assert_eq!(
            verify_assertion(&valid_credential, &expectation(true), &stored),
            Err(WebauthnError::InvalidStructure("stored COSE key"))
        );
    }

    struct DeterministicRng(u64);

    impl DeterministicRng {
        fn new(seed: u64) -> Self {
            Self(seed)
        }

        fn next(&mut self) -> u64 {
            let mut value = self.0;
            value ^= value << 13;
            value ^= value >> 7;
            value ^= value << 17;
            self.0 = value;
            value
        }
    }

    impl RngCore for DeterministicRng {
        fn next_u32(&mut self) -> u32 {
            self.next() as u32
        }

        fn next_u64(&mut self) -> u64 {
            self.next()
        }

        fn fill_bytes(&mut self, dest: &mut [u8]) {
            for chunk in dest.chunks_mut(8) {
                let bytes = self.next().to_le_bytes();
                chunk.copy_from_slice(&bytes[..chunk.len()]);
            }
        }

        fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), rsa::rand_core::Error> {
            self.fill_bytes(dest);
            Ok(())
        }
    }

    impl CryptoRng for DeterministicRng {}
}
