# cinatoken 到 cinatoken-rust 完整迁移方案

生成日期：2026-06-17

## 1. 目标与结论

本方案用于将 `github:cinagroup/cinatoken` 迁移为新的 `cinatoken-rust` 项目。迁移目标不是简单翻译 Go 代码，而是把当前 Gin/GORM/Redis/Docker 架构重构为 Rust 优先、Cloudflare 云原生优先的 AI API Gateway。

推荐目标形态：

1. 前端继续沿用 `web/default` 的 React 19、Rsbuild、Base UI、Tailwind 与 Bun 构建体系，部署到 Cloudflare Pages。
2. 核心 Relay 网关迁移为 Rust Worker/WASM，负责 OpenAI/Claude/Gemini 兼容接口、鉴权、限流、额度、路由、SSE 流式转发、AI Gateway/Workers AI 调用。
3. 管理后台 API、支付、订阅、OAuth、Passkey、长尾 Provider、视频/音乐异步任务分阶段迁移到 Rust 模块。
4. 数据层以 Cloudflare D1 作为主持久化数据库，KV 作为配置/短期缓存，R2 作为文件与任务产物存储，Upstash Redis 作为原子计数、分布式锁、并发控制和热数据缓存。
5. 对 Worker 不适合承载的状态型能力使用 Durable Objects、Queues、Cron Triggers 补齐；如未来需要完全保留全部企业级长尾功能，可保留同一代码库内的 native Rust 后端部署形态作为兼容出口。

关键判断：

纯 Worker 方案适合承载高频 Relay、鉴权、配额、模型路由、日志队列与轻量管理 API；但当前 cinatoken 的完整功能包含 Passkey、复杂支付、OpenAI Realtime WebSocket、Midjourney/Suno/视频任务、AWS/Vertex/Tencent/VolcEngine 签名、Codex 订阅凭证刷新、io.net 部署管理等长尾能力。完整迁移必须采用“核心优先、长尾分批”的策略，而不是一次性替换全部 Go 后端。

## 2. 当前项目能力清单

### 2.1 后端

当前仓库是 Go 后端，主要技术与模块如下：

- HTTP 框架：Gin。
- ORM：GORM v2。
- 数据库：SQLite、MySQL、PostgreSQL 三端兼容。
- 缓存：Redis 与内存缓存。
- 入口路径：`router/`，分为 `/api` 管理接口、`/v1` Relay 接口、`/mj`、`/suno`、`/v1beta` Gemini 兼容接口等。
- 业务分层：`router -> controller -> service -> model`。
- Relay Provider：OpenAI、Anthropic、Gemini、Azure、AWS Bedrock、Vertex AI、Cloudflare、OpenRouter、DeepSeek、Zhipu、Ali、Baidu、Tencent、VolcEngine、Cohere、Mistral、Jina、SiliconFlow、xAI、Ollama、Dify、Coze、Replicate、Suno、Midjourney、Kling、Jimeng、Vidu、Sora、Codex 等。
- 计费：额度预扣、结算、退款、按 token/图片/音频/视频/任务计费、订阅计费、动态/分层表达式计费。
- 账号体系：JWT/session、用户名密码、OAuth、OIDC、自定义 OAuth、WeChat、Telegram、LinuxDO、Passkey、2FA。
- 支付：Epay、Stripe、Creem、Waffo、Waffo Pancake。
- 运维：Docker、日志清理、性能统计、pprof/Pyroscope、批量落库、任务轮询。

### 2.2 前端

当前默认前端位于 `web/default`：

- React 19。
- TypeScript。
- Rsbuild。
- Base UI。
- Tailwind CSS。
- TanStack Router/Query/Table。
- i18next，多语言文件在 `web/default/src/i18n/locales/{lang}.json`。
- Bun 是首选包管理器与脚本执行器。

前端大部分 API 已经通过 `/api/...` 与 `/v1/...` 调用后端，因此迁移时应保持路径兼容，避免大规模重写前端。

### 2.3 数据表范围

当前 Go 迁移中涉及的核心表包括：

- `channels`
- `tokens`
- `users`
- `passkey_credentials`
- `options`
- `redemptions`
- `abilities`
- `logs`
- `midjourneys`
- `top_ups`
- `quota_data`
- `tasks`
- `models`
- `vendors`
- `prefill_groups`
- `setups`
- `two_fas`
- `two_fa_backup_codes`
- `checkins`
- `subscription_plans`
- `subscription_orders`
- `user_subscriptions`
- `subscription_pre_consume_records`
- `custom_oauth_providers`
- `user_oauth_bindings`
- `perf_metrics`

Rust 版需要优先保证这些表的字段、索引、默认值、时间戳和 JSON 文本字段可无损迁移。

## 3. 迁移原则

### 3.1 兼容优先

迁移后的 `cinatoken-rust` 必须优先保持以下兼容：

- 用户已有 API Key 不失效。
- 用户额度、令牌额度、已用额度不丢失。
- 管理员已有渠道配置、模型映射、分组、倍率配置可迁移。
- OpenAI 兼容接口路径保持稳定：`/v1/chat/completions`、`/v1/responses`、`/v1/models`、`/v1/embeddings`、`/v1/images/generations` 等。
- Claude 兼容接口 `/v1/messages` 保持稳定。
- Gemini 兼容接口 `/v1beta/models/*path` 保持稳定。
- 管理前端尽量不改 API 路径。

### 3.2 分层重写

不要按目录机械翻译 Go 文件。Rust 版应按能力分层：

- `api`：HTTP 路由、请求响应、鉴权中间件。
- `core`：公共错误、时间、配置、JSON、请求上下文。
- `storage`：D1/SQL 仓储、事务、迁移。
- `cache`：KV、Upstash Redis、内存级请求缓存。
- `auth`：用户登录、JWT、OAuth、2FA、Passkey。
- `relay`：统一 Relay 流程、渠道选择、模型映射、重试、错误标准化。
- `providers`：上游模型适配器。
- `billing`：预扣、结算、退款、订阅、表达式计费。
- `tasks`：异步视频/音乐/图片任务。
- `payments`：支付下单、回调、幂等。
- `observability`：日志、指标、追踪、审计。
- `migration`：Go 数据库到 D1/新 schema 的 ETL 工具。

