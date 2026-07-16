//! Default-off Container cross-store replay and divergence classification.

use worker::{Env, Response};

use crate::container_artifacts::{
    inspect_container_client_response, read_verified_container_client_response,
    validate_container_client_response_manifest, ContainerArtifactManifest,
    ContainerClientResponseManifest, ContainerClientResponseObjectState,
};
use crate::d1_repositories::{
    relay_container_financial_receipt_integrity_valid, RelayContainerFinancialTerminalReceipt,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContainerD1Observation {
    Active,
    RecoveryRequired,
    TerminalWithReceipt,
    LegacyTerminalWithoutReceipt,
    ContractViolation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContainerDoObservation {
    Unavailable,
    NotFound,
    InFlight,
    RecoveryRequired,
    MatchingTerminal,
    DefinitiveTerminal,
    ConflictingTerminal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContainerResponseObservation {
    NotExpected,
    Missing,
    Matching,
    Divergent,
    Orphan,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContainerDivergenceClass {
    ConvergedReplayable,
    PendingDoAbsent,
    PendingDoInFlight,
    D1LaggingTerminal,
    RecoveryPending,
    RecoveryResolvable,
    TerminalDoAbsent,
    TerminalConflict,
    TerminalResponseMissing,
    TerminalResponseDivergent,
    ResponseR2Orphan,
    LegacyTerminalWithoutReceipt,
    StoreUnavailable,
    ContractViolation,
}

pub fn classify_container_divergence(
    d1: ContainerD1Observation,
    controller: ContainerDoObservation,
    response: ContainerResponseObservation,
) -> ContainerDivergenceClass {
    if d1 == ContainerD1Observation::ContractViolation {
        return ContainerDivergenceClass::ContractViolation;
    }
    if d1 == ContainerD1Observation::LegacyTerminalWithoutReceipt {
        return ContainerDivergenceClass::LegacyTerminalWithoutReceipt;
    }
    if controller == ContainerDoObservation::Unavailable {
        return ContainerDivergenceClass::StoreUnavailable;
    }
    match d1 {
        ContainerD1Observation::Active => match response {
            ContainerResponseObservation::Orphan => ContainerDivergenceClass::ResponseR2Orphan,
            ContainerResponseObservation::NotExpected => match controller {
                ContainerDoObservation::NotFound => ContainerDivergenceClass::PendingDoAbsent,
                ContainerDoObservation::InFlight => ContainerDivergenceClass::PendingDoInFlight,
                ContainerDoObservation::RecoveryRequired
                | ContainerDoObservation::MatchingTerminal
                | ContainerDoObservation::DefinitiveTerminal => {
                    ContainerDivergenceClass::D1LaggingTerminal
                }
                ContainerDoObservation::ConflictingTerminal => {
                    ContainerDivergenceClass::TerminalConflict
                }
                ContainerDoObservation::Unavailable => ContainerDivergenceClass::StoreUnavailable,
            },
            _ => ContainerDivergenceClass::ContractViolation,
        },
        ContainerD1Observation::RecoveryRequired => match response {
            ContainerResponseObservation::Orphan => ContainerDivergenceClass::ResponseR2Orphan,
            ContainerResponseObservation::NotExpected => match controller {
                ContainerDoObservation::NotFound => ContainerDivergenceClass::PendingDoAbsent,
                ContainerDoObservation::InFlight | ContainerDoObservation::RecoveryRequired => {
                    ContainerDivergenceClass::RecoveryPending
                }
                ContainerDoObservation::MatchingTerminal
                | ContainerDoObservation::DefinitiveTerminal => {
                    ContainerDivergenceClass::RecoveryResolvable
                }
                ContainerDoObservation::ConflictingTerminal => {
                    ContainerDivergenceClass::TerminalConflict
                }
                ContainerDoObservation::Unavailable => ContainerDivergenceClass::StoreUnavailable,
            },
            _ => ContainerDivergenceClass::ContractViolation,
        },
        ContainerD1Observation::TerminalWithReceipt => match response {
            ContainerResponseObservation::Missing => {
                ContainerDivergenceClass::TerminalResponseMissing
            }
            ContainerResponseObservation::Divergent => {
                ContainerDivergenceClass::TerminalResponseDivergent
            }
            ContainerResponseObservation::Matching => match controller {
                ContainerDoObservation::MatchingTerminal => {
                    ContainerDivergenceClass::ConvergedReplayable
                }
                ContainerDoObservation::NotFound => ContainerDivergenceClass::TerminalDoAbsent,
                ContainerDoObservation::ConflictingTerminal
                | ContainerDoObservation::InFlight
                | ContainerDoObservation::RecoveryRequired
                | ContainerDoObservation::DefinitiveTerminal => {
                    ContainerDivergenceClass::TerminalConflict
                }
                ContainerDoObservation::Unavailable => ContainerDivergenceClass::StoreUnavailable,
            },
            ContainerResponseObservation::NotExpected | ContainerResponseObservation::Orphan => {
                ContainerDivergenceClass::ContractViolation
            }
        },
        ContainerD1Observation::LegacyTerminalWithoutReceipt => {
            ContainerDivergenceClass::LegacyTerminalWithoutReceipt
        }
        ContainerD1Observation::ContractViolation => ContainerDivergenceClass::ContractViolation,
    }
}

pub fn client_response_manifest_from_receipt(
    receipt: &RelayContainerFinancialTerminalReceipt,
) -> worker::Result<Option<ContainerClientResponseManifest>> {
    if !relay_container_financial_receipt_integrity_valid(receipt) {
        return Err(reconciliation_error(
            "container terminal receipt integrity check failed",
        ));
    }
    let fields = [
        receipt.client_response_status.is_some(),
        receipt.client_response_headers_json.is_some(),
        receipt.client_response_headers_sha256.is_some(),
        receipt.client_response_object_key.is_some(),
        receipt.client_response_object_version.is_some(),
        receipt.client_response_sha256.is_some(),
        receipt.client_response_size.is_some(),
        receipt.client_response_content_type.is_some(),
    ];
    if fields.iter().all(|present| !present) {
        if receipt.billing_action == "recovery_required"
            && receipt.operation_status == "recovery_required"
        {
            return Ok(None);
        }
        return Err(reconciliation_error(
            "container terminal receipt is missing a client response",
        ));
    }
    if !fields.iter().all(|present| *present) || receipt.billing_action == "recovery_required" {
        return Err(reconciliation_error(
            "container terminal receipt has a partial client response",
        ));
    }
    let status = u16::try_from(receipt.client_response_status.unwrap_or_default())
        .map_err(|_| reconciliation_error("container client response status is invalid"))?;
    if receipt.operation_response_status != Some(i64::from(status)) {
        return Err(reconciliation_error(
            "container client response status does not match the operation",
        ));
    }
    let size = u64::try_from(receipt.client_response_size.unwrap_or_default())
        .map_err(|_| reconciliation_error("container client response size is invalid"))?;
    let manifest = ContainerClientResponseManifest {
        status,
        headers_json: receipt
            .client_response_headers_json
            .clone()
            .unwrap_or_default(),
        headers_sha256: receipt
            .client_response_headers_sha256
            .clone()
            .unwrap_or_default(),
        body: ContainerArtifactManifest {
            object_key: receipt
                .client_response_object_key
                .clone()
                .unwrap_or_default(),
            object_version: receipt
                .client_response_object_version
                .clone()
                .unwrap_or_default(),
            sha256: receipt.client_response_sha256.clone().unwrap_or_default(),
            size,
            content_type: receipt
                .client_response_content_type
                .clone()
                .unwrap_or_default(),
        },
    };
    validate_container_client_response_manifest(
        &receipt.operation_id,
        receipt.owner_generation,
        &manifest,
    )?;
    Ok(Some(manifest))
}

pub async fn inspect_receipt_client_response(
    env: &Env,
    receipt: &RelayContainerFinancialTerminalReceipt,
) -> worker::Result<ContainerResponseObservation> {
    let Some(manifest) = client_response_manifest_from_receipt(receipt)? else {
        return Ok(ContainerResponseObservation::NotExpected);
    };
    Ok(
        match inspect_container_client_response(
            env,
            &receipt.operation_id,
            receipt.owner_generation,
            &manifest,
        )
        .await?
        {
            ContainerClientResponseObjectState::Missing => ContainerResponseObservation::Missing,
            ContainerClientResponseObjectState::Matching => ContainerResponseObservation::Matching,
            ContainerClientResponseObjectState::Divergent => {
                ContainerResponseObservation::Divergent
            }
        },
    )
}

pub async fn replay_receipt_client_response(
    env: &Env,
    receipt: &RelayContainerFinancialTerminalReceipt,
) -> worker::Result<Option<Response>> {
    let Some(manifest) = client_response_manifest_from_receipt(receipt)? else {
        return Ok(None);
    };
    read_verified_container_client_response(
        env,
        &receipt.operation_id,
        receipt.owner_generation,
        &manifest,
    )
    .await
    .map(Some)
}

fn reconciliation_error(message: &str) -> worker::Error {
    worker::Error::RustError(message.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn divergence_classifier_is_fail_closed_across_all_stores() {
        let cases = [
            (
                ContainerD1Observation::Active,
                ContainerDoObservation::NotFound,
                ContainerResponseObservation::NotExpected,
                ContainerDivergenceClass::PendingDoAbsent,
            ),
            (
                ContainerD1Observation::Active,
                ContainerDoObservation::InFlight,
                ContainerResponseObservation::NotExpected,
                ContainerDivergenceClass::PendingDoInFlight,
            ),
            (
                ContainerD1Observation::Active,
                ContainerDoObservation::DefinitiveTerminal,
                ContainerResponseObservation::NotExpected,
                ContainerDivergenceClass::D1LaggingTerminal,
            ),
            (
                ContainerD1Observation::RecoveryRequired,
                ContainerDoObservation::RecoveryRequired,
                ContainerResponseObservation::NotExpected,
                ContainerDivergenceClass::RecoveryPending,
            ),
            (
                ContainerD1Observation::RecoveryRequired,
                ContainerDoObservation::DefinitiveTerminal,
                ContainerResponseObservation::NotExpected,
                ContainerDivergenceClass::RecoveryResolvable,
            ),
            (
                ContainerD1Observation::TerminalWithReceipt,
                ContainerDoObservation::MatchingTerminal,
                ContainerResponseObservation::Matching,
                ContainerDivergenceClass::ConvergedReplayable,
            ),
            (
                ContainerD1Observation::TerminalWithReceipt,
                ContainerDoObservation::NotFound,
                ContainerResponseObservation::Matching,
                ContainerDivergenceClass::TerminalDoAbsent,
            ),
            (
                ContainerD1Observation::TerminalWithReceipt,
                ContainerDoObservation::ConflictingTerminal,
                ContainerResponseObservation::Matching,
                ContainerDivergenceClass::TerminalConflict,
            ),
            (
                ContainerD1Observation::TerminalWithReceipt,
                ContainerDoObservation::MatchingTerminal,
                ContainerResponseObservation::Missing,
                ContainerDivergenceClass::TerminalResponseMissing,
            ),
            (
                ContainerD1Observation::TerminalWithReceipt,
                ContainerDoObservation::MatchingTerminal,
                ContainerResponseObservation::Divergent,
                ContainerDivergenceClass::TerminalResponseDivergent,
            ),
            (
                ContainerD1Observation::Active,
                ContainerDoObservation::InFlight,
                ContainerResponseObservation::Orphan,
                ContainerDivergenceClass::ResponseR2Orphan,
            ),
            (
                ContainerD1Observation::LegacyTerminalWithoutReceipt,
                ContainerDoObservation::NotFound,
                ContainerResponseObservation::NotExpected,
                ContainerDivergenceClass::LegacyTerminalWithoutReceipt,
            ),
            (
                ContainerD1Observation::TerminalWithReceipt,
                ContainerDoObservation::Unavailable,
                ContainerResponseObservation::Matching,
                ContainerDivergenceClass::StoreUnavailable,
            ),
            (
                ContainerD1Observation::Active,
                ContainerDoObservation::InFlight,
                ContainerResponseObservation::Matching,
                ContainerDivergenceClass::ContractViolation,
            ),
        ];
        for (d1, controller, response, expected) in cases {
            assert_eq!(
                classify_container_divergence(d1, controller, response),
                expected
            );
        }
    }
}
