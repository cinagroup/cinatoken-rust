use cinatoken_relay::{channel_type_supported, clamp_i64_to_i32 as d1_i32, csv_contains};
use cinatoken_storage::{AuthenticatedToken, RelayAuditLog, RelayChannel};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use worker::{D1Database, D1Result, D1Type};

const BILLING_MODE_OPTION_KEY: &str = "billing_setting.billing_mode";
const BILLING_EXPR_OPTION_KEY: &str = "billing_setting.billing_expr";
const GROUP_RATIO_OPTION_KEY: &str = "group_ratio_setting.group_ratio";
const LEGACY_GROUP_RATIO_OPTION_KEY: &str = "GroupRatio";
const BILLING_MODE_TIERED_EXPR: &str = "tiered_expr";

#[derive(Debug, Deserialize)]
struct OptionValueRow {
    value: String,
}

#[derive(Debug, Deserialize)]
struct QuotaStateRow {
    token_status: i32,
    expired_time: i64,
    remain_quota: i64,
    unlimited_quota: i32,
    user_status: i32,
    user_quota: i64,
}

pub async fn authenticate_token(
    db: &D1Database,
    api_key: &str,
) -> worker::Result<Option<AuthenticatedToken>> {
    let stmt = db.prepare(
        r#"
        SELECT
          t.id AS token_id,
          t.user_id AS user_id,
          t.name AS token_name,
          t.status AS token_status,
          t.expired_time AS expired_time,
          t.remain_quota AS remain_quota,
          t.unlimited_quota AS unlimited_quota,
          t.model_limits_enabled AS model_limits_enabled,
          t.model_limits AS model_limits,
          t.allow_ips AS allow_ips,
          t."group" AS token_group,
          u.username AS username,
          u.status AS user_status,
          u.quota AS user_quota,
          u."group" AS user_group
        FROM tokens t
        JOIN users u ON u.id = t.user_id
        WHERE t."key" = ?1
          AND t.deleted_at IS NULL
          AND u.deleted_at IS NULL
        LIMIT 1
        "#,
    );
    let key_arg = D1Type::Text(api_key);
    stmt.bind_refs(&key_arg)?
        .first::<AuthenticatedToken>(None)
        .await
}

pub async fn refresh_authenticated_token_quota_state(
    db: &D1Database,
    auth: &mut AuthenticatedToken,
) -> worker::Result<bool> {
    let args = [
        D1Type::Integer(d1_i32(auth.token_id)),
        D1Type::Integer(d1_i32(auth.user_id)),
    ];
    let row = db
        .prepare(
            r#"
            SELECT
              t.status AS token_status,
              t.expired_time AS expired_time,
              t.remain_quota AS remain_quota,
              t.unlimited_quota AS unlimited_quota,
              u.status AS user_status,
              u.quota AS user_quota
            FROM tokens t
            JOIN users u ON u.id = t.user_id
            WHERE t.id = ?1
              AND u.id = ?2
              AND t.deleted_at IS NULL
              AND u.deleted_at IS NULL
            LIMIT 1
            "#,
        )
        .bind_refs(&args)?
        .first::<QuotaStateRow>(None)
        .await?;
    let Some(row) = row else {
        return Ok(false);
    };

    auth.token_status = row.token_status;
    auth.expired_time = row.expired_time;
    auth.remain_quota = row.remain_quota;
    auth.unlimited_quota = row.unlimited_quota;
    auth.user_status = row.user_status;
    auth.user_quota = row.user_quota;
    Ok(true)
}

pub async fn mark_token_status(
    db: &D1Database,
    token_id: i64,
    status: i32,
    accessed_time: i64,
) -> worker::Result<()> {
    let args = [
        D1Type::Integer(status),
        D1Type::Integer(d1_i32(accessed_time)),
        D1Type::Integer(d1_i32(token_id)),
    ];
    db.prepare("UPDATE tokens SET status = ?1, accessed_time = ?2 WHERE id = ?3")
        .bind_refs(&args)?
        .run()
        .await?;
    Ok(())
}

pub async fn select_relay_channel(
    db: &D1Database,
    model: &str,
    group: &str,
    supported_channel_types: &[i32],
) -> worker::Result<Option<RelayChannel>> {
    if let Some(channel) =
        select_channel_from_abilities(db, model, group, supported_channel_types).await?
    {
        return Ok(Some(channel));
    }

    select_channel_from_channel_csv(db, model, group, supported_channel_types).await
}