### 3.3 Serverless 友好

迁移后所有高频路径必须符合 Worker 运行模型：

- 请求内完成鉴权、限流、路由、转发。
- 长耗时任务提交后立即返回 task id。
- 日志、用量、统计进入 Queue 异步落库。
- 高频原子计数进入 Upstash Redis。
- 大对象进入 R2。
- 状态型 WebSocket 或会话进入 Durable Objects。
- 不依赖本地磁盘、不依赖常驻进程内存、不依赖全局锁。

### 3.4 受保护项目身份保持不变

迁移中不得删除、替换或改写原仓库中已有的受保护项目名、组织/作者归属、署名、许可证、包元数据、镜像引用、文档归属或历史 attribution。新 Rust 仓库可以增加迁移说明，但不得以“清理”“改名”“去品牌化”为理由破坏原有项目身份信息。

## 4. 目标架构

### 4.1 逻辑拓扑

```text
Client / Admin Browser
        |
Cloudflare CDN / WAF / Turnstile
        |
Cloudflare Pages: web/default static assets
        |
Rust Worker: API + Relay Gateway
        |
+-------------------+------------------+-------------------+
|                   |                  |                   |
D1                  KV                 Upstash Redis       R2
users/channels      hot config         rate/concurrency    files/task outputs
tokens/logs         token cache        locks/counters      backups/uploads
billing/tasks
        |
Queues / Cron / Durable Objects
async logs, task polling, websocket/session state
        |
Cloudflare AI Gateway / Workers AI / External Providers
```

### 4.2 Cloudflare 资源命名

建议资源命名统一使用 `cinatoken-rust-*`：

- Pages project：`cinatoken-rust-web`
- Worker：`cinatoken-rust-api`
- D1：`cinatoken-rust-db`
- KV cache：`cinatoken-rust-cache`
- KV config：`cinatoken-rust-config`
- R2 bucket：`cinatoken-rust-files`
- AI Gateway：`cinatoken-rust-gateway`
- Queue logs：`cinatoken-rust-log-events`
- Queue tasks：`cinatoken-rust-task-events`
- Durable Object namespace：`cinatoken-rust-realtime`
- Upstash Redis：`cinatoken-rust-redis`

### 4.3 Worker 绑定示例

```toml
name = "cinatoken-rust-api"
main = "build/worker/shim.mjs"
compatibility_date = "2026-06-17"
compatibility_flags = ["nodejs_compat"]

[ai]
binding = "AI"

[[d1_databases]]
binding = "DB"
database_name = "cinatoken-rust-db"
database_id = "<D1_DATABASE_ID>"

[[kv_namespaces]]
binding = "CACHE_KV"
id = "<CACHE_KV_ID>"

[[kv_namespaces]]
binding = "CONFIG_KV"
id = "<CONFIG_KV_ID>"

[[r2_buckets]]
binding = "FILE_BUCKET"
bucket_name = "cinatoken-rust-files"

[[queues.producers]]
queue = "cinatoken-rust-log-events"
binding = "LOG_QUEUE"

[[queues.producers]]
queue = "cinatoken-rust-task-events"
binding = "TASK_QUEUE"

[[durable_objects.bindings]]
name = "REALTIME"
class_name = "RealtimeSession"

[vars]
ENVIRONMENT = "production"
AI_GATEWAY_ID = "<AI_GATEWAY_ID>"
FRONTEND_BASE_URL = "https://<domain>"

# secrets:
# JWT_SECRET
# SESSION_SECRET
# ENCRYPTION_KEY
# UPSTASH_REDIS_REST_URL
# UPSTASH_REDIS_REST_TOKEN
# STRIPE_SECRET_KEY
# STRIPE_WEBHOOK_SECRET
# CREEM_API_KEY
# WAFFO_SECRET
# TURNSTILE_SECRET_KEY
```

## 5. 新仓库结构

建议 `cinatoken-rust` 使用 Cargo workspace：

```text
cinatoken-rust/
  Cargo.toml
  crates/
    api/              # HTTP router, middleware, handlers
    worker/           # Cloudflare Worker entrypoint
    core/             # config, errors, json, time, request context
    storage/          # D1/sqlx repositories, migrations
    cache/            # KV, Upstash Redis, request cache
    auth/             # login, JWT, OAuth, 2FA, passkey
    relay/            # relay pipeline, channel selection, streaming
    providers/        # provider adapters
    billing/          # quota, pre-consume, settlement, expression pricing
    tasks/            # async task submit/fetch/polling
    payments/         # Stripe/Creem/Epay/Waffo
    observability/    # logs, metrics, audit
    migration/        # export/import/verify tools
    xtask/            # dev automation
  apps/
    web/              # copied or vendored from web/default
  migrations/
    d1/
  wrangler.toml
  package.json
  bun.lock
  README.md
```

如果短期内需要保留 native Rust 后端部署能力，可以增加：

```text
crates/server/        # axum native server, optional
```

这样同一套 core/provider/billing/storage 逻辑可以同时被 Worker 与 native server 使用。Worker 承担主流云原生部署，native server 用作本地开发、复杂长连接、或不适合 WASM 的功能兜底。

## 6. Rust 技术选型

### 6.1 Worker/WASM 侧

