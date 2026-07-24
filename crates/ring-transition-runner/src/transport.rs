// Claim-resume and mutation methods are linked now but remain unreachable while trust is disabled.
#![allow(dead_code)]

use crate::credentials::{
    CredentialIdentity, DeployCredentialProven, LoadedCredentials, PendingAuthorityPreflight,
    ReadCredentialProven, ValidatedCredentialTrust, VerifiedCredentials, ACCESS_CLIENT_ID_ENV,
    ACCESS_CLIENT_SECRET_ENV, AUTHORITY_HEADER_NAME, AUTHORITY_PREFLIGHT_PATH,
    CLOUDFLARE_API_ORIGIN,
};
use crate::orchestrator::{
    self, AuthorityAppendAttempt, AuthorizedMutation, FreshIntentPermit, MutationPhase,
    VerifiedSnapshot,
};
use crate::release::{canonical_json, reject_duplicate_json, MAX_SAFE_INTEGER};
use crate::STAGING_AUTHORITY_ORIGIN;
use async_trait::async_trait;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use bytes::Bytes;
use hmac::{Hmac, Mac};
use http_body_util::{BodyExt, Full, LengthLimitError, Limited};
use hyper::header::{
    HeaderMap, HeaderName, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_ENCODING, CONTENT_LENGTH,
    CONTENT_TYPE,
};
use hyper::{Method, Request, Response, StatusCode, Uri};
#[cfg(not(windows))]
use hyper_rustls::{HttpsConnector as RustlsHttpsConnector, HttpsConnectorBuilder};
#[cfg(windows)]
use hyper_tls::HttpsConnector as NativeHttpsConnector;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fmt;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::time::Instant;
use zeroize::Zeroizing;

pub const ACCESS_CLIENT_ID_HEADER: &str = "cf-access-client-id";
pub const ACCESS_CLIENT_SECRET_HEADER: &str = "cf-access-client-secret";

const AUTHORITY_HMAC_DOMAIN: &[u8] = b"cinatoken-ring-transition-authority-v1\n";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const IDENTITY_RESPONSE_LIMIT: usize = 256 * 1024;
const CLOUDFLARE_RESPONSE_LIMIT: usize = 2 * 1024 * 1024;
const MAX_DEPLOYMENT_REQUEST_BYTES: usize = 256 * 1024;
const AUTHORITY_TOKEN_LIFETIME_SECONDS: u64 = 30;

#[cfg(not(windows))]
type ProductionConnector = RustlsHttpsConnector<HttpConnector>;
#[cfg(windows)]
type ProductionConnector = NativeHttpsConnector<HttpConnector>;
type ProductionHttpClient = Client<ProductionConnector, Full<Bytes>>;

pub struct PreparedControlPlane {
    core: ControlPlaneCore<HyperHttpsExchange>,
}

impl PreparedControlPlane {
    pub fn identity(&self) -> &CredentialIdentity {
        self.core.credentials.identity()
    }

    pub fn access_service_token_verified(&self) -> bool {
        true
    }

    pub(crate) async fn read_exact_claim(
        &self,
        authorization_id_sha256: &str,
        claim_digest_sha256: &str,
        claim_owner_sha256: &str,
    ) -> Result<VerifiedSnapshot, ControlPlaneError> {
        let now = system_time_seconds()?;
        let request_id = random_request_id()?;
        self.core
            .read_exact_claim_at(
                authorization_id_sha256,
                claim_digest_sha256,
                claim_owner_sha256,
                now,
                &request_id,
            )
            .await
    }

    pub(crate) async fn append_intent<P: MutationPhase>(
        &self,
        attempt: AuthorityAppendAttempt<P>,
    ) -> Result<FreshIntentPermit<P>, ControlPlaneError> {
        let now = system_time_seconds()?;
        self.core.append_intent_at(attempt, now).await
    }

    pub(crate) async fn deploy_once<P: MutationPhase>(
        &self,
        mutation: AuthorizedMutation<P>,
    ) -> MutationAttemptOutcome {
        let now = match system_time_seconds() {
            Ok(now) => now,
            Err(_) => return MutationAttemptOutcome::ambiguous(None, None, None),
        };
        self.core.deploy_once_at(mutation, now).await
    }
}

pub(crate) async fn verify_loaded_credentials(
    loaded: LoadedCredentials,
) -> Result<PreparedControlPlane, ControlPlaneError> {
    let exchange = HyperHttpsExchange::new()?;
    let now = system_time_seconds()?;
    let request_id = random_request_id()?;
    let core = ControlPlaneCore::verify(loaded, exchange, now, &request_id).await?;
    Ok(PreparedControlPlane { core })
}

struct ControlPlaneCore<E: HttpExchange> {
    credentials: VerifiedCredentials,
    exchange: E,
}

impl<E: HttpExchange> ControlPlaneCore<E> {
    async fn verify(
        loaded: LoadedCredentials,
        exchange: E,
        now: u64,
        request_id: &str,
    ) -> Result<Self, ControlPlaneError> {
        let credentials =
            verify_identity_proof_sequence(loaded, &exchange, now, request_id).await?;
        Ok(Self {
            credentials,
            exchange,
        })
    }

    async fn read_exact_claim_at(
        &self,
        authorization_id_sha256: &str,
        claim_digest_sha256: &str,
        claim_owner_sha256: &str,
        now: u64,
        request_id: &str,
    ) -> Result<VerifiedSnapshot, ControlPlaneError> {
        for (field, value) in [
            ("authorization_id_sha256", authorization_id_sha256),
            ("claim_digest_sha256", claim_digest_sha256),
            ("claim_owner_sha256", claim_owner_sha256),
        ] {
            require_sha256(value, field)?;
        }
        require_request_id(request_id)?;
        let path_and_query = format!(
            "/internal/v1/ring-transition/claims/{authorization_id_sha256}?claimDigestSha256={claim_digest_sha256}&claimOwnerSha256={claim_owner_sha256}"
        );
        let request = authority_request(
            &self.credentials,
            Method::GET,
            &path_and_query,
            Bytes::new(),
            request_id,
            now,
        )?;
        let response = self
            .exchange
            .send(request, IDENTITY_RESPONSE_LIMIT, REQUEST_TIMEOUT)
            .await
            .map_err(|_| ControlPlaneError::Exchange)?;
        if response.status != StatusCode::OK {
            return Err(ControlPlaneError::AuthorityRejected);
        }
        verify_exact_claim_response(
            &response.body,
            request_id,
            authorization_id_sha256,
            claim_digest_sha256,
            claim_owner_sha256,
            self.credentials.identity(),
        )
    }

    async fn append_intent_at<P: MutationPhase>(
        &self,
        attempt: AuthorityAppendAttempt<P>,
        now: u64,
    ) -> Result<FreshIntentPermit<P>, ControlPlaneError> {
        let path = format!(
            "/internal/v1/ring-transition/claims/{}/steps",
            attempt.authorization_id_sha256()
        );
        let request_id = attempt.request_id().to_owned();
        let body = attempt
            .canonical_step_json()
            .map_err(ControlPlaneError::Orchestrator)?
            .into_bytes();
        let request = authority_request(
            &self.credentials,
            Method::POST,
            &path,
            Bytes::from(body),
            &request_id,
            now,
        )?;
        let response = self
            .exchange
            .send(request, IDENTITY_RESPONSE_LIMIT, REQUEST_TIMEOUT)
            .await
            .map_err(|_| ControlPlaneError::AuthorityMutationAmbiguous)?;
        if response.status != StatusCode::CREATED && response.status != StatusCode::OK {
            return Err(ControlPlaneError::AuthorityMutationRejected);
        }
        orchestrator::verify_fresh_append(
            attempt,
            &response.body,
            &self.credentials.identity().authority_version_id,
        )
        .map_err(ControlPlaneError::Orchestrator)
    }

    async fn deploy_once_at<P: MutationPhase>(
        &self,
        mutation: AuthorizedMutation<P>,
        now: u64,
    ) -> MutationAttemptOutcome {
        deploy_authorized_once(
            &self.exchange,
            self.credentials.identity(),
            self.credentials.account_id(),
            self.credentials.deploy_token(),
            mutation,
            now,
        )
        .await
    }
}

trait IdentityProofMachine: Sized {
    type Read;
    type Deploy;
    type Pending;
    type Verified;

