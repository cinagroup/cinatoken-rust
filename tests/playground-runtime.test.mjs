import { applyD1Migrations, env, reset, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

const baseUrl = "https://cinatoken.test";
const password = "runtime-password";

afterEach(async () => {
  await reset();
});

describe("authenticated Playground runtime", () => {
  it("uses user-specific groups and only exposes routable chat models", async () => {
    await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);
    const cookie = await setupAndLogin();
    await seedPlaygroundData();

    const status = await jsonEnvelope("/api/status");
    const sidebar = JSON.parse(status.data.SidebarModulesAdmin);
    expect(sidebar.chat.playground).toBe(true);

    const groups = await jsonEnvelope("/api/user/self/groups", { cookie });
    expect(Object.keys(groups.data).sort()).toEqual([
      "auto",
      "default",
      "enterprise",
      "gold",
    ]);
    expect(groups.data.default.ratio).toBe(1);
    expect(groups.data.gold.ratio).toBe(0.5);
    expect(groups.data.enterprise.ratio).toBe(0.8);
    expect(typeof groups.data.auto.ratio).toBe("string");

    const models = await jsonEnvelope("/api/user/models", { cookie });
    expect(models.data).toEqual(["gold-chat", "gpt-chat"]);

    const denied = await playgroundRequest(cookie, {
      model: "gpt-chat",
      group: "blocked",
      stream: false,
    });
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.message).toBe("group access denied");

    const completion = await playgroundRequest(cookie, {
      model: "gpt-chat",
      group: "default",
      stream: false,
    });
    expect(completion.status).toBe(200);
    expect(await completion.json()).toMatchObject({
      id: "chatcmpl-playground-json",
      model: "gpt-chat",
      usage: { total_tokens: 4 },
    });

    const stream = await playgroundRequest(cookie, {
      model: "gold-chat",
      group: "gold",
      stream: true,
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const streamBody = await stream.text();
    expect(streamBody).toContain('"content":"streamed"');
    expect(streamBody).toContain("data: [DONE]");

    const usage = await waitForUserUsage(2);
    expect(usage.request_count).toBe(2);
    expect(usage.quota).toBeLessThan(100_000_000);

    const audit = await waitForAuditCount(2);
    expect(audit.count).toBe(2);
  });
});

async function setupAndLogin() {
  const setup = await SELF.fetch(`${baseUrl}/api/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "runtime-root",
      password,
      display_name: "Runtime Root",
    }),
  });
  expect(setup.status).toBe(200);

  const login = await SELF.fetch(`${baseUrl}/api/user/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "runtime-root", password }),
  });
  expect(login.status).toBe(200);
  const setCookie = login.headers.get("set-cookie");
  expect(setCookie).toContain("session=");
  return setCookie.split(";", 1)[0];
}

async function seedPlaygroundData() {
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE users SET "group" = ?1, quota = ?2 WHERE username = ?3',
    ).bind("enterprise", 100_000_000, "runtime-root"),
    env.DB.prepare(
      'INSERT OR REPLACE INTO options ("key", value) VALUES (?1, ?2)',
    ).bind(
      "UserUsableGroups",
      JSON.stringify({ default: "Default", vip: "VIP", auto: "Automatic" }),
    ),
    env.DB.prepare(
      'INSERT OR REPLACE INTO options ("key", value) VALUES (?1, ?2)',
    ).bind(
      "group_ratio_setting.group_special_usable_group",
      JSON.stringify({ enterprise: { "+:gold": "Gold", "-:vip": "" } }),
    ),
    env.DB.prepare(
      'INSERT OR REPLACE INTO options ("key", value) VALUES (?1, ?2)',
    ).bind(
      "group_ratio_setting.group_ratio",
      JSON.stringify({ default: 1, vip: 2, gold: 3, enterprise: 4 }),
    ),
    env.DB.prepare(
      'INSERT OR REPLACE INTO options ("key", value) VALUES (?1, ?2)',
    ).bind(
      "group_ratio_setting.group_group_ratio",
      JSON.stringify({ enterprise: { gold: 0.5, enterprise: 0.8 } }),
    ),
    env.DB.prepare(
      'INSERT OR REPLACE INTO options ("key", value) VALUES (?1, ?2)',
    ).bind("ModelRatio", JSON.stringify({ "gpt-chat": 1, "gold-chat": 1 })),
    env.DB.prepare(
      'INSERT OR REPLACE INTO options ("key", value) VALUES (?1, ?2)',
    ).bind(
      "CompletionRatio",
      JSON.stringify({ "gpt-chat": 1, "gold-chat": 1 }),
    ),
    channel(1, 1, 1, "gpt-chat", "default"),
    channel(2, 1, 1, "gold-chat", "gold"),
    channel(3, 2, 1, "task-only", "default"),
    channel(4, 1, 0, "disabled-chat", "default"),
    ability(1, "default", "gpt-chat", 1),
    ability(2, "gold", "gold-chat", 2),
    ability(3, "default", "task-only", 3),
    ability(4, "default", "disabled-chat", 4),
  ]);
}

function channel(id, type, status, model, group) {
  return env.DB.prepare(
    `INSERT INTO channels
      (id, type, "key", status, name, base_url, models, "group", weight)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 100)`,
  ).bind(
    id,
    type,
    "runtime-upstream-key",
    status,
    `runtime-${id}`,
    "https://provider.test",
    model,
    group,
  );
}

function ability(id, group, model, channelId) {
  return env.DB.prepare(
    `INSERT INTO abilities
      (id, group_name, model, channel_id, enabled, priority, weight)
     VALUES (?1, ?2, ?3, ?4, 1, 0, 100)`,
  ).bind(id, group, model, channelId);
}

async function jsonEnvelope(path, headers = {}) {
  const response = await SELF.fetch(`${baseUrl}${path}`, { headers });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.success).toBe(true);
  return body;
}

function playgroundRequest(cookie, { model, group, stream }) {
  return SELF.fetch(`${baseUrl}/pg/chat/completions`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      group,
      stream,
      messages: [{ role: "user", content: "runtime proof" }],
    }),
  });
}

async function waitForUserUsage(expectedRequestCount) {
  return waitForRow(async () => {
    const row = await env.DB.prepare(
      "SELECT quota, request_count FROM users WHERE username = ?1",
    )
      .bind("runtime-root")
      .first();
    return row?.request_count === expectedRequestCount ? row : null;
  }, "playground request-count settlement");
}

async function waitForAuditCount(expectedCount) {
  return waitForRow(async () => {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM logs WHERE username = ?1 AND type = 2",
    )
      .bind("runtime-root")
      .first();
    return row?.count === expectedCount ? row : null;
  }, "playground audit settlement");
}

async function waitForRow(read, label) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const row = await read();
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} did not complete within 3000ms`);
}