- Worker 框架：`worker` crate。
- 序列化：`serde`、`serde_json`，封装 `core::json`，统一 marshal/unmarshal。
- HTTP 请求：Worker runtime `Fetch` API 封装，不直接假设 Tokio TCP。
- 时间：`chrono` 或 `time`，统一 Unix timestamp。
- 错误：`thiserror` + 项目统一错误响应。
- Stream/SSE：基于 Web Streams 封装 OpenAI/Claude/Gemini 流式事件转换。
- 加密：优先使用 Cloudflare Web Crypto；不兼容时抽象 `crypto` trait。
- Redis：Upstash REST API client。
- D1：Worker D1 binding prepared statements。

### 6.2 Native 侧可选

- HTTP 框架：`axum`。
- SQL：`sqlx` 或 `sea-orm`。
- Redis：`redis` crate。
- Background worker：Tokio tasks。
- WebAuthn：`webauthn-rs`。
- AWS/Google/Tencent 签名：native crate 优先。

### 6.3 DTO 规则

迁移所有上游 Relay request DTO 时必须保留“显式零值”语义：

- Go 中的 `*int`, `*float64`, `*bool` 对应 Rust 的 `Option<i64>`, `Option<f64>`, `Option<bool>`。
- Serde 使用 `#[serde(skip_serializing_if = "Option::is_none")]`。
- 客户端 JSON 未传字段：`None`，上游请求省略。
- 客户端显式传 `0`、`0.0`、`false`：`Some(0)`、`Some(0.0)`、`Some(false)`，上游必须发送。

这是 Relay 兼容性的硬要求，尤其适用于 `temperature`、`top_p`、`max_tokens`、`seed`、`stream`、`stream_options`、`presence_penalty`、`frequency_penalty` 等字段。

## 7. 模块迁移设计

### 7.1 API 路由

Rust 版应保持现有路由分组：

- `/api/setup`
- `/api/status`
- `/api/user/*`
- `/api/token/*`
- `/api/channel/*`
- `/api/log/*`
- `/api/data/*`
- `/api/pricing`
- `/api/models/*`
- `/api/vendors/*`
- `/api/subscription/*`
- `/api/option/*`
- `/api/custom-oauth-provider/*`
- `/api/perf-metrics/*`
- `/v1/models`
- `/v1/chat/completions`
- `/v1/completions`
- `/v1/responses`
- `/v1/messages`
- `/v1/images/generations`
- `/v1/images/edits`
- `/v1/embeddings`
- `/v1/audio/transcriptions`
- `/v1/audio/translations`
- `/v1/audio/speech`
- `/v1/rerank`
- `/v1beta/models/*path`
- `/mj/*`
- `/suno/*`

迁移初期可以对尚未完成的管理接口返回明确的 `501 not_implemented`，但 Relay 主路径不能破坏 OpenAI 客户端兼容性。

### 7.2 鉴权

需要迁移四类鉴权：

- 用户 session/JWT：前端后台登录使用。
- API token：`Authorization: Bearer sk-*`、兼容部分 provider header。
- Admin/Root 权限：管理接口使用。
- Webhook signature：支付回调用。

实现建议：

- API token 在 Upstash Redis 中缓存 token base 信息，D1 兜底查询。
- 用户状态、用户 group、用户 quota、用户 setting 分别缓存。
- token IP allowlist 在 Worker 中校验 `CF-Connecting-IP`。
- 所有缓存更新走“写 D1 后删/改缓存”的模式。
- 高危接口保留 secure verification 与 Turnstile 校验。

### 7.3 渠道选择与模型路由

需要从 Go 的 `middleware.Distribute()`、`service/channel_select.go`、`model/ability.go`、`model/channel.go` 中抽象出 Rust 版 Channel Selector：

输入：

- 请求模型名。
- 用户 group。
- token model limits。
- channel status。
- channel group。
- channel priority。
- channel weight。
- channel tag。
- channel model mapping。
- channel param/header override。
- channel affinity。
- channel auto-ban 状态。

输出：

- 被选中的 channel。
- 实际上游 model。
- 实际上游 key。
- base URL。
- retry policy。
- billing metadata。

Upstash Redis 负责：

- 多 key 轮询 index。
- 并发计数。
- channel 熔断短期状态。
- affinity 热点缓存。

D1 负责：

- channel 持久配置。
- ability 表。
- channel used quota。
- auto-ban 后的长期状态。

### 7.4 Relay Pipeline

Rust 版统一流程：

```text
parse request
  -> request id
  -> auth token
  -> user/token quota check
  -> model permission check
  -> rate limit
  -> channel select
  -> model mapping
  -> param/header override
  -> price estimate
  -> pre-consume quota
  -> provider build request
  -> upstream fetch / AI Gateway / Workers AI
  -> stream or JSON response normalize
  -> usage parse
  -> settle quota
  -> enqueue logs
  -> channel status update if needed
```

错误处理要求：

- 上游错误转成统一 `NewAPIError` 等价结构。
- 可重试错误进入下一个 channel。
- 不可重试错误直接返回。
- 预扣成功但请求失败必须退款。
- 流式响应中途失败必须记录 stream status，并按已获得 usage 或估算 usage 结算。

### 7.5 Provider Adapter Trait

建议定义：

```rust
#[async_trait::async_trait]
pub trait ProviderAdapter {
    fn api_type(&self) -> ApiType;
    fn supported_formats(&self) -> &'static [RelayFormat];
    fn default_base_url(&self) -> &'static str;
    async fn validate(&self, ctx: &RelayContext) -> Result<()>;
    async fn build_request(&self, ctx: &mut RelayContext) -> Result<ProviderRequest>;
    async fn send(&self, ctx: &RelayContext, req: ProviderRequest) -> Result<ProviderResponse>;
    async fn parse_response(&self, ctx: &mut RelayContext, resp: ProviderResponse) -> Result<ClientResponse>;
    async fn parse_stream(&self, ctx: &mut RelayContext, resp: ProviderResponse) -> Result<ClientStream>;
    fn estimate_usage(&self, ctx: &RelayContext) -> UsageEstimate;
}
```

任务型 Provider 增加：

