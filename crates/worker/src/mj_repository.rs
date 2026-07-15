//! D1-backed Midjourney task repository (the `midjourneys` table from
//! `migrations/d1/0007_midjourneys.sql`).
//!
//! Midjourney is a separate subsystem (Go `model.Midjourney` + `controller/
//! midjourney.go`), not part of the unified `tasks` pipeline. This layer ports
//! its persistence: insert on submit, select unfinished rows for the batch poll,
//! and [`apply_midjourney_poll_result`] — the per-item merge that updates the
//! poll fields and refunds the reserve on a terminal failure, guarded so the
//! refund happens once. Foundation ahead of the mj submit/poll wiring.
#![allow(dead_code)]

use cinatoken_relay::clamp_i64_to_i32 as d1_i32;
use serde::{Deserialize, Serialize};
use worker::{D1Database, D1Type};

pub(crate) const MIDJOURNEY_TIMEOUT_SECONDS: i64 = 3_600;
const MIDJOURNEY_MILLIS_THRESHOLD: i64 = 10_000_000_000;
const MIDJOURNEY_TIMEOUT_SWEEP_MAX_LIMIT: i64 = 64;

pub(crate) fn midjourney_submit_time_seconds(submit_time: i64) -> i64 {
    if submit_time >= MIDJOURNEY_MILLIS_THRESHOLD {
        submit_time.saturating_div(1_000)
    } else {
        submit_time
    }
}

pub(crate) fn midjourney_is_timed_out(submit_time: i64, progress: &str, now: i64) -> bool {
    now.saturating_sub(midjourney_submit_time_seconds(submit_time)) > MIDJOURNEY_TIMEOUT_SECONDS
        && progress != "100%"
}

/// The fields stored when a Midjourney task is submitted. Columns not listed take
/// their `0007_midjourneys.sql` defaults.
pub struct NewMidjourney<'a> {
    pub code: i64,
    pub user_id: i64,
    pub action: &'a str,
    pub mj_id: &'a str,
    pub prompt: &'a str,
    pub prompt_en: &'a str,
    pub channel_id: i64,
    pub quota: i64,
    pub status: &'a str,
    pub progress: &'a str,
    pub submit_time: i64,
    pub properties: &'a str,
    pub billing_reservation_key: &'a str,
}

/// A Midjourney row read back for the batch poll (the subset the settle/merge
/// needs).
#[derive(Debug, Deserialize)]
pub struct MjRow {
    pub id: i64,
    pub code: i64,
    pub user_id: i64,
    pub mj_id: String,
    pub channel_id: i64,
    #[serde(default)]
    pub token_id: i64,
    #[serde(default)]
    pub billing_reservation_key: String,
    pub quota: i64,
    pub status: String,
    pub progress: String,
    pub submit_time: i64,
}

/// The poll-result fields merged onto a Midjourney row (from the upstream
/// `MidjourneyDto`).
pub struct MjPollResult<'a> {
    pub status: &'a str,
    pub progress: &'a str,
    pub fail_reason: &'a str,
    pub image_url: &'a str,
    pub video_url: &'a str,
    pub finish_time: i64,
}

fn is_terminal(status: &str) -> bool {
    status == "SUCCESS" || status == "FAILURE"
}