async fn select_channel_from_abilities(
    db: &D1Database,
    model: &str,
    group: &str,
    supported_channel_types: &[i32],
) -> worker::Result<Option<RelayChannel>> {
    let group_arg = D1Type::Text(group);
    let model_arg = D1Type::Text(model);
    let args = [group_arg, model_arg];
    let channel_type_filter = channel_type_filter_sql(supported_channel_types)?;
    let rows = db
        .prepare(&format!(
            r#"
            SELECT
              c.id,
              c.type AS channel_type,
              c."key",
              c.name,
              c.base_url,
              c.models,
              c."group" AS channel_group,
              c.model_mapping,
              c.openai_organization
            FROM abilities a
            JOIN channels c ON c.id = a.channel_id
            WHERE a.group_name = ?1
              AND a.model = ?2
              AND a.enabled = 1
              AND c.status = 1
              AND c.type IN ({channel_type_filter})
            ORDER BY a.priority DESC, a.weight DESC, c.priority DESC, c.id ASC
            LIMIT 50
            "#
        ))
        .bind_refs(&args)?
        .all()
        .await?
        .results::<RelayChannel>()?;

    Ok(rows
        .into_iter()
        .find(|channel| channel_type_supported(channel.channel_type, supported_channel_types)))
}

async fn select_channel_from_channel_csv(
    db: &D1Database,
    model: &str,
    group: &str,
    supported_channel_types: &[i32],
) -> worker::Result<Option<RelayChannel>> {
    let channel_type_filter = channel_type_filter_sql(supported_channel_types)?;
    let rows = db
        .prepare(&format!(
            r#"
            SELECT
              id,
              type AS channel_type,
              "key",
              name,
              base_url,
              models,
              "group" AS channel_group,
              model_mapping,
              openai_organization
            FROM channels
            WHERE status = 1
              AND type IN ({channel_type_filter})
            ORDER BY priority DESC, id ASC
            LIMIT 50
            "#
        ))
        .all()
        .await?
        .results::<RelayChannel>()?;

    Ok(rows.into_iter().find(|channel| {
        channel_type_supported(channel.channel_type, supported_channel_types)
            && csv_contains(&channel.channel_group, group)
            && (channel.models.trim().is_empty() || csv_contains(&channel.models, model))
    }))
}

fn channel_type_filter_sql(supported_channel_types: &[i32]) -> worker::Result<String> {
    if supported_channel_types.is_empty() {
        return Err(worker::Error::RustError(
            "supported channel type list cannot be empty".to_string(),
        ));
    }
    Ok(supported_channel_types
        .iter()
        .map(i32::to_string)
        .collect::<Vec<_>>()
        .join(", "))
}

pub async fn touch_token(db: &D1Database, token_id: i64, accessed_time: i64) -> worker::Result<()> {
    let args = [
        D1Type::Integer(d1_i32(accessed_time)),
        D1Type::Integer(d1_i32(token_id)),
    ];
    db.prepare("UPDATE tokens SET accessed_time = ?1 WHERE id = ?2")
        .bind_refs(&args)?
        .run()
        .await?;
    Ok(())
}

pub async fn increment_user_request_count(db: &D1Database, user_id: i64) -> worker::Result<()> {
    let args = [D1Type::Integer(d1_i32(user_id))];
    db.prepare("UPDATE users SET request_count = request_count + 1 WHERE id = ?1")
        .bind_refs(&args)?
        .run()
        .await?;
    Ok(())
}

pub async fn insert_relay_audit_log(
    db: &D1Database,
    created_at: i64,
    content: &str,
    audit_log: &RelayAuditLog<'_>,
) -> worker::Result<()> {
    let log_args = [
        D1Type::Integer(d1_i32(audit_log.user_id)),
        D1Type::Integer(d1_i32(created_at)),
        D1Type::Integer(2),
        D1Type::Text(content),
        D1Type::Text(audit_log.username),
        D1Type::Text(audit_log.token_name),
        D1Type::Text(audit_log.model),
        D1Type::Integer(d1_i32(audit_log.quota)),
        D1Type::Integer(audit_log.prompt_tokens),
        D1Type::Integer(audit_log.completion_tokens),
        D1Type::Integer(d1_i32(audit_log.use_time_seconds)),
        D1Type::Integer(i32::from(audit_log.is_stream)),
        D1Type::Integer(d1_i32(audit_log.channel_id)),
        D1Type::Integer(d1_i32(audit_log.token_id)),
        D1Type::Text(audit_log.group),
        D1Type::Text(audit_log.ip),
        D1Type::Text(audit_log.request_id),
        D1Type::Text(audit_log.upstream_request_id),
        D1Type::Text(audit_log.other),
    ];
    db.prepare(
        r#"
        INSERT INTO logs (
          user_id, created_at, type, content, username, token_name, model_name,
          quota, prompt_tokens, completion_tokens, use_time, is_stream,
          channel_id, token_id, "group", ip, request_id, upstream_request_id, other
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19
        )
        "#,
    )
    .bind_refs(&log_args)?
    .run()
    .await?;
    Ok(())
}