```rust
#[async_trait::async_trait]
pub trait TaskAdapter {
    async fn validate_and_set_action(&self, ctx: &mut TaskContext) -> Result<()>;
    async fn estimate_billing(&self, ctx: &TaskContext) -> Result<BillingEstimate>;
    async fn submit(&self, ctx: &mut TaskContext) -> Result<TaskSubmitResult>;
    async fn fetch(&self, ctx: &TaskContext, upstream_task_id: &str) -> Result<TaskStatus>;
    fn convert_to_openai_video(&self, task: &TaskRecord) -> Result<Option<ClientResponse>>;
}
```

### 7.6 Provider 迁移批次

第一批：OpenAI 兼容主路径。

- OpenAI。
- OpenRouter。
- DeepSeek。
- Zhipu OpenAI compatible。
- SiliconFlow。
- xAI。
- Moonshot OpenAI/Claude compatible。
- Mistral。
- Perplexity。
- Jina rerank/embedding。
- Cloudflare Workers AI。

第二批：非 OpenAI 但高频核心。

- Anthropic Claude。
- Gemini。
- Ali DashScope。
- Cohere。
- Baidu v2。
- VolcEngine Ark。

第三批：签名复杂或任务复杂。

- AWS Bedrock。
- Vertex AI。
- Tencent Hunyuan。
- Replicate。
- MiniMax。
- Dify。
- Coze。
- Baidu legacy。

第四批：异步媒体任务。

- Midjourney。
- Suno。
- Kling。
- Jimeng。
- Vidu。
- Doubao Video。
- Sora。
- Gemini/Vertex video。

第五批：特殊业务。

- Codex subscription channel。
- Ollama 本地模型管理。
- io.net deployment management。

对第四、第五批，必须单独评估 Worker 限制；必要时放入 native Rust server 或 Durable Objects/Queues 组合。

### 7.7 StreamOptions 支持

每迁移一个新 channel，需要确认上游是否支持 `stream_options`。支持的 channel 写入 Rust 版 `stream_supported_channels`。不支持时不得静默转发导致上游报错，应按 Go 版行为删除或转换字段。

### 7.8 计费系统

迁移范围：

- quota unit 与金额转换。
- user quota。
- token remain quota。
- used quota。
- request count。
- pre-consume。
- refund。
- post-consume settlement。
- image/audio/video/task 特殊计费。
- subscription funding source。
- tiered/dynamic billing expression。

迁移表达式计费前必须先阅读并对齐 `pkg/billingexpr/expr.md`。Rust 版不得只做语法替代，必须保留：

- 表达式变量语义。
- token normalization。
- `p`/`c` auto-exclusion。
- quota conversion。
- expression versioning。
- editor -> storage -> pre-consume -> settlement -> log display 的完整链路。

Rust 实现建议：

- 第一阶段：实现与 Go 表达式等价的 AST/解释器，避免换语言后语义漂移。
- 第二阶段：补充 property-based tests，对同一输入比较 Go 与 Rust 输出。
- 第三阶段：在灰度环境使用 shadow billing，同时记录 Go/Rust 差异。

### 7.9 日志与统计

当前 logs 是高频写入表，直接同步写 D1 会放大延迟与写入压力。Rust 版建议：

- 请求内只构造 log event。
- 投递到 Cloudflare Queue。
- Queue consumer 批量写 D1。
- 大体量原始请求/响应审计写 R2。
- 聚合指标写 D1 summary 表或 Cloudflare Analytics Engine。
- 管理后台查询近期日志从 D1 查，历史日志从 R2/归档表查。

日志字段必须保留：

- user id。
- username。
- token name/id。
- model name。
- prompt/completion tokens。
- quota。
- channel id/name。
- group。
- stream flag。
- use time。
- request id。
- upstream request id。
- other JSON。

### 7.10 异步任务

媒体任务迁移为：

```text
submit request
  -> validate auth/quota
  -> create public task id
  -> pre-consume
  -> call upstream submit
  -> save task row in D1
  -> return task id
  -> Queue/Cron poll upstream
  -> update task status/result
  -> save result file to R2 if needed
  -> final settlement/refund
```

任务结果 URL：

- data URI 小结果可直接存入 task data。
- 图片/视频/音频等大结果写 R2。
- 原始外链可保留，但建议后台异步转存 R2，降低上游失效风险。

### 7.11 Realtime 与 WebSocket

OpenAI Realtime 路由 `/v1/realtime` 不能直接按普通 HTTP Relay 处理。可选方案：

1. Worker WebSocket pass-through：简单转发，适合无状态场景。
2. Durable Object session：保存会话状态、计数、心跳、断线清理。
3. Native Rust server：如果需要复杂双向流、长连接统计和多上游桥接，作为兜底。

建议第一阶段不承诺 Realtime 完全等价，先实现 `/v1/chat/completions` 与 `/v1/responses` 的 SSE。

### 7.12 Passkey/WebAuthn

Passkey 在 Worker/WASM 环境可能受 crypto、origin、challenge/session 存储影响。迁移策略：

- challenge 写入 Upstash Redis，设置短 TTL。
- credential 写入 D1。
- origin/rp_id 从 `FRONTEND_BASE_URL` 与部署域名生成。
- Worker 中优先使用 Web Crypto。
- 如 Rust WebAuthn crate 无法编译到 Worker，抽象 `PasskeyService`，native server 或独立验证服务兜底。

### 7.13 支付与订阅

支付迁移必须先完成幂等模型：

- 每个支付 provider 的 webhook event id 建唯一索引。
- order 状态机：created -> pending -> paid -> failed/cancelled/refunded。
- subscription order 与 user subscription 单独表。
- 回调验签失败不得写入业务状态。
- 金额、币种、商品 ID、环境 test/prod 必须严格匹配。

优先级：

1. Balance pay。
2. Stripe。
3. Creem。
4. Waffo/Waffo Pancake。
5. Epay。