/// Insert a submitted Midjourney task and account the successful submit once.
pub async fn insert_midjourney(db: &D1Database, mj: &NewMidjourney<'_>) -> worker::Result<()> {
    // D1's Worker binding exposes integer parameters as i32. Midjourney
    // submit_time is millisecond precision in Go, so bind it as text and let
    // SQLite's INTEGER affinity store the full value instead of clamping it.
    let submit_time = mj.submit_time.to_string();
    let args = [
        D1Type::Integer(d1_i32(mj.code)),
        D1Type::Integer(d1_i32(mj.user_id)),
        D1Type::Text(mj.action),
        D1Type::Text(mj.mj_id),
        D1Type::Text(mj.prompt),
        D1Type::Text(mj.prompt_en),
        D1Type::Integer(d1_i32(mj.channel_id)),
        D1Type::Integer(d1_i32(mj.quota)),
        D1Type::Text(mj.status),
        D1Type::Text(mj.progress),
        D1Type::Text(submit_time.as_str()),
        D1Type::Text(mj.properties),
    ];
    let insert = db
        .prepare(
            r#"
        INSERT INTO midjourneys
          (code, user_id, action, mj_id, prompt, prompt_en, channel_id, quota,
           status, progress, submit_time, properties)
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
        WHERE EXISTS (SELECT 1 FROM users WHERE id = ?2)
          AND EXISTS (SELECT 1 FROM channels WHERE id = ?7)
        "#,
        )
        .bind_refs(&args)?;
    let user_args = [
        D1Type::Integer(d1_i32(mj.quota)),
        D1Type::Integer(d1_i32(mj.user_id)),
        D1Type::Text(mj.mj_id),
    ];
    let account_user = db
        .prepare(
            r#"
            UPDATE users
            SET used_quota = used_quota + ?1,
                request_count = request_count + 1
            WHERE id = ?2
              AND EXISTS (SELECT 1 FROM midjourneys WHERE mj_id = ?3)
            "#,
        )
        .bind_refs(&user_args)?;
    let channel_args = [
        D1Type::Integer(d1_i32(mj.quota)),
        D1Type::Integer(d1_i32(mj.channel_id)),
        D1Type::Text(mj.mj_id),
    ];
    let account_channel = db
        .prepare(
            r#"
            UPDATE channels
            SET used_quota = used_quota + ?1
            WHERE id = ?2
              AND EXISTS (SELECT 1 FROM midjourneys WHERE mj_id = ?3)
            "#,
        )
        .bind_refs(&channel_args)?;
    let results = db
        .batch(vec![insert, account_user, account_channel])
        .await?;
    for (index, label) in [
        "midjourney insert",
        "midjourney user accounting",
        "midjourney channel accounting",
    ]
    .into_iter()
    .enumerate()
    {
        let changes = results
            .get(index)
            .ok_or_else(|| worker::Error::RustError(format!("missing {label} result")))?
            .meta()?
            .and_then(|meta| meta.changes)
            .unwrap_or(0);
        if changes != 1 {
            return Err(worker::Error::RustError(format!("{label} did not apply")));
        }
    }
    Ok(())
}