    fn account_id(&self) -> &str;
    fn read_token(&self) -> &str;
    fn prove_read(self, response: &[u8]) -> Result<Self::Read, ControlPlaneError>;
    fn proven_account_id(read: &Self::Read) -> &str;
    fn deploy_token(read: &Self::Read) -> &str;
    fn prove_deploy(read: Self::Read, response: &[u8]) -> Result<Self::Deploy, ControlPlaneError>;
    fn begin_preflight(
        deploy: Self::Deploy,
        request_id: &str,
        now: u64,
    ) -> Result<Self::Pending, ControlPlaneError>;
    fn authority_token(pending: &Self::Pending) -> &str;
    fn access_client_id(pending: &Self::Pending) -> &str;
    fn access_client_secret(pending: &Self::Pending) -> &str;
    fn prove_preflight(
        pending: Self::Pending,
        response: &[u8],
    ) -> Result<Self::Verified, ControlPlaneError>;
}

impl IdentityProofMachine for LoadedCredentials {
    type Read = ReadCredentialProven;
    type Deploy = DeployCredentialProven;
    type Pending = PendingAuthorityPreflight;
    type Verified = VerifiedCredentials;

    fn account_id(&self) -> &str {
        self.account_id()
    }

    fn read_token(&self) -> &str {
        self.read_token()
    }

    fn prove_read(self, response: &[u8]) -> Result<Self::Read, ControlPlaneError> {
        self.prove_read_token_identity(response)
            .map_err(ControlPlaneError::Credential)
    }

    fn proven_account_id(read: &Self::Read) -> &str {
        read.account_id()
    }

    fn deploy_token(read: &Self::Read) -> &str {
        read.deploy_token()
    }

    fn prove_deploy(read: Self::Read, response: &[u8]) -> Result<Self::Deploy, ControlPlaneError> {
        read.prove_deploy_token_identity(response)
            .map_err(ControlPlaneError::Credential)
    }

    fn begin_preflight(
        deploy: Self::Deploy,
        request_id: &str,
        now: u64,
    ) -> Result<Self::Pending, ControlPlaneError> {
        deploy
            .begin_authority_preflight(request_id, now)
            .map_err(ControlPlaneError::Credential)
    }

    fn authority_token(pending: &Self::Pending) -> &str {
        pending.authority_token()
    }

    fn access_client_id(pending: &Self::Pending) -> &str {
        pending.access_client_id()
    }

    fn access_client_secret(pending: &Self::Pending) -> &str {
        pending.access_client_secret()
    }

    fn prove_preflight(
        pending: Self::Pending,
        response: &[u8],
    ) -> Result<Self::Verified, ControlPlaneError> {
        pending
            .verify_response(response)
            .map_err(ControlPlaneError::Credential)
    }
}

async fn verify_identity_proof_sequence<M: IdentityProofMachine, E: HttpExchange>(
    machine: M,
    exchange: &E,
    now: u64,
    request_id: &str,
) -> Result<M::Verified, ControlPlaneError> {
    let read_response =
        verify_cloudflare_token(exchange, machine.account_id(), machine.read_token(), "read")
            .await?;
    let read = machine.prove_read(&read_response)?;
    let deploy_response = verify_cloudflare_token(
        exchange,
        M::proven_account_id(&read),
        M::deploy_token(&read),
        "deploy",
    )
    .await?;
    let deploy = M::prove_deploy(read, &deploy_response)?;
    let pending = M::begin_preflight(deploy, request_id, now)?;
    let response = send_authority_preflight(
        exchange,
        M::authority_token(&pending),
        M::access_client_id(&pending),
        M::access_client_secret(&pending),
    )
    .await?;
    M::prove_preflight(pending, &response)
}

fn verify_exact_claim_response(
    response_body: &[u8],
    request_id: &str,
    authorization_id_sha256: &str,
    claim_digest_sha256: &str,
    claim_owner_sha256: &str,
    identity: &CredentialIdentity,
) -> Result<VerifiedSnapshot, ControlPlaneError> {
    reject_duplicate_json(response_body, IDENTITY_RESPONSE_LIMIT)
        .map_err(|_| ControlPlaneError::InvalidAuthorityResponse)?;
    let envelope: ExactClaimResponse = serde_json::from_slice(response_body)
        .map_err(|_| ControlPlaneError::InvalidAuthorityResponse)?;
    if envelope.result != "exact_claim"
        || envelope.request_id != request_id
        || envelope.authority_version_id != identity.authority_version_id
    {
        return Err(ControlPlaneError::AuthorityIdentityMismatch);
    }
    let snapshot_json = canonical_json(&envelope.snapshot)
        .map_err(|_| ControlPlaneError::InvalidAuthorityResponse)?;
    let snapshot = VerifiedSnapshot::from_json(snapshot_json.as_bytes())
        .map_err(ControlPlaneError::Orchestrator)?;
    if snapshot.authorization_id_sha256() != authorization_id_sha256
        || snapshot.claim_digest_sha256() != claim_digest_sha256
        || snapshot.claim_owner_sha256() != claim_owner_sha256
        || !snapshot_matches_identity(&snapshot, identity)
    {
        return Err(ControlPlaneError::ClaimIdentityMismatch);
    }
    Ok(snapshot)
}

async fn deploy_authorized_once<E: HttpExchange, P: MutationPhase>(
    exchange: &E,
    identity: &CredentialIdentity,
    account_id: &str,
    deploy_token: &str,
    mutation: AuthorizedMutation<P>,
    now: u64,
) -> MutationAttemptOutcome {
    if now < mutation.generated_at() || now >= mutation.expires_at() {
        return MutationAttemptOutcome::ambiguous(None, None, None);
    }
    if mutation.service_name() != identity.controller_service_name
        && mutation.service_name() != identity.edge_service_name
    {
        return MutationAttemptOutcome::ambiguous(None, None, None);
    }
    let service_name = mutation.service_name().to_owned();
    let expected_digest = mutation.mutation_request_sha256().to_owned();
    let request = mutation.into_request();
    if request.body().len() > MAX_DEPLOYMENT_REQUEST_BYTES
        || sha256_hex(request.body()) != expected_digest
    {
        return MutationAttemptOutcome::ambiguous(None, None, None);
    }
    let uri = match cloudflare_uri(&format!(
        "/client/v4/accounts/{account_id}/workers/scripts/{service_name}/deployments"
    )) {
        Ok(uri) => uri,
        Err(_) => return MutationAttemptOutcome::ambiguous(None, None, None),
    };
    let request = match Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/json")
        .header(
            AUTHORIZATION,
            match bearer_header(deploy_token) {
                Ok(value) => value,
                Err(_) => return MutationAttemptOutcome::ambiguous(None, None, None),
            },
        )
        .body(Full::new(Bytes::copy_from_slice(request.body())))
    {
        Ok(request) => request,
        Err(_) => return MutationAttemptOutcome::ambiguous(None, None, None),
    };
    let response = match exchange
        .send(request, CLOUDFLARE_RESPONSE_LIMIT, REQUEST_TIMEOUT)
        .await
    {
        Ok(response) => response,
        Err(_) => return MutationAttemptOutcome::ambiguous(None, None, None),
    };
    classify_deployment_response(response)
}

fn snapshot_matches_identity(snapshot: &VerifiedSnapshot, identity: &CredentialIdentity) -> bool {
    snapshot.account_id_sha256() == identity.account_id_sha256
        && snapshot.read_credential_id_sha256() == identity.read_credential_id_sha256
        && snapshot.claim_credential_id_sha256() == identity.claim_credential_id_sha256
        && snapshot.deploy_credential_id_sha256() == identity.deploy_credential_id_sha256
        && snapshot.runner_build_sha256() == identity.runner_build_sha256
        && snapshot.runner_trust_config_sha256() == identity.trust_config_sha256
        && snapshot.controller_service_name() == identity.controller_service_name
        && snapshot.edge_service_name() == identity.edge_service_name
}