## 8. 数据迁移方案

### 8.1 迁移阶段

数据迁移分四轮：

1. Schema freeze：冻结 Go 版数据库 schema，记录当前迁移版本。
2. Dry-run export/import：从现有 SQLite/MySQL/PostgreSQL 导出到本地中间格式，再导入 D1 staging。
3. Shadow sync：生产继续跑 Go，Rust 读 D1 staging 做只读校验；必要时同步增量数据。
4. Cutover migration：短暂停写，导出增量，导入 D1 production，预热缓存，切流量。

### 8.2 中间格式

建议使用 JSONL 或 Parquet/R2 归档作为中间格式，而不是直接 SQL dump：

```text
migration/export/
  users.jsonl
  tokens.jsonl
  channels.jsonl
  abilities.jsonl
  options.jsonl
  logs-2026-06.jsonl
  tasks.jsonl
  subscriptions.jsonl
  checksums.json
```

优点：

- 可从 SQLite/MySQL/PostgreSQL 统一导出。
- 可逐表校验 count/hash。
- 可脱敏检查。
- 可分批导入 D1。
- 便于失败重试。

### 8.3 字段处理规则

- 所有 JSON 字段在 D1 中用 `TEXT` 存储。
- Go bool 迁移为 D1 integer `0/1` 或 SQLite boolean affinity，查询层统一转换。
- `DeletedAt` 软删除字段迁移为 nullable timestamp。
- `CreatedAt`、`UpdatedAt`、`created_time`、`accessed_time` 等保持 Unix timestamp。
- quota 字段保持整数，不做浮点转换。
- channel key、token key、OAuth secrets、payment secrets 导入前评估是否进行应用层 AES-GCM 加密。
- 表名和列名保持兼容，避免前端和迁移脚本大改。

### 8.4 D1 Schema 策略

D1 使用 SQLite 方言，建议手写 migration SQL，不依赖 ORM 自动迁移。每张表：

- 显式定义 primary key。
- 显式定义 default。
- 显式创建查询必要索引。
- 避免数据库特定 JSON 类型。
- 避免不受支持的 ALTER COLUMN。
- 新字段只用 `ALTER TABLE ... ADD COLUMN`。

### 8.5 迁移校验

每次导入后执行：

- 每表 count 对比。
- 每表主键 min/max 对比。
- 关键字段 hash 对比。
- 随机抽样 1000 条用户、token、channel、log 对比。
- 用户登录抽样。
- API token 鉴权抽样。
- channel routing 抽样。
- billing expression 样例对比。
- 最近 7 天日志统计对比。

### 8.6 缓存预热

切流前预热：

- enabled tokens。
- enabled users base info。
- enabled channels。
- abilities by model/group。
- options。
- model pricing。
- ratio config。
- header nav/config。

Upstash Redis key 命名建议：

```text
ct:token:{api_key_hash}
ct:user:{user_id}:base
ct:user:{user_id}:quota
ct:user:{user_id}:group
ct:channel:{channel_id}
ct:ability:{group}:{model}
ct:rate:{scope}:{window}
ct:lock:{name}
ct:affinity:{user_or_token}:{model}
```

token 原文不要作为 Redis key，使用 hash 后缀。

## 9. 前端迁移方案

### 9.1 保留现有 web/default

短期不要重写前端。将 `web/default` 复制或迁移到 `cinatoken-rust/apps/web`：

- 保留 React 19。
- 保留 Rsbuild。
- 保留 i18n 结构。
- 保留 API path。
- 保留 Bun。

部署：

```bash
cd apps/web
bun install
bun run build
```

Cloudflare Pages：

- Build command：`bun run build`
- Output directory：按 Rsbuild 配置输出，一般为 `dist`
- Environment：`VITE_API_BASE_URL` 或现有 API base 配置指向 Worker 域名。

### 9.2 API 兼容层

Rust Worker 在迁移期提供 API compatibility layer：

- 返回格式沿用当前 `{ success, message, data }` 或现有控制器格式。
- 分页参数兼容 `p`、`size`、`page_size`。
- 登录态 cookie/header 兼容。
- 错误码与错误文案尽量兼容。

### 9.3 i18n

新增前端文本时：

- 先写英文 key。
- 更新 `en`, `zh`, `fr`, `ru`, `ja`, `vi`。
- 从 `apps/web` 执行 `bun run i18n:sync`。

## 10. Cloudflare AI Gateway 与 Workers AI 适配

### 10.1 调用策略

Provider 分为三类：

1. Workers AI 原生模型：通过 `env.AI` 调用。
2. AI Gateway 支持的外部 provider：通过 AI Gateway 统一转发、缓存、统计、限流。
3. 需要特殊签名/协议的 provider：Rust Worker 直接签名并 fetch，或 native server 兜底。

### 10.2 模型路由

新增 channel type：

- Cloudflare Workers AI。
- Cloudflare AI Gateway provider。

Rust channel 配置需要支持：

- gateway id。
- provider name。
- account id。
- model mapping。
- cache ttl。
- fallback model。
- upstream timeout。

### 10.3 降级策略

推荐降级顺序：

```text
primary channel
  -> same provider next key
  -> same model next provider
  -> configured fallback model
  -> cheaper/smaller model
  -> structured error
```

降级必须写入日志 `other.fallback`，便于后台审计。

## 11. 安全方案

### 11.1 密钥管理

- Cloudflare secrets 保存环境密钥。
- channel key/token key 可选择应用层加密后存 D1。
- 管理端展示 key 必须经过 secure verification。
- 日志中永不记录完整 key。
- Redis key 使用 hash。

### 11.2 SSRF 与出站控制

需要迁移 Go 版 SSRF protection：

- 禁止请求内网 IP。
- 禁止 file/local 协议。
- 对自定义 base URL 做域名/IP 校验。
- DNS resolve 后校验 IP range。
- 对 redirect 后地址再次校验。