pub async fn apply_relay_quota_usage(
    db: &D1Database,
    user_id: i64,
    token_id: i64,
    channel_id: i64,
    quota: i64,
    accessed_time: i64,
) -> worker::Result<()> {
    let quota = quota_i32(quota)?;
    debit_user_quota_usage_and_request_count(db, user_id, quota).await?;
    if let Err(err) = debit_token_quota_usage(db, token_id, quota, accessed_time).await {
        if let Err(compensate_err) =
            credit_user_quota_usage_and_request_count(db, user_id, quota).await
        {
            worker::console_error!(
                "failed to compensate user quota after token quota debit failure: {}",
                compensate_err
            );
        }
        return Err(err);
    }
    if let Err(err) = increment_channel_used_quota(db, channel_id, quota).await {
        if let Err(compensate_err) =
            credit_token_quota_usage(db, token_id, quota, accessed_time).await
        {
            worker::console_error!(
                "failed to compensate token quota after channel quota update failure: {}",
                compensate_err
            );
        }
        if let Err(compensate_err) =
            credit_user_quota_usage_and_request_count(db, user_id, quota).await
        {
            worker::console_error!(
                "failed to compensate user quota after channel quota update failure: {}",
                compensate_err
            );
        }
        return Err(err);
    }
    Ok(())
}

pub async fn reserve_relay_quota(
    db: &D1Database,
    user_id: i64,
    token_id: i64,
    quota: i64,
    accessed_time: i64,
) -> worker::Result<()> {
    let quota = quota_i32(quota)?;
    if quota == 0 {
        touch_token(db, token_id, accessed_time).await?;
        return Ok(());
    }

    let results = db
        .batch(vec![
            reserve_user_quota_statement(db, user_id, quota)?,
            debit_token_quota_usage_statement(db, token_id, quota, accessed_time)?,
        ])
        .await?;
    require_batch_change(&results, 0, "user quota is not enough")?;
    require_batch_change(&results, 1, "token quota is not enough")
}

pub async fn refund_reserved_relay_quota(
    db: &D1Database,
    user_id: i64,
    token_id: i64,
    quota: i64,
    accessed_time: i64,
) -> worker::Result<()> {
    let quota = quota_i32(quota)?;
    if quota == 0 {
        touch_token(db, token_id, accessed_time).await?;
        return Ok(());
    }

    let results = db
        .batch(vec![
            credit_user_quota_statement(db, user_id, quota)?,
            credit_token_quota_usage_statement(db, token_id, quota, accessed_time)?,
        ])
        .await?;
    require_batch_change(&results, 0, "user no longer exists")?;
    require_batch_change(&results, 1, "token no longer exists")
}

pub async fn settle_reserved_relay_quota_usage(
    db: &D1Database,
    user_id: i64,
    token_id: i64,
    channel_id: i64,
    pre_consumed_quota: i64,
    final_quota: i64,
    accessed_time: i64,
) -> worker::Result<()> {
    let pre_consumed_quota = quota_i32(pre_consumed_quota)?;
    let final_quota = quota_i32(final_quota)?;
    let delta = final_quota.saturating_sub(pre_consumed_quota);

    let mut statements = Vec::new();
    if delta > 0 {
        statements.push(reserve_user_quota_statement(db, user_id, delta)?);
        statements.push(debit_token_quota_usage_statement(
            db,
            token_id,
            delta,
            accessed_time,
        )?);
    } else if delta < 0 {
        let refund = delta.saturating_abs();
        statements.push(credit_user_quota_statement(db, user_id, refund)?);
        statements.push(credit_token_quota_usage_statement(
            db,
            token_id,
            refund,
            accessed_time,
        )?);
    } else {
        statements.push(touch_token_statement(db, token_id, accessed_time)?);
    }
    statements.push(increment_user_used_quota_and_request_count_statement(
        db,
        user_id,
        final_quota,
    )?);
    statements.push(increment_channel_used_quota_statement(
        db,
        channel_id,
        final_quota,
    )?);

    let results = db.batch(statements).await?;
    let offset = if delta == 0 { 1 } else { 2 };
    if delta != 0 {
        require_batch_change(&results, 0, "user quota settlement failed")?;
        require_batch_change(&results, 1, "token quota settlement failed")?;
    } else {
        require_batch_change(&results, 0, "token no longer exists")?;
    }
    require_batch_change(&results, offset, "user no longer exists")?;
    require_batch_change(&results, offset + 1, "relay channel no longer exists")
}