async fn verify_cloudflare_token<E: HttpExchange>(
    exchange: &E,
    account_id: &str,
    token: &str,
    class: &'static str,
) -> Result<Bytes, ControlPlaneError> {
    let uri = cloudflare_uri(&format!("/client/v4/accounts/{account_id}/tokens/verify"))?;
    let request = Request::builder()
        .method(Method::GET)
        .uri(uri)
        .header(ACCEPT, "application/json")
        .header(AUTHORIZATION, bearer_header(token)?)
        .body(Full::new(Bytes::new()))
        .map_err(|_| ControlPlaneError::InvalidRequest("cloudflare_token_verify"))?;
    let response = exchange
        .send(request, IDENTITY_RESPONSE_LIMIT, REQUEST_TIMEOUT)
        .await
        .map_err(|_| ControlPlaneError::Exchange)?;
    if response.status != StatusCode::OK {
        return Err(ControlPlaneError::CredentialIdentityRejected(class));
    }
    Ok(response.body)
}

async fn send_authority_preflight<E: HttpExchange>(
    exchange: &E,
    authority_token: &str,
    access_client_id: &str,
    access_client_secret: &str,
) -> Result<Bytes, ControlPlaneError> {
    let uri = authority_uri(AUTHORITY_PREFLIGHT_PATH)?;
    let request = Request::builder()
        .method(Method::GET)
        .uri(uri)
        .header(ACCEPT, "application/json")
        .header(
            HeaderName::from_static(AUTHORITY_HEADER_NAME),
            secret_header(authority_token, "authority_token")?,
        )
        .header(
            HeaderName::from_static(ACCESS_CLIENT_ID_HEADER),
            secret_header(access_client_id, ACCESS_CLIENT_ID_ENV)?,
        )
        .header(
            HeaderName::from_static(ACCESS_CLIENT_SECRET_HEADER),
            secret_header(access_client_secret, ACCESS_CLIENT_SECRET_ENV)?,
        )
        .body(Full::new(Bytes::new()))
        .map_err(|_| ControlPlaneError::InvalidRequest("authority_preflight"))?;
    let response = exchange
        .send(request, IDENTITY_RESPONSE_LIMIT, REQUEST_TIMEOUT)
        .await
        .map_err(|_| ControlPlaneError::Exchange)?;
    if response.status != StatusCode::OK {
        return Err(ControlPlaneError::AuthorityRejected);
    }
    Ok(response.body)
}

fn authority_request(
    credentials: &VerifiedCredentials,
    method: Method,
    path_and_query: &str,
    body: Bytes,
    request_id: &str,
    now: u64,
) -> Result<Request<Full<Bytes>>, ControlPlaneError> {
    let uri = authority_uri(path_and_query)?;
    let token = create_authority_token(
        credentials.trust(),
        credentials.claim_hmac_secret(),
        &method,
        path_and_query,
        &body,
        request_id,
        now,
    )?;
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header(ACCEPT, "application/json")
        .header(
            HeaderName::from_static(AUTHORITY_HEADER_NAME),
            secret_header(&token, "authority_token")?,
        )
        .header(
            HeaderName::from_static(ACCESS_CLIENT_ID_HEADER),
            secret_header(credentials.access_client_id(), ACCESS_CLIENT_ID_ENV)?,
        )
        .header(
            HeaderName::from_static(ACCESS_CLIENT_SECRET_HEADER),
            secret_header(credentials.access_client_secret(), ACCESS_CLIENT_SECRET_ENV)?,
        );
    if !body.is_empty() {
        builder = builder.header(CONTENT_TYPE, "application/json");
    }
    builder
        .body(Full::new(body))
        .map_err(|_| ControlPlaneError::InvalidRequest("authority_request"))
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
    method: &'a str,
    path_and_query: &'a str,
    request_id: &'a str,
}