### 11.3 CORS 与 WAF

- Worker 处理 API CORS。
- Cloudflare WAF 做基础攻击拦截。
- Turnstile 用于注册、登录、找回密码、check-in。
- Global API rate limit 进入 Upstash Redis。

### 11.4 审计

高危操作必须记录：

- 操作者 user id。
- 目标资源。
- 路由与方法。
- IP。
- request id。
- 操作结果。
- 参数摘要，不记录敏感明文。

## 12. 观测与运维

### 12.1 指标

需要采集：

- request count。
- relay latency。
- upstream latency。
- stream duration。
- status code。
- provider error code。
- model usage。
- prompt/completion tokens。
- quota consumed。
- cache hit/miss。
- rate-limit block count。
- queue lag。
- D1 write failures。

### 12.2 日志

建议分层：

- Worker console logs：短期调试。
- D1 logs：后台近期查询。
- R2 archived logs：长期归档。
- Analytics Engine：聚合分析。

### 12.3 告警

至少配置：

- upstream 5xx 比例。
- provider 429 比例。
- D1 write failure。
- Queue backlog。
- Redis REST failure。
- quota settlement failure。
- payment webhook failure。

## 13. 开发与测试计划

### 13.1 测试层级

- Unit tests：DTO serde、model mapping、pricing、quota、provider request build。
- Golden tests：Go 输入/输出样例与 Rust 输出一致。
- Integration tests：D1 local、Redis mock、Worker fetch mock。
- Stream tests：SSE chunk、usage chunk、error chunk、中途断流。
- Billing tests：pre-consume、refund、settlement、subscription funding。
- Migration tests：表 count/hash、抽样 diff。
- E2E tests：前端登录、创建 token、创建 channel、发起 chat completion、查看日志。

### 13.2 兼容测试矩阵

Relay：

- OpenAI chat non-stream。
- OpenAI chat stream。
- OpenAI responses non-stream。
- OpenAI responses stream。
- Claude messages。
- Gemini generateContent。
- embeddings。
- rerank。
- image generation。
- audio transcription。

业务：

- 用户注册/登录/退出。
- token 创建/编辑/删除。
- channel 创建/测试/禁用。
- quota 预扣/结算/退款。
- 日志查询。
- 支付 webhook 幂等。
- 订阅购买/失效/续期。

### 13.3 压测

压测目标按阶段提升：

- MVP：50 并发流式请求。
- Beta：200 并发流式请求。
- Release：500+ 并发混合请求。

指标：

- p95 first token latency。
- p95 total latency。
- stream disconnect rate。
- Redis latency。
- D1 write queue lag。
- error rate。

## 14. 分阶段实施计划

### Phase 0：盘点与冻结

交付物：

- 当前 Go 版接口清单。
- 当前数据表 schema dump。
- 当前 provider 能力矩阵。
- 当前 env/options 清单。
- 当前生产渠道、模型、价格、订阅、支付配置导出。
- 受保护项目身份与 attribution 清单。

验收：

- 所有迁移对象有 owner。
- 所有 P0/P1 功能标记完成。
- 数据迁移风险清单完成。

### Phase 1：Rust Workspace 与基础设施

交付物：

- `cinatoken-rust` Cargo workspace。
- Worker entrypoint。
- local `wrangler dev`。
- D1/KV/R2/Queue/Redis binding mock。
- 统一 error/json/config/time/request-id 模块。
- CI：fmt、clippy、test、wasm build。

验收：

- `/api/status` 可返回。
- `/v1/models` mock 可返回。
- Pages 可访问并指向 Worker。

### Phase 2：数据层与迁移工具

交付物：

- D1 migration SQL。
- storage repository。
- export/import/verify CLI。
- users/tokens/channels/options/abilities/logs 核心表迁移。
- Redis/KV cache abstraction。

验收：

- staging D1 导入成功。
- 核心表 count/hash 一致。
- token/user/channel 抽样查询一致。

### Phase 3：Relay MVP

交付物：

- TokenAuth。
- channel selector。
- OpenAI-compatible provider。
- SSE stream。
- quota pre-consume/refund/settlement。
- logs queue。
- `/v1/chat/completions`。
- `/v1/responses` 基础兼容。
- `/v1/models`。

验收：

- OpenAI SDK 可直接调用。
- stream/non-stream 正常。
- 显式零值参数保留。
- quota 正确扣减。
- 请求日志可查。

### Phase 4：管理后台核心

交付物：

- 登录/注册/退出。
- user self。
- token CRUD。
- channel CRUD。
- model/pricing 读取。
- logs/data 查询。
- option 读取/更新。

验收：

- `web/default` 无大规模改动即可使用。
- 管理员可创建 channel。
- 用户可创建 token 并发起请求。

### Phase 5：Provider 扩展

交付物：

- Anthropic。
- Gemini。
- Cloudflare Workers AI。
- AI Gateway provider。
- Ali。
- DeepSeek。
- Zhipu。
- SiliconFlow。
- xAI。
- Cohere/Jina/Mistral。

验收：

- 每个 provider 至少覆盖 non-stream、stream 或其核心能力。
- provider golden tests 通过。
- channel auto-ban 与 retry 生效。

### Phase 6：计费、订阅、支付

交付物：

- top-up。
- balance pay。
- Stripe webhook。
- subscription plans。
- user subscriptions。
- expression billing。
- payment compliance guard。

验收：

- 支付回调幂等。
- 订阅额度与普通余额 funding source 正确。
- Go/Rust shadow billing 差异为 0 或有明确豁免。

### Phase 7：异步任务与长尾能力

交付物：

- task submit/fetch。
- video task framework。
- R2 result storage。
- Queue/Cron polling。
- Midjourney/Suno/Kling/Jimeng/Vidu/Sora 分批迁移。
- Realtime/WebSocket 方案落地。

验收：