async fn debit_user_quota_usage_and_request_count(
    db: &D1Database,
    user_id: i64,
    quota: i32,
) -> worker::Result<()> {
    let result = debit_user_quota_usage_and_request_count_statement(db, user_id, quota)?
        .run()
        .await?;
    require_one_change(result, "user quota is not enough")
}

async fn credit_user_quota_usage_and_request_count(
    db: &D1Database,
    user_id: i64,
    quota: i32,
) -> worker::Result<()> {
    let args = [D1Type::Integer(quota), D1Type::Integer(d1_i32(user_id))];
    db.prepare(
        r#"
        UPDATE users
        SET quota = quota + ?1,
            used_quota = MAX(used_quota - ?1, 0),
            request_count = MAX(request_count - 1, 0)
        WHERE id = ?2
        "#,
    )
    .bind_refs(&args)?
    .run()
    .await?;
    Ok(())
}

async fn debit_token_quota_usage(
    db: &D1Database,
    token_id: i64,
    quota: i32,
    accessed_time: i64,
) -> worker::Result<()> {
    let result = debit_token_quota_usage_statement(db, token_id, quota, accessed_time)?
        .run()
        .await?;
    require_one_change(result, "token quota is not enough")
}

async fn credit_token_quota_usage(
    db: &D1Database,
    token_id: i64,
    quota: i32,
    accessed_time: i64,
) -> worker::Result<()> {
    credit_token_quota_usage_statement(db, token_id, quota, accessed_time)?
        .run()
        .await?;
    Ok(())
}

async fn increment_channel_used_quota(
    db: &D1Database,
    channel_id: i64,
    quota: i32,
) -> worker::Result<()> {
    let result = increment_channel_used_quota_statement(db, channel_id, quota)?
        .run()
        .await?;
    require_one_change(result, "relay channel no longer exists")
}

fn reserve_user_quota_statement(
    db: &D1Database,
    user_id: i64,
    quota: i32,
) -> worker::Result<worker::D1PreparedStatement> {
    let args = [D1Type::Integer(quota), D1Type::Integer(d1_i32(user_id))];
    db.prepare(
        r#"
        UPDATE users
        SET quota = quota - ?1
        WHERE id = ?2
          AND quota >= ?1
        "#,
    )
    .bind_refs(&args)
}

fn credit_user_quota_statement(
    db: &D1Database,
    user_id: i64,
    quota: i32,
) -> worker::Result<worker::D1PreparedStatement> {
    let args = [D1Type::Integer(quota), D1Type::Integer(d1_i32(user_id))];
    db.prepare("UPDATE users SET quota = quota + ?1 WHERE id = ?2")
        .bind_refs(&args)
}

fn increment_user_used_quota_and_request_count_statement(
    db: &D1Database,
    user_id: i64,
    quota: i32,
) -> worker::Result<worker::D1PreparedStatement> {
    let args = [D1Type::Integer(quota), D1Type::Integer(d1_i32(user_id))];
    db.prepare(
        r#"
        UPDATE users
        SET used_quota = used_quota + ?1,
            request_count = request_count + 1
        WHERE id = ?2
        "#,
    )
    .bind_refs(&args)
}

fn debit_user_quota_usage_and_request_count_statement(
    db: &D1Database,
    user_id: i64,
    quota: i32,
) -> worker::Result<worker::D1PreparedStatement> {
    let args = [D1Type::Integer(quota), D1Type::Integer(d1_i32(user_id))];
    db.prepare(
        r#"
        UPDATE users
        SET quota = quota - ?1,
            used_quota = used_quota + ?1,
            request_count = request_count + 1
        WHERE id = ?2
          AND quota >= ?1
        "#,
    )
    .bind_refs(&args)
}