/// Atomically attach a provider-accepted Midjourney row to its pre-provider
/// billing intent. The assertions deliberately turn a zero-row conditional
/// write into a SQL error so D1 rolls the whole batch back.
pub async fn attach_midjourney_billing_intent(
    db: &D1Database,
    mj: &NewMidjourney<'_>,
) -> worker::Result<crate::task_repository::TaskBillingIntentAttachOutcome> {
    use crate::task_repository::{
        assert_task_billing_previous_statement_statement, find_task_billing_intent,
        TaskBillingIntentAttachOutcome,
    };

    let reservation_key = mj.billing_reservation_key.trim();
    if reservation_key.is_empty() || mj.mj_id.trim().is_empty() {
        return Err(worker::Error::RustError(
            "midjourney billing attachment identity is invalid".to_string(),
        ));
    }
    let submit_time = mj.submit_time.to_string();
    let insert_args = [
        D1Type::Integer(d1_i32(mj.code)),
        D1Type::Integer(d1_i32(mj.user_id)),
        D1Type::Text(mj.action),
        D1Type::Text(mj.mj_id),
        D1Type::Text(mj.prompt),
        D1Type::Text(mj.prompt_en),
        D1Type::Integer(d1_i32(mj.channel_id)),
        D1Type::Integer(d1_i32(mj.quota)),
        D1Type::Text(mj.status),
        D1Type::Text(mj.progress),
        D1Type::Text(&submit_time),
        D1Type::Text(mj.properties),
        D1Type::Text(reservation_key),
    ];
    let insert = db
        .prepare(
            r#"
            INSERT INTO midjourneys
              (code, user_id, action, mj_id, prompt, prompt_en, channel_id, quota,
               status, progress, submit_time, properties)
            SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
            WHERE EXISTS (
              SELECT 1 FROM task_billing_intents
              WHERE reservation_key = ?13
                AND task_kind = 'midjourney'
                AND public_task_id = ?13
                AND user_id = ?2
                AND channel_id = ?7
                AND quota = ?8
                AND status = 'reserved'
                AND submit_state = 'submitting'
            )
            "#,
        )
        .bind_refs(&insert_args)?;
    let attached_at = mj.submit_time.saturating_div(1_000);
    let attach_args = [
        D1Type::Text(mj.mj_id),
        D1Type::Integer(d1_i32(attached_at)),
        D1Type::Text(reservation_key),
        D1Type::Integer(d1_i32(mj.user_id)),
        D1Type::Integer(d1_i32(mj.channel_id)),
        D1Type::Integer(d1_i32(mj.quota)),
    ];
    let attach = db
        .prepare(
            r#"
            UPDATE task_billing_intents
            SET status = 'attached',
                submit_state = 'submitted',
                provider_task_id = ?1,
                request_accounted = 1,
                attached_at = ?2,
                updated_at = ?2,
                owner_generation = owner_generation + 1,
                recovery_last_error = ''
            WHERE reservation_key = ?3
              AND task_kind = 'midjourney'
              AND public_task_id = ?3
              AND user_id = ?4
              AND channel_id = ?5
              AND quota = ?6
              AND status = 'reserved'
              AND submit_state = 'submitting'
              AND request_accounted = 0
              AND EXISTS (
                SELECT 1 FROM midjourneys
                WHERE mj_id = ?1
                  AND user_id = ?4
                  AND json_extract(
                    CASE WHEN json_valid(properties) THEN properties ELSE '{}' END,
                    '$.billing_reservation_key'
                  ) = ?3
              )
            "#,
        )
        .bind_refs(&attach_args)?;
    match db
        .batch(vec![
            insert,
            assert_task_billing_previous_statement_statement(db, reservation_key)?,
            attach,
            assert_task_billing_previous_statement_statement(db, reservation_key)?,
        ])
        .await
    {
        Ok(results) => {
            let insert_changed = results
                .first()
                .ok_or_else(|| worker::Error::RustError("missing midjourney insert result".into()))?
                .meta()?
                .and_then(|meta| meta.changes)
                .unwrap_or(0)
                == 1;
            let attach_changed = results
                .get(2)
                .ok_or_else(|| worker::Error::RustError("missing midjourney attach result".into()))?
                .meta()?
                .and_then(|meta| meta.changes)
                .unwrap_or(0)
                == 1;
            if insert_changed && attach_changed {
                return Ok(TaskBillingIntentAttachOutcome::Applied);
            }
        }
        Err(err) => {
            if let Some(intent) = find_task_billing_intent(db, reservation_key).await? {
                if intent.status == "attached"
                    && intent.submit_state == "submitted"
                    && intent.provider_task_id == mj.mj_id
                    && intent.request_accounted == 1
                {
                    return Ok(TaskBillingIntentAttachOutcome::MatchingAttached);
                }
            }
            return Err(err);
        }
    }
    match find_task_billing_intent(db, reservation_key).await? {
        Some(intent)
            if intent.status == "attached"
                && intent.submit_state == "submitted"
                && intent.provider_task_id == mj.mj_id
                && intent.request_accounted == 1 =>
        {
            Ok(TaskBillingIntentAttachOutcome::MatchingAttached)
        }
        Some(_) => Ok(TaskBillingIntentAttachOutcome::Conflict),
        None => Err(worker::Error::RustError(
            "midjourney billing intent disappeared during attachment".to_string(),
        )),
    }
}