- 任务生命周期完整。
- 成功/失败/退款可追踪。
- 大文件不进入 D1。

### Phase 8：灰度上线

交付物：

- shadow traffic。
- canary token group。
- canary channel group。
- 双写/差异对比。
- dashboard beta 域名。

验收：

- 24-72 小时核心指标稳定。
- quota/log/billing 差异可解释。
- 错误率低于 Go 版或不高于设定阈值。

### Phase 9：正式切换

步骤：

1. 通知维护窗口。
2. Go 版进入短暂停写或限制管理写操作。
3. 导出增量数据。
4. 导入 D1 production。
5. 预热 Redis/KV。
6. 切换 DNS 到 Cloudflare Worker/Pages。
7. 观察实时日志和支付回调。
8. 保留 Go 版只读/备用 7-14 天。
9. 完成后归档旧部署。

### Phase 10：收尾

交付物：

- 删除临时双写逻辑。
- 更新部署文档。
- 更新开发文档。
- 完善 provider coverage。
- 完成性能优化。
- 完成安全审计。

## 15. 切流与回滚策略

### 15.1 切流策略

优先采用域名分层：

- `api-rust.example.com`：Rust staging。
- `beta.example.com`：Pages beta + Rust Worker。
- `api.example.com`：正式 API。
- `example.com`：正式前端。

灰度方式：

- 按 token group 灰度。
- 按用户 group 灰度。
- 按模型灰度。
- 按 provider 灰度。
- 按路径灰度：先 `/v1/chat/completions`，再管理 API。

### 15.2 回滚策略

回滚必须可在 15 分钟内完成：

- DNS 切回 Go origin。
- Go 数据库保持只读快照和增量导入能力。
- 支付 webhook 保留旧 endpoint 备用。
- Rust 写入的新增用户/token/order/task 需要可导出回 Go 或在维护窗口内冻结。
- 若 quota/billing 出现差异，优先冻结扣费路径，保留查询与登录。

### 15.3 数据一致性

高风险表：

- users quota。
- tokens remain_quota/used_quota。
- logs。
- subscription orders。
- payment orders。
- tasks。

切流期建议：

- quota 使用 Redis 原子计数与 D1 异步 flush。
- payment/order 使用 D1 强一致写入和幂等 key。
- logs 可最终一致。
- tasks 可最终一致，但 billing/refund 必须幂等。

## 16. 风险清单

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| D1 高频写入压力 | 日志/额度写入延迟 | Queue 批量写，Redis 原子计数，日志归档 R2 |
| Worker CPU/请求时长限制 | 长任务/复杂转换失败 | 任务异步化，native server 兜底 |
| WebAuthn crate WASM 兼容 | Passkey 迁移受阻 | 抽象服务，Web Crypto 或 native fallback |
| Provider 长尾签名复杂 | AWS/Vertex/Tencent 等延期 | 分批迁移，golden tests |
| SSE 中途断流结算 | 额度不准 | stream status，usage chunk 优先，估算兜底 |
| 支付 webhook 重放 | 重复充值 | event id 幂等表，签名校验 |
| token 明文泄露 | 安全事故 | 加密存储，key masking，secure verification |
| AI Gateway 行为差异 | 上游兼容问题 | provider 直连 fallback |
| 前端 API 响应差异 | 后台页面异常 | compatibility layer 与 E2E |
| 受保护 attribution 被误改 | 合规/项目政策违规 | 迁移清单锁定，不做删除/替换 |

## 17. 验收标准

### 17.1 功能验收

- Pages 前端可访问。
- 用户可注册、登录、退出。
- 管理员可配置 channel。
- 用户可创建 token。
- OpenAI SDK 可调用 `/v1/chat/completions`。
- SSE 流式返回稳定。
- quota 预扣、结算、退款正确。
- logs 可查询。
- model/pricing 可查询。
- 至少 5 个核心 provider 可用。
- 支付与订阅在 staging 完成闭环。

### 17.2 数据验收

- 核心表 count 一致。
- 核心表 hash 一致或差异有解释。
- 用户 quota 抽样一致。
- token remain quota 抽样一致。
- channel ability 抽样一致。
- 最近日志统计一致。
- 订阅状态一致。

### 17.3 性能验收

- p95 鉴权 + 路由开销低于目标阈值。
- stream 首 token 延迟不明显高于 Go 版。
- Redis/D1/Queue 无持续错误。
- 500 并发混合请求下无系统性 5xx。

### 17.4 安全验收

- CORS 正确。
- Turnstile 正常。
- OAuth state 防重放。
- webhook 验签有效。
- admin/root 权限隔离有效。
- key 不出现在日志。
- SSRF 防护有效。

## 18. 建议里程碑

| 阶段 | 周期 | 结果 |
| --- | --- | --- |
| Phase 0 | 3-5 天 | 盘点、冻结、矩阵 |
| Phase 1 | 1 周 | Rust/Worker 基础可运行 |
| Phase 2 | 1-2 周 | D1 schema 与迁移工具 |
| Phase 3 | 2 周 | Relay MVP 可用 |
| Phase 4 | 2 周 | 管理后台核心可用 |
| Phase 5 | 2-4 周 | 主流 provider 完成 |
| Phase 6 | 2-3 周 | 计费/订阅/支付完成 |
| Phase 7 | 3-6 周 | 异步任务与长尾能力 |
| Phase 8 | 1-2 周 | 灰度与压测 |
| Phase 9 | 1-2 天 | 正式切换 |
| Phase 10 | 持续 | 收尾优化 |

完整迁移预计 10-18 周，取决于长尾 provider 与支付/任务能力要求。若只做 Relay MVP + 管理核心，4-6 周可交付 beta。

## 19. 首批任务清单