fn debit_token_quota_usage_statement(
    db: &D1Database,
    token_id: i64,
    quota: i32,
    accessed_time: i64,
) -> worker::Result<worker::D1PreparedStatement> {
    let args = [
        D1Type::Integer(quota),
        D1Type::Integer(d1_i32(accessed_time)),
        D1Type::Integer(d1_i32(token_id)),
    ];
    db.prepare(
        r#"
        UPDATE tokens
        SET remain_quota = remain_quota - ?1,
            used_quota = used_quota + ?1,
            accessed_time = ?2
        WHERE id = ?3
          AND (unlimited_quota != 0 OR remain_quota >= ?1)
        "#,
    )
    .bind_refs(&args)
}

fn credit_token_quota_usage_statement(
    db: &D1Database,
    token_id: i64,
    quota: i32,
    accessed_time: i64,
) -> worker::Result<worker::D1PreparedStatement> {
    let args = [
        D1Type::Integer(quota),
        D1Type::Integer(d1_i32(accessed_time)),
        D1Type::Integer(d1_i32(token_id)),
    ];
    db.prepare(
        r#"
        UPDATE tokens
        SET remain_quota = remain_quota + ?1,
            used_quota = MAX(used_quota - ?1, 0),
            accessed_time = ?2
        WHERE id = ?3
        "#,
    )
    .bind_refs(&args)
}

fn increment_channel_used_quota_statement(
    db: &D1Database,
    channel_id: i64,
    quota: i32,
) -> worker::Result<worker::D1PreparedStatement> {
    let args = [D1Type::Integer(quota), D1Type::Integer(d1_i32(channel_id))];
    db.prepare("UPDATE channels SET used_quota = used_quota + ?1 WHERE id = ?2")
        .bind_refs(&args)
}

fn touch_token_statement(
    db: &D1Database,
    token_id: i64,
    accessed_time: i64,
) -> worker::Result<worker::D1PreparedStatement> {
    let args = [
        D1Type::Integer(d1_i32(accessed_time)),
        D1Type::Integer(d1_i32(token_id)),
    ];
    db.prepare("UPDATE tokens SET accessed_time = ?1 WHERE id = ?2")
        .bind_refs(&args)
}

fn require_one_change(result: D1Result, message: &str) -> worker::Result<()> {
    let changes = result.meta()?.and_then(|meta| meta.changes).unwrap_or(0);
    if changes == 1 {
        Ok(())
    } else {
        Err(worker::Error::RustError(message.to_string()))
    }
}

fn require_batch_change(results: &[D1Result], index: usize, message: &str) -> worker::Result<()> {
    let Some(result) = results.get(index) else {
        return Err(worker::Error::RustError(format!(
            "missing D1 batch result at index {index}"
        )));
    };
    let changes = result.meta()?.and_then(|meta| meta.changes).unwrap_or(0);
    if changes == 1 {
        Ok(())
    } else {
        Err(worker::Error::RustError(message.to_string()))
    }
}

fn quota_i32(quota: i64) -> worker::Result<i32> {
    if quota < 0 {
        return Err(worker::Error::RustError(
            "quota must be non-negative".to_string(),
        ));
    }
    i32::try_from(quota).map_err(|_| {
        worker::Error::RustError(format!("quota {quota} exceeds D1 integer binding range"))
    })
}

pub async fn tiered_billing_expr_for_model(
    db: &D1Database,
    model: &str,
) -> worker::Result<Option<String>> {
    let billing_mode = option_value(db, BILLING_MODE_OPTION_KEY).await?;
    let billing_expr = option_value(db, BILLING_EXPR_OPTION_KEY).await?;
    resolve_tiered_billing_expr_for_model(model, billing_mode.as_deref(), billing_expr.as_deref())
}

pub async fn group_ratio_for_group(db: &D1Database, group: &str) -> worker::Result<f64> {
    if let Some(raw) = option_value(db, GROUP_RATIO_OPTION_KEY).await? {
        if let Some(ratio) = resolve_group_ratio(group, &raw)? {
            return Ok(ratio);
        }
    }
    if let Some(raw) = option_value(db, LEGACY_GROUP_RATIO_OPTION_KEY).await? {
        if let Some(ratio) = resolve_group_ratio(group, &raw)? {
            return Ok(ratio);
        }
    }
    Ok(1.0)
}

