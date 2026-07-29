-- Enforce immutable, campaign-bound evidence before a traffic-return review
-- receipt can be appended.
--
-- This migration is intentionally default-inert. It adds no application
-- writer and does not authorize traffic. The existing 0067 receipt remains an
-- eligibility-only record with traffic_return_authorized fixed to zero.

CREATE TABLE relay_container_traffic_return_evidence_subjects (
  evidence_subject_id_sha256 TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(evidence_subject_id_sha256) = 'text'
      AND length(evidence_subject_id_sha256) = 64
      AND evidence_subject_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  campaign_id TEXT NOT NULL UNIQUE,
  contract_version INTEGER NOT NULL
    CHECK (typeof(contract_version) = 'integer' AND contract_version = 1),
  subject_contract TEXT NOT NULL
    CHECK (
      subject_contract =
        'relay-container-traffic-return-evidence-subject-v1'
    ),
  evidence_enforcement_migration TEXT NOT NULL
    CHECK (
      evidence_enforcement_migration =
        '0069_relay_container_traffic_return_evidence_enforce.sql'
    ),
  environment TEXT NOT NULL
    CHECK (environment IN ('staging', 'production')),
  scope_kind TEXT NOT NULL
    CHECK (scope_kind IN ('global', 'tenant', 'group')),
  scope_id_sha256 TEXT NOT NULL,
  fence_generation INTEGER NOT NULL
    CHECK (typeof(fence_generation) = 'integer' AND fence_generation > 0),
  admission_fence_id_sha256 TEXT NOT NULL,
  accepted_set_manifest_sha256 TEXT NOT NULL,
  first_observation_id_sha256 TEXT NOT NULL,
  second_observation_id_sha256 TEXT NOT NULL,
  reverse_sync_manifest_id_sha256 TEXT NOT NULL,
  member_closure_manifest_sha256 TEXT NOT NULL,
  quarantine_manifest_sha256 TEXT NOT NULL,
  billing_conservation_sha256 TEXT NOT NULL,
  operation14_receipt_sha256 TEXT NOT NULL,
  operation14_baseline_sha256 TEXT NOT NULL,
  evidence_policy_sha256 TEXT NOT NULL,
  evidence_window_started_at INTEGER NOT NULL
    CHECK (
      typeof(evidence_window_started_at) = 'integer'
      AND evidence_window_started_at > 0
    ),
  evidence_window_ends_at INTEGER NOT NULL
    CHECK (
      typeof(evidence_window_ends_at) = 'integer'
      AND evidence_window_ends_at > 0
    ),
  review_expires_at INTEGER NOT NULL
    CHECK (
      typeof(review_expires_at) = 'integer'
      AND review_expires_at > 0
    ),
  retention_until INTEGER NOT NULL
    CHECK (
      typeof(retention_until) = 'integer'
      AND retention_until > 0
    ),
  assembler_identity_sha256 TEXT NOT NULL,
  subject_digest_sha256 TEXT NOT NULL UNIQUE,
  created_by_admin_id INTEGER NOT NULL
    CHECK (
      typeof(created_by_admin_id) = 'integer'
      AND created_by_admin_id > 0
    ),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(created_at) = 'integer' AND created_at > 0),
  FOREIGN KEY (campaign_id)
    REFERENCES relay_container_drain_campaigns(campaign_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (first_observation_id_sha256)
    REFERENCES relay_container_drain_observations(observation_id_sha256)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (second_observation_id_sha256)
    REFERENCES relay_container_drain_observations(observation_id_sha256)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (reverse_sync_manifest_id_sha256)
    REFERENCES relay_container_reverse_sync_manifests(manifest_id_sha256)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (first_observation_id_sha256 <> second_observation_id_sha256),
  CHECK (
    evidence_window_started_at <= created_at
    AND evidence_window_ends_at = review_expires_at
    AND review_expires_at >= created_at + 300
    AND review_expires_at <= created_at + 86400
    AND retention_until > review_expires_at
  ),
  CHECK (
    length(scope_id_sha256) = 64
    AND length(admission_fence_id_sha256) = 64
    AND length(accepted_set_manifest_sha256) = 64
    AND length(first_observation_id_sha256) = 64
    AND length(second_observation_id_sha256) = 64
    AND length(reverse_sync_manifest_id_sha256) = 64
    AND length(member_closure_manifest_sha256) = 64
    AND length(quarantine_manifest_sha256) = 64
    AND length(billing_conservation_sha256) = 64
    AND length(operation14_receipt_sha256) = 64
    AND length(operation14_baseline_sha256) = 64
    AND length(evidence_policy_sha256) = 64
    AND length(assembler_identity_sha256) = 64
    AND length(subject_digest_sha256) = 64
    AND (
      scope_id_sha256
      || admission_fence_id_sha256
      || accepted_set_manifest_sha256
      || first_observation_id_sha256
      || second_observation_id_sha256
      || reverse_sync_manifest_id_sha256
      || member_closure_manifest_sha256
      || quarantine_manifest_sha256
      || billing_conservation_sha256
      || operation14_receipt_sha256
      || operation14_baseline_sha256
      || evidence_policy_sha256
      || assembler_identity_sha256
      || subject_digest_sha256
    ) NOT GLOB '*[^0-9a-f]*'
  )
) WITHOUT ROWID;