1. 创建 `cinatoken-rust` 仓库与 Cargo workspace。
2. 建立 `worker`、`core`、`api`、`storage`、`cache`、`relay`、`providers`、`billing` crate。
3. 从 Go 版导出 OpenAPI/路由清单，标记 P0/P1/P2。
4. 手写 D1 migration v1，覆盖 users/tokens/channels/abilities/options/logs。
5. 实现 export/import/verify CLI。
6. 实现 `/api/status`、`/v1/models`、`/v1/chat/completions`。
7. 实现 token auth、user quota、token quota。
8. 实现 OpenAI-compatible provider。
9. 实现 SSE stream parser/normalizer。
10. 接入 Upstash Redis rate limit 与 pre-consume lock。
11. 接入 Queue 异步日志。
12. 将 `web/default` 构建到 Pages staging。
13. 用现有前端跑通登录、token、channel、chat、log 最小闭环。

## 19.1 Current Execution Status (2026-06-20)

Production-readiness audit and go/no-go gates are tracked in
`docs/production-migration-plan-audit.md`.

- Rust workspace, Worker entrypoint, D1 core schema, migration CLI, cache
  abstractions, Upstash Redis client, relay auth, channel selection, model
  mapping, OpenAI-compatible relay endpoints, native Anthropic Messages relay,
  OpenAI-compatible image generation JSON/SSE relay, OpenAI-compatible audio
  speech relay, Jina `/v1/rerank` JSON relay, Cohere `/v1/rerank` JSON
  request/response adapter, native Gemini generateContent, streamGenerateContent,
  embedContent, and batchEmbedContents relay, native Gemini countTokens relay,
  read-through token/channel cache, and relay token/IP rate limits are now in
  place.
- Tiered billing expression foundations are in place: expression execution,
  request `param()`/`header()` probes, tier trace capture, group-ratio
  snapshots, refund/additional settlement deltas, D1 billing option lookup, and
  D1 pre-consume reserve/delta settlement for OpenAI-compatible
  tiered-expression responses.
- Billing expressions stored as `billing_expr|||request_rule_expr` are now
  split and applied in Rust billing preflight/settlement, with Worker audit
  metadata marking the presence of request rules without logging full rule
  bodies.
- Rust billing snapshots now freeze Go-compatible expression hash metadata and
  run compile-style validation before tiered pre-consume, including inactive
  branches and request-rule expressions.
- The first Go/Rust billing golden parity fixtures now cover multi-condition
  expressions, cache split pricing, `len` tier conditions, ratio-equivalent
  quota conversion, request probes, and used-variable detection.
- OpenAI-compatible JSON and SSE usage parsing is now shared in the relay
  crate, including cached/cache-creation token details, Anthropic cache
  semantics, Anthropic streaming usage events, Gemini generate and embedding
  `usageMetadata`, Gemini countTokens `totalTokens`, GPT image generation
  output image tokens, image/audio input/output token details, final streaming
  usage chunks, `[DONE]`, CRLF streams, and nested response usage metadata.
- Channel selection and channel read-through cache keys now include endpoint
  provider family, so OpenAI-compatible, native Anthropic, and native Gemini
  routes do not reuse each other's selected channels for the same group/model.
- The Worker now freezes a tiered billing preflight snapshot before upstream
  relay using the original request body, prompt/completion token estimates, and
  visible request-body media fallback counts, applies Go-compatible
  request-time `img`/`ai` expression-variable normalization, reserves estimated
  wallet/token quota for tiered requests, then settles successful usage against
  that frozen snapshot.
- Streaming chat, completions, responses, image generations, Anthropic
  Messages, and native Gemini passthrough now tee the upstream response and
  consume an audit branch with incremental SSE usage parsing in `wait_until`;
  successful tiered streaming responses settle reserved quota after full stream
  usage is known.
- Non-stream relays with a Worker `Context` now return the original upstream
  response stream to the client and consume a cloned audit branch in
  `wait_until`; clone failures fall back to the buffered relay response path.
- Actual tiered-expression settlement now rebuilds token parameters from
  upstream usage details and the frozen expression's variable usage, avoiding
  double-counting cached/image/audio sub-categories in `p` or `c`.
- Successful tiered-expression audit logs now include top-level usage-log
  display fields for `billing_mode`, base-expression `expr_b64`, and
  `matched_tier`, while request-rule bodies remain out of log metadata.
- `/v1/rerank` now supports Jina channel type `38` as non-streaming JSON
  passthrough and Cohere channel type `34` with Go-compatible request/response
  adaptation, including `query`/`documents` validation, request-time token
  estimation from rerank `query` and `documents`, Cohere `top_n`/document
  return normalization, and unified rerank usage parsing for Jina total-token
  usage plus Cohere `meta.billed_units`.
- Remaining Phase 3 billing work: exact tokenizer counts plus image dimension
  and audio duration parity for request-time token estimation, and continued
  Go/Rust golden billing parity expansion.
- Next relay/API candidate from the migration plan: the relay now has an
  explicit JSON request-body mode, shared JSON preparation boundary, and
  reusable bounded request-byte reader with JSON content-type preflight;
  extend this into multipart/raw-body modes before
  `/v1/audio/transcriptions` and `/v1/audio/translations`. Provider-specific
  rerank transforms beyond Jina/Cohere remain pending.

## 20. 最终交付形态

最终 `cinatoken-rust` 应具备：

- 一套 Rust 代码库。
- Worker 云原生部署。
- Pages 前端部署。
- D1/KV/R2/Upstash/Queues/Durable Objects 全资源绑定。
- 与当前 cinatoken 核心 API 兼容。
- 主流 provider 等价迁移。
- 完整 quota/billing/log/payment/task 链路。
- 数据迁移工具与回滚工具。
- 可观测性与安全策略。
- 明确的长尾 provider coverage 文档。

这份方案以附件中的 Cloudflare 全栈思路为基础，但针对 cinatoken 当前真实功能面做了分阶段与兼容边界设计。执行时应先迁移高频 Relay 与管理核心，再迁移计费支付与长尾任务，最后切换生产流量。