/// Attach a provider-confirmed Midjourney task while closing its quarantined
/// submit reconciliation. The immutable event, task row, financial accounting,
/// intent resolution, and administrator audit row commit in one D1 batch.
pub async fn attach_midjourney_billing_reconciliation(
    db: &D1Database,
    mj: &NewMidjourney<'_>,
    event: &crate::task_repository::TaskBillingReconciliationEvent<'_>,
    admin_audit: worker::D1PreparedStatement,
) -> worker::Result<crate::task_repository::TaskBillingReconciliationMutationOutcome> {
    use crate::task_repository::{
        assert_task_billing_previous_statement_statement, task_batch_changed,
        task_billing_reconciliation_event_statement, TaskBillingReconciliationMutationOutcome,
    };

    let event_insert = task_billing_reconciliation_event_statement(db, event)?;
    let submit_time = mj.submit_time.to_string();
    let insert_args = [
        D1Type::Integer(d1_i32(mj.code)),
        D1Type::Integer(d1_i32(mj.user_id)),
        D1Type::Text(mj.action),
        D1Type::Text(mj.mj_id),
        D1Type::Text(mj.prompt),
        D1Type::Text(mj.prompt_en),
        D1Type::Integer(d1_i32(mj.channel_id)),
        D1Type::Integer(d1_i32(mj.quota)),
        D1Type::Text(mj.status),
        D1Type::Text(mj.progress),
        D1Type::Text(&submit_time),
        D1Type::Text(mj.properties),
        D1Type::Text(event.reservation_key),
        D1Type::Text(event.reconciliation_id),
        D1Type::Integer(d1_i32(event.expected_revision)),
    ];
    let insert = db
        .prepare(
            r#"
            INSERT INTO midjourneys
              (code, user_id, action, mj_id, prompt, prompt_en, channel_id,
               quota, status, progress, submit_time, properties)
            SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
            WHERE EXISTS (
              SELECT 1 FROM task_billing_intents
              WHERE reservation_key = ?13
                AND reconciliation_id = ?14
                AND reconciliation_revision = ?15
                AND reconciliation_resolution = ''
                AND task_kind = 'midjourney'
                AND public_task_id = ?13
                AND user_id = ?2 AND channel_id = ?7 AND quota = ?8
                AND status = 'recovery_required'
                AND submit_state = 'submit_unknown'
            )
            "#,
        )
        .bind_refs(&insert_args)?;
    let resolved_at = event.created_at;
    let update_args = [
        D1Type::Text(mj.mj_id),
        D1Type::Integer(d1_i32(resolved_at)),
        D1Type::Text(event.resolution_key),
        D1Type::Integer(d1_i32(event.operator_id)),
        D1Type::Text(event.evidence_sha256),
        D1Type::Text(event.reason),
        D1Type::Text(event.reconciliation_id),
        D1Type::Text(event.reservation_key),
        D1Type::Integer(d1_i32(event.expected_revision)),
    ];
    let update = db
        .prepare(
            r#"
            UPDATE task_billing_intents
            SET status = 'attached', submit_state = 'submitted',
                provider_task_id = ?1, request_accounted = 1,
                attached_at = ?2, updated_at = ?2,
                owner_generation = owner_generation + 1,
                reconciliation_revision = reconciliation_revision + 1,
                reconciliation_resolution = 'attached',
                reconciliation_resolution_key = ?3,
                reconciliation_resolved_at = ?2,
                reconciliation_operator_id = ?4,
                reconciliation_evidence_sha256 = ?5,
                reconciliation_reason = ?6,
                recovery_last_error = ''
            WHERE reconciliation_id = ?7
              AND reservation_key = ?8
              AND reconciliation_revision = ?9
              AND reconciliation_resolution = ''
              AND task_kind = 'midjourney'
              AND status = 'recovery_required'
              AND submit_state = 'submit_unknown'
              AND request_accounted = 0
              AND (provider_task_id = '' OR provider_task_id = ?1)
              AND EXISTS (
                SELECT 1 FROM midjourneys
                WHERE mj_id = ?1
                  AND midjourneys.user_id = task_billing_intents.user_id
                  AND json_extract(
                    CASE WHEN json_valid(properties) THEN properties ELSE '{}' END,
                    '$.billing_reservation_key'
                  ) = ?8
              )
              AND EXISTS (
                SELECT 1 FROM task_billing_reconciliation_events
                WHERE resolution_key = ?3 AND reconciliation_id = ?7
              )
            "#,
        )
        .bind_refs(&update_args)?;
    let results = db
        .batch(vec![
            event_insert,
            assert_task_billing_previous_statement_statement(db, event.reservation_key)?,
            insert,
            assert_task_billing_previous_statement_statement(db, event.reservation_key)?,
            update,
            assert_task_billing_previous_statement_statement(db, event.reservation_key)?,
            admin_audit,
        ])
        .await?;
    if task_batch_changed(&results, 0)?
        && task_batch_changed(&results, 2)?
        && task_batch_changed(&results, 4)?
    {
        Ok(TaskBillingReconciliationMutationOutcome::Applied)
    } else {
        Ok(TaskBillingReconciliationMutationOutcome::Conflict)
    }
}

