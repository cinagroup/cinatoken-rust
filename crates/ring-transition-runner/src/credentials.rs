// Identity-proof typestates stay dormant until the bounded HTTP client consumes them.
#![allow(dead_code)]

use crate::publication::{ActivatedPublication, PublicationIdentity};
use crate::release::{canonical_json, reject_duplicate_json, MAX_SAFE_INTEGER};
use crate::STAGING_AUTHORITY_ORIGIN;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;
use zeroize::Zeroizing;

pub const CREDENTIAL_TRUST_CONTRACT: &str =
    "cinatoken-relay-container-ring-transition-runner-credential-trust-v1";
pub const CLOUDFLARE_API_ORIGIN: &str = "https://api.cloudflare.com";
pub const AUTHORITY_PREFLIGHT_PATH: &str = "/internal/v1/ring-transition/preflight";
pub const AUTHORITY_HEADER_NAME: &str = "x-cinatoken-ring-authority";
pub const ACCOUNT_ID_ENV: &str = "CINATOKEN_RING_TRANSITION_ACCOUNT_ID";
pub const READ_TOKEN_ENV: &str = "CINATOKEN_RING_TRANSITION_READ_TOKEN";
pub const CLAIM_HMAC_SECRET_ENV: &str = "CINATOKEN_RING_TRANSITION_CLAIM_HMAC_SECRET";
pub const DEPLOY_TOKEN_ENV: &str = "CINATOKEN_RING_TRANSITION_DEPLOY_TOKEN";

const AUTHORITY_HMAC_DOMAIN: &[u8] = b"cinatoken-ring-transition-authority-v1\n";
const AUTHORITY_TOKEN_LIFETIME_SECONDS: u64 = 30;
const MAX_IDENTITY_RESPONSE_BYTES: usize = 256 * 1024;
const MIN_SECRET_BYTES: usize = 32;
const MAX_SECRET_BYTES: usize = 4096;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedCredentialTrust {
    pub schema_version: u8,
    pub contract: &'static str,
    pub enabled: bool,
    pub environment: &'static str,
    pub cloudflare_api_origin: &'static str,
    pub authority_origin: Option<&'static str>,
    pub authority_version_id: Option<&'static str>,
    pub authority_issuer: Option<&'static str>,
    pub authority_audience: Option<&'static str>,
    pub authority_hmac_key_id: Option<&'static str>,
    pub permit_spki_sha256: Option<&'static str>,
    pub trust_config_sha256: Option<&'static str>,
    pub account_id_sha256: Option<&'static str>,
    pub read_credential_id_sha256: Option<&'static str>,
    pub claim_credential_id_sha256: Option<&'static str>,
    pub deploy_credential_id_sha256: Option<&'static str>,
}

impl EmbeddedCredentialTrust {
    pub const fn checked_in() -> Self {
        Self {
            schema_version: 1,
            contract: CREDENTIAL_TRUST_CONTRACT,
            enabled: false,
            environment: "staging",
            cloudflare_api_origin: CLOUDFLARE_API_ORIGIN,
            authority_origin: None,
            authority_version_id: None,
            authority_issuer: None,
            authority_audience: None,
            authority_hmac_key_id: None,
            permit_spki_sha256: None,
            trust_config_sha256: None,
            account_id_sha256: None,
            read_credential_id_sha256: None,
            claim_credential_id_sha256: None,
            deploy_credential_id_sha256: None,
        }
    }