CREATE TABLE relay_container_traffic_return_evidence_items (
  evidence_id_sha256 TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(evidence_id_sha256) = 'text'
      AND length(evidence_id_sha256) = 64
      AND evidence_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  evidence_subject_id_sha256 TEXT NOT NULL,
  contract_version INTEGER NOT NULL
    CHECK (typeof(contract_version) = 'integer' AND contract_version = 1),
  evidence_contract TEXT NOT NULL
    CHECK (
      evidence_contract = 'relay-container-traffic-return-evidence-item-v1'
    ),
  evidence_type TEXT NOT NULL
    CHECK (
      evidence_type IN (
        'go_vps_readiness',
        'traffic_rehearsal',
        'slo',
        'security',
        'finance',
        'release',
        'retention',
        'worm_location'
      )
    ),
  issuer_role TEXT NOT NULL
    CHECK (
      issuer_role IN (
        'go-vps-owner',
        'traffic-owner',
        'sre',
        'security',
        'finance',
        'release',
        'retention',
        'worm-custodian'
      )
    ),
  artifact_sha256 TEXT NOT NULL,
  approval_digest_sha256 TEXT NOT NULL,
  issuer_identity_sha256 TEXT NOT NULL,
  signing_key_sha256 TEXT NOT NULL,
  signature_envelope_sha256 TEXT NOT NULL,
  canonical_digest_sha256 TEXT NOT NULL UNIQUE,
  captured_at INTEGER NOT NULL
    CHECK (typeof(captured_at) = 'integer' AND captured_at > 0),
  valid_from INTEGER NOT NULL
    CHECK (typeof(valid_from) = 'integer' AND valid_from > 0),
  valid_until INTEGER NOT NULL
    CHECK (typeof(valid_until) = 'integer' AND valid_until > 0),
  retention_until INTEGER NOT NULL
    CHECK (
      typeof(retention_until) = 'integer'
      AND retention_until > 0
    ),
  registered_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(registered_at) = 'integer' AND registered_at > 0),
  FOREIGN KEY (evidence_subject_id_sha256)
    REFERENCES relay_container_traffic_return_evidence_subjects(
      evidence_subject_id_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  UNIQUE (evidence_subject_id_sha256, evidence_type),
  UNIQUE (evidence_subject_id_sha256, artifact_sha256),
  UNIQUE (evidence_subject_id_sha256, issuer_identity_sha256),
  UNIQUE (evidence_subject_id_sha256, signing_key_sha256),
  CHECK (
    (
      evidence_type = 'go_vps_readiness'
      AND issuer_role = 'go-vps-owner'
    )
    OR (
      evidence_type = 'traffic_rehearsal'
      AND issuer_role = 'traffic-owner'
    )
    OR (evidence_type = 'slo' AND issuer_role = 'sre')
    OR (evidence_type = 'security' AND issuer_role = 'security')
    OR (evidence_type = 'finance' AND issuer_role = 'finance')
    OR (evidence_type = 'release' AND issuer_role = 'release')
    OR (evidence_type = 'retention' AND issuer_role = 'retention')
    OR (
      evidence_type = 'worm_location'
      AND issuer_role = 'worm-custodian'
    )
  ),
  CHECK (
    captured_at >= valid_from
    AND captured_at <= registered_at
    AND valid_until > registered_at
    AND retention_until > valid_until
  ),
  CHECK (
    length(artifact_sha256) = 64
    AND length(approval_digest_sha256) = 64
    AND length(issuer_identity_sha256) = 64
    AND length(signing_key_sha256) = 64
    AND length(signature_envelope_sha256) = 64
    AND length(canonical_digest_sha256) = 64
    AND (
      artifact_sha256
      || approval_digest_sha256
      || issuer_identity_sha256
      || signing_key_sha256
      || signature_envelope_sha256
      || canonical_digest_sha256
    ) NOT GLOB '*[^0-9a-f]*'
  )
) WITHOUT ROWID;