/// Load unfinished Midjourney rows for the batch poll: those not in a terminal
/// status that carry an upstream `mj_id`. Bounded by `limit`, ordered by id.
pub async fn find_unfinished_midjourneys(
    db: &D1Database,
    limit: i64,
) -> worker::Result<Vec<MjRow>> {
    let arg = D1Type::Integer(d1_i32(limit));
    db.prepare(
        r#"
        SELECT id, code, user_id, mj_id, channel_id,
               CASE WHEN json_valid(properties)
                    THEN COALESCE(json_extract(properties, '$.token_id'), 0)
                    ELSE 0 END AS token_id,
               CASE WHEN json_valid(properties)
                    THEN COALESCE(json_extract(properties, '$.billing_reservation_key'), '')
                    ELSE '' END AS billing_reservation_key,
               quota, status, progress, submit_time
        FROM midjourneys
        WHERE status NOT IN ('SUCCESS', 'FAILURE')
          AND mj_id != ''
        ORDER BY id ASC
        LIMIT ?1
        "#,
    )
    .bind_refs(&arg)?
    .all()
    .await?
    .results::<MjRow>()
}

/// Recover Midjourney rows that exceeded Go's one-hour timeout without relying
/// on channel availability or a successful provider poll. The terminal CAS and
/// owned refund still run through [`apply_midjourney_poll_result`].
pub async fn sweep_timed_out_midjourneys(
    db: &D1Database,
    now: i64,
    limit: i64,
) -> worker::Result<u32> {
    let cutoff_seconds = now.saturating_sub(MIDJOURNEY_TIMEOUT_SECONDS);
    let cutoff_millis = cutoff_seconds.saturating_mul(1_000);
    let limit = limit.clamp(1, MIDJOURNEY_TIMEOUT_SWEEP_MAX_LIMIT);
    let cutoff_seconds = cutoff_seconds.to_string();
    let cutoff_millis = cutoff_millis.to_string();
    let args = [
        D1Type::Text(&cutoff_millis),
        D1Type::Text(&cutoff_seconds),
        D1Type::Integer(d1_i32(limit)),
    ];
    let rows = db
        .prepare(
            r#"
            SELECT id, code, user_id, mj_id, channel_id,
                   CASE WHEN json_valid(properties)
                        THEN COALESCE(json_extract(properties, '$.token_id'), 0)
                        ELSE 0 END AS token_id,
                   CASE WHEN json_valid(properties)
                        THEN COALESCE(json_extract(properties, '$.billing_reservation_key'), '')
                        ELSE '' END AS billing_reservation_key,
                   quota, status, progress, submit_time
            FROM midjourneys
            WHERE status NOT IN ('SUCCESS', 'FAILURE')
              AND mj_id != ''
              AND progress != '100%'
              AND (
                (submit_time >= 10000000000 AND submit_time < CAST(?1 AS INTEGER)) OR
                (submit_time < 10000000000 AND submit_time < CAST(?2 AS INTEGER))
              )
            ORDER BY submit_time ASC, id ASC
            LIMIT ?3
            "#,
        )
        .bind_refs(&args)?
        .all()
        .await?
        .results::<MjRow>()?;

    let mut settled = 0u32;
    let finish_time = now.saturating_mul(1_000);
    for row in rows {
        let result = MjPollResult {
            status: "FAILURE",
            progress: &row.progress,
            fail_reason: "upstream task timeout (over 1 hour)",
            image_url: "",
            video_url: "",
            finish_time,
        };
        match apply_midjourney_poll_result(db, &row, &result).await {
            Ok(true) => settled += 1,
            Ok(false) => {}
            Err(err) => worker::console_error!(
                "midjourney timeout recovery failed for {}: {}",
                row.mj_id,
                err
            ),
        }
    }
    Ok(settled)
}