    fn validate_for_publication(
        &self,
        publication: &PublicationIdentity,
    ) -> Result<ValidatedCredentialTrust, CredentialError> {
        if !self.enabled {
            return Err(CredentialError::TrustDisabled);
        }
        if self.schema_version != 1
            || self.contract != CREDENTIAL_TRUST_CONTRACT
            || self.environment != "staging"
            || self.cloudflare_api_origin != CLOUDFLARE_API_ORIGIN
            || self.authority_origin != Some(STAGING_AUTHORITY_ORIGIN)
        {
            return Err(CredentialError::TrustContractMismatch);
        }

        let authority_version_id =
            required_field(self.authority_version_id, "authority_version_id")?;
        let authority_issuer = required_field(self.authority_issuer, "authority_issuer")?;
        let authority_audience = required_field(self.authority_audience, "authority_audience")?;
        let authority_hmac_key_id =
            required_field(self.authority_hmac_key_id, "authority_hmac_key_id")?;
        let permit_spki_sha256 = required_sha256(self.permit_spki_sha256, "permit_spki_sha256")?;
        let trust_config_sha256 = required_sha256(self.trust_config_sha256, "trust_config_sha256")?;
        let account_id_sha256 = required_sha256(self.account_id_sha256, "account_id_sha256")?;
        let read_credential_id_sha256 =
            required_sha256(self.read_credential_id_sha256, "read_credential_id_sha256")?;
        let claim_credential_id_sha256 = required_sha256(
            self.claim_credential_id_sha256,
            "claim_credential_id_sha256",
        )?;
        let deploy_credential_id_sha256 = required_sha256(
            self.deploy_credential_id_sha256,
            "deploy_credential_id_sha256",
        )?;

        if !valid_token(authority_version_id, 1, 128, version_token_byte)
            || !valid_token(authority_issuer, 1, 128, identity_token_byte)
            || !valid_token(authority_audience, 1, 128, identity_token_byte)
            || !valid_token(authority_hmac_key_id, 1, 32, key_id_token_byte)
        {
            return Err(CredentialError::InvalidTrustField("authority_identity"));
        }
        if read_credential_id_sha256 == claim_credential_id_sha256
            || read_credential_id_sha256 == deploy_credential_id_sha256
            || claim_credential_id_sha256 == deploy_credential_id_sha256
        {
            return Err(CredentialError::CredentialIdentitiesNotDistinct);
        }
        if publication.release.authority_version_id != authority_version_id
            || publication.release.permit_spki_sha256 != permit_spki_sha256
            || publication.release.trust_config_sha256 != trust_config_sha256
        {
            return Err(CredentialError::ActivationIdentityMismatch);
        }

        Ok(ValidatedCredentialTrust {
            authority_version_id,
            authority_issuer,
            authority_audience,
            authority_hmac_key_id,
            permit_spki_sha256,
            trust_config_sha256,
            account_id_sha256,
            read_credential_id_sha256,
            claim_credential_id_sha256,
            deploy_credential_id_sha256,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialIdentity {
    pub account_id_sha256: String,
    pub read_credential_id_sha256: String,
    pub claim_credential_id_sha256: String,
    pub deploy_credential_id_sha256: String,
    pub authority_version_id: String,
    pub permit_spki_sha256: String,
    pub trust_config_sha256: String,
    pub publication_manifest_sha256: String,
    pub activation_sequence: u64,
}

pub struct LoadedCredentials {
    material: CredentialMaterial,
    identity: CredentialIdentity,
    trust: ValidatedCredentialTrust,
}

impl LoadedCredentials {
    pub fn identity(&self) -> &CredentialIdentity {
        &self.identity
    }

    #[allow(dead_code)]
    pub(crate) fn prove_read_token_identity(
        self,
        response_json: &[u8],
    ) -> Result<ReadCredentialProven, CredentialError> {
        verify_cloudflare_token_identity(
            response_json,
            self.trust.read_credential_id_sha256,
            "read",
        )?;
        Ok(ReadCredentialProven { loaded: self })
    }
}

#[allow(dead_code)]
pub(crate) struct ReadCredentialProven {
    loaded: LoadedCredentials,
}

impl ReadCredentialProven {
    pub(crate) fn prove_deploy_token_identity(
        self,
        response_json: &[u8],
    ) -> Result<DeployCredentialProven, CredentialError> {
        verify_cloudflare_token_identity(
            response_json,
            self.loaded.trust.deploy_credential_id_sha256,
            "deploy",
        )?;
        Ok(DeployCredentialProven {
            loaded: self.loaded,
        })
    }
}

#[allow(dead_code)]
pub(crate) struct DeployCredentialProven {
    loaded: LoadedCredentials,
}

impl DeployCredentialProven {
    pub(crate) fn begin_authority_preflight(
        self,
        request_id: &str,
        now: u64,
    ) -> Result<PendingAuthorityPreflight, CredentialError> {
        if now == 0 || now > MAX_SAFE_INTEGER - AUTHORITY_TOKEN_LIFETIME_SECONDS {
            return Err(CredentialError::InvalidRequest("preflight_time"));
        }
        if !valid_token(request_id, 1, 128, version_token_byte) {
            return Err(CredentialError::InvalidRequest("request_id"));
        }
        let authority_token = create_authority_token(
            &self.loaded.trust,
            self.loaded.material.claim_hmac_secret.expose(),
            request_id,
            now,
        )?;
        Ok(PendingAuthorityPreflight {
            loaded: self.loaded,
            request_id: request_id.to_owned(),
            authority_token: SecretBytes::from_string(authority_token),
        })
    }
}

#[allow(dead_code)]
pub(crate) struct PendingAuthorityPreflight {
    loaded: LoadedCredentials,
    request_id: String,
    #[allow(dead_code)]
    authority_token: SecretBytes,
}

impl PendingAuthorityPreflight {
    pub(crate) fn verify_response(
        self,
        response_json: &[u8],
    ) -> Result<VerifiedCredentials, CredentialError> {
        reject_duplicate_json(response_json, MAX_IDENTITY_RESPONSE_BYTES)
            .map_err(|_| CredentialError::InvalidJson("authority_preflight"))?;
        let response: AuthorityPreflightResponse = serde_json::from_slice(response_json)
            .map_err(|_| CredentialError::InvalidJson("authority_preflight"))?;
        if response.result != "authority_ready"
            || response.request_id != self.request_id
            || response.credential_id_sha256 != self.loaded.trust.claim_credential_id_sha256
            || response.permit_spki_sha256 != self.loaded.trust.permit_spki_sha256
            || response.authority_version_id != self.loaded.trust.authority_version_id
        {
            return Err(CredentialError::AuthorityPreflightIdentityMismatch);
        }
        Ok(VerifiedCredentials {
            material: self.loaded.material,
            identity: self.loaded.identity,
        })
    }
}

#[allow(dead_code)]
pub(crate) struct VerifiedCredentials {
    material: CredentialMaterial,
    identity: CredentialIdentity,
}

impl VerifiedCredentials {
    pub(crate) fn identity(&self) -> &CredentialIdentity {
        &self.identity
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CredentialError {
    TrustDisabled,
    TrustContractMismatch,
    MissingTrustField(&'static str),
    InvalidTrustField(&'static str),
    CredentialIdentitiesNotDistinct,
    ActivationIdentityMismatch,
    MissingEnvironment(&'static str),
    InvalidEnvironment(&'static str),
    AccountIdentityMismatch,
    SecretMaterialNotDistinct,
    InvalidJson(&'static str),
    CredentialIdentityRejected(&'static str),
    CredentialIdentityMismatch(&'static str),
    InvalidRequest(&'static str),
    AuthorityPreflightIdentityMismatch,
}

impl fmt::Display for CredentialError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TrustDisabled => formatter.write_str("embedded credential trust is disabled"),
            Self::TrustContractMismatch => {
                formatter.write_str("embedded credential trust contract mismatch")
            }
            Self::MissingTrustField(field) => {
                write!(
                    formatter,
                    "embedded credential trust field missing: {field}"
                )
            }
            Self::InvalidTrustField(field) => {
                write!(
                    formatter,
                    "embedded credential trust field invalid: {field}"
                )
            }
            Self::CredentialIdentitiesNotDistinct => {
                formatter.write_str("credential identities are not distinct")
            }
            Self::ActivationIdentityMismatch => {
                formatter.write_str("credential trust does not match activated publication")
            }
            Self::MissingEnvironment(name) => {
                write!(formatter, "required credential handle is missing: {name}")
            }
            Self::InvalidEnvironment(name) => {
                write!(formatter, "required credential handle is invalid: {name}")
            }
            Self::AccountIdentityMismatch => {
                formatter.write_str("Cloudflare account identity does not match compiled trust")
            }
            Self::SecretMaterialNotDistinct => {
                formatter.write_str("credential secret material is not distinct")
            }
            Self::InvalidJson(label) => write!(formatter, "{label} response JSON is invalid"),
            Self::CredentialIdentityRejected(class) => {
                write!(formatter, "{class} credential identity was not active")
            }
            Self::CredentialIdentityMismatch(class) => {
                write!(
                    formatter,
                    "{class} credential identity does not match compiled trust"
                )
            }
            Self::InvalidRequest(field) => {
                write!(formatter, "credential proof request is invalid: {field}")
            }
            Self::AuthorityPreflightIdentityMismatch => {
                formatter.write_str("Authority preflight identity does not match compiled trust")
            }
        }
    }
}

impl std::error::Error for CredentialError {}

pub(crate) fn load_activated_credentials(
    activation: ActivatedPublication,
) -> Result<LoadedCredentials, CredentialError> {
    let identity = activation.into_identity();
    let trust = EmbeddedCredentialTrust::checked_in();
    load_from_source(identity, &trust, &mut ProcessEnvironment)
}

trait FixedCredentialSource {
    fn take(&mut self, name: &'static str) -> Result<String, CredentialError>;
}

struct ProcessEnvironment;

impl FixedCredentialSource for ProcessEnvironment {
    fn take(&mut self, name: &'static str) -> Result<String, CredentialError> {
        match std::env::var(name) {
            Ok(value) => Ok(value),
            Err(std::env::VarError::NotPresent) => Err(CredentialError::MissingEnvironment(name)),
            Err(std::env::VarError::NotUnicode(_)) => {
                Err(CredentialError::InvalidEnvironment(name))
            }
        }
    }
}

fn load_from_source(
    publication: PublicationIdentity,
    trust: &EmbeddedCredentialTrust,
    source: &mut impl FixedCredentialSource,
) -> Result<LoadedCredentials, CredentialError> {
    let validated = trust.validate_for_publication(&publication)?;

    let account_id = SecretBytes::from_string(source.take(ACCOUNT_ID_ENV)?);
    if !valid_account_id(account_id.expose()) {
        return Err(CredentialError::InvalidEnvironment(ACCOUNT_ID_ENV));
    }
    if sha256_hex(account_id.as_bytes()) != validated.account_id_sha256 {
        return Err(CredentialError::AccountIdentityMismatch);
    }

    let read_token = read_secret(source, READ_TOKEN_ENV)?;
    let claim_hmac_secret = read_secret(source, CLAIM_HMAC_SECRET_ENV)?;
    let deploy_token = read_secret(source, DEPLOY_TOKEN_ENV)?;
    if constant_time_equal(read_token.as_bytes(), claim_hmac_secret.as_bytes())
        || constant_time_equal(read_token.as_bytes(), deploy_token.as_bytes())
        || constant_time_equal(claim_hmac_secret.as_bytes(), deploy_token.as_bytes())
    {
        return Err(CredentialError::SecretMaterialNotDistinct);
    }

    let identity = CredentialIdentity {
        account_id_sha256: validated.account_id_sha256.to_owned(),
        read_credential_id_sha256: validated.read_credential_id_sha256.to_owned(),
        claim_credential_id_sha256: validated.claim_credential_id_sha256.to_owned(),
        deploy_credential_id_sha256: validated.deploy_credential_id_sha256.to_owned(),
        authority_version_id: validated.authority_version_id.to_owned(),
        permit_spki_sha256: validated.permit_spki_sha256.to_owned(),
        trust_config_sha256: validated.trust_config_sha256.to_owned(),
        publication_manifest_sha256: publication.publication_manifest_sha256,
        activation_sequence: publication.activation_sequence,
    };
    Ok(LoadedCredentials {
        material: CredentialMaterial {
            account_id,
            read_token,
            claim_hmac_secret,
            deploy_token,
        },
        identity,
        trust: validated,
    })
}

fn read_secret(
    source: &mut impl FixedCredentialSource,
    name: &'static str,
) -> Result<SecretBytes, CredentialError> {
    let secret = SecretBytes::from_string(source.take(name)?);
    if secret.as_bytes().len() < MIN_SECRET_BYTES
        || secret.as_bytes().len() > MAX_SECRET_BYTES
        || secret.expose().chars().any(char::is_whitespace)
    {
        return Err(CredentialError::InvalidEnvironment(name));
    }
    Ok(secret)
}

#[allow(dead_code)]
struct CredentialMaterial {
    account_id: SecretBytes,
    read_token: SecretBytes,
    claim_hmac_secret: SecretBytes,
    deploy_token: SecretBytes,
}

struct SecretBytes(Zeroizing<Vec<u8>>);

impl SecretBytes {
    fn from_string(value: String) -> Self {
        Self(Zeroizing::new(value.into_bytes()))
    }

    fn as_bytes(&self) -> &[u8] {
        self.0.as_slice()
    }

    fn expose(&self) -> &str {
        std::str::from_utf8(self.as_bytes()).expect("environment strings are valid UTF-8")
    }
}

#[derive(Clone, Copy)]
struct ValidatedCredentialTrust {
    authority_version_id: &'static str,
    authority_issuer: &'static str,
    authority_audience: &'static str,
    authority_hmac_key_id: &'static str,
    permit_spki_sha256: &'static str,
    trust_config_sha256: &'static str,
    account_id_sha256: &'static str,
    read_credential_id_sha256: &'static str,
    claim_credential_id_sha256: &'static str,
    deploy_credential_id_sha256: &'static str,
}

#[derive(Deserialize)]
struct CloudflareTokenVerifyEnvelope {
    success: bool,
    result: CloudflareTokenVerifyResult,
}

#[derive(Deserialize)]
struct CloudflareTokenVerifyResult {
    id: String,
    status: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthorityPreflightResponse {
    result: String,
    request_id: String,
    credential_id_sha256: String,
    permit_spki_sha256: String,
    authority_version_id: String,
}

#[derive(Serialize)]
struct AuthorityTokenHeader<'a> {
    alg: &'static str,
    kid: &'a str,
    typ: &'static str,
}

#[derive(Serialize)]
struct AuthorityTokenClaims<'a> {
    audience: &'a str,
    body_sha256: String,
    credential_id_sha256: &'a str,
    expires_at: u64,
    issued_at: u64,
    issuer: &'a str,
    method: &'static str,
    path_and_query: &'static str,
    request_id: &'a str,
}

fn verify_cloudflare_token_identity(
    response_json: &[u8],
    expected_id_sha256: &str,
    class: &'static str,
) -> Result<(), CredentialError> {
    reject_duplicate_json(response_json, MAX_IDENTITY_RESPONSE_BYTES)
        .map_err(|_| CredentialError::InvalidJson("Cloudflare token identity"))?;
    let response: CloudflareTokenVerifyEnvelope = serde_json::from_slice(response_json)
        .map_err(|_| CredentialError::InvalidJson("Cloudflare token identity"))?;
    if !response.success
        || response.result.status != "active"
        || !valid_token(&response.result.id, 1, 128, version_token_byte)
    {
        return Err(CredentialError::CredentialIdentityRejected(class));
    }
    if sha256_hex(response.result.id.as_bytes()) != expected_id_sha256 {
        return Err(CredentialError::CredentialIdentityMismatch(class));
    }
    Ok(())
}

fn create_authority_token(
    trust: &ValidatedCredentialTrust,
    secret: &str,
    request_id: &str,
    now: u64,
) -> Result<String, CredentialError> {
    let header = canonical_json(&AuthorityTokenHeader {
        alg: "HS256",
        kid: trust.authority_hmac_key_id,
        typ: "CINATOKEN-RING-AUTHORITY",
    })
    .map_err(|_| CredentialError::InvalidRequest("authority_header"))?;
    let claims = canonical_json(&AuthorityTokenClaims {
        audience: trust.authority_audience,
        body_sha256: sha256_hex(&[]),
        credential_id_sha256: trust.claim_credential_id_sha256,
        expires_at: now + AUTHORITY_TOKEN_LIFETIME_SECONDS,
        issued_at: now,
        issuer: trust.authority_issuer,
        method: "GET",
        path_and_query: AUTHORITY_PREFLIGHT_PATH,
        request_id,
    })
    .map_err(|_| CredentialError::InvalidRequest("authority_claims"))?;
    let header_part = URL_SAFE_NO_PAD.encode(header.as_bytes());
    let claims_part = URL_SAFE_NO_PAD.encode(claims.as_bytes());
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
        .map_err(|_| CredentialError::InvalidRequest("authority_secret"))?;
    mac.update(AUTHORITY_HMAC_DOMAIN);
    mac.update(header_part.as_bytes());
    mac.update(b".");
    mac.update(claims_part.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    Ok(format!("{header_part}.{claims_part}.{signature}"))
}

fn required_field(
    value: Option<&'static str>,
    field: &'static str,
) -> Result<&'static str, CredentialError> {
    value.ok_or(CredentialError::MissingTrustField(field))
}

fn required_sha256(
    value: Option<&'static str>,
    field: &'static str,
) -> Result<&'static str, CredentialError> {
    let value = required_field(value, field)?;
    if !valid_lower_hex(value, 64) {
        return Err(CredentialError::InvalidTrustField(field));
    }
    Ok(value)
}

fn valid_account_id(value: &str) -> bool {
    valid_lower_hex(value, 32)
}

fn valid_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_token(
    value: &str,
    minimum: usize,
    maximum: usize,
    allowed: fn(usize, u8) -> bool,
) -> bool {
    value.len() >= minimum
        && value.len() <= maximum
        && value.is_ascii()
        && value
            .bytes()
            .enumerate()
            .all(|(index, byte)| allowed(index, byte))
}

fn version_token_byte(index: usize, byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn identity_token_byte(index: usize, byte: u8) -> bool {
    byte.is_ascii_digit()
        || byte.is_ascii_lowercase()
        || (index > 0 && matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn key_id_token_byte(index: usize, byte: u8) -> bool {
    byte.is_ascii_digit()
        || byte.is_ascii_lowercase()
        || (index > 0 && matches!(byte, b'.' | b'_' | b'-'))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        write!(&mut output, "{byte:02x}").expect("writing to a String cannot fail");
    }
    output
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::publication::PublicationIdentity;
    use crate::release::VerifiedRelease;
    use std::collections::BTreeMap;

    const ACCOUNT_ID: &str = "0123456789abcdef0123456789abcdef";
    const ACCOUNT_ID_SHA256: &str =
        "3eb1bd439947eb762998e566ccc2e099c791118b2f40579cc4f7da2b5061b7f9";
    const READ_CREDENTIAL_ID_SHA256: &str =
        "b6ce21a4cf7860d3414bb6c146d21c918bb485c121d408bde14ad894f35be647";
    const CLAIM_CREDENTIAL_ID_SHA256: &str =
        "a01bfefd6a25d9107e9472809973052a7e3f09266616eae2de0ae5cf09fb2bf3";
    const DEPLOY_CREDENTIAL_ID_SHA256: &str =
        "4926f0bf601ffe3ddfabdb7be57907446e507d58ecafedd1bac1eaf26acc10ef";
    const TRUST_CONFIG_SHA256: &str =
        "5555555555555555555555555555555555555555555555555555555555555555";
    const PERMIT_SPKI_SHA256: &str =
        "6666666666666666666666666666666666666666666666666666666666666666";
    const AUTHORITY_VERSION_ID: &str = "authority-version-1";
    const CLAIM_SECRET: &str = "0123456789abcdef0123456789abcdef";
    const HMAC_VECTOR: &str = "eyJhbGciOiJIUzI1NiIsImtpZCI6ImN1cnJlbnQtdjEiLCJ0eXAiOiJDSU5BVE9LRU4tUklORy1BVVRIT1JJVFkifQ.eyJhdWRpZW5jZSI6ImF1dGhvcml0eS1zdGFnaW5nIiwiYm9keV9zaGEyNTYiOiJlM2IwYzQ0Mjk4ZmMxYzE0OWFmYmY0Yzg5OTZmYjkyNDI3YWU0MWU0NjQ5YjkzNGNhNDk1OTkxYjc4NTJiODU1IiwiY3JlZGVudGlhbF9pZF9zaGEyNTYiOiJhMDFiZmVmZDZhMjVkOTEwN2U5NDcyODA5OTczMDUyYTdlM2YwOTI2NjYxNmVhZTJkZTBhZTVjZjA5ZmIyYmYzIiwiZXhwaXJlc19hdCI6MTgwMDAwMDAzMCwiaXNzdWVkX2F0IjoxODAwMDAwMDAwLCJpc3N1ZXIiOiJydW5uZXItc3RhZ2luZyIsIm1ldGhvZCI6IkdFVCIsInBhdGhfYW5kX3F1ZXJ5IjoiL2ludGVybmFsL3YxL3JpbmctdHJhbnNpdGlvbi9wcmVmbGlnaHQiLCJyZXF1ZXN0X2lkIjoicmVxdWVzdC0xIn0.ar2B2dDPZLGvIOwK930i5TOHmv8EBKgF1HQWowJxq2c";

    #[test]
    fn checked_in_trust_fails_before_any_environment_access() {
        let mut source = FakeSource::valid();
        assert_eq!(
            load_from_source(
                publication_identity(),
                &EmbeddedCredentialTrust::checked_in(),
                &mut source
            )
            .err(),
            Some(CredentialError::TrustDisabled)
        );
        assert!(source.reads.is_empty());
    }

    #[test]
    fn loader_reads_only_four_fixed_handles_after_activation_identity_matches() {
        let mut source = FakeSource::valid();
        let loaded =
            load_from_source(publication_identity(), &fully_pinned_trust(), &mut source).unwrap();
        assert_eq!(
            source.reads,
            [
                ACCOUNT_ID_ENV,
                READ_TOKEN_ENV,
                CLAIM_HMAC_SECRET_ENV,
                DEPLOY_TOKEN_ENV
            ]
        );
        assert_eq!(loaded.identity().account_id_sha256, ACCOUNT_ID_SHA256);
        assert_eq!(loaded.identity().activation_sequence, 7);
    }

    #[test]
    fn account_and_activation_mismatch_fail_before_secret_reads() {
        let mut activation_drift = publication_identity();
        activation_drift.release.trust_config_sha256 = "9".repeat(64);
        let mut source = FakeSource::valid();
        assert_eq!(
            load_from_source(activation_drift, &fully_pinned_trust(), &mut source).err(),
            Some(CredentialError::ActivationIdentityMismatch)
        );
        assert!(source.reads.is_empty());

        let mut source = FakeSource::valid();
        source.values.insert(ACCOUNT_ID_ENV, "f".repeat(32));
        assert_eq!(
            load_from_source(publication_identity(), &fully_pinned_trust(), &mut source).err(),
            Some(CredentialError::AccountIdentityMismatch)
        );
        assert_eq!(source.reads, [ACCOUNT_ID_ENV]);
    }

    #[test]
    fn invalid_or_shared_secret_material_never_loads() {
        let mut short = FakeSource::valid();
        short.values.insert(READ_TOKEN_ENV, "too-short".to_owned());
        assert_eq!(
            load_from_source(publication_identity(), &fully_pinned_trust(), &mut short).err(),
            Some(CredentialError::InvalidEnvironment(READ_TOKEN_ENV))
        );

        let mut shared = FakeSource::valid();
        shared
            .values
            .insert(DEPLOY_TOKEN_ENV, shared.values[READ_TOKEN_ENV].clone());
        assert_eq!(
            load_from_source(publication_identity(), &fully_pinned_trust(), &mut shared).err(),
            Some(CredentialError::SecretMaterialNotDistinct)
        );
    }

    #[test]
    fn identity_proofs_are_ordered_atomic_and_match_the_authority_hmac_vector() {
        let loaded = loaded_credentials();
        let read = loaded
            .prove_read_token_identity(
                br#"{"result":{"id":"read-token-id","status":"active"},"success":true}"#,
            )
            .unwrap();
        let deploy = read
            .prove_deploy_token_identity(
                br#"{"result":{"id":"deploy-token-id","status":"active"},"success":true}"#,
            )
            .unwrap();
        let pending = deploy
            .begin_authority_preflight("request-1", 1_800_000_000)
            .unwrap();
        assert_eq!(pending.authority_token.expose(), HMAC_VECTOR);
        let response = format!(
            "{{\"authorityVersionId\":\"{AUTHORITY_VERSION_ID}\",\"credentialIdSha256\":\"{CLAIM_CREDENTIAL_ID_SHA256}\",\"permitSpkiSha256\":\"{PERMIT_SPKI_SHA256}\",\"requestId\":\"request-1\",\"result\":\"authority_ready\"}}"
        );
        let verified = pending.verify_response(response.as_bytes()).unwrap();
        assert_eq!(
            verified.identity().deploy_credential_id_sha256,
            DEPLOY_CREDENTIAL_ID_SHA256
        );
    }

    #[test]
    fn token_and_preflight_identity_drift_fail_closed() {
        assert_eq!(
            loaded_credentials()
                .prove_read_token_identity(
                    br#"{"result":{"id":"other-token-id","status":"active"},"success":true}"#
                )
                .err(),
            Some(CredentialError::CredentialIdentityMismatch("read"))
        );

        let read = loaded_credentials()
            .prove_read_token_identity(
                br#"{"result":{"id":"read-token-id","status":"active"},"success":true}"#,
            )
            .unwrap();
        assert_eq!(
            read.prove_deploy_token_identity(
                br#"{"result":{"id":"deploy-token-id","status":"disabled"},"success":true}"#
            )
            .err(),
            Some(CredentialError::CredentialIdentityRejected("deploy"))
        );

        let pending = valid_pending_preflight();
        let response = format!(
            "{{\"authorityVersionId\":\"drift\",\"credentialIdSha256\":\"{CLAIM_CREDENTIAL_ID_SHA256}\",\"permitSpkiSha256\":\"{PERMIT_SPKI_SHA256}\",\"requestId\":\"request-1\",\"result\":\"authority_ready\"}}"
        );
        assert_eq!(
            pending.verify_response(response.as_bytes()).err(),
            Some(CredentialError::AuthorityPreflightIdentityMismatch)
        );
    }

    #[test]
    fn duplicate_and_unknown_preflight_fields_are_rejected() {
        let duplicate = format!(
            "{{\"authorityVersionId\":\"{AUTHORITY_VERSION_ID}\",\"credentialIdSha256\":\"{CLAIM_CREDENTIAL_ID_SHA256}\",\"permitSpkiSha256\":\"{PERMIT_SPKI_SHA256}\",\"requestId\":\"request-1\",\"requestId\":\"request-1\",\"result\":\"authority_ready\"}}"
        );
        assert_eq!(
            valid_pending_preflight()
                .verify_response(duplicate.as_bytes())
                .err(),
            Some(CredentialError::InvalidJson("authority_preflight"))
        );

        let unknown = format!(
            "{{\"authorityVersionId\":\"{AUTHORITY_VERSION_ID}\",\"credentialIdSha256\":\"{CLAIM_CREDENTIAL_ID_SHA256}\",\"permitSpkiSha256\":\"{PERMIT_SPKI_SHA256}\",\"requestId\":\"request-1\",\"result\":\"authority_ready\",\"secret\":\"never\"}}"
        );
        assert_eq!(
            valid_pending_preflight()
                .verify_response(unknown.as_bytes())
                .err(),
            Some(CredentialError::InvalidJson("authority_preflight"))
        );
    }

    #[test]
    fn production_source_has_fixed_handles_zeroization_and_no_egress() {
        let production = include_str!("credentials.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        for handle in [
            ACCOUNT_ID_ENV,
            READ_TOKEN_ENV,
            CLAIM_HMAC_SECRET_ENV,
            DEPLOY_TOKEN_ENV,
        ] {
            assert_eq!(production.matches(handle).count(), 1);
        }
        assert!(production.contains("Zeroizing<Vec<u8>>"));
        for forbidden in [
            ["std::env::", "vars"].concat(),
            ["std::process", "::Command"].concat(),
            ["req", "west"].concat(),
            ["wran", "gler"].concat(),
            ["Tcp", "Stream"].concat(),
            ["Udp", "Socket"].concat(),
        ] {
            assert!(!production.contains(&forbidden));
        }
    }

    fn loaded_credentials() -> LoadedCredentials {
        load_from_source(
            publication_identity(),
            &fully_pinned_trust(),
            &mut FakeSource::valid(),
        )
        .unwrap()
    }

    fn valid_pending_preflight() -> PendingAuthorityPreflight {
        loaded_credentials()
            .prove_read_token_identity(
                br#"{"result":{"id":"read-token-id","status":"active"},"success":true}"#,
            )
            .unwrap()
            .prove_deploy_token_identity(
                br#"{"result":{"id":"deploy-token-id","status":"active"},"success":true}"#,
            )
            .unwrap()
            .begin_authority_preflight("request-1", 1_800_000_000)
            .unwrap()
    }

    fn fully_pinned_trust() -> EmbeddedCredentialTrust {
        EmbeddedCredentialTrust {
            enabled: true,
            authority_origin: Some(STAGING_AUTHORITY_ORIGIN),
            authority_version_id: Some(AUTHORITY_VERSION_ID),
            authority_issuer: Some("runner-staging"),
            authority_audience: Some("authority-staging"),
            authority_hmac_key_id: Some("current-v1"),
            permit_spki_sha256: Some(PERMIT_SPKI_SHA256),
            trust_config_sha256: Some(TRUST_CONFIG_SHA256),
            account_id_sha256: Some(ACCOUNT_ID_SHA256),
            read_credential_id_sha256: Some(READ_CREDENTIAL_ID_SHA256),
            claim_credential_id_sha256: Some(CLAIM_CREDENTIAL_ID_SHA256),
            deploy_credential_id_sha256: Some(DEPLOY_CREDENTIAL_ID_SHA256),
            ..EmbeddedCredentialTrust::checked_in()
        }
    }

    fn publication_identity() -> PublicationIdentity {
        PublicationIdentity {
            release: VerifiedRelease {
                source_commit: "1".repeat(40),
                git_tree_sha: "2".repeat(40),
                target_triple: "x86_64-pc-windows-msvc".to_owned(),
                manifest_sha256: "3".repeat(64),
                packet_sha256: "4".repeat(64),
                policy_sha256: "5".repeat(64),
                release_key_id: "release-v1".to_owned(),
                release_key_spki_base64url: "synthetic".to_owned(),
                release_key_spki_sha256: "6".repeat(64),
                artifact_file_name: "cinatoken-ring-transition-runner.exe".to_owned(),
                artifact_byte_length: 64,
                artifact_sha256: "7".repeat(64),
                module_inventory_sha256: "8".repeat(64),
                module_count: 20,
                module_bytes: 4096,
                authority_version_id: AUTHORITY_VERSION_ID.to_owned(),
                permit_spki_sha256: PERMIT_SPKI_SHA256.to_owned(),
                trust_config_sha256: TRUST_CONFIG_SHA256.to_owned(),
                issued_at: "2026-07-23T00:00:00.000Z".to_owned(),
                expires_at: "2026-07-24T00:00:00.000Z".to_owned(),
            },
            publication_manifest_sha256: "9".repeat(64),
            publication_packet_sha256: "a".repeat(64),
            generation_sha256: "b".repeat(64),
            publication_directory_name: format!("publication-{}", "9".repeat(64)),
            activation_sequence: 7,
            previous_publication_manifest_sha256: Some("c".repeat(64)),
            published_at: "2026-07-23T01:00:00.000Z".to_owned(),
            expires_at: "2026-07-24T00:00:00.000Z".to_owned(),
        }
    }

    struct FakeSource {
        values: BTreeMap<&'static str, String>,
        reads: Vec<&'static str>,
    }

    impl FakeSource {
        fn valid() -> Self {
            Self {
                values: BTreeMap::from([
                    (ACCOUNT_ID_ENV, ACCOUNT_ID.to_owned()),
                    (
                        READ_TOKEN_ENV,
                        "read-token-secret-0123456789abcdef".to_owned(),
                    ),
                    (CLAIM_HMAC_SECRET_ENV, CLAIM_SECRET.to_owned()),
                    (
                        DEPLOY_TOKEN_ENV,
                        "deploy-token-secret-0123456789abcdef".to_owned(),
                    ),
                ]),
                reads: Vec::new(),
            }
        }
    }

    impl FixedCredentialSource for FakeSource {
        fn take(&mut self, name: &'static str) -> Result<String, CredentialError> {
            self.reads.push(name);
            self.values
                .get(name)
                .cloned()
                .ok_or(CredentialError::MissingEnvironment(name))
        }
    }
}