CREATE TABLE relay_container_traffic_return_evidence_seals (
  evidence_seal_id_sha256 TEXT PRIMARY KEY NOT NULL
    CHECK (
      typeof(evidence_seal_id_sha256) = 'text'
      AND length(evidence_seal_id_sha256) = 64
      AND evidence_seal_id_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  evidence_subject_id_sha256 TEXT NOT NULL UNIQUE,
  contract_version INTEGER NOT NULL
    CHECK (typeof(contract_version) = 'integer' AND contract_version = 1),
  seal_contract TEXT NOT NULL
    CHECK (
      seal_contract = 'relay-container-traffic-return-evidence-seal-v1'
    ),
  evidence_item_count INTEGER NOT NULL
    CHECK (
      typeof(evidence_item_count) = 'integer'
      AND evidence_item_count = 8
    ),
  evidence_manifest_sha256 TEXT NOT NULL UNIQUE,
  worm_location_sha256 TEXT NOT NULL,
  retention_policy_sha256 TEXT NOT NULL,
  retention_until INTEGER NOT NULL
    CHECK (
      typeof(retention_until) = 'integer'
      AND retention_until > 0
    ),
  sealer_role TEXT NOT NULL
    CHECK (sealer_role = 'evidence-custodian'),
  sealer_identity_sha256 TEXT NOT NULL,
  signing_key_sha256 TEXT NOT NULL,
  seal_digest_sha256 TEXT NOT NULL UNIQUE,
  sealed_at INTEGER NOT NULL DEFAULT (unixepoch())
    CHECK (typeof(sealed_at) = 'integer' AND sealed_at > 0),
  FOREIGN KEY (evidence_subject_id_sha256)
    REFERENCES relay_container_traffic_return_evidence_subjects(
      evidence_subject_id_sha256
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (
    length(evidence_manifest_sha256) = 64
    AND length(worm_location_sha256) = 64
    AND length(retention_policy_sha256) = 64
    AND length(sealer_identity_sha256) = 64
    AND length(signing_key_sha256) = 64
    AND length(seal_digest_sha256) = 64
    AND (
      evidence_manifest_sha256
      || worm_location_sha256
      || retention_policy_sha256
      || sealer_identity_sha256
      || signing_key_sha256
      || seal_digest_sha256
    ) NOT GLOB '*[^0-9a-f]*'
  )
) WITHOUT ROWID;

CREATE INDEX idx_relay_container_traffic_return_subject_review
  ON relay_container_traffic_return_evidence_subjects(
    campaign_id,
    review_expires_at
  );

CREATE INDEX idx_relay_container_traffic_return_evidence_type
  ON relay_container_traffic_return_evidence_items(
    evidence_subject_id_sha256,
    evidence_type,
    valid_until
  );

CREATE INDEX idx_relay_container_traffic_return_evidence_retention
  ON relay_container_traffic_return_evidence_items(
    retention_until,
    evidence_subject_id_sha256
  );

CREATE INDEX idx_relay_container_traffic_return_evidence_seal_review
  ON relay_container_traffic_return_evidence_seals(
    evidence_subject_id_sha256,
    sealed_at
  );

CREATE TRIGGER relay_container_traffic_return_evidence_subject_insert_guard
BEFORE INSERT ON relay_container_traffic_return_evidence_subjects
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.created_at <> unixepoch()
  THEN RAISE(
    ABORT,
    'traffic return evidence subject time must come from D1'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_drain_campaigns AS campaign
    JOIN relay_container_drain_events AS membership_event
      ON membership_event.campaign_id = campaign.campaign_id
     AND membership_event.event_code = 'membership_sealed'
    JOIN relay_container_drain_events AS drain_event
      ON drain_event.campaign_id = campaign.campaign_id
     AND drain_event.event_code = 'drain_sealed'
    JOIN relay_container_drain_events AS operation14_event
      ON operation14_event.campaign_id = campaign.campaign_id
     AND operation14_event.event_code = 'operation14_completed'
    JOIN relay_container_drain_observations AS first_observation
      ON first_observation.observation_id_sha256 =
          NEW.first_observation_id_sha256
     AND first_observation.campaign_id = campaign.campaign_id
     AND first_observation.observation_kind = 'global'
    JOIN relay_container_drain_observations AS second_observation
      ON second_observation.observation_id_sha256 =
          NEW.second_observation_id_sha256
     AND second_observation.campaign_id = campaign.campaign_id
     AND second_observation.observation_kind = 'global'
    JOIN relay_container_reverse_sync_manifests AS reverse_sync
      ON reverse_sync.manifest_id_sha256 =
          NEW.reverse_sync_manifest_id_sha256
     AND reverse_sync.campaign_id = campaign.campaign_id
     AND reverse_sync.status = 'passed'
    WHERE campaign.campaign_id = NEW.campaign_id
      AND campaign.state = 'operation14_complete'
      AND campaign.environment = NEW.environment
      AND campaign.scope_kind = NEW.scope_kind
      AND campaign.scope_id_sha256 = NEW.scope_id_sha256
      AND campaign.fence_generation = NEW.fence_generation
      AND campaign.admission_fence_id_sha256 =
            NEW.admission_fence_id_sha256
      AND campaign.accepted_set_manifest_sha256 =
            NEW.accepted_set_manifest_sha256
      AND membership_event.membership_manifest_sha256 =
            NEW.accepted_set_manifest_sha256
      AND drain_event.first_observation_id_sha256 =
            NEW.first_observation_id_sha256
      AND drain_event.second_observation_id_sha256 =
            NEW.second_observation_id_sha256
      AND drain_event.reverse_sync_manifest_id_sha256 =
            NEW.reverse_sync_manifest_id_sha256
      AND first_observation.member_closure_manifest_sha256 =
            NEW.member_closure_manifest_sha256
      AND second_observation.member_closure_manifest_sha256 =
            NEW.member_closure_manifest_sha256
      AND first_observation.quarantine_manifest_sha256 =
            NEW.quarantine_manifest_sha256
      AND second_observation.quarantine_manifest_sha256 =
            NEW.quarantine_manifest_sha256
      AND first_observation.billing_conservation_sha256 =
            NEW.billing_conservation_sha256
      AND second_observation.billing_conservation_sha256 =
            NEW.billing_conservation_sha256
      AND operation14_event.operation14_receipt_sha256 =
            NEW.operation14_receipt_sha256
      AND operation14_event.operation14_baseline_sha256 =
            NEW.operation14_baseline_sha256
      AND NEW.evidence_window_started_at >= operation14_event.recorded_at
  ) THEN RAISE(
    ABORT,
    'traffic return evidence subject does not match sealed campaign'
  ) END;
END;

CREATE TRIGGER relay_container_traffic_return_evidence_subject_update_guard
BEFORE UPDATE ON relay_container_traffic_return_evidence_subjects
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'traffic return evidence subjects are immutable');
END;

CREATE TRIGGER relay_container_traffic_return_evidence_subject_delete_guard
BEFORE DELETE ON relay_container_traffic_return_evidence_subjects
FOR EACH ROW
BEGIN
  SELECT RAISE(
    ABORT,
    'traffic return evidence subjects are append-preserved'
  );
END;

CREATE TRIGGER relay_container_traffic_return_evidence_item_insert_guard
BEFORE INSERT ON relay_container_traffic_return_evidence_items
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.registered_at <> unixepoch()
  THEN RAISE(
    ABORT,
    'traffic return evidence item time must come from D1'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM relay_container_traffic_return_evidence_seals AS seal
    WHERE seal.evidence_subject_id_sha256 =
          NEW.evidence_subject_id_sha256
  ) THEN RAISE(
    ABORT,
    'sealed traffic return evidence cannot accept another item'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_traffic_return_evidence_subjects AS subject
    WHERE subject.evidence_subject_id_sha256 =
          NEW.evidence_subject_id_sha256
      AND NEW.captured_at >= subject.evidence_window_started_at
      AND NEW.captured_at <= subject.evidence_window_ends_at
      AND NEW.registered_at <= subject.review_expires_at
      AND NEW.valid_from <= subject.created_at
      AND NEW.valid_until >= subject.review_expires_at
      AND NEW.retention_until >= subject.retention_until
      AND NEW.issuer_identity_sha256 <>
            subject.assembler_identity_sha256
  ) THEN RAISE(
    ABORT,
    'traffic return evidence item is outside its subject contract'
  ) END;
END;

CREATE TRIGGER relay_container_traffic_return_evidence_item_update_guard
BEFORE UPDATE ON relay_container_traffic_return_evidence_items
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'traffic return evidence items are immutable');
END;