/// Merge one upstream poll result onto a Midjourney row — the per-item update of
/// Go `controller/midjourney.go`. The update is guarded to non-terminal rows
/// (`status NOT IN terminal`), so a row settles once; when this caller wins the
/// update and the new status is a failure (`FAILURE` or a non-empty
/// `fail_reason`), the reserved quota is refunded. Returns whether the update won
/// (i.e. the row was non-terminal and is now updated).
///
/// Simplification vs Go: only the poll-driven fields (status/progress/
/// fail_reason/finish_time/image_url/video_url) are merged; the buttons/
/// properties/prompt_en/state/video_urls blobs are not (display-only).
pub async fn apply_midjourney_poll_result(
    db: &D1Database,
    row: &MjRow,
    result: &MjPollResult<'_>,
) -> worker::Result<bool> {
    // Same D1 i32 binding limitation as submit_time: upstream Midjourney
    // finishTime is millisecond precision.
    let finish_time = result.finish_time.to_string();
    let effective_status = if result.fail_reason.is_empty() {
        result.status
    } else {
        "FAILURE"
    };
    let args = [
        D1Type::Text(effective_status),
        D1Type::Text(result.progress),
        D1Type::Text(result.fail_reason),
        D1Type::Text(result.image_url),
        D1Type::Text(result.video_url),
        D1Type::Text(finish_time.as_str()),
        D1Type::Integer(d1_i32(row.id)),
    ];
    let update = db
        .prepare(
            r#"
            UPDATE midjourneys
            SET status = ?1, progress = ?2, fail_reason = ?3, image_url = ?4,
                video_url = ?5, finish_time = ?6
            WHERE id = ?7 AND status NOT IN ('SUCCESS', 'FAILURE')
            "#,
        )
        .bind_refs(&args)?;

    let terminal = is_terminal(effective_status);
    if !terminal || is_terminal(&row.status) {
        let applied = update.run().await?;
        return Ok(applied.meta()?.and_then(|meta| meta.changes).unwrap_or(0) == 1);
    }

    let reservation_key = row.billing_reservation_key.trim();
    let financial_time = result.finish_time.saturating_div(1_000).max(1);
    if !reservation_key.is_empty() {
        let terminal_args = [
            D1Type::Integer(d1_i32(financial_time)),
            D1Type::Text(reservation_key),
            D1Type::Integer(d1_i32(row.id)),
            D1Type::Text(effective_status),
        ];
        let intent_update = if effective_status == "FAILURE" {
            db.prepare(
                r#"
                UPDATE task_billing_intents
                SET status = 'refunded', refunded_at = ?1, updated_at = ?1,
                    owner_generation = owner_generation + 1,
                    recovery_last_error = 'terminal_midjourney_failure'
                WHERE reservation_key = ?2
                  AND task_kind = 'midjourney'
                  AND status = 'attached'
                  AND EXISTS (
                    SELECT 1 FROM midjourneys
                    WHERE id = ?3 AND status = ?4
                      AND json_extract(
                        CASE WHEN json_valid(properties) THEN properties ELSE '{}' END,
                        '$.billing_reservation_key'
                      ) = ?2
                  )
                "#,
            )
            .bind_refs(&terminal_args)?
        } else {
            db.prepare(
                r#"
                UPDATE task_billing_intents
                SET status = 'settled', settled_at = ?1, updated_at = ?1,
                    owner_generation = owner_generation + 1,
                    recovery_last_error = ''
                WHERE reservation_key = ?2
                  AND task_kind = 'midjourney'
                  AND status = 'attached'
                  AND request_accounted = 1
                  AND EXISTS (
                    SELECT 1 FROM midjourneys
                    WHERE id = ?3 AND status = ?4
                      AND json_extract(
                        CASE WHEN json_valid(properties) THEN properties ELSE '{}' END,
                        '$.billing_reservation_key'
                      ) = ?2
                  )
                "#,
            )
            .bind_refs(&terminal_args)?
        };
        let results = db
            .batch(vec![
                update,
                crate::task_repository::assert_task_billing_previous_statement_statement(
                    db,
                    reservation_key,
                )?,
                intent_update,
                crate::task_repository::assert_task_billing_previous_statement_statement(
                    db,
                    reservation_key,
                )?,
            ])
            .await?;
        let won = results
            .first()
            .ok_or_else(|| worker::Error::RustError("missing midjourney CAS result".into()))?
            .meta()?
            .and_then(|meta| meta.changes)
            .unwrap_or(0)
            == 1;
        return Ok(won);
    }

    if effective_status != "FAILURE" || row.quota == 0 {
        let applied = update.run().await?;
        return Ok(applied.meta()?.and_then(|meta| meta.changes).unwrap_or(0) == 1);
    }

    // Imported rows retain the legacy wallet source, but their terminal CAS and
    // credits still share one guarded D1 transaction.
    let user_args = [
        D1Type::Integer(d1_i32(row.quota)),
        D1Type::Integer(d1_i32(row.user_id)),
        D1Type::Integer(d1_i32(row.id)),
    ];
    let credit_user = db
        .prepare(
            r#"
            UPDATE users SET quota = quota + ?1
            WHERE id = ?2
              AND EXISTS (SELECT 1 FROM midjourneys WHERE id = ?3 AND status = 'FAILURE')
            "#,
        )
        .bind_refs(&user_args)?;
    let mut statements = vec![
        update,
        crate::task_repository::assert_task_billing_previous_statement_statement(db, "")?,
        credit_user,
        crate::task_repository::assert_task_billing_previous_statement_statement(db, "")?,
    ];
    if row.token_id > 0 {
        let token_args = [
            D1Type::Integer(d1_i32(row.quota)),
            D1Type::Integer(d1_i32(financial_time)),
            D1Type::Integer(d1_i32(row.token_id)),
            D1Type::Integer(d1_i32(row.id)),
        ];
        statements.push(
            db.prepare(
                r#"
                UPDATE tokens
                SET remain_quota = remain_quota + ?1,
                    used_quota = MAX(used_quota - ?1, 0),
                    accessed_time = ?2
                WHERE id = ?3
                  AND EXISTS (SELECT 1 FROM midjourneys WHERE id = ?4 AND status = 'FAILURE')
                "#,
            )
            .bind_refs(&token_args)?,
        );
        statements.push(
            crate::task_repository::assert_task_billing_previous_statement_statement(db, "")?,
        );
    }
    let results = db.batch(statements).await?;
    Ok(results
        .first()
        .ok_or_else(|| worker::Error::RustError("missing midjourney CAS result".into()))?
        .meta()?
        .and_then(|meta| meta.changes)
        .unwrap_or(0)
        == 1)
}

