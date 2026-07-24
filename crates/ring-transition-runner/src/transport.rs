// Claim-resume and mutation methods are linked now but remain unreachable while trust is disabled.
#![allow(dead_code)]

use crate::credentials::{
    CredentialIdentity, DeployCredentialProven, LoadedCredentials, PendingAuthorityPreflight,
    ReadCredentialProven, ValidatedCredentialTrust, VerifiedCredentials, ACCESS_CLIENT_ID_ENV,
    ACCESS_CLIENT_SECRET_ENV, AUTHORITY_HEADER_NAME, AUTHORITY_PREFLIGHT_PATH,
    CLOUDFLARE_API_ORIGIN,
};
use crate::execution_activation::{
    reserve_claim_dispatch, ClaimDispatchLocation, ClaimDispatchReservation,
    ExecutionActivationIdentity, CLAIMS_PATH,
};
use crate::orchestrator::{
    self, AuthorityAppendAttempt, AuthorizedMutation, BaselineReadbackAppendAttempt,
    BaselineReadbackPhase, BaselineReadbackRecordInput, BaselineReadbackStability, ClaimStatus,
    FreshIntentPermit, MutationPhase, ObservationAppendAttempt, ObservationPhase,
    ObservationRecordInput, ObservationStability, PreparedBaselineReadback, PreparedObservation,
    RecordedObservation, TransportOutcome, VerifiedSnapshot,
};
use crate::readback::{
    BaselineReadbackClassification, ReadbackClassification, ReadbackError, ReadbackSnapshot,
    StableBaselineReadbackPair, StableReadbackPair, MAX_DEPLOYMENTS_RESPONSE_BYTES,
    MAX_OBSERVATION_SECONDS, MAX_TARGET_VERSION_RESPONSE_BYTES, MIN_OBSERVATION_SECONDS,
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
    execution_activation: ExecutionActivationIdentity,
    dispatch_location: ClaimDispatchLocation,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClaimCreationClassification {
    Created,
    ExactReplay,
    RecoveredAfterAmbiguous,
}

pub enum ClaimCreationOutcome {
    Claimed(ClaimedControlPlane),
    Recovery(ClaimRecoveryControlPlane),
}

pub enum ClaimRecoveryOutcome {
    Claimed(ClaimedControlPlane),
    Pending(ClaimRecoveryControlPlane),
}

pub struct ClaimedControlPlane {
    core: ControlPlaneCore<HyperHttpsExchange>,
    execution_activation: ExecutionActivationIdentity,
    snapshot: Box<VerifiedSnapshot>,
    classification: ClaimCreationClassification,
}

pub struct ClaimRecoveryControlPlane {
    core: ControlPlaneCore<HyperHttpsExchange>,
    execution_activation: ExecutionActivationIdentity,
    classification: ClaimCreationClassification,
    last_error: ControlPlaneError,
}

impl PreparedControlPlane {
    pub fn identity(&self) -> &CredentialIdentity {
        self.core.credentials.identity()
    }

    pub fn access_service_token_verified(&self) -> bool {
        true
    }

    pub fn execution_activation(&self) -> &ExecutionActivationIdentity {
        &self.execution_activation
    }

    pub async fn create_claim_once(self) -> Result<ClaimCreationOutcome, ControlPlaneError> {
        let now = system_time_seconds()?;
        let post_request_id = random_request_id()?;
        let read_request_id = random_request_id()?;
        let reservation = reserve_claim_dispatch(
            &self.dispatch_location,
            &self.execution_activation,
            &post_request_id,
            now,
        )
        .map_err(ControlPlaneError::ExecutionActivation)?;
        let establishment = match reservation {
            ClaimDispatchReservation::Fresh => {
                self.core
                    .establish_claim_once_at(
                        &self.execution_activation,
                        now,
                        &post_request_id,
                        &read_request_id,
                    )
                    .await?
            }
            ClaimDispatchReservation::Existing => {
                match self
                    .core
                    .read_activated_claim_at(&self.execution_activation, now, &read_request_id)
                    .await
                {
                    Ok(snapshot) => ClaimEstablishment::Claimed {
                        snapshot: Box::new(snapshot),
                        classification: ClaimCreationClassification::RecoveredAfterAmbiguous,
                    },
                    Err(error) => ClaimEstablishment::Recovery {
                        error,
                        classification: ClaimCreationClassification::RecoveredAfterAmbiguous,
                    },
                }
            }
        };
        match establishment {
            ClaimEstablishment::Claimed {
                snapshot,
                classification,
            } => Ok(ClaimCreationOutcome::Claimed(ClaimedControlPlane {
                core: self.core,
                execution_activation: self.execution_activation,
                snapshot,
                classification,
            })),
            ClaimEstablishment::Recovery {
                error: last_error,
                classification,
            } => Ok(ClaimCreationOutcome::Recovery(ClaimRecoveryControlPlane {
                core: self.core,
                execution_activation: self.execution_activation,
                classification,
                last_error,
            })),
        }
    }
}

impl ClaimedControlPlane {
    pub fn identity(&self) -> &CredentialIdentity {
        self.core.credentials.identity()
    }

    pub fn access_service_token_verified(&self) -> bool {
        true
    }

    pub fn execution_activation(&self) -> &ExecutionActivationIdentity {
        &self.execution_activation
    }

    pub fn snapshot(&self) -> &VerifiedSnapshot {
        &self.snapshot
    }

    pub fn classification(&self) -> ClaimCreationClassification {
        self.classification
    }

    pub(crate) async fn record_t1_readback(mut self) -> Result<Self, ControlPlaneError> {
        let now = system_time_seconds()?;
        let prepared = orchestrator::prepare_t1_readback(&self.snapshot, now)
            .map_err(ControlPlaneError::Orchestrator)?;
        self.require_claim_binding(
            prepared.authorization_id_sha256(),
            prepared.claim_digest_sha256(),
        )?;
        let append_request_id = random_request_id()?;
        let read_request_id = random_request_id()?;
        let snapshot = self
            .core
            .record_baseline_readback_once_at(
                prepared,
                &SystemObservationSchedule,
                &append_request_id,
                &read_request_id,
            )
            .await?;
        self.snapshot = Box::new(snapshot);
        Ok(self)
    }

    pub(crate) async fn record_edge_previous_readback(mut self) -> Result<Self, ControlPlaneError> {
        let now = system_time_seconds()?;
        let prepared = orchestrator::prepare_edge_previous_readback(&self.snapshot, now)
            .map_err(ControlPlaneError::Orchestrator)?;
        self.require_claim_binding(
            prepared.authorization_id_sha256(),
            prepared.claim_digest_sha256(),
        )?;
        let append_request_id = random_request_id()?;
        let read_request_id = random_request_id()?;
        let snapshot = self
            .core
            .record_baseline_readback_once_at(
                prepared,
                &SystemObservationSchedule,
                &append_request_id,
                &read_request_id,
            )
            .await?;
        self.snapshot = Box::new(snapshot);
        Ok(self)
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
        self.require_claim_binding(
            attempt.authorization_id_sha256(),
            attempt.claim_digest_sha256(),
        )?;
        let now = system_time_seconds()?;
        self.core.append_intent_at(attempt, now).await
    }

    pub(crate) async fn deploy_once<P: MutationPhase>(
        &self,
        mutation: AuthorizedMutation<P>,
    ) -> MutationAttemptOutcome {
        if self
            .require_claim_binding(
                mutation.authorization_id_sha256(),
                mutation.claim_digest_sha256(),
            )
            .is_err()
        {
            return MutationAttemptOutcome::ambiguous(None, None, None);
        }
        let now = match system_time_seconds() {
            Ok(now) => now,
            Err(_) => return MutationAttemptOutcome::ambiguous(None, None, None),
        };
        self.core.deploy_once_at(mutation, now).await
    }

    pub(crate) async fn observe_once<P: ObservationPhase>(
        &self,
        observation: PreparedObservation<P>,
        outcome: MutationAttemptOutcome,
    ) -> Result<RecordedObservation<P>, ControlPlaneError> {
        self.require_claim_binding(
            observation.authorization_id_sha256(),
            observation.claim_digest_sha256(),
        )?;
        self.core
            .observe_once_at(observation, outcome, &SystemObservationSchedule)
            .await
    }

    pub(crate) async fn observe_restored_once<P: ObservationPhase>(
        &self,
        observation: PreparedObservation<P>,
    ) -> Result<RecordedObservation<P>, ControlPlaneError> {
        self.observe_once(observation, MutationAttemptOutcome::restored_ambiguous())
            .await
    }

    fn require_claim_binding(
        &self,
        authorization_id_sha256: &str,
        claim_digest_sha256: &str,
    ) -> Result<(), ControlPlaneError> {
        if authorization_id_sha256 != self.snapshot.authorization_id_sha256()
            || claim_digest_sha256 != self.snapshot.claim_digest_sha256()
        {
            return Err(ControlPlaneError::ClaimIdentityMismatch);
        }
        Ok(())
    }
}

impl ClaimRecoveryControlPlane {
    pub fn identity(&self) -> &CredentialIdentity {
        self.core.credentials.identity()
    }

    pub fn execution_activation(&self) -> &ExecutionActivationIdentity {
        &self.execution_activation
    }

    pub fn last_error(&self) -> &ControlPlaneError {
        &self.last_error
    }

    pub fn classification(&self) -> ClaimCreationClassification {
        self.classification
    }

    pub async fn recover_exact_claim(self) -> ClaimRecoveryOutcome {
        let now = match system_time_seconds() {
            Ok(now) => now,
            Err(last_error) => {
                return ClaimRecoveryOutcome::Pending(Self { last_error, ..self });
            }
        };
        let request_id = match random_request_id() {
            Ok(request_id) => request_id,
            Err(last_error) => {
                return ClaimRecoveryOutcome::Pending(Self { last_error, ..self });
            }
        };
        match self
            .core
            .read_activated_claim_at(&self.execution_activation, now, &request_id)
            .await
        {
            Ok(snapshot) => ClaimRecoveryOutcome::Claimed(ClaimedControlPlane {
                core: self.core,
                execution_activation: self.execution_activation,
                snapshot: Box::new(snapshot),
                classification: self.classification,
            }),
            Err(last_error) => ClaimRecoveryOutcome::Pending(Self { last_error, ..self }),
        }
    }
}

pub(crate) async fn verify_loaded_credentials(
    loaded: LoadedCredentials,
    execution_activation: ExecutionActivationIdentity,
    dispatch_location: ClaimDispatchLocation,
) -> Result<PreparedControlPlane, ControlPlaneError> {
    execution_activation
        .validate_credential_identity(loaded.identity())
        .map_err(ControlPlaneError::ExecutionActivation)?;
    let exchange = HyperHttpsExchange::new()?;
    let now = system_time_seconds()?;
    let request_id = random_request_id()?;
    let core = ControlPlaneCore::verify(loaded, exchange, now, &request_id).await?;
    Ok(PreparedControlPlane {
        core,
        execution_activation,
        dispatch_location,
    })
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

    async fn establish_claim_once_at(
        &self,
        activation: &ExecutionActivationIdentity,
        now: u64,
        post_request_id: &str,
        read_request_id: &str,
    ) -> Result<ClaimEstablishment, ControlPlaneError> {
        let post = self
            .create_claim_once_at(activation, now, post_request_id)
            .await?;
        let classification = match post {
            ClaimPostDisposition::Accepted(classification) => classification,
            ClaimPostDisposition::Ambiguous => ClaimCreationClassification::RecoveredAfterAmbiguous,
        };
        Ok(
            match self
                .read_activated_claim_at(activation, now, read_request_id)
                .await
            {
                Ok(snapshot) => ClaimEstablishment::Claimed {
                    snapshot: Box::new(snapshot),
                    classification,
                },
                Err(error) => ClaimEstablishment::Recovery {
                    error,
                    classification,
                },
            },
        )
    }

    async fn create_claim_once_at(
        &self,
        activation: &ExecutionActivationIdentity,
        now: u64,
        request_id: &str,
    ) -> Result<ClaimPostDisposition, ControlPlaneError> {
        require_request_id(request_id)?;
        if now < activation.claim_generated_at()
            || now >= activation.permit_expires_at()
            || now >= activation.claim_expires_at()
        {
            return Err(ControlPlaneError::ClaimActivationExpired);
        }
        let body = activation.claim_request_bytes();
        if body.is_empty()
            || body.len() > 64 * 1024
            || sha256_hex(body) != activation.claim_request_sha256()
        {
            return Err(ControlPlaneError::ClaimRequestIdentityMismatch);
        }
        let request = authority_request(
            &self.credentials,
            Method::POST,
            CLAIMS_PATH,
            Bytes::copy_from_slice(body),
            request_id,
            now,
        )?;
        let response = match self
            .exchange
            .send(request, IDENTITY_RESPONSE_LIMIT, REQUEST_TIMEOUT)
            .await
        {
            Ok(response) => response,
            Err(_) => return Ok(ClaimPostDisposition::Ambiguous),
        };
        if response.status == StatusCode::CREATED || response.status == StatusCode::OK {
            return Ok(
                match verify_claim_create_response(
                    &response.body,
                    response.status,
                    request_id,
                    activation,
                    self.credentials.identity(),
                ) {
                    Ok(classification) => ClaimPostDisposition::Accepted(classification),
                    Err(_) => ClaimPostDisposition::Ambiguous,
                },
            );
        }
        if response.status.is_success()
            || response.status.is_redirection()
            || response.status == StatusCode::REQUEST_TIMEOUT
            || response.status == StatusCode::CONFLICT
            || response.status == StatusCode::TOO_EARLY
            || response.status == StatusCode::TOO_MANY_REQUESTS
            || response.status.is_server_error()
        {
            return Ok(ClaimPostDisposition::Ambiguous);
        }
        Err(ControlPlaneError::AuthorityMutationRejected)
    }

    async fn read_activated_claim_at(
        &self,
        activation: &ExecutionActivationIdentity,
        now: u64,
        request_id: &str,
    ) -> Result<VerifiedSnapshot, ControlPlaneError> {
        self.read_exact_claim_at(
            activation.authorization_id_sha256(),
            activation.claim_digest_sha256(),
            activation.claim_owner_sha256(),
            now,
            request_id,
        )
        .await
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
        match response.status {
            StatusCode::OK => {}
            StatusCode::NOT_FOUND => return Err(ControlPlaneError::AuthorityClaimNotFound),
            StatusCode::CONFLICT => return Err(ControlPlaneError::AuthorityClaimConflict),
            status if status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error() => {
                return Err(ControlPlaneError::AuthorityReadUnavailable);
            }
            _ => return Err(ControlPlaneError::AuthorityRejected),
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

    async fn append_observation_at<P: ObservationPhase>(
        &self,
        attempt: ObservationAppendAttempt<P>,
        now: u64,
    ) -> Result<RecordedObservation<P>, ControlPlaneError> {
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
        orchestrator::verify_observation_append(
            attempt,
            &response.body,
            &self.credentials.identity().authority_version_id,
        )
        .map_err(ControlPlaneError::Orchestrator)
    }

    async fn append_baseline_readback_at<P: BaselineReadbackPhase>(
        &self,
        attempt: BaselineReadbackAppendAttempt<P>,
        now: u64,
    ) -> Result<BaselineAppendDisposition, ControlPlaneError> {
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
        let response = match self
            .exchange
            .send(request, IDENTITY_RESPONSE_LIMIT, REQUEST_TIMEOUT)
            .await
        {
            Ok(response) => response,
            Err(_) => return Ok(BaselineAppendDisposition::Ambiguous),
        };
        if response.status == StatusCode::CREATED || response.status == StatusCode::OK {
            return Ok(
                match orchestrator::verify_baseline_readback_append(
                    attempt,
                    &response.body,
                    &self.credentials.identity().authority_version_id,
                    response.status == StatusCode::CREATED,
                ) {
                    Ok(_) => BaselineAppendDisposition::Accepted,
                    Err(_) => BaselineAppendDisposition::Ambiguous,
                },
            );
        }
        if response.status.is_success()
            || response.status.is_redirection()
            || response.status == StatusCode::REQUEST_TIMEOUT
            || response.status == StatusCode::CONFLICT
            || response.status == StatusCode::TOO_EARLY
            || response.status == StatusCode::TOO_MANY_REQUESTS
            || response.status.is_server_error()
        {
            return Ok(BaselineAppendDisposition::Ambiguous);
        }
        Err(ControlPlaneError::AuthorityMutationRejected)
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

    async fn observe_once_at<P: ObservationPhase, S: ObservationSchedule>(
        &self,
        observation: PreparedObservation<P>,
        outcome: MutationAttemptOutcome,
        schedule: &S,
    ) -> Result<RecordedObservation<P>, ControlPlaneError> {
        outcome.validate_for_observation()?;
        let binding = observation.binding();
        let readback = read_stable_observation(
            &self.exchange,
            self.credentials.account_id(),
            self.credentials.read_token(),
            binding.service_name(),
            binding.target_version_id(),
            binding.canonical_request_digest_sha256(),
            binding.mutation_annotation(),
            u64::from(
                self.credentials
                    .identity()
                    .stable_readback_observation_seconds,
            ),
            schedule,
        )
        .await?;
        let transport_outcome = outcome.orchestrator_outcome();
        let input = ObservationRecordInput {
            deployment_set_sha256: readback.deployment_set_sha256,
            cloudflare_request_id_sha256: outcome.response_id_sha256,
            evidence_sha256: readback.evidence_sha256,
            transport_outcome,
            stability: readback.stability,
        };
        let request_id = random_request_id()?;
        let attempt = orchestrator::begin_observation_append(observation, input, &request_id)
            .map_err(ControlPlaneError::Orchestrator)?;
        let now = schedule.now_seconds()?;
        self.append_observation_at(attempt, now).await
    }

    async fn record_baseline_readback_once_at<P: BaselineReadbackPhase, S: ObservationSchedule>(
        &self,
        prepared: PreparedBaselineReadback<P>,
        schedule: &S,
        append_request_id: &str,
        read_request_id: &str,
    ) -> Result<VerifiedSnapshot, ControlPlaneError> {
        let authorization_id_sha256 = prepared.authorization_id_sha256().to_owned();
        let claim_digest_sha256 = prepared.claim_digest_sha256().to_owned();
        let claim_owner_sha256 = prepared.claim_owner_sha256().to_owned();
        let binding = prepared.binding();
        let readback = read_stable_baseline(
            &self.exchange,
            self.credentials.account_id(),
            self.credentials.read_token(),
            binding.service_name(),
            binding.previous_version_id(),
            binding.previous_deployment_set_sha256(),
            u64::from(
                self.credentials
                    .identity()
                    .stable_readback_observation_seconds,
            ),
            schedule,
        )
        .await?;
        let stability = match readback.stability {
            BaselineReadbackClassification::Confirmed => BaselineReadbackStability::Confirmed,
            BaselineReadbackClassification::Drift => BaselineReadbackStability::Drift,
        };
        let input = BaselineReadbackRecordInput {
            deployment_set_sha256: readback.deployment_set_sha256,
            evidence_sha256: readback.evidence_sha256,
            stability,
        };
        let now = schedule.now_seconds()?;
        let attempt =
            orchestrator::begin_baseline_readback_append(prepared, input, append_request_id, now)
                .map_err(ControlPlaneError::Orchestrator)?;
        let expected_state_version = attempt.step().state_version;
        let expected_status = attempt.step().to_status;
        let expected_step_digest_sha256 = attempt.step().step_digest_sha256.clone();
        self.append_baseline_readback_at(attempt, now).await?;
        let read_now = schedule.now_seconds()?;
        let snapshot = self
            .read_exact_claim_at(
                &authorization_id_sha256,
                &claim_digest_sha256,
                &claim_owner_sha256,
                read_now,
                read_request_id,
            )
            .await?;
        if !snapshot.contains_exact_step(
            expected_state_version,
            expected_status,
            &expected_step_digest_sha256,
        ) {
            return Err(ControlPlaneError::AuthorityClaimConflict);
        }
        Ok(snapshot)
    }
}

#[async_trait]
trait ObservationSchedule: Sync {
    fn now_seconds(&self) -> Result<u64, ControlPlaneError>;

    async fn wait(&self, duration: Duration) -> Result<(), ControlPlaneError>;
}

struct SystemObservationSchedule;

#[async_trait]
impl ObservationSchedule for SystemObservationSchedule {
    fn now_seconds(&self) -> Result<u64, ControlPlaneError> {
        system_time_seconds()
    }

    async fn wait(&self, duration: Duration) -> Result<(), ControlPlaneError> {
        tokio::time::sleep(duration).await;
        Ok(())
    }
}

#[derive(Debug)]
struct StableObservation {
    deployment_set_sha256: String,
    evidence_sha256: String,
    stability: ObservationStability,
}

#[derive(Debug)]
struct StableBaseline {
    deployment_set_sha256: String,
    evidence_sha256: String,
    stability: BaselineReadbackClassification,
}

#[allow(clippy::too_many_arguments)]
async fn read_stable_baseline<E: HttpExchange, S: ObservationSchedule>(
    exchange: &E,
    account_id: &str,
    read_token: &str,
    service_name: &str,
    previous_version_id: &str,
    expected_deployment_set_sha256: &str,
    observation_seconds: u64,
    schedule: &S,
) -> Result<StableBaseline, ControlPlaneError> {
    if !(MIN_OBSERVATION_SECONDS..=MAX_OBSERVATION_SECONDS).contains(&observation_seconds) {
        return Err(ControlPlaneError::Readback(
            ReadbackError::InvalidObservationSeconds,
        ));
    }
    let first = read_observation_snapshot(
        exchange,
        account_id,
        read_token,
        service_name,
        previous_version_id,
    )
    .await?;
    let first = crate::readback::ObservedReadback::new(schedule.now_seconds()?, first)
        .map_err(ControlPlaneError::Readback)?;
    schedule
        .wait(Duration::from_secs(observation_seconds))
        .await?;
    let second = read_observation_snapshot(
        exchange,
        account_id,
        read_token,
        service_name,
        previous_version_id,
    )
    .await?;
    let second = crate::readback::ObservedReadback::new(schedule.now_seconds()?, second)
        .map_err(ControlPlaneError::Readback)?;
    let decision = StableBaselineReadbackPair::new(
        service_name,
        previous_version_id,
        expected_deployment_set_sha256,
        observation_seconds,
        first,
        second,
    )
    .map_err(ControlPlaneError::Readback)?
    .evaluate()
    .map_err(ControlPlaneError::Readback)?;
    Ok(StableBaseline {
        deployment_set_sha256: decision.deployment_set_sha256().to_owned(),
        evidence_sha256: decision.evidence_digest_sha256().to_owned(),
        stability: decision.classification(),
    })
}

#[allow(clippy::too_many_arguments)]
async fn read_stable_observation<E: HttpExchange, S: ObservationSchedule>(
    exchange: &E,
    account_id: &str,
    read_token: &str,
    service_name: &str,
    target_version_id: &str,
    expected_request_digest_sha256: &str,
    expected_annotation: &str,
    observation_seconds: u64,
    schedule: &S,
) -> Result<StableObservation, ControlPlaneError> {
    if !(MIN_OBSERVATION_SECONDS..=MAX_OBSERVATION_SECONDS).contains(&observation_seconds) {
        return Err(ControlPlaneError::Readback(
            ReadbackError::InvalidObservationSeconds,
        ));
    }
    let first = read_observation_snapshot(
        exchange,
        account_id,
        read_token,
        service_name,
        target_version_id,
    )
    .await?;
    let first = crate::readback::ObservedReadback::new(schedule.now_seconds()?, first)
        .map_err(ControlPlaneError::Readback)?;

    schedule
        .wait(Duration::from_secs(observation_seconds))
        .await?;

    let second = read_observation_snapshot(
        exchange,
        account_id,
        read_token,
        service_name,
        target_version_id,
    )
    .await?;
    let second = crate::readback::ObservedReadback::new(schedule.now_seconds()?, second)
        .map_err(ControlPlaneError::Readback)?;

    let decision = StableReadbackPair::new(
        expected_request_digest_sha256,
        service_name,
        target_version_id,
        expected_annotation,
        observation_seconds,
        first,
        second,
    )
    .map_err(ControlPlaneError::Readback)?
    .evaluate()
    .map_err(ControlPlaneError::Readback)?;
    let stability = match decision.classification() {
        ReadbackClassification::Confirmed => ObservationStability::Confirmed,
        ReadbackClassification::TargetNotStable => ObservationStability::TargetNotStable,
        ReadbackClassification::Drift => ObservationStability::Drift,
    };
    Ok(StableObservation {
        deployment_set_sha256: decision.deployment_set_sha256().to_owned(),
        evidence_sha256: decision.evidence_digest_sha256().to_owned(),
        stability,
    })
}

async fn read_observation_snapshot<E: HttpExchange>(
    exchange: &E,
    account_id: &str,
    read_token: &str,
    service_name: &str,
    target_version_id: &str,
) -> Result<ReadbackSnapshot, ControlPlaneError> {
    let base = format!("/client/v4/accounts/{account_id}/workers/scripts/{service_name}");
    let deployments = read_cloudflare_json(
        exchange,
        read_token,
        &format!("{base}/deployments"),
        MAX_DEPLOYMENTS_RESPONSE_BYTES,
    )
    .await?;
    let target_version = read_cloudflare_json(
        exchange,
        read_token,
        &format!("{base}/versions/{target_version_id}"),
        MAX_TARGET_VERSION_RESPONSE_BYTES,
    )
    .await?;
    ReadbackSnapshot::from_json(
        service_name,
        target_version_id,
        &deployments,
        &target_version,
    )
    .map_err(ControlPlaneError::Readback)
}

async fn read_cloudflare_json<E: HttpExchange>(
    exchange: &E,
    read_token: &str,
    path: &str,
    maximum_response_bytes: usize,
) -> Result<Bytes, ControlPlaneError> {
    let request = Request::builder()
        .method(Method::GET)
        .uri(cloudflare_uri(path)?)
        .header(ACCEPT, "application/json")
        .header(AUTHORIZATION, bearer_header(read_token)?)
        .body(Full::new(Bytes::new()))
        .map_err(|_| ControlPlaneError::InvalidRequest("cloudflare_readback"))?;
    let response = exchange
        .send(request, maximum_response_bytes, REQUEST_TIMEOUT)
        .await
        .map_err(|_| ControlPlaneError::Exchange)?;
    if response.status != StatusCode::OK {
        return Err(ControlPlaneError::ReadbackRejected);
    }
    Ok(response.body)
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ClaimPostDisposition {
    Accepted(ClaimCreationClassification),
    Ambiguous,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BaselineAppendDisposition {
    Accepted,
    Ambiguous,
}

enum ClaimEstablishment {
    Claimed {
        snapshot: Box<VerifiedSnapshot>,
        classification: ClaimCreationClassification,
    },
    Recovery {
        error: ControlPlaneError,
        classification: ClaimCreationClassification,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
enum ClaimCreateResult {
    Created,
    ExactReplay,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClaimCreateResponse {
    result: ClaimCreateResult,
    request_id: String,
    claim: ClaimCreateState,
    authority_version_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClaimCreateState {
    authorization_id_sha256: String,
    claim_digest_sha256: String,
    claim_owner_sha256: String,
    ledger_identity_sha256: String,
    claim_credential_id_sha256: String,
    status: ClaimStatus,
    state_version: u8,
    generated_at: u64,
    claimed_at: u64,
    expires_at: u64,
    updated_at: u64,
    terminal_at: Option<u64>,
}

fn verify_claim_create_response(
    response_body: &[u8],
    status: StatusCode,
    request_id: &str,
    activation: &ExecutionActivationIdentity,
    identity: &CredentialIdentity,
) -> Result<ClaimCreationClassification, ControlPlaneError> {
    reject_duplicate_json(response_body, IDENTITY_RESPONSE_LIMIT)
        .map_err(|_| ControlPlaneError::InvalidAuthorityResponse)?;
    let response: ClaimCreateResponse = serde_json::from_slice(response_body)
        .map_err(|_| ControlPlaneError::InvalidAuthorityResponse)?;
    let classification = match (status, response.result) {
        (StatusCode::CREATED, ClaimCreateResult::Created) => ClaimCreationClassification::Created,
        (StatusCode::OK, ClaimCreateResult::ExactReplay) => {
            ClaimCreationClassification::ExactReplay
        }
        _ => return Err(ControlPlaneError::InvalidAuthorityResponse),
    };
    let claim = response.claim;
    if response.request_id != request_id
        || response.authority_version_id != identity.authority_version_id
        || claim.authorization_id_sha256 != activation.authorization_id_sha256()
        || claim.claim_digest_sha256 != activation.claim_digest_sha256()
        || claim.claim_owner_sha256 != activation.claim_owner_sha256()
        || claim.ledger_identity_sha256 != activation.ledger_identity_sha256()
        || claim.claim_credential_id_sha256 != identity.claim_credential_id_sha256
        || claim.status != ClaimStatus::Claimed
        || claim.state_version != 0
        || claim.generated_at != activation.claim_generated_at()
        || claim.expires_at != activation.claim_expires_at()
        || claim.claimed_at < claim.generated_at
        || claim.claimed_at >= claim.expires_at
        || claim.updated_at != claim.claimed_at
        || claim.terminal_at.is_some()
    {
        return Err(ControlPlaneError::ClaimIdentityMismatch);
    }
    Ok(classification)
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

    fn restored_ambiguous() -> Self {
        Self::ambiguous(None, None, None)
    }

    fn validate_for_observation(&self) -> Result<(), ControlPlaneError> {
        if self.retry {
            return Err(ControlPlaneError::InvalidRequest(
                "mutation_retry_forbidden",
            ));
        }
        for digest in [
            self.response_body_sha256.as_deref(),
            self.response_id_sha256.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            require_sha256(digest, "mutation_response_digest")?;
        }
        Ok(())
    }

    fn orchestrator_outcome(&self) -> TransportOutcome {
        match self.transport_outcome {
            MutationTransportOutcome::Success => TransportOutcome::Success,
            MutationTransportOutcome::Rejected => TransportOutcome::Rejected,
            MutationTransportOutcome::Ambiguous => TransportOutcome::Ambiguous,
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
    ExecutionActivation(crate::execution_activation::ExecutionActivationError),
    Orchestrator(orchestrator::OrchestratorError),
    Exchange,
    InvalidRequest(&'static str),
    CredentialIdentityRejected(&'static str),
    AuthorityRejected,
    AuthorityIdentityMismatch,
    InvalidAuthorityResponse,
    ClaimIdentityMismatch,
    ClaimRequestIdentityMismatch,
    ClaimActivationExpired,
    AuthorityClaimNotFound,
    AuthorityClaimConflict,
    AuthorityReadUnavailable,
    Readback(ReadbackError),
    ReadbackRejected,
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
            Self::ExecutionActivation(error) => error.fmt(formatter),
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
            Self::ClaimRequestIdentityMismatch => {
                formatter.write_str("activated claim request bytes do not match their digest")
            }
            Self::ClaimActivationExpired => {
                formatter.write_str("activated claim or permit is outside its execution window")
            }
            Self::AuthorityClaimNotFound => {
                formatter.write_str("Authority exact claim was not found")
            }
            Self::AuthorityClaimConflict => {
                formatter.write_str("Authority exact claim identity conflicts")
            }
            Self::AuthorityReadUnavailable => {
                formatter.write_str("Authority exact claim read is temporarily unavailable")
            }
            Self::Readback(error) => error.fmt(formatter),
            Self::ReadbackRejected => {
                formatter.write_str("Cloudflare deployment readback was rejected")
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
    use crate::credentials::verified_credentials_for_transport_test;
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
    const MUTATION_REQUEST_DIGEST: &str =
        "4f75767d59d027a0ed9fc763954ac1b128c08732ac46bd1f19a274595a5225e2";

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

    struct ScriptedObservationSchedule {
        times: Mutex<VecDeque<u64>>,
        waits: Mutex<Vec<Duration>>,
        fail_wait: bool,
    }

    impl ScriptedObservationSchedule {
        fn new(times: impl IntoIterator<Item = u64>) -> Self {
            Self {
                times: Mutex::new(times.into_iter().collect()),
                waits: Mutex::new(Vec::new()),
                fail_wait: false,
            }
        }

        fn waits(&self) -> Vec<Duration> {
            self.waits.lock().expect("wait observation lock").clone()
        }
    }

    #[async_trait]
    impl ObservationSchedule for ScriptedObservationSchedule {
        fn now_seconds(&self) -> Result<u64, ControlPlaneError> {
            self.times
                .lock()
                .expect("time observation lock")
                .pop_front()
                .ok_or(ControlPlaneError::ClockUnavailable)
        }

        async fn wait(&self, duration: Duration) -> Result<(), ControlPlaneError> {
            self.waits
                .lock()
                .expect("wait observation lock")
                .push(duration);
            if self.fail_wait {
                Err(ControlPlaneError::ClockUnavailable)
            } else {
                Ok(())
            }
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
    async fn claim_creation_posts_frozen_bytes_once_then_requires_exact_readback() {
        let activation = transport_activation();
        let identity = matching_identity();
        let snapshot = claimed_snapshot_value();
        let exchange = ScriptedExchange::new(vec![
            Ok(claim_create_response(
                StatusCode::CREATED,
                "created",
                "claim-create-001",
                &activation,
                &identity,
            )),
            Ok(scripted_json(
                StatusCode::OK,
                serde_json::from_slice(&exact_claim_response(
                    &snapshot,
                    &identity,
                    "claim-read-001",
                ))
                .unwrap(),
            )),
        ]);
        let core = ControlPlaneCore {
            credentials: verified_credentials_for_transport_test(),
            exchange: exchange.clone(),
        };

        let result = core
            .establish_claim_once_at(&activation, NOW, "claim-create-001", "claim-read-001")
            .await
            .expect("created claim must establish");
        let ClaimEstablishment::Claimed {
            snapshot,
            classification,
        } = result
        else {
            panic!("exact readback must establish the claim");
        };
        assert_eq!(classification, ClaimCreationClassification::Created);
        assert_eq!(snapshot.status(), ClaimStatus::Claimed);
        assert_eq!(snapshot.state_version(), 0);

        let observed = exchange.observed();
        assert_eq!(observed.len(), 2);
        assert_eq!(
            observed
                .iter()
                .filter(|request| request.method == Method::POST)
                .count(),
            1
        );
        assert_eq!(observed[0].method, Method::POST);
        assert_eq!(
            observed[0].uri,
            format!("{STAGING_AUTHORITY_ORIGIN}{CLAIMS_PATH}")
        );
        assert_eq!(observed[0].body.as_ref(), activation.claim_request_bytes());
        assert_eq!(
            observed[0].headers.get(CONTENT_TYPE),
            Some(&HeaderValue::from_static("application/json"))
        );
        assert_eq!(observed[1].method, Method::GET);
        assert_eq!(
            observed[1].uri,
            format!(
                "{STAGING_AUTHORITY_ORIGIN}{CLAIMS_PATH}/{}?claimDigestSha256={}&claimOwnerSha256={}",
                activation.authorization_id_sha256(),
                activation.claim_digest_sha256(),
                activation.claim_owner_sha256()
            )
        );
        assert!(observed[1].body.is_empty());
        assert!(observed
            .iter()
            .all(|request| request.maximum_response_bytes == IDENTITY_RESPONSE_LIMIT));
        assert!(observed
            .iter()
            .all(|request| request.timeout == REQUEST_TIMEOUT));
    }

    #[tokio::test]
    async fn claim_response_loss_and_invalid_success_recover_only_through_get() {
        for first_response in [
            Err(ExchangeError::Connection),
            Ok(claim_create_response(
                StatusCode::CREATED,
                "exact_replay",
                "claim-create-ambiguous",
                &transport_activation(),
                &matching_identity(),
            )),
            Ok(scripted_json(
                StatusCode::ACCEPTED,
                serde_json::json!({"result": "queued"}),
            )),
            Ok(scripted_json(
                StatusCode::CONFLICT,
                serde_json::json!({"error": "claim_conflict"}),
            )),
            Ok(scripted_json(
                StatusCode::SERVICE_UNAVAILABLE,
                serde_json::json!({
                    "error": "outcome_unknown",
                    "outcomeUnknown": true,
                }),
            )),
        ] {
            let activation = transport_activation();
            let identity = matching_identity();
            let snapshot = claimed_snapshot_value();
            let exchange = ScriptedExchange::new(vec![
                first_response,
                Ok(scripted_json(
                    StatusCode::OK,
                    serde_json::from_slice(&exact_claim_response(
                        &snapshot,
                        &identity,
                        "claim-read-ambiguous",
                    ))
                    .unwrap(),
                )),
            ]);
            let core = ControlPlaneCore {
                credentials: verified_credentials_for_transport_test(),
                exchange: exchange.clone(),
            };
            let result = core
                .establish_claim_once_at(
                    &activation,
                    NOW,
                    "claim-create-ambiguous",
                    "claim-read-ambiguous",
                )
                .await
                .expect("ambiguous POST with exact readback must recover");
            assert!(matches!(
                result,
                ClaimEstablishment::Claimed {
                    classification: ClaimCreationClassification::RecoveredAfterAmbiguous,
                    ..
                }
            ));
            let observed = exchange.observed();
            assert_eq!(observed.len(), 2);
            assert_eq!(
                observed
                    .iter()
                    .filter(|request| request.method == Method::POST)
                    .count(),
                1
            );
            assert_eq!(observed[1].method, Method::GET);
            assert_eq!(exchange.remaining(), 0);
        }
    }

    #[tokio::test]
    async fn unresolved_claim_recovery_never_restores_post_capability() {
        let activation = transport_activation();
        let identity = matching_identity();
        let snapshot = claimed_snapshot_value();
        let exchange = ScriptedExchange::new(vec![
            Err(ExchangeError::Timeout),
            Err(ExchangeError::Connection),
            Ok(scripted_json(
                StatusCode::OK,
                serde_json::from_slice(&exact_claim_response(
                    &snapshot,
                    &identity,
                    "claim-read-recovery-002",
                ))
                .unwrap(),
            )),
        ]);
        let core = ControlPlaneCore {
            credentials: verified_credentials_for_transport_test(),
            exchange: exchange.clone(),
        };
        let first = core
            .establish_claim_once_at(
                &activation,
                NOW,
                "claim-create-recovery",
                "claim-read-recovery-001",
            )
            .await
            .expect("ambiguous establishment returns recovery state");
        assert!(matches!(
            first,
            ClaimEstablishment::Recovery {
                error: ControlPlaneError::Exchange,
                classification: ClaimCreationClassification::RecoveredAfterAmbiguous,
            }
        ));

        let recovered = core
            .read_activated_claim_at(&activation, NOW, "claim-read-recovery-002")
            .await
            .expect("later exact GET may recover");
        assert_eq!(recovered.status(), ClaimStatus::Claimed);
        let observed = exchange.observed();
        assert_eq!(
            observed
                .iter()
                .filter(|request| request.method == Method::POST)
                .count(),
            1
        );
        assert_eq!(
            observed
                .iter()
                .filter(|request| request.method == Method::GET)
                .count(),
            2
        );
        assert_eq!(exchange.remaining(), 0);
    }

    #[tokio::test]
    async fn deterministic_claim_rejection_and_expiry_do_not_read_or_retry() {
        let activation = transport_activation();
        let exchange = ScriptedExchange::new(vec![Ok(scripted_json(
            StatusCode::FORBIDDEN,
            serde_json::json!({"error": "invalid_permit"}),
        ))]);
        let core = ControlPlaneCore {
            credentials: verified_credentials_for_transport_test(),
            exchange: exchange.clone(),
        };
        assert!(matches!(
            core.establish_claim_once_at(
                &activation,
                NOW,
                "claim-create-rejected",
                "claim-read-forbidden",
            )
            .await,
            Err(ControlPlaneError::AuthorityMutationRejected)
        ));
        assert_eq!(exchange.observed().len(), 1);
        assert_eq!(exchange.observed()[0].method, Method::POST);

        let expired_exchange = ScriptedExchange::new(Vec::new());
        let expired_core = ControlPlaneCore {
            credentials: verified_credentials_for_transport_test(),
            exchange: expired_exchange.clone(),
        };
        assert!(matches!(
            expired_core
                .create_claim_once_at(&activation, NOW + 60, "claim-create-expired",)
                .await,
            Err(ControlPlaneError::ClaimActivationExpired)
        ));
        assert!(expired_exchange.observed().is_empty());
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
    async fn stable_readback_uses_four_ordered_read_only_requests_and_compiled_wait() {
        let annotation = controller_mutation_annotation();
        let exchange = ScriptedExchange::new(stable_readback_responses(&annotation));
        let schedule = ScriptedObservationSchedule::new([1_000, 1_005]);

        let observation = read_stable_observation(
            &exchange,
            ACCOUNT_ID,
            READ_TOKEN,
            "controller-staging",
            "controller-version-002",
            MUTATION_REQUEST_DIGEST,
            &annotation,
            5,
            &schedule,
        )
        .await
        .expect("stable readback");

        assert_eq!(observation.stability, ObservationStability::Confirmed);
        assert_eq!(observation.deployment_set_sha256.len(), 64);
        assert_eq!(observation.evidence_sha256.len(), 64);
        assert_eq!(schedule.waits(), [Duration::from_secs(5)]);
        assert_eq!(exchange.remaining(), 0);

        let observed = exchange.observed();
        assert_eq!(observed.len(), 4);
        let expected_paths = [
            "deployments",
            "versions/controller-version-002",
            "deployments",
            "versions/controller-version-002",
        ];
        for (request, suffix) in observed.iter().zip(expected_paths) {
            assert_eq!(request.method, Method::GET);
            assert!(request.uri.ends_with(suffix));
            assert_eq!(
                request.headers.get(AUTHORIZATION),
                Some(&HeaderValue::from_static(
                    "Bearer read-token-secret-material-00000001"
                ))
            );
            assert_authority_headers_absent(&request.headers);
            assert!(request.body.is_empty());
            assert_eq!(request.timeout, REQUEST_TIMEOUT);
        }
        assert_eq!(
            observed[0].maximum_response_bytes,
            MAX_DEPLOYMENTS_RESPONSE_BYTES
        );
        assert_eq!(
            observed[1].maximum_response_bytes,
            MAX_TARGET_VERSION_RESPONSE_BYTES
        );
        assert!(observed
            .iter()
            .all(|request| request.method != Method::POST));
        assert_secret_absent(&format!("{observation:?}"));
    }

    #[tokio::test]
    async fn baseline_readback_uses_previous_version_and_exact_deployment_identity() {
        let expected =
            baseline_readback_decision("controller-staging", "controller-version-001", None);
        let exchange = ScriptedExchange::new(stable_baseline_responses(
            "controller-staging",
            "controller-version-001",
        ));
        let schedule = ScriptedObservationSchedule::new([1_000, 1_005]);
        let baseline = read_stable_baseline(
            &exchange,
            ACCOUNT_ID,
            READ_TOKEN,
            "controller-staging",
            "controller-version-001",
            expected.deployment_set_sha256(),
            5,
            &schedule,
        )
        .await
        .expect("stable previous baseline");

        assert_eq!(
            baseline.stability,
            BaselineReadbackClassification::Confirmed
        );
        assert_eq!(
            baseline.deployment_set_sha256,
            expected.deployment_set_sha256()
        );
        assert_eq!(baseline.evidence_sha256, expected.evidence_digest_sha256());
        assert_eq!(schedule.waits(), [Duration::from_secs(5)]);
        let observed = exchange.observed();
        assert_eq!(observed.len(), 4);
        for (request, suffix) in observed.iter().zip([
            "deployments",
            "versions/controller-version-001",
            "deployments",
            "versions/controller-version-001",
        ]) {
            assert_eq!(request.method, Method::GET);
            assert!(request.uri.ends_with(suffix));
            assert_eq!(
                request.headers.get(AUTHORIZATION),
                Some(&HeaderValue::from_static(
                    "Bearer read-token-secret-material-00000001"
                ))
            );
            assert_authority_headers_absent(&request.headers);
        }
    }

    #[tokio::test]
    async fn baseline_phase_reads_stably_before_one_exact_authority_append() {
        let expected =
            baseline_readback_decision("controller-staging", "controller-version-001", None);
        let claimed_value =
            claimed_snapshot_value_with_controller_baseline(expected.deployment_set_sha256());
        let snapshot = verified_snapshot(&claimed_value);
        let prepared = orchestrator::prepare_t1_readback(&snapshot, NOW)
            .expect("prepared T1 baseline readback");
        let attempt = orchestrator::begin_baseline_readback_append(
            orchestrator::prepare_t1_readback(&snapshot, NOW).expect("prepared response fixture"),
            BaselineReadbackRecordInput {
                deployment_set_sha256: expected.deployment_set_sha256().to_owned(),
                evidence_sha256: expected.evidence_digest_sha256().to_owned(),
                stability: BaselineReadbackStability::Confirmed,
            },
            "t1-live-readback-001",
            NOW,
        )
        .expect("baseline append fixture");
        let append_response = scripted_json(
            StatusCode::CREATED,
            serde_json::json!({
                "result": "step_appended",
                "requestId": "t1-live-readback-001",
                "authorizationIdSha256": attempt.authorization_id_sha256(),
                "claimDigestSha256": attempt.claim_digest_sha256(),
                "status": attempt.step().to_status,
                "stateVersion": attempt.step().state_version,
                "stepDigestSha256": attempt.step().step_digest_sha256,
                "authorityVersionId": "authority-version-001",
            }),
        );
        let mut responses =
            stable_baseline_responses("controller-staging", "controller-version-001");
        responses.push(Ok(append_response));
        let advanced_value = advanced_baseline_snapshot_value(claimed_value, &attempt, NOW);
        responses.push(Ok(scripted_json(
            StatusCode::OK,
            serde_json::from_slice(&exact_claim_response(
                &advanced_value,
                &matching_identity(),
                "t1-live-readback-get-001",
            ))
            .expect("exact baseline GET fixture"),
        )));
        let exchange = ScriptedExchange::new(responses);
        let schedule = ScriptedObservationSchedule::new([1_000, 1_005, NOW, NOW]);
        let core = ControlPlaneCore {
            credentials: verified_credentials_for_transport_test(),
            exchange: exchange.clone(),
        };

        let refreshed = core
            .record_baseline_readback_once_at(
                prepared,
                &schedule,
                "t1-live-readback-001",
                "t1-live-readback-get-001",
            )
            .await
            .expect("baseline read and append");
        assert_eq!(refreshed.status(), ClaimStatus::T1Verified);
        assert_eq!(refreshed.state_version(), 1);
        assert!(refreshed.contains_exact_step(
            attempt.step().state_version,
            attempt.step().to_status,
            &attempt.step().step_digest_sha256,
        ));
        let observed = exchange.observed();
        assert_eq!(observed.len(), 6);
        assert!(observed[..4]
            .iter()
            .all(|request| request.method == Method::GET));
        assert_eq!(observed[4].method, Method::POST);
        assert!(observed[4].uri.ends_with(&format!(
            "/internal/v1/ring-transition/claims/{}/steps",
            snapshot.authorization_id_sha256()
        )));
        let authority_header = observed[4]
            .headers
            .get(AUTHORITY_HEADER_NAME)
            .and_then(|value| value.to_str().ok())
            .expect("signed Authority header");
        assert_eq!(authority_header.split('.').count(), 3);
        assert!(!authority_header.contains(AUTHORITY_TOKEN));
        assert!(observed[4].headers.get(AUTHORIZATION).is_none());
        assert_eq!(observed[5].method, Method::GET);
        assert!(observed[5].uri.contains("claimDigestSha256="));
        assert_eq!(exchange.remaining(), 0);
    }

    #[tokio::test]
    async fn ambiguous_baseline_append_never_reposts_and_recovers_by_exact_get() {
        for mode in ["connection_loss", "unavailable", "invalid_success"] {
            let expected =
                baseline_readback_decision("controller-staging", "controller-version-001", None);
            let claimed_value =
                claimed_snapshot_value_with_controller_baseline(expected.deployment_set_sha256());
            let snapshot = verified_snapshot(&claimed_value);
            let prepared = orchestrator::prepare_t1_readback(&snapshot, NOW)
                .expect("prepared T1 baseline readback");
            let attempt = orchestrator::begin_baseline_readback_append(
                orchestrator::prepare_t1_readback(&snapshot, NOW)
                    .expect("prepared ambiguity fixture"),
                BaselineReadbackRecordInput {
                    deployment_set_sha256: expected.deployment_set_sha256().to_owned(),
                    evidence_sha256: expected.evidence_digest_sha256().to_owned(),
                    stability: BaselineReadbackStability::Confirmed,
                },
                "t1-ambiguous-append-001",
                NOW,
            )
            .expect("ambiguous append fixture");
            let append_response = match mode {
                "connection_loss" => Err(ExchangeError::Connection),
                "unavailable" => Ok(scripted_json(
                    StatusCode::SERVICE_UNAVAILABLE,
                    serde_json::json!({
                        "error": "outcome_unknown",
                        "outcomeUnknown": true,
                    }),
                )),
                "invalid_success" => Ok(scripted_json(
                    StatusCode::CREATED,
                    serde_json::json!({
                        "result": "step_replayed",
                        "requestId": "t1-ambiguous-append-001",
                        "authorizationIdSha256": attempt.authorization_id_sha256(),
                        "claimDigestSha256": attempt.claim_digest_sha256(),
                        "status": attempt.step().to_status,
                        "stateVersion": attempt.step().state_version,
                        "stepDigestSha256": attempt.step().step_digest_sha256,
                        "authorityVersionId": "authority-version-001",
                    }),
                )),
                _ => unreachable!("fixed ambiguity mode"),
            };
            let advanced_value = advanced_baseline_snapshot_value(claimed_value, &attempt, NOW);
            let mut responses =
                stable_baseline_responses("controller-staging", "controller-version-001");
            responses.push(append_response);
            responses.push(Ok(scripted_json(
                StatusCode::OK,
                serde_json::from_slice(&exact_claim_response(
                    &advanced_value,
                    &matching_identity(),
                    "t1-ambiguous-get-001",
                ))
                .expect("ambiguous exact GET fixture"),
            )));
            let exchange = ScriptedExchange::new(responses);
            let schedule = ScriptedObservationSchedule::new([1_000, 1_005, NOW, NOW]);
            let core = ControlPlaneCore {
                credentials: verified_credentials_for_transport_test(),
                exchange: exchange.clone(),
            };

            let refreshed = core
                .record_baseline_readback_once_at(
                    prepared,
                    &schedule,
                    "t1-ambiguous-append-001",
                    "t1-ambiguous-get-001",
                )
                .await
                .expect("exact GET recovers ambiguous append");
            assert_eq!(refreshed.status(), ClaimStatus::T1Verified);
            let observed = exchange.observed();
            assert_eq!(
                observed
                    .iter()
                    .filter(|request| request.method == Method::POST)
                    .count(),
                1
            );
            assert_eq!(observed.last().expect("exact GET").method, Method::GET);
            assert_eq!(exchange.remaining(), 0);
        }
    }

    #[tokio::test]
    async fn baseline_append_expiry_and_unproven_outcome_fail_closed() {
        let expected =
            baseline_readback_decision("controller-staging", "controller-version-001", None);
        let claimed_value =
            claimed_snapshot_value_with_controller_baseline(expected.deployment_set_sha256());
        let snapshot = verified_snapshot(&claimed_value);
        let expired_exchange = ScriptedExchange::new(stable_baseline_responses(
            "controller-staging",
            "controller-version-001",
        ));
        let expired_schedule = ScriptedObservationSchedule::new([1_000, 1_005, NOW + 300]);
        let expired_core = ControlPlaneCore {
            credentials: verified_credentials_for_transport_test(),
            exchange: expired_exchange.clone(),
        };
        assert!(matches!(
            expired_core
                .record_baseline_readback_once_at(
                    orchestrator::prepare_t1_readback(&snapshot, NOW)
                        .expect("prepared expiry fixture"),
                    &expired_schedule,
                    "t1-expired-append-001",
                    "t1-expired-get-001",
                )
                .await,
            Err(ControlPlaneError::Orchestrator(
                orchestrator::OrchestratorError::AuthorizationExpired
            ))
        ));
        assert_eq!(expired_exchange.observed().len(), 4);
        assert!(expired_exchange
            .observed()
            .iter()
            .all(|request| request.method == Method::GET));

        let prepared = orchestrator::prepare_t1_readback(&snapshot, NOW)
            .expect("prepared stale outcome fixture");
        let mut responses =
            stable_baseline_responses("controller-staging", "controller-version-001");
        responses.push(Err(ExchangeError::Connection));
        responses.push(Ok(scripted_json(
            StatusCode::OK,
            serde_json::from_slice(&exact_claim_response(
                &claimed_value,
                &matching_identity(),
                "t1-stale-get-001",
            ))
            .expect("stale exact GET fixture"),
        )));
        let stale_exchange = ScriptedExchange::new(responses);
        let stale_schedule = ScriptedObservationSchedule::new([1_000, 1_005, NOW, NOW]);
        let stale_core = ControlPlaneCore {
            credentials: verified_credentials_for_transport_test(),
            exchange: stale_exchange.clone(),
        };
        assert!(matches!(
            stale_core
                .record_baseline_readback_once_at(
                    prepared,
                    &stale_schedule,
                    "t1-stale-append-001",
                    "t1-stale-get-001",
                )
                .await,
            Err(ControlPlaneError::AuthorityClaimConflict)
        ));
        assert_eq!(
            stale_exchange
                .observed()
                .iter()
                .filter(|request| request.method == Method::POST)
                .count(),
            1
        );
        assert_eq!(
            stale_exchange
                .observed()
                .last()
                .expect("stale exact GET")
                .method,
            Method::GET
        );
    }

    #[tokio::test]
    async fn each_readback_failure_stops_without_retry_or_authority_append() {
        let annotation = controller_mutation_annotation();
        for failed_request in 0..4 {
            let mut responses = stable_readback_responses(&annotation);
            responses[failed_request] = Ok(scripted_json(
                StatusCode::BAD_GATEWAY,
                serde_json::json!({"success": false}),
            ));
            let exchange = ScriptedExchange::new(responses);
            let schedule = ScriptedObservationSchedule::new([1_000, 1_005]);

            assert!(matches!(
                read_stable_observation(
                    &exchange,
                    ACCOUNT_ID,
                    READ_TOKEN,
                    "controller-staging",
                    "controller-version-002",
                    MUTATION_REQUEST_DIGEST,
                    &annotation,
                    5,
                    &schedule,
                )
                .await,
                Err(ControlPlaneError::ReadbackRejected)
            ));
            let observed = exchange.observed();
            assert_eq!(observed.len(), failed_request + 1);
            assert!(observed.iter().all(|request| request.method == Method::GET));
            assert!(observed
                .iter()
                .all(|request| request.uri.starts_with(CLOUDFLARE_API_ORIGIN)));
            assert_eq!(schedule.waits().len(), usize::from(failed_request >= 2));
        }
    }

    #[tokio::test]
    async fn readback_time_drift_fails_closed_after_one_pair_without_post() {
        for times in [[1_000, 1_004], [1_000, 1_121], [1_005, 1_000]] {
            let annotation = controller_mutation_annotation();
            let exchange = ScriptedExchange::new(stable_readback_responses(&annotation));
            let schedule = ScriptedObservationSchedule::new(times);
            let result = read_stable_observation(
                &exchange,
                ACCOUNT_ID,
                READ_TOKEN,
                "controller-staging",
                "controller-version-002",
                MUTATION_REQUEST_DIGEST,
                &annotation,
                5,
                &schedule,
            )
            .await;
            assert!(matches!(result, Err(ControlPlaneError::Readback(_))));
            assert_eq!(exchange.observed().len(), 4);
            assert!(exchange
                .observed()
                .iter()
                .all(|request| request.method == Method::GET));
        }
    }

    #[tokio::test]
    async fn invalid_compiled_readback_window_performs_no_network_or_wait() {
        for observation_seconds in [0, 4, 121, u64::MAX] {
            let exchange = ScriptedExchange::new(Vec::new());
            let schedule = ScriptedObservationSchedule::new([]);
            assert!(matches!(
                read_stable_observation(
                    &exchange,
                    ACCOUNT_ID,
                    READ_TOKEN,
                    "controller-staging",
                    "controller-version-002",
                    MUTATION_REQUEST_DIGEST,
                    &controller_mutation_annotation(),
                    observation_seconds,
                    &schedule,
                )
                .await,
                Err(ControlPlaneError::Readback(
                    ReadbackError::InvalidObservationSeconds
                ))
            ));
            assert!(exchange.observed().is_empty());
            assert!(schedule.waits().is_empty());
        }
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
            stable_readback_observation_seconds: 5,
            activation_sequence: 1,
        }
    }

    fn transport_activation() -> ExecutionActivationIdentity {
        let snapshot = claimed_snapshot_value();
        let claim = snapshot["claim"].as_object().expect("test claim object");
        let authorization_id_sha256 = claim["authorizationIdSha256"].as_str().unwrap().to_owned();
        let claim_digest_sha256 = claim["claimDigestSha256"].as_str().unwrap().to_owned();
        let claim_owner_sha256 = claim["claimOwnerSha256"].as_str().unwrap().to_owned();
        let ledger_identity_sha256 = claim["ledgerIdentitySha256"].as_str().unwrap().to_owned();
        let request = canonical_json(&serde_json::json!({
            "schemaVersion": 1,
            "contract": "cinatoken-ring-transition-claim-request-v1",
            "claim": {
                "authorizationIdSha256": authorization_id_sha256,
                "claimDigestSha256": claim_digest_sha256,
                "claimOwnerSha256": claim_owner_sha256,
                "ledgerIdentitySha256": ledger_identity_sha256,
            },
            "permit": {
                "marker": "transport-fixture-only",
            },
        }))
        .expect("canonical frozen claim request")
        .into_bytes();
        ExecutionActivationIdentity::for_transport_test(
            request,
            authorization_id_sha256,
            claim_digest_sha256,
            claim_owner_sha256,
            ledger_identity_sha256,
            NOW,
            NOW + 300,
        )
    }

    fn claim_create_response(
        status: StatusCode,
        result: &str,
        request_id: &str,
        activation: &ExecutionActivationIdentity,
        identity: &CredentialIdentity,
    ) -> BoundedHttpResponse {
        scripted_json(
            status,
            serde_json::json!({
                "result": result,
                "requestId": request_id,
                "claim": {
                    "authorizationIdSha256": activation.authorization_id_sha256(),
                    "claimDigestSha256": activation.claim_digest_sha256(),
                    "claimOwnerSha256": activation.claim_owner_sha256(),
                    "ledgerIdentitySha256": activation.ledger_identity_sha256(),
                    "claimCredentialIdSha256": identity.claim_credential_id_sha256,
                    "status": "claimed",
                    "stateVersion": 0,
                    "generatedAt": activation.claim_generated_at(),
                    "claimedAt": NOW,
                    "expiresAt": activation.claim_expires_at(),
                    "updatedAt": NOW,
                    "terminalAt": null,
                },
                "authorityVersionId": identity.authority_version_id,
            }),
        )
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

    fn claimed_snapshot_value() -> Value {
        let mut snapshot = t1_snapshot_value();
        snapshot["state"]["status"] = Value::String("claimed".to_owned());
        snapshot["state"]["stateVersion"] = Value::from(0);
        snapshot["state"]["updatedAt"] = Value::from(NOW);
        snapshot["state"]["terminalAt"] = Value::Null;
        snapshot["steps"] = Value::Array(Vec::new());
        snapshot["expiryEvents"] = Value::Array(Vec::new());
        snapshot
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

    fn controller_mutation_annotation() -> String {
        format!(
            "cinatoken-ring-v1:{}:2:f129da426a8b40e5fa9f8f8ffb53747a0ed6b4feda21093ef570b8fe847aa293",
            "1".repeat(64)
        )
    }

    fn stable_readback_responses(
        annotation: &str,
    ) -> Vec<Result<BoundedHttpResponse, ExchangeError>> {
        let deployment = || {
            Ok(scripted_json(
                StatusCode::OK,
                serde_json::json!({
                    "success": true,
                    "result": {
                        "deployments": [{
                            "id": "deployment-controller-002",
                            "strategy": "percentage",
                            "versions": [{
                                "version_id": "controller-version-002",
                                "percentage": 100,
                            }],
                            "annotations": {
                                "workers/message": annotation,
                            },
                        }],
                    },
                }),
            ))
        };
        let version = || {
            Ok(scripted_json(
                StatusCode::OK,
                serde_json::json!({
                    "success": true,
                    "result": {
                        "id": "controller-version-002",
                        "compatibility_date": "2026-07-01",
                        "usage_model": "standard",
                    },
                }),
            ))
        };
        vec![deployment(), version(), deployment(), version()]
    }

    fn baseline_payloads(service_name: &str, version_id: &str) -> (Value, Value) {
        (
            serde_json::json!({
                "success": true,
                "result": {
                    "deployments": [{
                        "id": format!("deployment-{service_name}-previous"),
                        "strategy": "percentage",
                        "versions": [{
                            "version_id": version_id,
                            "percentage": 100,
                        }],
                        "annotations": {
                            "workers/message": "historical deployment",
                        },
                    }],
                },
            }),
            serde_json::json!({
                "success": true,
                "result": {
                    "id": version_id,
                    "compatibility_date": "2026-07-01",
                    "usage_model": "standard",
                },
            }),
        )
    }

    fn stable_baseline_responses(
        service_name: &str,
        version_id: &str,
    ) -> Vec<Result<BoundedHttpResponse, ExchangeError>> {
        let (deployment, version) = baseline_payloads(service_name, version_id);
        vec![
            Ok(scripted_json(StatusCode::OK, deployment.clone())),
            Ok(scripted_json(StatusCode::OK, version.clone())),
            Ok(scripted_json(StatusCode::OK, deployment)),
            Ok(scripted_json(StatusCode::OK, version)),
        ]
    }

    fn baseline_readback_decision(
        service_name: &str,
        version_id: &str,
        expected_deployment_set_sha256: Option<&str>,
    ) -> crate::readback::BaselineReadbackDecision {
        let (deployment, version) = baseline_payloads(service_name, version_id);
        let deployment = canonical_json(&deployment)
            .expect("canonical baseline deployment")
            .into_bytes();
        let version = canonical_json(&version)
            .expect("canonical baseline version")
            .into_bytes();
        let snapshot = ReadbackSnapshot::from_json(service_name, version_id, &deployment, &version)
            .expect("normalized baseline snapshot");
        let expected = expected_deployment_set_sha256
            .unwrap_or_else(|| snapshot.deployment_set_sha256())
            .to_owned();
        StableBaselineReadbackPair::new(
            service_name,
            version_id,
            &expected,
            5,
            crate::readback::ObservedReadback::new(1_000, snapshot.clone())
                .expect("first baseline observation"),
            crate::readback::ObservedReadback::new(1_005, snapshot)
                .expect("second baseline observation"),
        )
        .expect("stable baseline pair")
        .evaluate()
        .expect("baseline decision")
    }

    fn claimed_snapshot_value_with_controller_baseline(
        previous_deployment_set_sha256: &str,
    ) -> Value {
        let mut snapshot = claimed_snapshot_value();
        snapshot["claim"]["controller"]["previousDeploymentSetSha256"] =
            Value::String(previous_deployment_set_sha256.to_owned());
        let claim: orchestrator::SnapshotClaim =
            serde_json::from_value(snapshot["claim"].clone()).expect("snapshot claim");
        let claim_digest =
            orchestrator::activation_claim_digest(&claim).expect("refreshed claim digest");
        snapshot["claim"]["claimDigestSha256"] = Value::String(claim_digest.clone());
        snapshot["state"]["claimDigestSha256"] = Value::String(claim_digest);
        snapshot
    }

    fn claimed_snapshot_with_controller_baseline(
        previous_deployment_set_sha256: &str,
    ) -> VerifiedSnapshot {
        verified_snapshot(&claimed_snapshot_value_with_controller_baseline(
            previous_deployment_set_sha256,
        ))
    }

    fn advanced_baseline_snapshot_value<P: orchestrator::BaselineReadbackPhase>(
        mut claimed: Value,
        attempt: &orchestrator::BaselineReadbackAppendAttempt<P>,
        recorded_at: u64,
    ) -> Value {
        claimed["state"]["status"] =
            serde_json::to_value(attempt.step().to_status).expect("baseline status");
        claimed["state"]["stateVersion"] = Value::from(attempt.step().state_version);
        claimed["state"]["updatedAt"] = Value::from(recorded_at);
        claimed["state"]["terminalAt"] = if attempt.step().to_status.is_terminal() {
            Value::from(recorded_at)
        } else {
            Value::Null
        };
        let actor_execution_id_sha256 = claimed["claim"]["claimOwnerSha256"].clone();
        claimed["steps"] = Value::Array(vec![serde_json::json!({
            "stateVersion": attempt.step().state_version,
            "stepCode": attempt.step().step_code,
            "fromStatus": attempt.step().from_status,
            "toStatus": attempt.step().to_status,
            "actorExecutionIdSha256": actor_execution_id_sha256,
            "mutationRequestSha256": attempt.step().mutation_request_sha256,
            "cloudflareRequestIdSha256": attempt.step().cloudflare_request_id_sha256,
            "deploymentSetSha256": attempt.step().deployment_set_sha256,
            "evidenceSha256": attempt.step().evidence_sha256,
            "failureClass": attempt.step().failure_class,
            "transportOutcome": attempt.step().transport_outcome,
            "stepDigestSha256": attempt.step().step_digest_sha256,
            "recordedAt": recorded_at,
        })]);
        claimed
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