CREATE TRIGGER relay_container_traffic_return_evidence_item_delete_guard
BEFORE DELETE ON relay_container_traffic_return_evidence_items
FOR EACH ROW
BEGIN
  SELECT RAISE(
    ABORT,
    'traffic return evidence items are append-preserved'
  );
END;

CREATE TRIGGER relay_container_traffic_return_evidence_seal_insert_guard
BEFORE INSERT ON relay_container_traffic_return_evidence_seals
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.sealed_at <> unixepoch()
  THEN RAISE(
    ABORT,
    'traffic return evidence seal time must come from D1'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_traffic_return_evidence_subjects AS subject
    WHERE subject.evidence_subject_id_sha256 =
          NEW.evidence_subject_id_sha256
      AND NEW.sealed_at >= subject.created_at
      AND NEW.sealed_at <= subject.review_expires_at
      AND NEW.retention_until >= subject.retention_until
      AND NEW.sealer_identity_sha256 <>
            subject.assembler_identity_sha256
  ) THEN RAISE(
    ABORT,
    'traffic return evidence seal is outside its subject contract'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM relay_container_traffic_return_evidence_items AS item
    WHERE item.evidence_subject_id_sha256 =
          NEW.evidence_subject_id_sha256
      AND item.registered_at <= NEW.sealed_at
      AND item.valid_from <= NEW.sealed_at
      AND item.valid_until >= NEW.sealed_at
      AND item.retention_until >= NEW.retention_until
  ) <> 8 THEN RAISE(
    ABORT,
    'traffic return evidence seal requires eight valid retained items'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(DISTINCT item.evidence_type)
    FROM relay_container_traffic_return_evidence_items AS item
    WHERE item.evidence_subject_id_sha256 =
          NEW.evidence_subject_id_sha256
      AND item.evidence_type IN (
        'go_vps_readiness',
        'traffic_rehearsal',
        'slo',
        'security',
        'finance',
        'release',
        'retention',
        'worm_location'
      )
  ) <> 8 THEN RAISE(
    ABORT,
    'traffic return evidence seal is missing a required evidence type'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM relay_container_traffic_return_evidence_items AS item
    WHERE item.evidence_subject_id_sha256 =
          NEW.evidence_subject_id_sha256
      AND (
        item.issuer_identity_sha256 = NEW.sealer_identity_sha256
        OR item.signing_key_sha256 = NEW.signing_key_sha256
      )
  ) THEN RAISE(
    ABORT,
    'traffic return evidence sealer must be independent'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_traffic_return_evidence_items AS retention_item
    JOIN relay_container_traffic_return_evidence_items AS worm_item
      ON worm_item.evidence_subject_id_sha256 =
          retention_item.evidence_subject_id_sha256
     AND worm_item.evidence_type = 'worm_location'
    WHERE retention_item.evidence_subject_id_sha256 =
          NEW.evidence_subject_id_sha256
      AND retention_item.evidence_type = 'retention'
      AND retention_item.artifact_sha256 =
            NEW.retention_policy_sha256
      AND worm_item.artifact_sha256 = NEW.worm_location_sha256
  ) THEN RAISE(
    ABORT,
    'traffic return evidence seal retention or WORM identity mismatch'
  ) END;