fn create_authority_token(
    trust: ValidatedCredentialTrust,
    secret: &str,
    method: &Method,
    path_and_query: &str,
    body: &[u8],
    request_id: &str,
    now: u64,
) -> Result<Zeroizing<String>, ControlPlaneError> {
    require_request_id(request_id)?;
    if now == 0 || now > MAX_SAFE_INTEGER - AUTHORITY_TOKEN_LIFETIME_SECONDS {
        return Err(ControlPlaneError::InvalidRequest("authority_time"));
    }
    let method = method.as_str();
    if !matches!(method, "GET" | "POST")
        || !path_and_query.starts_with("/internal/v1/ring-transition/")
        || path_and_query.contains('#')
        || path_and_query.contains('\r')
        || path_and_query.contains('\n')
    {
        return Err(ControlPlaneError::InvalidRequest("authority_target"));
    }
    let header = canonical_json(&AuthorityTokenHeader {
        alg: "HS256",
        kid: trust.authority_hmac_key_id,
        typ: "CINATOKEN-RING-AUTHORITY",
    })
    .map_err(|_| ControlPlaneError::InvalidRequest("authority_header"))?;
    let claims = canonical_json(&AuthorityTokenClaims {
        audience: trust.authority_audience,
        body_sha256: sha256_hex(body),
        credential_id_sha256: trust.claim_credential_id_sha256,
        expires_at: now + AUTHORITY_TOKEN_LIFETIME_SECONDS,
        issued_at: now,
        issuer: trust.authority_issuer,
        method,
        path_and_query,
        request_id,
    })
    .map_err(|_| ControlPlaneError::InvalidRequest("authority_claims"))?;
    let header_part = URL_SAFE_NO_PAD.encode(header.as_bytes());
    let claims_part = URL_SAFE_NO_PAD.encode(claims.as_bytes());
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
        .map_err(|_| ControlPlaneError::InvalidRequest("authority_secret"))?;
    mac.update(AUTHORITY_HMAC_DOMAIN);
    mac.update(header_part.as_bytes());
    mac.update(b".");
    mac.update(claims_part.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    Ok(Zeroizing::new(format!(
        "{header_part}.{claims_part}.{signature}"
    )))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExactClaimResponse {
    result: String,
    request_id: String,
    snapshot: Value,
    authority_version_id: String,
}

struct BoundedHttpResponse {
    status: StatusCode,
    headers: HeaderMap,
    body: Bytes,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ExchangeError {
    Timeout,
    Connection,
    InvalidContentLength,
    ResponseTooLarge,
    EncodedResponse,
    InvalidContentType,
}

#[async_trait]
trait HttpExchange: Send + Sync {
    async fn send(
        &self,
        request: Request<Full<Bytes>>,
        maximum_response_bytes: usize,
        timeout: Duration,
    ) -> Result<BoundedHttpResponse, ExchangeError>;
}

struct HyperHttpsExchange {
    client: ProductionHttpClient,
}

impl HyperHttpsExchange {
    fn new() -> Result<Self, ControlPlaneError> {
        #[cfg(not(windows))]
        let connector = HttpsConnectorBuilder::new()
            .with_webpki_roots()
            .https_only()
            .enable_http1()
            .build();
        #[cfg(windows)]
        let connector = {
            let mut http = HttpConnector::new();
            http.enforce_http(false);
            let tls = native_tls::TlsConnector::builder()
                .min_protocol_version(Some(native_tls::Protocol::Tlsv12))
                .build()
                .map_err(|_| ControlPlaneError::TlsUnavailable)?;
            let mut connector = NativeHttpsConnector::from((http, tls.into()));
            connector.https_only(true);
            connector
        };
        let mut builder = Client::builder(TokioExecutor::new());
        builder.retry_canceled_requests(false);
        builder.pool_max_idle_per_host(0);
        Ok(Self {
            client: builder.build(connector),
        })
    }
}

#[async_trait]
impl HttpExchange for HyperHttpsExchange {
    async fn send(
        &self,
        request: Request<Full<Bytes>>,
        maximum_response_bytes: usize,
        timeout: Duration,
    ) -> Result<BoundedHttpResponse, ExchangeError> {
        let deadline = Instant::now() + timeout;
        let response = tokio::time::timeout_at(deadline, self.client.request(request))
            .await
            .map_err(|_| ExchangeError::Timeout)?
            .map_err(|_| ExchangeError::Connection)?;
        collect_bounded_response(response, maximum_response_bytes, deadline).await
    }
}

async fn collect_bounded_response(
    response: Response<hyper::body::Incoming>,
    maximum_response_bytes: usize,
    deadline: Instant,
) -> Result<BoundedHttpResponse, ExchangeError> {
    if response.headers().contains_key(CONTENT_ENCODING) {
        return Err(ExchangeError::EncodedResponse);
    }
    if let Some(length) = response.headers().get(CONTENT_LENGTH) {
        let length = length
            .to_str()
            .map_err(|_| ExchangeError::InvalidContentLength)?
            .parse::<usize>()
            .map_err(|_| ExchangeError::InvalidContentLength)?;
        if length > maximum_response_bytes {
            return Err(ExchangeError::ResponseTooLarge);
        }
    }
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !is_json_content_type(content_type) {
        return Err(ExchangeError::InvalidContentType);
    }
    let status = response.status();
    let headers = response.headers().clone();
    let limited = Limited::new(response.into_body(), maximum_response_bytes);
    let body = tokio::time::timeout_at(deadline, limited.collect())
        .await
        .map_err(|_| ExchangeError::Timeout)?
        .map_err(|error| {
            if error.downcast_ref::<LengthLimitError>().is_some() {
                ExchangeError::ResponseTooLarge
            } else {
                ExchangeError::Connection
            }
        })?
        .to_bytes();
    Ok(BoundedHttpResponse {
        status,
        headers,
        body,
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MutationTransportOutcome {
    Success,
    Rejected,
    Ambiguous,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationAttemptOutcome {
    pub transport_outcome: MutationTransportOutcome,
    pub http_status: Option<u16>,
    pub response_body_sha256: Option<String>,
    pub response_id_sha256: Option<String>,
    pub error_codes: Vec<u64>,
    pub retry: bool,
}

impl MutationAttemptOutcome {
    fn ambiguous(
        status: Option<u16>,
        response_body_sha256: Option<String>,
        response_id_sha256: Option<String>,
    ) -> Self {
        Self {
            transport_outcome: MutationTransportOutcome::Ambiguous,
            http_status: status,
            response_body_sha256,
            response_id_sha256,
            error_codes: Vec::new(),
            retry: false,
        }
    }
}

fn classify_deployment_response(response: BoundedHttpResponse) -> MutationAttemptOutcome {
    let status = response.status.as_u16();
    let response_body_sha256 = Some(sha256_hex(&response.body));
    let response_id_sha256 = response_identity_sha256(&response.headers);
    let payload = reject_duplicate_json(&response.body, CLOUDFLARE_RESPONSE_LIMIT)
        .ok()
        .and_then(|_| serde_json::from_slice::<Value>(&response.body).ok());
    if response.status.is_success() {
        if payload
            .as_ref()
            .and_then(Value::as_object)
            .and_then(|value| value.get("success"))
            .and_then(Value::as_bool)
            == Some(true)
        {
            return MutationAttemptOutcome {
                transport_outcome: MutationTransportOutcome::Success,
                http_status: Some(status),
                response_body_sha256,
                response_id_sha256,
                error_codes: Vec::new(),
                retry: false,
            };
        }
        return MutationAttemptOutcome::ambiguous(
            Some(status),
            response_body_sha256,
            response_id_sha256,
        );
    }
    let error_codes = payload
        .as_ref()
        .map(cloudflare_error_codes)
        .unwrap_or_default();
    if response.status.is_client_error()
        && !matches!(
            response.status,
            StatusCode::REQUEST_TIMEOUT | StatusCode::TOO_EARLY
        )
        && response.status != StatusCode::TOO_MANY_REQUESTS
        && !error_codes.is_empty()
    {
        return MutationAttemptOutcome {
            transport_outcome: MutationTransportOutcome::Rejected,
            http_status: Some(status),
            response_body_sha256,
            response_id_sha256,
            error_codes,
            retry: false,
        };
    }
    MutationAttemptOutcome::ambiguous(Some(status), response_body_sha256, response_id_sha256)
}

fn cloudflare_error_codes(payload: &Value) -> Vec<u64> {
    let mut codes = payload
        .as_object()
        .and_then(|value| value.get("errors"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            entry
                .as_object()
                .and_then(|entry| entry.get("code"))
                .and_then(Value::as_u64)
        })
        .take(16)
        .collect::<Vec<_>>();
    codes.sort_unstable();
    codes.dedup();
    codes
}

fn response_identity_sha256(headers: &HeaderMap) -> Option<String> {
    for name in ["cf-ray", "cf-request-id"] {
        if let Some(value) = headers.get(name).and_then(|value| value.to_str().ok()) {
            if !value.is_empty()
                && value.len() <= 256
                && value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
            {
                return Some(sha256_hex(value.as_bytes()));
            }
        }
    }
    None
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ControlPlaneError {
    ClockUnavailable,
    RandomUnavailable,
    TlsUnavailable,
    Credential(crate::credentials::CredentialError),
    Orchestrator(orchestrator::OrchestratorError),
    Exchange,
    InvalidRequest(&'static str),
    CredentialIdentityRejected(&'static str),
    AuthorityRejected,
    AuthorityIdentityMismatch,
    InvalidAuthorityResponse,
    ClaimIdentityMismatch,
    AuthorityMutationRejected,
    AuthorityMutationAmbiguous,
}

impl fmt::Display for ControlPlaneError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ClockUnavailable => formatter.write_str("runner clock is unavailable"),
            Self::RandomUnavailable => {
                formatter.write_str("cryptographic request ID source is unavailable")
            }
            Self::TlsUnavailable => formatter.write_str("TLS client initialization failed"),
            Self::Credential(error) => error.fmt(formatter),
            Self::Orchestrator(error) => error.fmt(formatter),
            Self::Exchange => formatter.write_str("bounded control-plane request failed"),
            Self::InvalidRequest(field) => {
                write!(formatter, "control-plane request is invalid: {field}")
            }
            Self::CredentialIdentityRejected(class) => {
                write!(
                    formatter,
                    "{class} credential identity request was rejected"
                )
            }
            Self::AuthorityRejected => formatter.write_str("Authority request was rejected"),
            Self::AuthorityIdentityMismatch => {
                formatter.write_str("Authority response identity mismatch")
            }
            Self::InvalidAuthorityResponse => formatter.write_str("Authority response is invalid"),
            Self::ClaimIdentityMismatch => {
                formatter.write_str("Authority claim does not match activated identities")
            }
            Self::AuthorityMutationRejected => {
                formatter.write_str("Authority mutation was rejected")
            }
            Self::AuthorityMutationAmbiguous => {
                formatter.write_str("Authority mutation outcome is ambiguous")
            }
        }
    }
}

impl std::error::Error for ControlPlaneError {}

fn bearer_header(secret: &str) -> Result<HeaderValue, ControlPlaneError> {
    let mut bytes = Zeroizing::new(Vec::with_capacity(7 + secret.len()));
    bytes.extend_from_slice(b"Bearer ");
    bytes.extend_from_slice(secret.as_bytes());
    HeaderValue::from_bytes(&bytes)
        .map_err(|_| ControlPlaneError::InvalidRequest("authorization_header"))
}

fn secret_header(secret: &str, field: &'static str) -> Result<HeaderValue, ControlPlaneError> {
    HeaderValue::from_bytes(secret.as_bytes()).map_err(|_| ControlPlaneError::InvalidRequest(field))
}

fn cloudflare_uri(path: &str) -> Result<Uri, ControlPlaneError> {
    fixed_uri(CLOUDFLARE_API_ORIGIN, path, "cloudflare_uri")
}

fn authority_uri(path_and_query: &str) -> Result<Uri, ControlPlaneError> {
    fixed_uri(STAGING_AUTHORITY_ORIGIN, path_and_query, "authority_uri")
}

fn fixed_uri(
    origin: &str,
    path_and_query: &str,
    field: &'static str,
) -> Result<Uri, ControlPlaneError> {
    if !path_and_query.starts_with('/')
        || path_and_query.contains('#')
        || path_and_query.contains('\r')
        || path_and_query.contains('\n')
    {
        return Err(ControlPlaneError::InvalidRequest(field));
    }
    format!("{origin}{path_and_query}")
        .parse()
        .map_err(|_| ControlPlaneError::InvalidRequest(field))
}

fn require_request_id(value: &str) -> Result<(), ControlPlaneError> {
    if value.is_empty()
        || value.len() > 128
        || !value.is_ascii()
        || !value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b':' | b'-'))
        })
    {
        return Err(ControlPlaneError::InvalidRequest("request_id"));
    }
    Ok(())
}

fn require_sha256(value: &str, field: &'static str) -> Result<(), ControlPlaneError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ControlPlaneError::InvalidRequest(field));
    }
    Ok(())
}

fn random_request_id() -> Result<String, ControlPlaneError> {
    let mut bytes = [0_u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|_| ControlPlaneError::RandomUnavailable)?;
    Ok(hex_lower(&bytes))
}

fn system_time_seconds() -> Result<u64, ControlPlaneError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ControlPlaneError::ClockUnavailable)
        .map(|duration| duration.as_secs())
}

