use cinatoken_relay::{
    clamp_i64_to_i32 as d1_i32, csv_contains, is_openai_compatible_channel_type,
};
use cinatoken_storage::{AuthenticatedToken, RelayAuditLog, RelayChannel};
use worker::{D1Database, D1Type};

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

pub async fn select_openai_compatible_channel(
    db: &D1Database,
    model: &str,
    group: &str,
) -> worker::Result<Option<RelayChannel>> {
    if let Some(channel) = select_channel_from_abilities(db, model, group).await? {
        return Ok(Some(channel));
    }

    select_channel_from_channel_csv(db, model, group).await
}

async fn select_channel_from_abilities(
    db: &D1Database,
    model: &str,
    group: &str,
) -> worker::Result<Option<RelayChannel>> {
    let group_arg = D1Type::Text(group);
    let model_arg = D1Type::Text(model);
    let args = [group_arg, model_arg];
    let rows = db
        .prepare(
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
              AND c.type IN (1, 20, 40, 42, 43, 48, 53)
            ORDER BY a.priority DESC, a.weight DESC, c.priority DESC, c.id ASC
            LIMIT 50
            "#,
        )
        .bind_refs(&args)?
        .all()
        .await?
        .results::<RelayChannel>()?;

    Ok(rows.into_iter().next())
}

async fn select_channel_from_channel_csv(
    db: &D1Database,
    model: &str,
    group: &str,
) -> worker::Result<Option<RelayChannel>> {
    let rows = db
        .prepare(
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
              AND type IN (1, 20, 40, 42, 43, 48, 53)
            ORDER BY priority DESC, id ASC
            LIMIT 50
            "#,
        )
        .all()
        .await?
        .results::<RelayChannel>()?;

    Ok(rows.into_iter().find(|channel| {
        is_openai_compatible_channel_type(channel.channel_type)
            && csv_contains(&channel.channel_group, group)
            && (channel.models.trim().is_empty() || csv_contains(&channel.models, model))
    }))
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