END;

CREATE TRIGGER relay_container_traffic_return_evidence_seal_update_guard
BEFORE UPDATE ON relay_container_traffic_return_evidence_seals
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'traffic return evidence seals are immutable');
END;

CREATE TRIGGER relay_container_traffic_return_evidence_seal_delete_guard
BEFORE DELETE ON relay_container_traffic_return_evidence_seals
FOR EACH ROW
BEGIN
  SELECT RAISE(
    ABORT,
    'traffic return evidence seals are append-preserved'
  );
END;

DROP TRIGGER relay_container_traffic_return_receipt_insert_guard;

CREATE TRIGGER relay_container_traffic_return_receipt_insert_guard
BEFORE INSERT ON relay_container_traffic_return_receipts
FOR EACH ROW
BEGIN
  SELECT CASE WHEN NEW.issued_at <> unixepoch()
  THEN RAISE(ABORT, 'traffic return receipt time must come from D1') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM d1_migrations
    WHERE name =
      '0069_relay_container_traffic_return_evidence_enforce.sql'
  ) THEN RAISE(
    ABORT,
    'traffic return receipt requires typed evidence enforcement migration 0069'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_drain_campaigns AS campaign
    JOIN relay_container_drain_events AS drain_event
      ON drain_event.campaign_id = campaign.campaign_id
     AND drain_event.event_code = 'drain_sealed'
    JOIN relay_container_drain_events AS operation14_event
      ON operation14_event.campaign_id = campaign.campaign_id
     AND operation14_event.event_code = 'operation14_completed'
    JOIN relay_container_drain_observations AS first_observation
      ON first_observation.observation_id_sha256 =
          NEW.first_observation_id_sha256
     AND first_observation.campaign_id = campaign.campaign_id
     AND first_observation.observation_kind = 'global'
    JOIN relay_container_drain_observations AS second_observation
      ON second_observation.observation_id_sha256 =
          NEW.second_observation_id_sha256
     AND second_observation.campaign_id = campaign.campaign_id
     AND second_observation.observation_kind = 'global'
    JOIN relay_container_reverse_sync_manifests AS reverse_sync
      ON reverse_sync.manifest_id_sha256 =
          NEW.reverse_sync_manifest_id_sha256
     AND reverse_sync.campaign_id = campaign.campaign_id
     AND reverse_sync.status = 'passed'
    WHERE campaign.campaign_id = NEW.campaign_id
      AND campaign.state = 'operation14_complete'
      AND drain_event.first_observation_id_sha256 =
            NEW.first_observation_id_sha256
      AND drain_event.second_observation_id_sha256 =
            NEW.second_observation_id_sha256
      AND drain_event.reverse_sync_manifest_id_sha256 =
            NEW.reverse_sync_manifest_id_sha256
      AND operation14_event.operation14_receipt_sha256 =
            NEW.operation14_receipt_sha256
      AND operation14_event.operation14_baseline_sha256 =
            NEW.operation14_baseline_sha256
      AND NEW.membership_manifest_sha256 = (
        SELECT membership_event.membership_manifest_sha256
        FROM relay_container_drain_events AS membership_event
        WHERE membership_event.campaign_id = campaign.campaign_id
          AND membership_event.event_code = 'membership_sealed'
      )
      AND NEW.member_closure_manifest_sha256 =
            first_observation.member_closure_manifest_sha256
      AND NEW.member_closure_manifest_sha256 =
            second_observation.member_closure_manifest_sha256
      AND NEW.quarantine_manifest_sha256 =
            first_observation.quarantine_manifest_sha256
      AND NEW.quarantine_manifest_sha256 =
            second_observation.quarantine_manifest_sha256
      AND NEW.billing_conservation_sha256 =
            first_observation.billing_conservation_sha256
      AND NEW.billing_conservation_sha256 =
            second_observation.billing_conservation_sha256
  ) THEN RAISE(ABORT, 'traffic return receipt evidence mismatch') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM relay_container_traffic_return_evidence_subjects AS subject
    JOIN relay_container_traffic_return_evidence_seals AS seal
      ON seal.evidence_subject_id_sha256 =
          subject.evidence_subject_id_sha256
    JOIN relay_container_traffic_return_evidence_items AS go_readiness
      ON go_readiness.evidence_subject_id_sha256 =
          subject.evidence_subject_id_sha256
     AND go_readiness.evidence_type = 'go_vps_readiness'
    JOIN relay_container_traffic_return_evidence_items AS rehearsal
      ON rehearsal.evidence_subject_id_sha256 =
          subject.evidence_subject_id_sha256
     AND rehearsal.evidence_type = 'traffic_rehearsal'
    JOIN relay_container_traffic_return_evidence_items AS slo
      ON slo.evidence_subject_id_sha256 =
          subject.evidence_subject_id_sha256
     AND slo.evidence_type = 'slo'
    JOIN relay_container_traffic_return_evidence_items AS security
      ON security.evidence_subject_id_sha256 =
          subject.evidence_subject_id_sha256
     AND security.evidence_type = 'security'
    JOIN relay_container_traffic_return_evidence_items AS finance
      ON finance.evidence_subject_id_sha256 =
          subject.evidence_subject_id_sha256
     AND finance.evidence_type = 'finance'
    JOIN relay_container_traffic_return_evidence_items AS release
      ON release.evidence_subject_id_sha256 =
          subject.evidence_subject_id_sha256
     AND release.evidence_type = 'release'
    JOIN relay_container_traffic_return_evidence_items AS retention
      ON retention.evidence_subject_id_sha256 =
          subject.evidence_subject_id_sha256
     AND retention.evidence_type = 'retention'
    JOIN relay_container_traffic_return_evidence_items AS worm
      ON worm.evidence_subject_id_sha256 =
          subject.evidence_subject_id_sha256
     AND worm.evidence_type = 'worm_location'
    WHERE subject.campaign_id = NEW.campaign_id
      AND subject.accepted_set_manifest_sha256 =
            NEW.membership_manifest_sha256
      AND subject.first_observation_id_sha256 =
            NEW.first_observation_id_sha256
      AND subject.second_observation_id_sha256 =
            NEW.second_observation_id_sha256
      AND subject.reverse_sync_manifest_id_sha256 =
            NEW.reverse_sync_manifest_id_sha256
      AND subject.member_closure_manifest_sha256 =
            NEW.member_closure_manifest_sha256
      AND subject.quarantine_manifest_sha256 =
            NEW.quarantine_manifest_sha256
      AND subject.billing_conservation_sha256 =
            NEW.billing_conservation_sha256
      AND subject.operation14_receipt_sha256 =
            NEW.operation14_receipt_sha256
      AND subject.operation14_baseline_sha256 =
            NEW.operation14_baseline_sha256
      AND go_readiness.artifact_sha256 =
            NEW.go_vps_readiness_sha256
      AND rehearsal.artifact_sha256 =
            NEW.traffic_rehearsal_sha256
      AND slo.approval_digest_sha256 =
            NEW.slo_approval_sha256
      AND security.approval_digest_sha256 =
            NEW.security_approval_sha256
      AND finance.approval_digest_sha256 =
            NEW.finance_approval_sha256
      AND release.approval_digest_sha256 =
            NEW.release_approval_sha256
      AND retention.artifact_sha256 =
            NEW.retention_policy_sha256
      AND worm.artifact_sha256 =
            NEW.immutable_evidence_location_sha256
      AND seal.retention_policy_sha256 =
            NEW.retention_policy_sha256
      AND seal.worm_location_sha256 =
            NEW.immutable_evidence_location_sha256
      AND seal.sealed_at <= NEW.issued_at
      AND NEW.issued_at <= subject.review_expires_at
      AND NEW.issued_at < seal.retention_until
      AND NEW.reviewer_identity_sha256 <>
            subject.assembler_identity_sha256
      AND NEW.reviewer_identity_sha256 <>
            seal.sealer_identity_sha256
      AND NOT EXISTS (
        SELECT 1
        FROM relay_container_traffic_return_evidence_items AS issuer_item
        WHERE issuer_item.evidence_subject_id_sha256 =
              subject.evidence_subject_id_sha256
          AND (
            issuer_item.issuer_identity_sha256 =
              NEW.reviewer_identity_sha256
            OR NEW.issued_at < issuer_item.valid_from
            OR NEW.issued_at > issuer_item.valid_until
            OR NEW.issued_at >= issuer_item.retention_until
          )
      )
  ) THEN RAISE(
    ABORT,
    'traffic return receipt requires complete independent typed evidence'
  ) END;
END;
