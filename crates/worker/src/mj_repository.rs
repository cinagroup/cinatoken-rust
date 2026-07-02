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
use serde::Deserialize;
use worker::{D1Database, D1Type};

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

/// Insert a submitted Midjourney task (Go `Midjourney.Insert`).
pub async fn insert_midjourney(db: &D1Database, mj: &NewMidjourney<'_>) -> worker::Result<()> {
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
        D1Type::Integer(d1_i32(mj.submit_time)),
    ];
    db.prepare(
        r#"
        INSERT INTO midjourneys
          (code, user_id, action, mj_id, prompt, prompt_en, channel_id, quota,
           status, progress, submit_time)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
        "#,
    )
    .bind_refs(&args)?
    .run()
    .await
    .map(|_| ())
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
        SELECT id, code, user_id, mj_id, channel_id, quota, status, progress,
               submit_time
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
    let args = [
        D1Type::Text(result.status),
        D1Type::Text(result.progress),
        D1Type::Text(result.fail_reason),
        D1Type::Text(result.image_url),
        D1Type::Text(result.video_url),
        D1Type::Integer(d1_i32(result.finish_time)),
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
        .bind_refs(&args)?
        .run()
        .await?;
    let won = update.meta()?.and_then(|meta| meta.changes).unwrap_or(0) == 1;

    let is_failure = result.status == "FAILURE" || !result.fail_reason.is_empty();
    if won && is_failure && !is_terminal(&row.status) {
        crate::d1_repositories::increase_user_quota(db, row.user_id, row.quota).await?;
    }
    Ok(won)
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