/// A full midjourneys row for the client-facing fetch (Go `dto.MidjourneyDto`
/// source fields).
#[derive(Debug, serde::Deserialize)]
pub struct MjDtoRow {
    pub mj_id: String,
    pub action: String,
    pub prompt: String,
    pub prompt_en: String,
    pub description: String,
    pub state: String,
    pub submit_time: i64,
    pub start_time: i64,
    pub finish_time: i64,
    pub image_url: String,
    pub video_url: String,
    pub video_urls: String,
    pub status: String,
    pub progress: String,
    pub fail_reason: String,
    pub buttons: String,
    pub properties: String,
}

const MJ_DTO_COLUMNS: &str = r#"mj_id, action, prompt, prompt_en, description, state,
    submit_time, start_time, finish_time, image_url, video_url, video_urls,
    status, progress, fail_reason, buttons, properties"#;

/// One Midjourney task by public mj id, owner-scoped (Go `GetByMJId`).
pub async fn find_mj_dto(
    db: &D1Database,
    user_id: i64,
    mj_id: &str,
) -> worker::Result<Option<MjDtoRow>> {
    let args = [D1Type::Integer(d1_i32(user_id)), D1Type::Text(mj_id)];
    db.prepare(&format!(
        "SELECT {MJ_DTO_COLUMNS} FROM midjourneys WHERE user_id = ?1 AND mj_id = ?2 LIMIT 1"
    ))
    .bind_refs(&args)?
    .first::<MjDtoRow>(None)
    .await
}

/// The owner's Midjourney tasks matching a set of mj ids (Go `GetByMJIds`).
pub async fn find_mj_dtos(
    db: &D1Database,
    user_id: i64,
    mj_ids: &[String],
) -> worker::Result<Vec<MjDtoRow>> {
    let mut rows = Vec::new();
    for chunk in mj_ids.chunks(50) {
        let mut args: Vec<D1Type<'_>> = vec![D1Type::Integer(d1_i32(user_id))];
        for mj_id in chunk {
            args.push(D1Type::Text(mj_id));
        }
        let placeholders: Vec<String> = (0..chunk.len()).map(|i| format!("?{}", i + 2)).collect();
        let sql = format!(
            "SELECT {MJ_DTO_COLUMNS} FROM midjourneys WHERE user_id = ?1 AND mj_id IN ({})",
            placeholders.join(", ")
        );
        rows.extend(
            db.prepare(&sql)
                .bind_refs(&args)?
                .all()
                .await?
                .results::<MjDtoRow>()?,
        );
    }
    Ok(rows)
}

/// Filters shared by the admin (`GET /api/mj`) and self (`GET /api/mj/self`)
/// Midjourney log pages.
#[derive(Debug, Default)]
pub struct MjListFilter {
    pub user_id: Option<i64>,
    pub channel_id: Option<i64>,
    pub mj_id: Option<String>,
    /// Millisecond timestamp from the React usage-log filters.
    pub start_timestamp: Option<String>,
    /// Millisecond timestamp from the React usage-log filters.
    pub end_timestamp: Option<String>,
}