async fn option_value(db: &D1Database, key: &str) -> worker::Result<Option<String>> {
    let key_arg = D1Type::Text(key);
    db.prepare(r#"SELECT value FROM options WHERE "key" = ?1 LIMIT 1"#)
        .bind_refs(&key_arg)?
        .first::<OptionValueRow>(None)
        .await
        .map(|row| row.map(|row| row.value))
}

fn resolve_tiered_billing_expr_for_model(
    model: &str,
    billing_mode: Option<&str>,
    billing_expr: Option<&str>,
) -> worker::Result<Option<String>> {
    let modes = parse_string_map_option(BILLING_MODE_OPTION_KEY, billing_mode)?;
    if modes.get(model).map(String::as_str).map(str::trim) != Some(BILLING_MODE_TIERED_EXPR) {
        return Ok(None);
    }

    let expressions = parse_string_map_option(BILLING_EXPR_OPTION_KEY, billing_expr)?;
    Ok(expressions
        .get(model)
        .map(String::as_str)
        .map(str::trim)
        .filter(|expr| !expr.is_empty())
        .map(str::to_string))
}

fn parse_string_map_option(
    key: &str,
    raw: Option<&str>,
) -> worker::Result<HashMap<String, String>> {
    let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(HashMap::new());
    };
    serde_json::from_str::<HashMap<String, String>>(raw).map_err(|err| {
        worker::Error::RustError(format!("option {key} must be a JSON string map: {err}"))
    })
}

fn resolve_group_ratio(group: &str, raw: &str) -> worker::Result<Option<f64>> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    let values = serde_json::from_str::<HashMap<String, Value>>(raw).map_err(|err| {
        worker::Error::RustError(format!("group ratio option must be a JSON object: {err}"))
    })?;
    let Some(value) = values.get(group) else {
        return Ok(None);
    };
    let ratio = value
        .as_f64()
        .or_else(|| value.as_str().and_then(|value| value.trim().parse().ok()))
        .ok_or_else(|| {
            worker::Error::RustError(format!("group ratio for {group} must be numeric"))
        })?;
    Ok(Some(ratio.max(0.0)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_tiered_billing_expr_from_go_option_maps() {
        let expr = resolve_tiered_billing_expr_for_model(
            "gpt-test",
            Some(r#"{"gpt-test":"tiered_expr","other":"ratio"}"#),
            Some(r#"{"gpt-test":" tier(\"base\", p * 2 + c * 10) "}"#),
        )
        .unwrap();

        assert_eq!(expr.as_deref(), Some(r#"tier("base", p * 2 + c * 10)"#));
    }

    #[test]
    fn ignores_non_tiered_or_missing_billing_expr() {
        assert_eq!(
            resolve_tiered_billing_expr_for_model(
                "gpt-test",
                Some(r#"{"gpt-test":"ratio"}"#),
                Some(r#"{"gpt-test":"tier(\"base\", p)"}"#),
            )
            .unwrap(),
            None
        );
        assert_eq!(
            resolve_tiered_billing_expr_for_model(
                "gpt-test",
                Some(r#"{"gpt-test":"tiered_expr"}"#),
                Some(r#"{"gpt-test":"   "}"#),
            )
            .unwrap(),
            None
        );
    }

    #[test]
    fn resolves_group_ratio_from_numeric_or_string_values() {
        assert_eq!(
            resolve_group_ratio("vip", r#"{"default":1,"vip":1.5}"#).unwrap(),
            Some(1.5)
        );
        assert_eq!(
            resolve_group_ratio("vip", r#"{"vip":"2.25"}"#).unwrap(),
            Some(2.25)
        );
        assert_eq!(
            resolve_group_ratio("missing", r#"{"vip":2}"#).unwrap(),
            None
        );
    }

    #[test]
    fn channel_type_filter_sql_accepts_internal_type_lists_only() {
        assert_eq!(channel_type_filter_sql(&[1, 20, 53]).unwrap(), "1, 20, 53");
        assert!(channel_type_filter_sql(&[]).is_err());
    }

    #[test]
    fn quota_i32_accepts_non_negative_d1_range() {
        assert_eq!(quota_i32(0).unwrap(), 0);
        assert_eq!(quota_i32(i64::from(i32::MAX)).unwrap(), i32::MAX);
        assert!(quota_i32(-1).is_err());
        assert!(quota_i32(i64::from(i32::MAX) + 1).is_err());
    }
}