fn is_json_content_type(value: &str) -> bool {
    let essence = value.split(';').next().unwrap_or_default().trim();
    let Some((kind, subtype)) = essence.split_once('/') else {
        return false;
    };
    kind.eq_ignore_ascii_case("application")
        && (subtype.eq_ignore_ascii_case("json") || subtype.to_ascii_lowercase().ends_with("+json"))
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex_lower(&Sha256::digest(bytes))
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut output, "{byte:02x}").expect("writing to a String cannot fail");
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::{
        authorize_mutation, begin_authority_append, plan_controller_deployment,
        prepare_controller_intent, verify_fresh_append, ControllerMutation,
    };
    use std::collections::VecDeque;
    use std::io::{Read, Write};
    use std::net::{Shutdown, TcpListener};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Instant as StdInstant;

    const NOW: u64 = 1_784_800_000;
    const ACCOUNT_ID: &str = "0123456789abcdef0123456789abcdef";
    const READ_TOKEN: &str = "read-token-secret-material-00000001";
    const DEPLOY_TOKEN: &str = "deploy-token-secret-material-00001";
    const AUTHORITY_TOKEN: &str = "authority-token-secret-material-001";
    const ACCESS_CLIENT_ID: &str = "access-client-id-secret-material-01";
    const ACCESS_CLIENT_SECRET: &str = "access-client-secret-material-0001";
    const EVIDENCE_DIGEST: &str =
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    struct ObservedRequest {
        method: Method,
        uri: String,
        headers: HeaderMap,
        body: Bytes,
        maximum_response_bytes: usize,
        timeout: Duration,
    }

    #[derive(Clone)]
    struct ScriptedExchange {
        responses: Arc<Mutex<VecDeque<Result<BoundedHttpResponse, ExchangeError>>>>,
        observed: Arc<Mutex<Vec<ObservedRequest>>>,
    }

    impl ScriptedExchange {
        fn new(responses: Vec<Result<BoundedHttpResponse, ExchangeError>>) -> Self {
            Self {
                responses: Arc::new(Mutex::new(responses.into())),
                observed: Arc::new(Mutex::new(Vec::new())),
            }
        }

        fn observed(&self) -> std::sync::MutexGuard<'_, Vec<ObservedRequest>> {
            self.observed.lock().expect("observed request lock")
        }

        fn remaining(&self) -> usize {
            self.responses.lock().expect("response script lock").len()
        }
    }

    #[async_trait]
    impl HttpExchange for ScriptedExchange {
        async fn send(
            &self,
            request: Request<Full<Bytes>>,
            maximum_response_bytes: usize,
            timeout: Duration,
        ) -> Result<BoundedHttpResponse, ExchangeError> {
            let (parts, body) = request.into_parts();
            let body = body
                .collect()
                .await
                .expect("Full request bodies are infallible")
                .to_bytes();
            self.observed
                .lock()
                .expect("observed request lock")
                .push(ObservedRequest {
                    method: parts.method,
                    uri: parts.uri.to_string(),
                    headers: parts.headers,
                    body,
                    maximum_response_bytes,
                    timeout,
                });
            self.responses
                .lock()
                .expect("response script lock")
                .pop_front()
                .expect("unexpected control-plane request")
        }
    }

    fn scripted_json(status: StatusCode, body: Value) -> BoundedHttpResponse {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        BoundedHttpResponse {
            status,
            headers,
            body: Bytes::from(canonical_json(&body).expect("canonical response JSON")),
        }
    }

    struct FakeIdentityMachine;
    struct FakeRead;
    struct FakeDeploy;
    struct FakePending;

    impl IdentityProofMachine for FakeIdentityMachine {
        type Read = FakeRead;
        type Deploy = FakeDeploy;
        type Pending = FakePending;
        type Verified = ();

        fn account_id(&self) -> &str {
            ACCOUNT_ID
        }

        fn read_token(&self) -> &str {
            READ_TOKEN
        }

        fn prove_read(self, response: &[u8]) -> Result<Self::Read, ControlPlaneError> {
            if response == b"read-identity-proven" {
                Ok(FakeRead)
            } else {
                Err(ControlPlaneError::CredentialIdentityRejected("read"))
            }
        }

        fn proven_account_id(_: &Self::Read) -> &str {
            ACCOUNT_ID
        }

        fn deploy_token(_: &Self::Read) -> &str {
            DEPLOY_TOKEN
        }

        fn prove_deploy(_: Self::Read, response: &[u8]) -> Result<Self::Deploy, ControlPlaneError> {
            if response == b"deploy-identity-proven" {
                Ok(FakeDeploy)
            } else {
                Err(ControlPlaneError::CredentialIdentityRejected("deploy"))
            }
        }

        fn begin_preflight(
            _: Self::Deploy,
            request_id: &str,
            now: u64,
        ) -> Result<Self::Pending, ControlPlaneError> {
            if request_id == "request-identity-001" && now == NOW {
                Ok(FakePending)
            } else {
                Err(ControlPlaneError::InvalidRequest("preflight_fixture"))
            }
        }

        fn authority_token(_: &Self::Pending) -> &str {
            AUTHORITY_TOKEN
        }

        fn access_client_id(_: &Self::Pending) -> &str {
            ACCESS_CLIENT_ID
        }

        fn access_client_secret(_: &Self::Pending) -> &str {
            ACCESS_CLIENT_SECRET
        }

        fn prove_preflight(
            _: Self::Pending,
            response: &[u8],
        ) -> Result<Self::Verified, ControlPlaneError> {
            if response == b"authority-preflight-proven" {
                Ok(())
            } else {
                Err(ControlPlaneError::AuthorityIdentityMismatch)
            }
        }
    }

    #[tokio::test]
    async fn identity_proofs_are_strictly_read_then_deploy_then_authority() {
        let exchange = ScriptedExchange::new(vec![
            Ok(BoundedHttpResponse {
                status: StatusCode::OK,
                headers: HeaderMap::new(),
                body: Bytes::from_static(b"read-identity-proven"),
            }),
            Ok(BoundedHttpResponse {
                status: StatusCode::OK,
                headers: HeaderMap::new(),
                body: Bytes::from_static(b"deploy-identity-proven"),
            }),
            Ok(BoundedHttpResponse {
                status: StatusCode::OK,
                headers: HeaderMap::new(),
                body: Bytes::from_static(b"authority-preflight-proven"),
            }),
        ]);

        verify_identity_proof_sequence(FakeIdentityMachine, &exchange, NOW, "request-identity-001")
            .await
            .expect("ordered identity proof sequence");

        assert_eq!(exchange.remaining(), 0);
        let observed = exchange.observed();
        assert_eq!(observed.len(), 3);
        assert_eq!(observed[0].method, Method::GET);
        assert_eq!(
            observed[0].uri,
            format!("{CLOUDFLARE_API_ORIGIN}/client/v4/accounts/{ACCOUNT_ID}/tokens/verify")
        );
        assert_eq!(
            observed[0].headers.get(AUTHORIZATION),
            Some(&HeaderValue::from_static(
                "Bearer read-token-secret-material-00000001"
            ))
        );
        assert_authority_headers_absent(&observed[0].headers);

        assert_eq!(observed[1].method, Method::GET);
        assert_eq!(observed[1].uri, observed[0].uri);
        assert_eq!(
            observed[1].headers.get(AUTHORIZATION),
            Some(&HeaderValue::from_static(
                "Bearer deploy-token-secret-material-00001"
            ))
        );
        assert_authority_headers_absent(&observed[1].headers);

        assert_eq!(observed[2].method, Method::GET);
        assert_eq!(
            observed[2].uri,
            format!("{STAGING_AUTHORITY_ORIGIN}{AUTHORITY_PREFLIGHT_PATH}")
        );
        assert!(observed[2].headers.get(AUTHORIZATION).is_none());
        assert_eq!(
            observed[2]
                .headers
                .get(HeaderName::from_static(AUTHORITY_HEADER_NAME)),
            Some(&HeaderValue::from_static(
                "authority-token-secret-material-001"
            ))
        );
        assert_eq!(
            observed[2]
                .headers
                .get(HeaderName::from_static(ACCESS_CLIENT_ID_HEADER)),
            Some(&HeaderValue::from_static(
                "access-client-id-secret-material-01"
            ))
        );
        assert_eq!(
            observed[2]
                .headers
                .get(HeaderName::from_static(ACCESS_CLIENT_SECRET_HEADER)),
            Some(&HeaderValue::from_static(
                "access-client-secret-material-0001"
            ))
        );
        assert!(observed.iter().all(|request| request.body.is_empty()));
        assert!(observed
            .iter()
            .all(|request| request.maximum_response_bytes == IDENTITY_RESPONSE_LIMIT));
        assert!(observed
            .iter()
            .all(|request| request.timeout == REQUEST_TIMEOUT));
    }

    #[test]
    fn exact_claim_rejects_identity_and_claim_drift() {
        let snapshot = t1_snapshot_value();
        let verified = verified_snapshot(&snapshot);
        let identity = matching_identity();
        let response = exact_claim_response(&snapshot, &identity, "claim-request-001");

        verify_exact_claim_response(
            &response,
            "claim-request-001",
            verified.authorization_id_sha256(),
            verified.claim_digest_sha256(),
            verified.claim_owner_sha256(),
            &identity,
        )
        .expect("exact identity-bound claim");

        let mut drifted_identity = identity.clone();
        drifted_identity.runner_build_sha256 = "a".repeat(64);
        assert!(matches!(
            verify_exact_claim_response(
                &response,
                "claim-request-001",
                verified.authorization_id_sha256(),
                verified.claim_digest_sha256(),
                verified.claim_owner_sha256(),
                &drifted_identity,
            ),
            Err(ControlPlaneError::ClaimIdentityMismatch)
        ));

        assert!(matches!(
            verify_exact_claim_response(
                &response,
                "claim-request-001",
                verified.authorization_id_sha256(),
                verified.claim_digest_sha256(),
                &"6".repeat(64),
                &identity,
            ),
            Err(ControlPlaneError::ClaimIdentityMismatch)
        ));

        assert!(matches!(
            verify_exact_claim_response(
                &response,
                "claim-request-drifted",
                verified.authorization_id_sha256(),
                verified.claim_digest_sha256(),
                verified.claim_owner_sha256(),
                &identity,
            ),
            Err(ControlPlaneError::AuthorityIdentityMismatch)
        ));
    }

    #[tokio::test]
    async fn deployment_consumes_authorized_path_and_body_exactly_once() {
        let (mutation, expected_body) = authorized_controller_mutation();
        let mut response = scripted_json(
            StatusCode::OK,
            serde_json::json!({
                "success": true,
                "result": {"id": "deployment-001"},
                "echo": DEPLOY_TOKEN,
            }),
        );
        response
            .headers
            .insert("cf-ray", HeaderValue::from_static("ray-identity-001"));
        let exchange = ScriptedExchange::new(vec![Ok(response)]);
        let outcome = deploy_authorized_once(
            &exchange,
            &matching_identity(),
            ACCOUNT_ID,
            DEPLOY_TOKEN,
            mutation,
            NOW,
        )
        .await;

        assert_eq!(outcome.transport_outcome, MutationTransportOutcome::Success);
        assert_eq!(outcome.http_status, Some(200));
        assert!(!outcome.retry);
        assert_eq!(exchange.remaining(), 0);
        let observed = exchange.observed();
        assert_eq!(observed.len(), 1);
        assert_eq!(observed[0].method, Method::POST);
        assert_eq!(
            observed[0].uri,
            format!(
                "{CLOUDFLARE_API_ORIGIN}/client/v4/accounts/{ACCOUNT_ID}/workers/scripts/controller-staging/deployments"
            )
        );
        assert_eq!(observed[0].body.as_ref(), expected_body.as_slice());
        assert_eq!(
            observed[0].headers.get(AUTHORIZATION),
            Some(&HeaderValue::from_static(
                "Bearer deploy-token-secret-material-00001"
            ))
        );
        assert_authority_headers_absent(&observed[0].headers);
        assert_secret_absent(&format!("{outcome:?}"));
        assert_secret_absent(
            &serde_json::to_string(&outcome).expect("serializable mutation outcome"),
        );
    }

    #[tokio::test]
    async fn uncertain_deployment_statuses_and_connection_loss_are_ambiguous_without_retry() {
        for status in [
            StatusCode::REQUEST_TIMEOUT,
            StatusCode::TOO_EARLY,
            StatusCode::TOO_MANY_REQUESTS,
            StatusCode::INTERNAL_SERVER_ERROR,
            StatusCode::SERVICE_UNAVAILABLE,
        ] {
            let exchange = ScriptedExchange::new(vec![Ok(scripted_json(
                status,
                serde_json::json!({
                    "success": false,
                    "errors": [{"code": 1000, "message": DEPLOY_TOKEN}],
                }),
            ))]);
            let outcome = deploy_authorized_once(
                &exchange,
                &matching_identity(),
                ACCOUNT_ID,
                DEPLOY_TOKEN,
                authorized_controller_mutation().0,
                NOW,
            )
            .await;
            assert_eq!(
                outcome.transport_outcome,
                MutationTransportOutcome::Ambiguous
            );
            assert_eq!(outcome.http_status, Some(status.as_u16()));
            assert!(!outcome.retry);
            assert_eq!(exchange.observed().len(), 1);
            assert_secret_absent(&format!("{outcome:?}"));
        }

        let exchange = ScriptedExchange::new(vec![Err(ExchangeError::Connection)]);
        let outcome = deploy_authorized_once(
            &exchange,
            &matching_identity(),
            ACCOUNT_ID,
            DEPLOY_TOKEN,
            authorized_controller_mutation().0,
            NOW,
        )
        .await;
        assert_eq!(
            outcome.transport_outcome,
            MutationTransportOutcome::Ambiguous
        );
        assert_eq!(outcome.http_status, None);
        assert!(!outcome.retry);
        assert_eq!(exchange.observed().len(), 1);
        assert_secret_absent(&format!("{outcome:?}"));
    }

    #[tokio::test]
    async fn redirect_is_not_followed_and_proxy_environment_is_ignored() {
        let _proxy_guard = ProxyEnvironmentGuard::poison();
        let response = concat!(
            "HTTP/1.1 302 Found\r\n",
            "Location: http://127.0.0.1:9/must-not-follow\r\n",
            "Content-Type: application/json\r\n",
            "Content-Length: 2\r\n",
            "Connection: close\r\n",
            "\r\n",
            "{}"
        )
        .as_bytes()
        .to_vec();
        let server = RawLoopbackServer::spawn(response, Duration::ZERO);
        let exchange = PlainHttpExchange::new();
        let result = exchange
            .send(empty_request(server.uri()), 32, Duration::from_secs(1))
            .await
            .expect("direct loopback response");
        assert_eq!(result.status, StatusCode::FOUND);
        assert_eq!(result.body, Bytes::from_static(b"{}"));
        assert_eq!(server.finish(), 1);
    }

    #[tokio::test]
    async fn content_length_and_chunked_responses_are_bounded() {
        let content_length = RawLoopbackServer::spawn(
            concat!(
                "HTTP/1.1 200 OK\r\n",
                "Content-Type: application/json\r\n",
                "Content-Length: 1024\r\n",
                "Connection: close\r\n",
                "\r\n"
            )
            .as_bytes()
            .to_vec(),
            Duration::ZERO,
        );
        let exchange = PlainHttpExchange::new();
        assert!(matches!(
            exchange
                .send(
                    empty_request(content_length.uri()),
                    8,
                    Duration::from_secs(1)
                )
                .await,
            Err(ExchangeError::ResponseTooLarge)
        ));
        assert_eq!(content_length.finish(), 1);

        let chunk = "a".repeat(64);
        let chunked_response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n40\r\n{chunk}\r\n0\r\n\r\n"
        )
        .into_bytes();
        let chunked = RawLoopbackServer::spawn(chunked_response, Duration::ZERO);
        assert!(matches!(
            exchange
                .send(empty_request(chunked.uri()), 8, Duration::from_secs(1))
                .await,
            Err(ExchangeError::ResponseTooLarge)
        ));
        assert_eq!(chunked.finish(), 1);
    }

    #[tokio::test]
    async fn timeout_and_connection_interruption_are_distinct_fail_closed_errors() {
        let delayed = RawLoopbackServer::spawn(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"
                .to_vec(),
            Duration::from_millis(150),
        );
        let exchange = PlainHttpExchange::new();
        assert!(matches!(
            exchange
                .send(empty_request(delayed.uri()), 8, Duration::from_millis(25))
                .await,
            Err(ExchangeError::Timeout)
        ));
        assert_eq!(delayed.finish(), 1);

        let interrupted = RawLoopbackServer::spawn(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 64\r\nConnection: close\r\n\r\n{}"
                .to_vec(),
            Duration::ZERO,
        );
        assert!(matches!(
            exchange
                .send(
                    empty_request(interrupted.uri()),
                    128,
                    Duration::from_secs(1)
                )
                .await,
            Err(ExchangeError::Connection)
        ));
        assert_eq!(interrupted.finish(), 1);
    }

    #[tokio::test]
    async fn secret_material_never_enters_errors_or_outcomes() {
        let exchange = ScriptedExchange::new(vec![Err(ExchangeError::Connection)]);
        let error = verify_identity_proof_sequence(
            FakeIdentityMachine,
            &exchange,
            NOW,
            "request-identity-001",
        )
        .await
        .expect_err("connection loss must fail closed");
        assert_secret_absent(&format!("{error:?}"));
        assert_secret_absent(&error.to_string());

        let response = scripted_json(
            StatusCode::BAD_REQUEST,
            serde_json::json!({
                "success": false,
                "errors": [{"code": 1001, "message": DEPLOY_TOKEN}],
            }),
        );
        let outcome = classify_deployment_response(response);
        assert_eq!(
            outcome.transport_outcome,
            MutationTransportOutcome::Rejected
        );
        assert!(!outcome.retry);
        assert_secret_absent(&format!("{outcome:?}"));
        assert_secret_absent(
            &serde_json::to_string(&outcome).expect("serializable mutation outcome"),
        );
    }

    fn assert_authority_headers_absent(headers: &HeaderMap) {
        assert!(headers
            .get(HeaderName::from_static(AUTHORITY_HEADER_NAME))
            .is_none());
        assert!(headers
            .get(HeaderName::from_static(ACCESS_CLIENT_ID_HEADER))
            .is_none());
        assert!(headers
            .get(HeaderName::from_static(ACCESS_CLIENT_SECRET_HEADER))
            .is_none());
    }

    fn assert_secret_absent(rendered: &str) {
        for secret in [
            READ_TOKEN,
            DEPLOY_TOKEN,
            AUTHORITY_TOKEN,
            ACCESS_CLIENT_ID,
            ACCESS_CLIENT_SECRET,
        ] {
            assert!(!rendered.contains(secret));
        }
    }

    fn matching_identity() -> CredentialIdentity {
        CredentialIdentity {
            account_id_sha256: "c".repeat(64),
            read_credential_id_sha256: "e".repeat(64),
            claim_credential_id_sha256: "f".repeat(64),
            deploy_credential_id_sha256: "0".repeat(64),
            access_client_id_sha256: "a".repeat(64),
            authority_version_id: "authority-version-001".to_owned(),
            permit_spki_sha256: "6".repeat(64),
            trust_config_sha256: "4".repeat(64),
            publication_manifest_sha256: "7".repeat(64),
            runner_build_sha256: "3".repeat(64),
            controller_service_name: "controller-staging".to_owned(),
            edge_service_name: "edge-staging".to_owned(),
            activation_sequence: 1,
        }
    }

    fn exact_claim_response(
        snapshot: &Value,
        identity: &CredentialIdentity,
        request_id: &str,
    ) -> Vec<u8> {
        canonical_json(&serde_json::json!({
            "result": "exact_claim",
            "requestId": request_id,
            "snapshot": snapshot,
            "authorityVersionId": identity.authority_version_id,
        }))
        .expect("canonical exact claim response")
        .into_bytes()
    }

    fn verified_snapshot(snapshot: &Value) -> VerifiedSnapshot {
        let json = canonical_json(snapshot).expect("canonical snapshot");
        VerifiedSnapshot::from_json(json.as_bytes()).expect("verified test snapshot")
    }

    fn authorized_controller_mutation() -> (AuthorizedMutation<ControllerMutation>, Vec<u8>) {
        let snapshot = verified_snapshot(&t1_snapshot_value());
        let request =
            plan_controller_deployment(&snapshot).expect("canonical controller deployment");
        let expected_body = request.body().to_vec();
        let intent = prepare_controller_intent(&snapshot, request, EVIDENCE_DIGEST, NOW)
            .expect("prepared controller intent");
        let response = canonical_json(&serde_json::json!({
            "result": "step_appended",
            "requestId": "append-request-001",
            "authorizationIdSha256": snapshot.authorization_id_sha256(),
            "claimDigestSha256": snapshot.claim_digest_sha256(),
            "status": "controller_inflight",
            "stateVersion": 2,
            "stepDigestSha256": intent.step().step_digest_sha256,
            "authorityVersionId": "authority-version-001",
        }))
        .expect("canonical append response");
        let attempt = begin_authority_append(intent, "append-request-001").expect("append attempt");
        let permit = verify_fresh_append(attempt, response.as_bytes(), "authority-version-001")
            .expect("fresh append permit");
        let mutation = authorize_mutation(permit, NOW).expect("authorized mutation");
        (mutation, expected_body)
    }

    fn t1_snapshot_value() -> Value {
        let controller = serde_json::json!({
            "serviceName": "controller-staging",
            "previousVersionId": "controller-version-001",
            "previousDeploymentSetSha256": "1".repeat(64),
            "targetVersionId": "controller-version-002",
        });
        let edge = serde_json::json!({
            "serviceName": "edge-staging",
            "previousVersionId": "edge-version-001",
            "previousDeploymentSetSha256": "2".repeat(64),
            "targetVersionId": "edge-version-002",
        });
        let mut claim = serde_json::json!({
            "schemaVersion": 1,
            "claimAuthority": "d1-unique-claim-v1",
            "claimScope": "staging-worker-ring-transition",
            "environment": "staging",
            "authorizationIdSha256": "1".repeat(64),
            "executionNonceSha256": "2".repeat(64),
            "authorizationManifestSha256": "3".repeat(64),
            "authorizationSubjectSha256": "4".repeat(64),
            "authorizationPolicySha256": "5".repeat(64),
            "transitionManifestSha256": "6".repeat(64),
            "transitionSubjectSha256": "7".repeat(64),
            "transitionPolicySha256": "8".repeat(64),
            "transitionPlanSha256": "9".repeat(64),
            "candidateSha256": "a".repeat(64),
            "executionPlanSha256": "b".repeat(64),
            "accountIdSha256": "c".repeat(64),
            "ledgerIdentitySha256": "d".repeat(64),
            "readCredentialIdSha256": "e".repeat(64),
            "claimCredentialIdSha256": "f".repeat(64),
            "deployCredentialIdSha256": "0".repeat(64),
            "controller": controller,
            "edge": edge,
            "runnerBuildSha256": "3".repeat(64),
            "runnerTrustConfigSha256": "4".repeat(64),
            "claimOwnerSha256": "5".repeat(64),
            "claimDigestSha256": "",
            "generatedAt": NOW,
            "expiresAt": NOW + 300,
        });
        let claim_digest_input = serde_json::json!({
            "schemaVersion": 1,
            "contract": orchestrator::CLAIM_CONTRACT,
            "claimAuthority": claim["claimAuthority"],
            "claimScope": claim["claimScope"],
            "environment": claim["environment"],
            "authorizationIdSha256": claim["authorizationIdSha256"],
            "executionNonceSha256": claim["executionNonceSha256"],
            "authorizationManifestSha256": claim["authorizationManifestSha256"],
            "authorizationSubjectSha256": claim["authorizationSubjectSha256"],
            "authorizationPolicySha256": claim["authorizationPolicySha256"],
            "transitionManifestSha256": claim["transitionManifestSha256"],
            "transitionSubjectSha256": claim["transitionSubjectSha256"],
            "transitionPolicySha256": claim["transitionPolicySha256"],
            "transitionPlanSha256": claim["transitionPlanSha256"],
            "candidateSha256": claim["candidateSha256"],
            "executionPlanSha256": claim["executionPlanSha256"],
            "accountIdSha256": claim["accountIdSha256"],
            "ledgerIdentitySha256": claim["ledgerIdentitySha256"],
            "readCredentialIdSha256": claim["readCredentialIdSha256"],
            "claimCredentialIdSha256": claim["claimCredentialIdSha256"],
            "deployCredentialIdSha256": claim["deployCredentialIdSha256"],
            "controller": claim["controller"],
            "edge": claim["edge"],
            "runnerBuildSha256": claim["runnerBuildSha256"],
            "runnerTrustConfigSha256": claim["runnerTrustConfigSha256"],
            "claimOwnerSha256": claim["claimOwnerSha256"],
            "generatedAt": NOW,
            "expiresAt": NOW + 300,
        });
        let claim_digest = sha256_hex(
            canonical_json(&claim_digest_input)
                .expect("canonical claim digest input")
                .as_bytes(),
        );
        claim["claimDigestSha256"] = Value::String(claim_digest.clone());
        let step_digest_input = serde_json::json!({
            "schemaVersion": 1,
            "contract": orchestrator::STEP_CONTRACT,
            "ledgerIdentitySha256": claim["ledgerIdentitySha256"],
            "claimDigestSha256": claim_digest,
            "stateVersion": 1,
            "stepCode": "t1_readback",
            "fromStatus": "claimed",
            "toStatus": "t1_verified",
            "mutationRequestSha256": null,
            "cloudflareRequestIdSha256": null,
            "deploymentSetSha256": "6".repeat(64),
            "evidenceSha256": EVIDENCE_DIGEST,
            "failureClass": "",
            "transportOutcome": "not_applicable",
        });
        let step_digest = sha256_hex(
            canonical_json(&step_digest_input)
                .expect("canonical step digest input")
                .as_bytes(),
        );
        serde_json::json!({
            "claim": claim,
            "state": {
                "authorizationIdSha256": "1".repeat(64),
                "claimDigestSha256": claim_digest,
                "claimOwnerSha256": "5".repeat(64),
                "ledgerIdentitySha256": "d".repeat(64),
                "claimCredentialIdSha256": "f".repeat(64),
                "status": "t1_verified",
                "stateVersion": 1,
                "generatedAt": NOW,
                "claimedAt": NOW,
                "expiresAt": NOW + 300,
                "updatedAt": NOW + 1,
                "terminalAt": null,
            },
            "steps": [{
                "stateVersion": 1,
                "stepCode": "t1_readback",
                "fromStatus": "claimed",
                "toStatus": "t1_verified",
                "actorExecutionIdSha256": "5".repeat(64),
                "mutationRequestSha256": null,
                "cloudflareRequestIdSha256": null,
                "deploymentSetSha256": "6".repeat(64),
                "evidenceSha256": EVIDENCE_DIGEST,
                "failureClass": "",
                "transportOutcome": "not_applicable",
                "stepDigestSha256": step_digest,
                "recordedAt": NOW + 1,
            }],
            "expiryEvents": [],
        })
    }

    struct PlainHttpExchange {
        client: Client<HttpConnector, Full<Bytes>>,
    }

    impl PlainHttpExchange {
        fn new() -> Self {
            let mut connector = HttpConnector::new();
            connector.enforce_http(true);
            let mut builder = Client::builder(TokioExecutor::new());
            builder.retry_canceled_requests(false);
            builder.pool_max_idle_per_host(0);
            Self {
                client: builder.build(connector),
            }
        }
    }

    #[async_trait]
    impl HttpExchange for PlainHttpExchange {
        async fn send(
            &self,
            request: Request<Full<Bytes>>,
            maximum_response_bytes: usize,
            timeout: Duration,
        ) -> Result<BoundedHttpResponse, ExchangeError> {
            let deadline = Instant::now() + timeout;
            let response = tokio::time::timeout_at(deadline, self.client.request(request))
                .await
                .map_err(|_| ExchangeError::Timeout)?
                .map_err(|_| ExchangeError::Connection)?;
            collect_bounded_response(response, maximum_response_bytes, deadline).await
        }
    }

    fn empty_request(uri: Uri) -> Request<Full<Bytes>> {
        Request::builder()
            .method(Method::GET)
            .uri(uri)
            .body(Full::new(Bytes::new()))
            .expect("loopback request")
    }

    struct RawLoopbackServer {
        uri: Uri,
        requests: Arc<AtomicUsize>,
        thread: thread::JoinHandle<()>,
    }

    impl RawLoopbackServer {
        fn spawn(response: Vec<u8>, delay: Duration) -> Self {
            let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind loopback HTTP fixture");
            let address = listener.local_addr().expect("loopback fixture address");
            let requests = Arc::new(AtomicUsize::new(0));
            let thread_requests = Arc::clone(&requests);
            let thread = thread::spawn(move || {
                let (mut stream, _) = listener.accept().expect("accept loopback request");
                thread_requests.fetch_add(1, Ordering::SeqCst);
                read_request_headers(&mut stream);
                if !delay.is_zero() {
                    thread::sleep(delay);
                }
                let _ = stream.write_all(&response);
                let _ = stream.flush();
                let _ = stream.shutdown(Shutdown::Both);
                drop(stream);

                listener
                    .set_nonblocking(true)
                    .expect("nonblocking redirect observation");
                let deadline = StdInstant::now() + Duration::from_millis(120);
                while StdInstant::now() < deadline {
                    match listener.accept() {
                        Ok((mut extra, _)) => {
                            thread_requests.fetch_add(1, Ordering::SeqCst);
                            read_request_headers(&mut extra);
                            let _ = extra.write_all(&response);
                            let _ = extra.shutdown(Shutdown::Both);
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(5));
                        }
                        Err(_) => break,
                    }
                }
            });
            Self {
                uri: format!("http://{address}/fixture")
                    .parse()
                    .expect("loopback URI"),
                requests,
                thread,
            }
        }

        fn uri(&self) -> Uri {
            self.uri.clone()
        }

        fn finish(self) -> usize {
            self.thread.join().expect("loopback fixture thread");
            self.requests.load(Ordering::SeqCst)
        }
    }

    fn read_request_headers(stream: &mut std::net::TcpStream) {
        stream
            .set_read_timeout(Some(Duration::from_secs(1)))
            .expect("request read timeout");
        let mut request = Vec::new();
        let mut buffer = [0_u8; 1024];
        while request.len() < 16 * 1024 && !request.ends_with(b"\r\n\r\n") {
            match stream.read(&mut buffer) {
                Ok(0) => break,
                Ok(length) => request.extend_from_slice(&buffer[..length]),
                Err(_) => break,
            }
        }
    }

    struct ProxyEnvironmentGuard {
        previous: Vec<(&'static str, Option<std::ffi::OsString>)>,
    }

    impl ProxyEnvironmentGuard {
        fn poison() -> Self {
            const CASE_SENSITIVE_NAMES: [&str; 6] = [
                "HTTP_PROXY",
                "HTTPS_PROXY",
                "ALL_PROXY",
                "http_proxy",
                "https_proxy",
                "all_proxy",
            ];
            const CASE_INSENSITIVE_NAMES: [&str; 3] = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"];
            let names = if cfg!(windows) {
                CASE_INSENSITIVE_NAMES.as_slice()
            } else {
                CASE_SENSITIVE_NAMES.as_slice()
            };
            let previous = names
                .iter()
                .copied()
                .map(|name| {
                    let value = std::env::var_os(name);
                    std::env::set_var(name, "http://127.0.0.1:9");
                    (name, value)
                })
                .collect();
            Self { previous }
        }
    }

    impl Drop for ProxyEnvironmentGuard {
        fn drop(&mut self) {
            for (name, value) in self.previous.drain(..) {
                if let Some(value) = value {
                    std::env::set_var(name, value);
                } else {
                    std::env::remove_var(name);
                }
            }
        }
    }
}