/// Go `model.Midjourney` JSON shape for dashboard log lists (snake_case).
#[derive(Debug, Deserialize, Serialize)]
pub struct MjListRow {
    pub id: i64,
    pub code: i64,
    pub user_id: i64,
    pub action: String,
    pub mj_id: String,
    pub prompt: String,
    pub prompt_en: String,
    pub description: String,
    pub state: String,
    pub submit_time: i64,
    pub start_time: i64,
    pub finish_time: i64,
    pub image_url: String,
    pub video_url: String,
    pub video_urls: String,
    pub status: String,
    pub progress: String,
    pub fail_reason: String,
    pub channel_id: i64,
    pub quota: i64,
    pub buttons: String,
    pub properties: String,
}

const MJ_LIST_COLUMNS: &str = r#"id, code, user_id, action, mj_id, prompt, prompt_en,
    description, state, submit_time, start_time, finish_time, image_url,
    video_url, video_urls, status, progress, fail_reason, channel_id, quota,
    buttons, properties"#;

#[derive(Debug, Deserialize)]
struct CountRow {
    count: i64,
}

/// List Midjourney rows for the admin/self usage-log tables. Mirrors Go
/// `GetAllTasks` / `GetAllUserTask`: optional channel (admin only at the
/// handler), public mj id, and submit_time range filters, ordered newest first.
pub async fn list_midjourneys(
    db: &D1Database,
    filter: &MjListFilter,
    page: u32,
    page_size: u32,
) -> worker::Result<Vec<MjListRow>> {
    let mut args: Vec<D1Type<'_>> = Vec::new();
    let where_sql = mj_where_clause(filter, &mut args);
    let limit_idx = args.len() + 1;
    let offset_idx = args.len() + 2;
    let offset = ((page.max(1) - 1) as i64) * page_size as i64;
    args.push(D1Type::Integer(d1_i32(page_size as i64)));
    args.push(D1Type::Integer(d1_i32(offset)));
    let sql = format!(
        "SELECT {MJ_LIST_COLUMNS} FROM midjourneys{where_sql} ORDER BY id DESC LIMIT ?{limit_idx} OFFSET ?{offset_idx}"
    );
    db.prepare(&sql)
        .bind_refs(&args)?
        .all()
        .await?
        .results::<MjListRow>()
}

/// Count Midjourney rows matching the usage-log filters.
pub async fn count_midjourneys(db: &D1Database, filter: &MjListFilter) -> worker::Result<i64> {
    let mut args: Vec<D1Type<'_>> = Vec::new();
    let where_sql = mj_where_clause(filter, &mut args);
    let sql = format!("SELECT COUNT(*) AS count FROM midjourneys{where_sql}");
    let row = db
        .prepare(&sql)
        .bind_refs(&args)?
        .first::<CountRow>(None)
        .await?;
    Ok(row.map(|row| row.count).unwrap_or(0))
}

fn mj_where_clause<'a>(filter: &'a MjListFilter, args: &mut Vec<D1Type<'a>>) -> String {
    let mut conditions = Vec::new();
    if let Some(user_id) = filter.user_id {
        args.push(D1Type::Integer(d1_i32(user_id)));
        conditions.push(format!("user_id = ?{}", args.len()));
    }
    if let Some(channel_id) = filter.channel_id {
        args.push(D1Type::Integer(d1_i32(channel_id)));
        conditions.push(format!("channel_id = ?{}", args.len()));
    }
    if let Some(mj_id) = filter.mj_id.as_deref() {
        args.push(D1Type::Text(mj_id));
        conditions.push(format!("mj_id = ?{}", args.len()));
    }
    if let Some(start) = filter.start_timestamp.as_deref() {
        args.push(D1Type::Text(start));
        conditions.push(format!("submit_time >= ?{}", args.len()));
    }
    if let Some(end) = filter.end_timestamp.as_deref() {
        args.push(D1Type::Text(end));
        conditions.push(format!("submit_time <= ?{}", args.len()));
    }
    if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn midjourney_timeout_supports_legacy_seconds_and_current_millis() {
        let now = 1_700_003_601;
        assert!(midjourney_is_timed_out(1_700_000_000, "99%", now));
        assert!(midjourney_is_timed_out(1_700_000_000_000, "99%", now));
        assert!(!midjourney_is_timed_out(1_700_000_001_000, "99%", now));
        assert!(!midjourney_is_timed_out(1_700_000_000_000, "100%", now));
    }
}
