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
Cloudflare CDN / WAF / Turnstile / Rate Limiting binding
        |
Rust Worker: Static Assets (web/default, 同源) + API + Relay Gateway
        |
+-------------------+------------------+-------------------+
|                   |                  |                   |
D1 (Sessions API    KV                 Durable Objects     R2
 + 读副本)          hot config         counters/locks       files/task outputs
users/channels      token cache        concurrency/熔断     backups/uploads
tokens/logs/billing
        |
Queues / Cron / Workflows / Durable Objects
async logs(Queue), task+payment 编排(Workflows), websocket/session(DO)

注：限流改用 Workers 原生 Rate Limiting binding；native 兜底改用 Cloudflare
Containers；前端用 Worker Static Assets。详见 §21（凡冲突以 §21 为准）。
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

- Codex subscription channel（管理端 usage/refresh 已迁移；relay/runtime 仍需单独评估）。
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
`docs/production-migration-plan-audit.md`. The production execution source of
truth is now `docs/production-migration-execution-plan.md`, which breaks the
migration into gate-driven workstreams, route/data/billing readiness, canary,
and rollback evidence.

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
  reusable bounded request-byte reader with shared content-type policy. Inactive
  multipart/raw/stream modes are defined with guarded 501 handling; implement
  extraction and upstream forwarding before
  `/v1/audio/transcriptions` and `/v1/audio/translations`. Provider-specific
  rerank transforms beyond Jina/Cohere remain pending.

## Production Execution Cross-References

This original migration plan remains the architecture baseline. The current
production-grade execution details are split into focused runbooks:

- `docs/production-migration-execution-plan.md` is the gate-driven source of
  truth for production migration.
- `docs/production-readiness-matrices.md` tracks route, provider, table,
  Cloudflare binding, billing, G5 admin/frontend/auth, observability, security,
  and SLO evidence.
- `docs/data-migration-runbook.md` controls source export, D1 import, row/hash
  verification, freeze, rollback, and reconciliation.
- `docs/billing-parity-runbook.md` controls billing-expression parity, shadow
  settlement, and paid cutover.
- `docs/route-provider-parity-runbook.md` controls G3 relay/provider parity.
- `docs/admin-frontend-parity-runbook.md` controls G5 frontend deployment,
  auth/session strategy, operator CRUD, cache invalidation, and admin audit.
- `docs/observability-slo-security-runbook.md` controls G6 logs, SLOs, alerts,
  security checks, and incident evidence.
- `docs/performance-capacity-cost-runbook.md` controls load profiles,
  Cloudflare capacity, D1/Upstash/Queue/R2 cost forecasts, and bottleneck
  ownership.
- `docs/staging-smoke-runbook.md` and `docs/cutover-rollback-runbook.md`
  control staging evidence, canary, abort, rollback, and decommission.

## 20. 最终交付形态

最终 `cinatoken-rust` 应具备：

- 一套 Rust 代码库。
- Worker 云原生部署（API + 同源 Static Assets 前端）。
- D1（Sessions API 读副本）/KV/R2/Queues/Workflows/Durable Objects/Rate Limiting binding
  全资源绑定；WASM 不兼容/长任务用 Cloudflare Containers 兜底。详见 §21。
- 与当前 cinatoken 核心 API 兼容。
- 主流 provider 等价迁移。
- 完整 quota/billing/log/payment/task 链路。
- 数据迁移工具与回滚工具。
- 可观测性与安全策略。
- 明确的长尾 provider coverage 文档。

这份方案以附件中的 Cloudflare 全栈思路为基础，但针对 cinatoken 当前真实功能面做了分阶段与兼容边界设计。执行时应先迁移高频 Relay 与管理核心，再迁移计费支付与长尾任务，最后切换生产流量。

## 21. 结合 2026 Cloudflare 平台的优化修正

更新日期：2026-06-25

本节是对前文（§3.3、§4.1、§7.2、§7.3、§7.9、§7.10、§7.11、§7.12、§9、§10、§14
Phase 7、§16）的**平台级修正与升级**。本方案的多数 Cloudflare 引用锚定在
2026-06-22，而 2026 上半年若干 GA 能力已经取代或显著优化了原有假设。**凡本节与前文
冲突处，以本节为准。** 所有结论均基于已核实的当前平台事实（GA 日期见各条）。

执行原则不变：核心优先、长尾分批、D1 为真相源、流式不缓冲、所有变更可回滚。本节只把
"用什么 Cloudflare 原语实现"修正到 2026 的最佳实践。

### 21.1 限流：从 Upstash REST 迁移到 Workers 原生 Rate Limiting binding（修正 §3.3/§7.2/§7.3）

原方案在每个 relay 请求上把限流走 Upstash REST，意味着每个请求都有一次跨区域 REST 往返
到单区域 Upstash，既加延迟又引入方案 §16 自己列为告警的外部失败模式。

Workers 原生 Rate Limiting binding 已于 **2025-09-19 GA**：计数器缓存在运行 Worker 的
同一台机器上、后端存储在同一 Cloudflare 机房内异步更新，官方明确"不引入任何有意义的延迟"。

修正：

- per-token / per-IP / per-route-family 限流改用 `[[ratelimit]]` binding（`namespace_id`
  + `simple { limit, period }`），按 token 指纹 / `CF-Connecting-IP` / 路由族 / 环境分桶。
- 限流计数**不再走 Upstash**。`ct:rate:{scope}:{window}` 这一类 Redis key 退役。
- Rate Limiting binding 不在 Dashboard 直接可视，监控改为：Workers Logs 记录 429 +
  Analytics Engine 自定义数据点（`limit()` 返回 `success:false` 时 emit `rate_limited`）。

### 21.2 去 Upstash：热路径外部往返尽量换成 Cloudflare 原生（修正 §4.1/§7.3/§8.6）

目标：**把热路径上的非 Cloudflare egress 降到零**。原方案把 counters / locks / cache /
concurrency 全压在 Upstash；对全球分布的 Worker，每次 Upstash REST 都是到单区域的往返。
原语映射修正如下：

| 用途 | 原方案 | 修正后 |
| --- | --- | --- |
| 限流 | Upstash REST | Rate Limiting binding（§21.1） |
| token/channel/options 读缓存 | Upstash 读穿透 | D1 Sessions API 读副本（§21.3）+ KV/Cache API |
| 多 key 轮询 index | Upstash 计数 | Durable Object（单线程强一致、就近）|
| 并发上限 / 熔断短期状态 | Upstash | Durable Object |
| 分布式锁 | Upstash | Durable Object（DO 即天然临界区，多数场景无需显式锁）|
| 短 TTL 状态（Passkey challenge 等）| Upstash | KV（短 TTL）或 DO |

落地策略：

- 新增 Durable Object 命名空间承载"全局原子状态"（轮询 index、并发计数、channel 熔断）。
  DO 单线程串行化天然提供强一致，省掉 Upstash 显式锁。
- §8.6 的 `ct:*` Redis key 命名表整体改写为 DO storage key / KV key；token 原文仍只用 hash。
- **Upstash 不作为生产硬依赖**。若过渡期保留，必须：钉住其区域靠近 D1 primary 或改用
  Upstash Global，并在 §11/§16 记录该跨网络依赖的失败降级（fail-open 仅限非关键缓存读，
  限流/并发控制 fail-closed 或降级到本地近似）。

### 21.3 D1：启用 Sessions API + 全球读副本，并明确 10GB/库上限的归档/分片策略（修正 §8）

原方案把 D1 当作单区域 primary。但 relay 热路径是读密集的（token 鉴权、channel/ability/
options 读取）。

- **读复制（Sessions API，公测）**：把读路由到就近读副本，降低全球读延迟；同时用 session
  bookmark 保证 read-your-writes 顺序一致——管理员改配置后立即可见。这直接缓解 §16 的
  "D1 高频读写压力"。所有 Worker 内 D1 访问改为 `env.DB.withSession(bookmark)`，把 bookmark
  随登录态/请求上下文传递。写后立即读的管理路径必须复用同一 session。
- **10GB/库上限不可调**（Paid，已从 2GB 提升；账户级最多 50,000 库）。修正归档策略：
  - D1 只存近期可查日志/任务；历史按月归档到 R2 + Analytics Engine（已与 §7.9 一致）。
  - `logs` / `tasks` / `quota_data` 长期可能撑爆单库，预留**按月或按账户分库**的 schema 设计
    （表名带分片后缀、查询层路由），利用账户级多库能力。
- 备份/回滚：D1 **Time Travel**（30 天）即 cutover 的还原点，写入 §15 回滚清单。

### 21.4 native 兜底：用 Cloudflare Containers 取代独立 VPS/native server（修正 §5/§6.2/§7.11/§7.12，provider 第四/五批）

原方案把 native axum server 作为 WASM 不兼容 / 长任务的逃生舱，隐含独立 VPS 基础设施。
**Cloudflare Containers + Sandboxes 已于 2026-04-13 GA**（Workers Paid，active-CPU 计费，
可由 Worker 经 binding/hostname 就近调度，支持数千并发容器）。

修正：

- 同一个 `crates/server`（axum）二进制打包为 Container，由 Worker 转发调用，**全部留在
  Cloudflare**——无需独立 VPS、独立 DNS、跨网络 egress。
- 适合放 Container 的工作负载：WebAuthn/Passkey（§7.12）、AWS/Vertex/Tencent 复杂签名、
  Realtime WebSocket 桥接（§7.11，配合 DO WebSocket Hibernation 管理空闲连接）、
  Codex relay/runtime 长尾语义（bounded admin usage/refresh 已可留在 Worker）、
  io.net 部署管理、超大 tokenizer / CPU 密集转换。
- VPS 仅作为 Containers 也不适用时的最后退路。原方案 §1 的"单一 Cloudflare 云原生"目标因此
  得以保持。

### 21.5 异步任务与支付：用 Workflows（持久化执行）编排，Queue 仅做高吞吐扇入（修正 §7.10/§7.13，Phase 7）

**Cloudflare Workflows 已 GA**：持久化步骤、`step.sleep/sleepUntil`（用于轮询
Midjourney/Suno/视频上游）、自动重试、`waitForEvent`（等 Stripe/Creem webhook）、状态持久化。
这让"task retry 不重复扣费""payment replay 不重复入账"成为一等公民。

修正分工：

- **Queue**：高吞吐日志扇入 + 批量写 D1（§7.9 不变）。
- **Workflows**：任务生命周期（submit → 轮询 → 落 R2 → 结算/退款）与支付对账的多步编排，
  每步幂等、可重放、可观测。
- **Cron Triggers**：仅保留定时清理/对账触发，轮询逻辑迁入 Workflows。

### 21.6 前端：统一为 Workers Static Assets（单 Worker 同源），不再用独立 Pages（修正 §4.1/§9）

实现（`wrangler.toml` 的 `[assets]` + `not_found_handling = "single-page-application"`）
已经用 Workers Static Assets，但 §4.1 拓扑与 §9 仍写 Pages，属文档滞后。

- 2026-03 起 Workers Static Assets 与 Pages 已**完全平价**，官方对新项目建议"skip Pages
  entirely"；Secrets Store / Workflows / Containers / Durable Objects 均为 Workers-only。
- 单 Worker（静态资源 + API 同源）**消除 Pages 与 API Worker 间的跨域 CORS 和跨站 cookie**，
  简化 §7.2 登录态。
- §4.1 拓扑中"Cloudflare Pages"一项更正为"Worker Static Assets（与 API 同一 Worker）"。

### 21.7 增强项

- **金丝雀用 Workers Gradual Deployments（版本级百分比）作为主手段**：原生百分比切流 +
  秒级回滚，轻松满足 §15 的 15 分钟回滚。组合：版本风险用 gradual deployments，业务风险用
  token-group 门控。替代 §15.1 中以 DNS 为主的灰度描述。
- **Smart Placement 评估**：热路径与 D1 primary、（残留的）Upstash 多次 subrequest 往返时，
  Smart Placement 可把 Worker 放到后端附近。对流式 relay 上游延迟通常主导，须两种摆放都压测
  再定，默认不开。
- **Secrets Store**：provider/payment key 在 Worker + Container 间共享、需集中轮换与审计时，
  用账户级 Secrets Store 优于逐 Worker `wrangler secret put`。§11.1 密钥清单加"是否走
  Secrets Store"一列。
- **AI Gateway 多卸载少自造**（修正 §10.3）：provider fallback / retry / 缓存 / 限流 /
  统一日志 / 成本统计交给 AI Gateway，Worker 只管业务路由（channel/group/billing），减少
  热路径代码与 subrequest 数。
- **tokenizer crate 的 bundle/CPU 预算**：精确 token 计数会撑大 Worker 包（Paid 压缩后 10MB
  上限）并吃 CPU。大词表/merges 从 KV/R2 加载而非内嵌；设 `[limits] cpu_ms`；必要时把重
  tokenize 卸到 Container（§21.4）。挂在 billing P1 下。

### 21.8 文档一致性与小问题

- 删除仓库根目录的 `nul` 文件（Windows `> nul` 重定向产物），并加入 `.gitignore`。
- §4.1 拓扑图与 audit "Target Production Architecture" 图按 §21.1/§21.2/§21.4/§21.6 对齐。
- `compatibility_date` 在 config checklist 中定季度 bump cadence，不要临到 prod 才 review。

### 21.9 受影响 runbook

本节落地到以下文档（均已同步更新，标注 2026-06-25）：

- `docs/production-migration-execution-plan.md`：Best-Practice Anchors、Cache/Rate-Limit、
  Async/Tasks、Canary、Platform 计划。
- `docs/production-migration-plan-audit.md`：Target Production Architecture 图与原则。
- `docs/cloudflare-production-config-checklist.md`：Binding 清单新增原生原语与 canary。
- `docs/observability-slo-security-runbook.md`：原生限流可观测性（Analytics Engine）。
- `docs/performance-capacity-cost-runbook.md`：读副本、原生限流、Containers active-CPU 成本。
- `docs/cutover-rollback-runbook.md`：Gradual Deployments 切流/回滚。

## 22. 2026-07-02 执行审计与修订后的推进基线

本节不是新的目标架构，而是对前述计划的执行状态复核。详细证据、缺口与优先级见
`docs/migration-progress-audit-2026-07-02.md`。从本日期起，任何“完成”判断必须区分：

1. 已盘点源码行为；
2. 已存在 Rust 实现；
3. 已通过单元测试、类型检查或构建；
4. 已在 staging 使用真实 Cloudflare 资源验证；
5. 已通过生产 canary、回滚和数据对账。

前四项中的任何一项都不能单独替代第五项。

### 22.1 原计划 Phase 状态复核

| 原 Phase | 当前判断 | 说明 |
| --- | --- | --- |
| Phase 0 盘点与冻结 | 基本完成 | 已有 canonical route/provider/schema/billing 清单；生产数据量与 secret 名称清单仍待导出 |
| Phase 1 Workspace 与基础设施 | 大部完成 | Workspace、Worker、D1、Static Assets、Queue/Cron 基础已存在；生产配置仍有占位符 |
| Phase 2 数据层与迁移工具 | 部分完成 | D1 schema、repository、SQLite 导出/导入工具已存在；真实生产数据全量迁移与校验未完成 |
| Phase 3 Relay MVP | 大部完成 | 主流 JSON/SSE、鉴权、选路、计费已实现；model negotiation、multipart、Realtime、部分 alias/501 仍缺 |
| Phase 4 管理后台核心 | 部分完成 | 核心 auth/user/token/channel/log/option/model/vendor 已实现；完整前端契约和若干管理族仍缺 |
| Phase 5 Provider 扩展 | 部分完成 | OpenAI-like、Anthropic、Gemini、Jina/Cohere、Workers AI 已覆盖；复杂签名和长尾 provider 未完成 |
| Phase 6 计费、订阅、支付 | 部分完成 | 计费表达式与 Stripe 参考链路较完整；生产 shadow、订阅和非 Stripe 支付未完成 |
| Phase 7 异步与长尾 | 部分完成 | task submit/poll/CAS settle 基础较强；fetch/read/content、真实 provider 和 R2 产物链路仍缺 |
| Phase 8 灰度上线 | 未达门槛 | 有 staging 子系统证据，但没有完整前端、数据、容量和回滚证据包 |
| Phase 9 正式切换 | 未开始 | 生产 binding 占位符、生产数据迁移和 operator sign-off 未完成 |
| Phase 10 收尾 | 未开始 | Go/VPS 不能退役 |

### 22.2 前端迁移状态修订

`apps/web/source/` 现在跟踪完整 Bun workspace，不再依赖部署前从 Go 仓库临时
`robocopy`。默认前端已完成 frozen install、TypeScript 检查和 Rsbuild 生产构建，
构建产物由 `tools/build_web.mjs` 复制到 `apps/web/dist/`，并保持同源 API。

首次真实构建审计同时证明“静态资源能构建”不等于“前端已迁移完成”：

- `/api/status` 原先不是 Go-compatible envelope，前端无法读取系统配置；
- `/api/setup` 的完成状态方向与 Go/前端相反；
- 钱包、任务、兑换码、订阅等页面仍调用未迁移 API；
- 严格 lint 仍有 101 errors / 4 warnings；
- bundle 约 18.9 MB（gzip 约 4.4 MB），需要性能预算和拆包。

状态与安装契约已修正并加入测试。当前 Worker 会通过 `HeaderNavModules` 与
`SidebarModulesAdmin` 能力收敛隐藏未支持模块；这是过渡期防护，不是这些模块已经完成。

### 22.3 修订后的近期执行波次

**Wave A：可验证的 G5 产品切片**

- 将前端、`/api/status`、`/api/setup` 修复部署到 staging；
- 浏览器验证 setup、登录、dashboard、keys、channels、users、logs、models、
  settings、profile 和 hard refresh；
- 建立前端请求到 Worker route 的自动契约清单；
- 修复 P0 运行时错误，记录隐藏模块及恢复条件。

**Wave B：高价值、低架构风险的兼容缺口**

- model list/retrieve 协商；
- Responses compact、moderations、engines embeddings 等 JSON alias；
- task fetch/read/content；
- dashboard billing read compatibility；
- Go SQLite 到 D1 的真实导出、导入、行数、哈希和关系校验。

**Wave C：完整产品族**

- subscription/redemption；
- check-in historical import/reset policy and authenticated staging smoke；
- multipart image/audio；
- email/reset/bind、Passkey；
- 非 Stripe payment；
- Realtime 和复杂 provider/Container 路径。

**Wave D：生产切换**

- 清除所有 production placeholder；
- 完成 billing shadow、支付 replay、容量/成本、安全和 SLO 证据；
- 演练 D1 restore 与流量回滚；
- internal-token canary -> percentage canary -> freeze/reconcile -> promote。

### 22.4 当前结论

当前项目应标记为：

> Rust/Cloudflare 核心迁移已形成可部署切片，完整 Go 产品等价迁移仍在进行中。

在 canonical route inventory、生产数据迁移、前端运行时契约、支付/订阅、生产配置与
cutover evidence 全部闭环前，不得再使用“所有可迁移工作已完成”或“可直接全量替换
Go/VPS”的结论。

### 22.5 2026-07-03 Wave A 契约收敛进展

Wave A 已建立三条可重复执行的自动证据链：

- `bun run audit:web:routes` 使用 TypeScript Program/TypeChecker 扫描默认前端的
  212 个不同 API 调用，并与 Worker Router 对比；
- `bun run check:web:routes` 校验已分类缺口的数量、分类计数和 SHA-256 路由集合摘要，
  新增未分类调用或未经审查的集合变化会使检查失败；
- `bun run check:web:staging` 对 staging 执行只读 HTTP 契约验证，覆盖 status/setup、
  11 个 SPA hard-refresh 路径、8 个静态资源、构建产物同一性、公共 envelope 和
  API/SPA 优先级。

兼容工作、审计器校正、单通道 upstream model update 与 Codex 管理端 usage/refresh
迁移已将 unmatched frontend calls 从 122 降至 72，完成：

- 2FA setup/enable/disable/status/backup-code 的完整默认前端契约；
- Token 批量密钥查看的所有权、100 条上限、secure verification 和审计；
- Channel 批量标签与 tag models 查询；
- 管理表单使用的 group 列表；
- 用户管理页面使用的 2FA reset 方法/路径兼容；
- `prefill_group` D1 schema、repository、AdminAuth CRUD、软删除和唯一存活名称约束；
- 官方 model metadata 的 preview/sync，固定 HTTPS 上游、超时、5 MiB 响应上限、
  选择性覆盖和聚合审计；
- Channel provider balance 查询与持久化，以及 multi-key 的状态、分页、启停、删除和
  重建索引操作；
- Channel upstream model update 单通道 `detect`/`apply`，包括 bounded Worker
  outbound fetch、provider URL 特例、Gemini 有限分页、regex ignored models、
  model-mapping 别名保护、`models/settings` 乐观并发守卫、abilities rebuild、
  cache invalidation 和 secret-safe audit；
- Codex channel 管理端 `GET /api/channel/:id/codex/usage` 与
  `POST /api/channel/:id/codex/refresh`，包括 OAuth key JSON 校验、JWT
  account/email 提取、401/403 自动 refresh 后重试、D1 CAS 凭证替换、best-effort cache
  invalidation、secret-safe audit、HTTPS-only/443 outbound SSRF 防护、响应体上限和
  Worker 不支持 Go VPS 本地 proxy 语义的显式 422；
- Channel affinity 管理端 `GET /api/option/channel_affinity_cache` 与
  `DELETE /api/option/channel_affinity_cache`，覆盖 Rust Worker 当前真实写入的
  KV-indexed Durable Object affinity 子集，支持 bounded stats/clear、AdminAuth 和
  审计；Go 的 configurable rule-template 语义与 usage-stat cache 不用占位响应伪装；
- Channel affinity usage 诊断 `GET /api/log/channel_affinity_usage_cache`，由 relay 成功
  审计写入 `other.admin_info.channel_affinity`，并在上游返回真实 usage 时累积
  KV TTL 窗口内的 hit/total/token 统计，供默认前端 usage log 弹窗读取；
- Channel upstream model update 批处理 `POST /api/channel/upstream_updates/detect_all` 与
  `POST /api/channel/upstream_updates/apply_all`，后端以 after-id bounded slice
  处理启用通道，默认前端循环续页聚合结果，避免在单个 Worker 请求内同步扫全库/全上游；
- Ollama 管理端点 `GET /api/channel/ollama/version/:id`、
  `DELETE /api/channel/ollama/delete` 与 `POST /api/channel/ollama/pull/stream`，
  以及 `fetch_models`/`fetch_models/:id` 的 `/api/tags` 模型列表。Worker 只接受
  HTTPS/443 base_url（Tunnel/Container/service-facing gateway），并将 Ollama
  NDJSON pull 进度转换为前端已有 SSE UI，不恢复 VPS 时代的本地 daemon 假设；
- 运维面 `GET /api/uptime/status`、`GET /api/perf-metrics/summary`、`GET /api/perf-metrics`
  与 root-only `/api/performance/*`：Uptime Kuma 使用有超时、1 MiB 响应上限和 SSRF
  防线的 Worker outbound fetch；性能指标从 D1 `logs` 聚合到前端 schema；VPS 本地磁盘
  cache/GC/log 文件操作在 Worker 上以显式 no-op 兼容响应和 admin audit 表达，不伪装本地文件系统；
- root-only `GET /api/ratio_sync/channels` 与 `POST /api/ratio_sync/fetch`：Worker
  列出 D1 channels 和 Go-compatible official/models.dev presets，在 timeout/10 MiB
  body limit 下抓取上游 pricing，兼容 OpenRouter `/v1/models`、models.dev
  `/api.json`、ratio-config envelope 和 `/api/pricing` rows，并与本地
  default-plus-option ratio maps 生成前端 `differences`/`test_results` 契约，
  不返回上游密钥；
- root-only custom OAuth provider 管理面：`GET/POST /api/custom-oauth-provider`
  （含 trailing-slash alias）、`GET/PUT/DELETE /api/custom-oauth-provider/:id`
  与 `POST /api/custom-oauth-provider/discovery`。D1 migration 0010 增加
  `custom_oauth_providers`/`user_oauth_bindings`，migration CLI import 表同步支持
  这两张表；Worker 响应不返回 `client_secret`，CRUD 写 admin audit，
  discovery 使用 SSRF policy、redirect error、20s timeout 和 1 MiB 响应上限；
  `/api/status` 现在对登录页公开已启用 provider 的非密字段，但自定义 OAuth
  登录/绑定 callback 仍是后续 auth flow；
- custom OAuth account-binding 管理面：`GET/DELETE /api/user/oauth/bindings/:provider_id`、
  `GET/DELETE /api/user/:id/oauth/bindings/:provider_id` 与
  `DELETE /api/user/:id/bindings/:binding_type`。Worker 通过 D1
  `user_oauth_bindings` join provider 配置返回绑定列表，解绑不存在也按 Go 语义成功，
  并为 self/admin unbind 与内置绑定清除写入 audit；自定义 OAuth callback/login、WeChat、
  email reset 与 Passkey 仍留在后续 auth flow；
- async usage-log read 管理面：`GET /api/mj`、`GET /api/mj/self`、
  `GET /api/task` 与 `GET /api/task/self`。Worker 基于 D1
  `midjourneys`/`tasks` 提供 Go-compatible pagination/filter，self 路径强制会话
  user scope 且不暴露 task `channel_id`；Midjourney `submit_time`/`finish_time`
  写入保留毫秒值，与 Go 和默认前端筛选单位一致；
- 本地 API wrapper 的 HTTP method 推断，并移除将 `endsWith('/v1')` 误判为 API 调用的
  假阳性；
- 缺口分类基线：13 auth-deferred、42 capability-hidden-product、16 payment-deferred；
  operations-debt 与 visible-admin-debt 已清零。

当前证据边界：

- Worker 单元测试 248 项通过；
- D1 migration 0001-0010 的 SQLite schema 重放通过，包括
  `custom_oauth_providers` 与 `user_oauth_bindings`；
- `wasm32-unknown-unknown` 检查通过；
- 默认前端 TypeScript + Rsbuild production build 通过；
- staging 公共 HTTP 契约 7 项通过；
- 2026-07-03 两批新增后端路由尚需重新部署并做已登录 CRUD/2FA 浏览器 smoke；
- browser DOM、console、network、desktop/mobile 截图证据仍缺，不能将 HTTP shell
  相等误报为真实页面已渲染。

下一批 Wave A 优先级：

1. 将 channel-affinity 从当前可枚举 Rust 子集继续升级为 rule-template aware 与
   usage-stat aware 的 Cloudflare 原生架构；不得用全零占位响应伪装 Go 管理语义；
2. 将 bounded upstream `detect_all`/`apply_all` slice 继续升级为 Queue/Workflow 编排，
   记录任务进度、幂等键、失败 channel 集合和可重试边界；
3. 将已分类的 auth、payment、operations 和 capability-hidden 家族逐项绑定 cutover
   场景、负责人和恢复条件；
4. 部署 migration 0010 和本批 Worker 到隔离 staging，完成已登录的 prefill、model
   sync、channel balance/multi-key/custom OAuth provider smoke，并核查审计与无密钥泄漏；
5. 在初始化后的隔离 staging 上完成登录、角色、CRUD、2FA 和过期 session 浏览器证据。

### 22.6 2026-07-04 Check-In Compatibility Delta

This increment supersedes the 22.5 route-debt number for the default frontend
contract audit. The Rust Worker now implements the profile daily check-in slice:

- `GET /api/user/checkin` returns the current user's monthly check-in status,
  monthly records, total count, total awarded quota, min/max award settings,
  and today's checked state.
- `POST /api/user/checkin` performs the daily award, runs Turnstile when the
  deployment has it configured, inserts the D1 record first, increments user
  quota, rolls the record back if quota mutation fails, and writes a best-effort
  system log.
- D1 migration `0011_checkins.sql` adds `checkins` with a unique
  `(user_id, checkin_date)` guard and an indexed `(user_id, checkin_date)` read
  path. The migration CLI can now import the Go `checkins` table.
- `/api/status` now exposes `checkin_enabled` from
  `checkin_setting.enabled`, so the default profile UI can keep the card hidden
  unless operators enable the feature.
- Cloudflare Workers use UTC dates for the daily boundary. The Go/VPS version
  used the server-local day; production cutover must either accept UTC or add an
  explicit product-timezone option before importing historical check-ins.

Updated local evidence:

- route audit: 212 frontend calls, 200 Worker routes, 71 missing calls;
- debt categories: 13 auth-deferred, 42 capability-hidden-product,
  16 payment-deferred;
- route-set SHA-256:
  `ec37c0cf67e953733ee7e43c291150f17f0d1f859073cc352e7d66b80865e677`;
- `cargo test -p cinatoken-worker --lib`: 252 passed;
- `cargo test -p cinatoken-migration`: 20 passed;
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed;
- `bun run check`: passed;
- in-memory SQLite replay of `0001_core.sql` + `0011_checkins.sql`: passed.

Remaining production gates: apply migration 0011 to isolated staging, import or
explicitly reset historical check-ins, run authenticated browser smoke for
status, first submit, duplicate submit, disabled setting, and Turnstile-enabled
submit, then capture row-count/quota-delta evidence before any production
cutover.

### 22.7 2026-07-04 Admin Redemption Compatibility Delta

This increment supersedes the 22.6 route-debt number for the default frontend
contract audit. The Rust Worker now implements the admin redemption-code
management slice used by the default dashboard:

- `GET /api/redemption` and `GET /api/redemption/` return Go-compatible
  paginated live redemption rows ordered by newest id.
- `GET /api/redemption/search` searches by exact numeric id or by name prefix,
  matching the Go controller's frontend-facing behavior.
- `GET /api/redemption/:id` returns one live row and preserves the
  Go-compatible success envelope.
- `POST /api/redemption` and `POST /api/redemption/` create 1-100 redemption
  codes after checking `payment_setting.compliance_confirmed=true` and
  `payment_setting.compliance_terms_version=v1`; generated keys use the same
  32-character lowercase hex shape as the Go UUID-without-dashes helper.
- `PUT /api/redemption` and `PUT /api/redemption/` support both field updates
  and the frontend `?status_only=true` status toggle payload.
- `DELETE /api/redemption/:id` soft-deletes one live row, and
  `DELETE /api/redemption/invalid` soft-deletes used, disabled, or expired
  live rows.
- D1 migration `0012_redemptions.sql` adds the `redemptions` table, live-row
  indexes, and a nullable `deleted_at` column for Go GORM soft-delete parity.
  The migration CLI import table set now includes source `redemptions`.
- `/api/status` no longer hard-hides `SidebarModulesAdmin.admin.redemption`;
  operators can still disable the page through their normal sidebar option.

Updated local evidence:

- route audit: 212 frontend calls, 212 Worker routes, 64 missing calls;
- debt categories: 13 auth-deferred, 35 capability-hidden-product,
  16 payment-deferred;
- route-set SHA-256:
  `b326864fa555cba7ba27e73a8a0b849a5511141f262f1723edbbd4d6baa7fbf7`;
- `cargo test -p cinatoken-worker --lib`: 255 passed;
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed.

Important boundary: this is the admin redemption-code management surface, not
the public payment/top-up/redemption settlement chain. Before Rust owns paid
redemption in production, the payment/idempotency and double-credit gates in
the billing and data-migration runbooks still apply.

### 22.8 2026-07-04 Public Rankings Compatibility Delta

This increment supersedes the 22.7 route-debt number for the default frontend
contract audit. The Rust Worker now implements the public rankings page API:

- `GET /api/rankings` returns the Go-compatible envelope consumed by the
  default React rankings page.
- Supported periods match Go: `today`, `week` (default), `month`, `year`, and
  `all`; invalid periods return `400` with `invalid ranking period: ...`.
- Access control mirrors Go `HeaderNavModuleAuth("rankings")`: empty or
  malformed `HeaderNavModules` defaults to public access, legacy boolean/string
  values control `enabled`, and object values support `enabled` plus
  `requireAuth`.
- `/api/status` no longer hard-hides `HeaderNavModules.rankings`; operators can
  still disable it or require login through the normal header-nav option.
- The snapshot includes model rankings, vendor rankings, top movers, top
  droppers, model token history, and vendor share history with the same JSON
  field names as the frontend types.
- Go reads rankings from the background-fed `quota_data` table. The Worker
  intentionally computes the public view from live D1 `logs`, matching the
  existing Rust dashboard trend strategy and avoiding a new Cron/flush job in
  this migration slice. A future high-traffic deployment can reintroduce a
  Worker Cron + `quota_data` aggregate if D1 read cost requires it.
- The D1 repository log filters were corrected for schema parity: `logs` does
  not have Go GORM soft-delete semantics, so analytics queries no longer add
  `deleted_at IS NULL` to `logs`.

Updated local evidence:

- route audit: 212 frontend calls, 213 Worker routes, 63 missing calls;
- debt categories: 13 auth-deferred, 34 capability-hidden-product,
  16 payment-deferred;
- route-set SHA-256:
  `63b9b8f87ecdf6caa7cb15269c86be22c2cbeed1c27d3f6659258a37f146f6b1`;
- `cargo test -p cinatoken-worker --lib`: 262 passed;
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed.

Remaining production gates: apply this Worker to isolated staging, seed enough
`logs` rows to exercise every period and the `Others` grouping, verify public
and `requireAuth=true` rankings behavior in browser, and confirm D1 read
latency before enabling rankings on high-traffic production tenants.

### 22.9 2026-07-04 Subscription Core And Balance Pay Delta

This increment supersedes the 22.8 route-debt number for the default frontend
contract audit. The Rust Worker now implements the subscription core needed by
the default dashboard's admin user-subscription dialog, subscription plan
management surface, self subscription summary, billing preference selector, and
balance-pay purchase path:

- D1 migration `0013_subscriptions.sql` adds Go-compatible
  `subscription_plans`, `user_subscriptions`, and
  `subscription_pre_consume_records`, and upgrades the original MVP
  `subscription_orders` stub with Go fields (`money`, `trade_no`,
  `payment_method`, `payment_provider`, `create_time`, `complete_time`, and
  `provider_payload`). A partial unique index protects non-empty `trade_no`
  values while preserving existing upgraded rows with empty defaults.
- The migration CLI now imports `subscription_plans`, Go-compatible
  `subscription_orders`, `user_subscriptions`, and
  `subscription_pre_consume_records`; subscription orders also populate the
  legacy `provider`/`order_no`/`amount`/`created_at`/`updated_at` compatibility
  columns so fresh and already-migrated D1 databases converge.
- `GET/POST/PUT/PATCH /api/subscription/admin/plans` provide plan list,
  create, update, and status-toggle support. Writes require the same payment
  compliance option pair as Go:
  `payment_setting.compliance_confirmed=true` and
  `payment_setting.compliance_terms_version=v1`.
- `GET/POST /api/subscription/admin/users/:id/subscriptions`,
  `POST /api/subscription/admin/user_subscriptions/:id/invalidate`, and
  `DELETE /api/subscription/admin/user_subscriptions/:id` support the user-row
  Manage Subscriptions dialog that was already visible from the imported
  frontend.
- `GET /api/subscription/plans`, `GET /api/subscription/self`, and
  `PUT /api/subscription/self/preference` support the wallet subscription card,
  including billing-preference normalization and JSON setting preservation.
- `POST /api/subscription/balance/pay` implements the provider-independent
  balance purchase path: `ceil(price_amount * QuotaPerUnit)` quota debit,
  user subscription creation, success order record, system log, plan
  duration/reset calculation, max-purchase guard, and user group
  upgrade/downgrade metadata.

Updated local evidence:

- route audit: 212 frontend calls, 225 Worker routes, 51 missing calls;
- debt categories: 13 auth-deferred, 22 capability-hidden-product,
  16 payment-deferred;
- route-set SHA-256:
  `448760251387dfa8e36b8663ea40ab985c22dad56cc4e37635b783d3f529e69b`;
- `cargo test -p cinatoken-worker --lib`: 265 passed;
- `cargo test -p cinatoken-migration`: 22 passed;
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed;
- in-memory SQLite replay of `0001_core.sql` plus
  `0013_subscriptions.sql`: passed;
- `bun run check`: passed.

Remaining boundary: this is not the external subscription payment-provider
cutover. Stripe, Creem, Epay, Waffo Pancake checkout/callback/product helper
routes remain payment-deferred and `/subscriptions` / `/wallet` should stay
capability-hidden until those provider paths have staging evidence or the UI is
explicitly configured for balance-only operation.

### 22.10 2026-07-04 Wallet Topup Compatibility Delta

This increment supersedes the 22.9 route-debt number for the default frontend
contract audit. The Rust Worker now implements the default wallet's Stripe
topup and topup-history read path:

- `GET /api/user/topup/info` returns the wallet payment capability/config
  envelope consumed by the React wallet. It exposes only implemented Worker
  payment methods: Stripe can be enabled when payment compliance and Stripe
  secrets are configured; Epay, Creem, Waffo, Waffo Pancake, and public
  redemption stay hidden until their Worker routes exist.
- `POST /api/user/stripe/amount` returns the frontend-compatible estimated
  charge string, guarded by UserAuth, payment compliance, Stripe config, and
  minimum topup validation.
- `POST /api/user/stripe/pay` now also returns `data.pay_link`, preserving the
  existing `checkout_url`/`session_id` fields while matching the default
  wallet's redirect code.
- `GET /api/user/topup/self` returns the current user's recent topups with
  Go-compatible pagination, optional sanitized `trade_no LIKE ... ESCAPE '!'`
  search, the same 30-day self-service window as Go, and string topup statuses.
- `GET /api/user/topup` is now the AdminAuth all-topups page consumed by the
  wallet billing-history dialog; it has no 30-day cutoff.
- `POST /api/user/topup/complete` lets admins manually complete a pending D1
  topup row through the same atomic `complete_topup_and_credit` path used by
  Stripe webhooks, with admin audit logging.
- `/api/user/self` now includes `aff_quota`, `aff_history_quota`, and
  `aff_count`, which the wallet referral rewards card consumes.

Updated local evidence:

- route audit: 212 frontend calls, 229 Worker routes, 47 missing calls;
- debt categories: 13 auth-deferred, 22 capability-hidden-product,
  12 payment-deferred;
- route-set SHA-256:
  `6eecf1ca5d3bdff5200390e4d7251cb440fa8bd260516a7f3b3a5a86bfdcbb7a`;
- `cargo test -p cinatoken-worker --lib`: 268 passed;
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed.

Remaining boundary: the Worker still does not own public redemption-code topup,
Epay, Creem, Waffo, Waffo Pancake, or external subscription checkout/callback
routes. The wallet keeps those methods hidden through `topup/info`; production
must not turn them on until their provider-specific idempotency, signature, and
staging replay evidence exists.

### 22.11 2026-07-04 Public Redemption Topup Delta

This increment supersedes the 22.10 route-debt number for the default frontend
wallet audit. The Rust Worker now owns the public redemption-code topup path
that the React wallet calls through `redeemTopupCode()`:

- `POST /api/user/topup` is UserAuth-protected, payment-compliance gated, and
  accepts the default frontend `{ "key": "..." }` request shape.
- D1 migration `0014_redemptions_credited.sql` adds a Worker-only
  `redemptions.credited` idempotency anchor. Imported Go rows with
  `status = used` are marked credited immediately, while new Rust redemptions
  start with `credited = 0`.
- `redeem_redemption_code` uses a D1 batch to compare-and-swap enabled codes
  to used, credit the user's quota only while `credited = 0`, and then mark
  the code credited. This replaces Go's process-local user lock with a
  Cloudflare-safe durable guard and prevents same-second replay double-credit.
- Successful redemptions write a topup log row with Go-compatible log type
  `1` and caller/payment metadata in `other`.
- `GET /api/user/topup/info` now exposes `enable_redemption` when payment
  compliance is confirmed, because the underlying public route exists.

Updated local evidence:

- route audit: 212 frontend calls, 230 Worker routes, 46 missing calls;
- debt categories: 13 auth-deferred, 22 capability-hidden-product,
  11 payment-deferred;
- route-set SHA-256:
  `02ad77dc86420152ce55a972cd86faeaf8e1ae49e07783f1807ade8501aa57db`;
- `cargo test -p cinatoken-worker --lib`: 268 passed.

Remaining boundary: Epay, Creem, Waffo, Waffo Pancake, and external
subscription checkout/callback routes remain payment-deferred and hidden from
the wallet until their provider-specific signature, idempotency, replay, and
staging evidence is in place.

### 22.12 2026-07-04 Legacy Online Amount Delta

This increment supersedes the 22.11 route-debt number for the default frontend
wallet audit. The Rust Worker now implements the read-only legacy online/Epay
amount-estimation route consumed by the wallet before creating an online
payment order:

- `POST /api/user/amount` is UserAuth-protected, payment-compliance gated, and
  rejects disabled or missing users before returning an amount.
- The formula matches Go `controller/topup.go`: `MinTopUp` is multiplied by
  `QuotaPerUnit` when `general_setting.quota_display_type` is `TOKENS`,
  displayed token amounts are converted back by `QuotaPerUnit`, and the
  payable amount applies `Price`, the caller's `TopupGroupRatio`, and
  `payment_setting.amount_discount[amount]` when present and positive.
- The implementation reads all settings from D1 `options`, accepts numeric or
  numeric-string JSON values for group ratios and discounts, and defaults to
  Go's legacy values (`Price = 7.3`, `QuotaPerUnit = 500000`, ratio/discount
  `1`) when options are absent or malformed.
- `GET /api/user/topup/info` still keeps `enable_online_topup = false`.
  Estimation is available for frontend compatibility and route-debt reduction,
  but Epay order creation/callback settlement is not exposed yet.

Updated local evidence:

- route audit: 212 frontend calls, 231 Worker routes, 45 missing calls;
- debt categories: 13 auth-deferred, 22 capability-hidden-product,
  10 payment-deferred;
- route-set SHA-256:
  `b95c68040a3bf53e4c5890f216b224d925a3432e3f4ae2eca8addcc962c44604`;
- `cargo test -p cinatoken-worker --lib`: 272 passed.

Remaining boundary: `/api/user/pay`, Creem, Waffo, Waffo Pancake, and external
subscription checkout/callback routes remain payment-deferred and hidden until
their provider-specific order model, signature verification, idempotency,
replay, and reconciliation evidence is in place.

### 22.13 2026-07-04 Waffo Pancake Amount Delta

This increment supersedes the 22.12 route-debt number for the default frontend
wallet audit. The Rust Worker now implements the Waffo Pancake read-only amount
estimation route used by the wallet before hosted-checkout creation:

- `POST /api/user/waffo-pancake/amount` is UserAuth-protected,
  payment-compliance gated, and rejects disabled or missing users before
  returning an amount.
- The formula matches Go `controller/topup_waffo_pancake.go`: the minimum
  threshold is the direct `WaffoPancakeMinTopUp` option, while
  `general_setting.quota_display_type = TOKENS` converts the requested amount
  by `QuotaPerUnit` only for the payable amount calculation.
- The payable amount applies `WaffoPancakeUnitPrice`, the caller's
  `TopupGroupRatio`, and `payment_setting.amount_discount[amount]` when
  present and positive, using decimal intermediate calculation and Go-style
  two-decimal response formatting.
- `GET /api/user/topup/info` still keeps `enable_waffo_pancake_topup = false`.
  Estimation is available for frontend compatibility and route-debt reduction,
  but Waffo Pancake order creation/callback settlement is not exposed yet.

Updated local evidence:

- route audit: 212 frontend calls, 232 Worker routes, 44 missing calls;
- debt categories: 13 auth-deferred, 22 capability-hidden-product,
  9 payment-deferred;
- route-set SHA-256:
  `88d9d14ee2bf04ed1f4736718b6442346ac437e6b97b263e0fc655f41c999a1f`;
- `cargo test -p cinatoken-worker --lib`: 273 passed.

Remaining boundary: `/api/user/pay`, `/api/user/creem/pay`,
`/api/user/waffo/pay`, `/api/user/waffo-pancake/pay`, Waffo Pancake admin
catalog/pair/product helper routes, and external subscription checkout/callback
routes remain payment-deferred and hidden until their provider-specific order
model, signature verification, idempotency, replay, and reconciliation evidence
is in place.

### 22.14 2026-07-04 Waffo Pancake Config Save Delta

This increment supersedes the 22.13 route-debt number for the default frontend
payment-settings audit. The Rust Worker now implements the root-only config
save endpoint used after an operator has selected or manually entered Waffo
Pancake merchant/store/product settings:

- `POST /api/option/waffo-pancake/save` requires root session auth and writes
  `WaffoPancakeMerchantID`, `WaffoPancakeReturnURL`,
  `WaffoPancakeStoreID`, and `WaffoPancakeProductID` through the D1 repository
  option boundary.
- `WaffoPancakePrivateKey` is persisted only when the request value is
  non-blank, matching Go `SaveWaffoPancakeConfig` and the frontend UX where
  `GET /api/option/` never re-exposes the stored key.
- Merchant, store, and product IDs are required before saving. The response
  returns the saved `product_id` and `store_id` expected by the default
  frontend.
- The handler invalidates option cache and records admin audit metadata without
  logging the private key.
- This does not enable Waffo Pancake checkout or webhook settlement; wallet
  `topup/info` still keeps `enable_waffo_pancake_topup = false`.

Updated local evidence from this config-save batch is superseded by 22.15,
which adds the adjacent Waffo Pancake catalog read paths and records the current
route-debt baseline.

Remaining boundary at this checkpoint: `/api/user/pay`, `/api/user/creem/pay`,
`/api/user/waffo/pay`, `/api/user/waffo-pancake/pay`, Waffo Pancake admin
pair/subscription-product creation helper routes, and external subscription
checkout/callback routes remained payment-deferred. The Waffo Pancake admin
helper portion is closed by 22.16; checkout/callback settlement remains gated by
provider-specific order model, signature verification, idempotency, replay, and
reconciliation evidence.

### 22.15 2026-07-04 Waffo Pancake Catalog Read Delta

This increment supersedes the 22.14 route-debt number for the default frontend
payment-settings audit. The Rust Worker now implements the root-only Waffo
Pancake read helpers used before saving payment settings:

- `POST /api/option/waffo-pancake/catalog` requires root session auth and
  accepts optional `merchant_id` / `private_key` request credentials. When both
  body fields are blank it falls back to persisted `WaffoPancakeMerchantID` and
  `WaffoPancakePrivateKey`, matching Go `ListWaffoPancakeCatalog`.
- `POST /api/option/waffo-pancake/subscription-product-options` requires root
  session auth and uses persisted merchant/private-key/store settings to return
  the active onetime products for the saved store.
- The Worker signs Waffo Pancake GraphQL requests with the Go-compatible
  canonical string `METHOD\nPATH\nTIMESTAMP\nbase64(sha256(body))`, RSA-SHA256
  PKCS#1 v1.5 signatures, `X-Merchant-Id`, `X-Timestamp`, and `X-Signature`.
- The external request boundary uses a 12 second timeout, rejects redirects,
  requires a JSON response, checks `Content-Length`, and caps streamed response
  bodies at 512 KiB. Optional admin request bodies are capped before whitespace
  normalization.
- Catalog products are filtered to active onetime products before returning to
  the frontend, preserving Go's operator-visible product list behavior.
- This is still read-only provider integration. It does not create Waffo
  Pancake pairs/products, open checkout, or settle webhooks.

Updated local evidence:

- route audit: 212 frontend calls, 235 Worker routes, 41 missing calls;
- debt categories: 13 auth-deferred, 22 capability-hidden-product,
  6 payment-deferred;
- route-set SHA-256:
  `0cbaff3dac0f6260cc4457b913681d43573919205f3a3cb329e8cd34ebddfbd1`;
- `cargo test -p cinatoken-worker --lib`: 282 passed.

Remaining boundary at this checkpoint: `/api/user/pay`, `/api/user/creem/pay`,
`/api/user/waffo/pay`, `/api/user/waffo-pancake/pay`, Waffo Pancake admin
pair/subscription-product creation helper routes, and external subscription
checkout/callback routes remained payment-deferred. The Waffo Pancake admin
helper portion is closed by 22.16; checkout/callback settlement remains gated by
provider-specific order model, signature verification, idempotency, replay, and
reconciliation evidence.

### 22.16 2026-07-04 Waffo Pancake Action Helper Delta

This increment supersedes the 22.15 route-debt number for the default frontend
payment-settings and subscription-plan audits. The Rust Worker now implements
the root-only Waffo Pancake external resource helpers used by the frontend
before any checkout/callback ownership is exposed:

- `POST /api/option/waffo-pancake/pair` creates the default
  `cinatoken-store` plus `cinatoken-charge-product` pair using typed body
  credentials or persisted credential fallback, matching Go
  `CreateWaffoPancakePair`.
- `POST /api/option/waffo-pancake/subscription-product` creates and publishes a
  Waffo Pancake OnetimeProduct for a subscription plan using persisted
  merchant/private-key/store/return-url options, matching Go's
  OnetimeProduct-not-SubscriptionProduct rationale.
- Action calls use the SDK-compatible signed REST endpoints
  `/v1/actions/store/create-store`,
  `/v1/actions/onetime-product/create-product`, and
  `/v1/actions/onetime-product/publish-product`.
- The Worker sends `X-Idempotency-Key = sha256(merchant:path:body)` for action
  calls, while catalog GraphQL remains no-idempotency. This preserves the Go SDK
  retry/dedupe shape for deterministic default names.
- The external request boundary keeps the 12 second timeout, redirect rejection,
  JSON response requirement, `Content-Length` check, and 512 KiB streamed
  response cap added in 22.15.
- Pair creation preserves Go's orphan-store response shape when store creation
  succeeds but product creation/publish fails, so the frontend can preselect the
  new store and retry without losing context.
- The Waffo admin helper routes now return the Go-compatible
  `{message:"success"|"error", data}` shape expected by the tracked React
  frontend. Root-auth failures still use the shared Rust auth envelope/status.
- This does not enable customer Waffo Pancake checkout, webhook settlement, or
  subscription external payment callbacks.

Updated local evidence:

- route audit: 212 frontend calls, 237 Worker routes, 39 missing calls;
- debt categories: 13 auth-deferred, 22 capability-hidden-product,
  4 payment-deferred;
- route-set SHA-256:
  `a3ffcf011d892afb7b2a2388b3321b66c64456564271cddccb22e29735b4021c`;
- `cargo test -p cinatoken-worker --lib`: 286 passed.

Remaining boundary: `/api/user/pay`, `/api/user/creem/pay`,
`/api/user/waffo/pay`, `/api/user/waffo-pancake/pay`,
`/api/subscription/creem/pay`, `/api/subscription/waffo-pancake/pay`, and
external subscription checkout/callback routes remain payment-deferred and
hidden until their provider-specific order model, signature verification,
idempotency, replay, and reconciliation evidence is in place.

### 22.17 2026-07-04 Epay Wallet Topup Delta

This increment supersedes the 22.16 route-debt number for the default frontend
wallet audit. The Rust Worker now implements the legacy online/Epay wallet
checkout and callback pair without extending ownership to subscription Epay or
other non-Stripe gateways:

- `POST /api/user/pay` requires user session auth, payment-compliance
  confirmation, configured `PayAddress` / `EpayId` / `EpayKey`, and a
  `PayMethods` allowlist entry for the requested `payment_method`.
- The payable amount reuses the Go-compatible `POST /api/user/amount` formula:
  `MinTopUp`, `Price`, `QuotaPerUnit`, `TopupGroupRatio`, token-display mode,
  and `payment_setting.amount_discount`.
- The Worker precomputes D1 `topups.amount` as the final quota to credit. This
  preserves the Rust D1 invariant established by Stripe/redemption paths while
  matching Go's Epay settlement result (`amount * QuotaPerUnit`, or the original
  token amount in token-display mode).
- Epay purchase params match the Go SDK shape: `pid`, `type`, `out_trade_no`,
  `notify_url`, `name`, `money`, `device=pc`, `return_url`, `sign_type=MD5`,
  and `sign=md5(sorted_nonempty_params + EpayKey)`. The response keeps Go's
  `{message:"success", data:<params>, url:<submit.php>}` contract used by the
  default React form-submission helper.
- Order IDs use Worker CSPRNG bytes in the Go-visible `USR{id}NO...` shape; the
  existing Stripe topup suffix path now uses the same CSPRNG helper instead of
  `Math.random()`.
- `GET/POST /api/user/epay/notify` parses query/form callbacks under a 16 KiB
  body guard, requires POST `Content-Length` before reading, verifies the same
  MD5 signature with constant-time comparison before any state change, ignores
  non-`TRADE_SUCCESS` events, records best-effort payment events, and credits
  only through a provider-aware atomic D1 batch that verifies complete/credit/
  mark changes before ACKing a first-time settlement.
- `migrations/d1/0015_topups_payment_provider.sql` adds
  `topups.payment_provider` (default/backfill `stripe`) plus a provider/status
  index, so Epay and future Creem/Waffo callbacks can guard against
  cross-gateway callback attacks.
- `GET /api/user/topup/info` now exposes legacy online topup only when payment
  compliance, Epay credentials, and non-empty `PayMethods` are all present.

Updated local evidence:

- route audit: 212 frontend calls, 240 Worker routes, 38 missing calls;
- debt categories: 13 auth-deferred, 22 capability-hidden-product,
  3 payment-deferred;
- route-set SHA-256:
  `8968b7ebbb9422657492c9a67dc1177b414ccdebf80873bdfdb55f6503175b9c`;
- `cargo test -p cinatoken-worker --lib`: 292 passed.

Remaining boundary: `/api/user/creem/pay`, `/api/user/waffo/pay`,
`/api/user/waffo-pancake/pay`, `/api/subscription/creem/pay`,
`/api/subscription/waffo-pancake/pay`, subscription Epay checkout/callback, and
other external subscription checkout/callback routes remain payment-deferred or
capability-hidden until their provider-specific order model, signature
verification, amount/product/env match checks, idempotency, replay, and
reconciliation evidence is in place.

### 22.18 2026-07-04 Waffo Pancake Wallet Topup/Webhook Delta

This increment supersedes the 22.17 route-debt number for the default frontend
wallet audit. The Rust Worker now owns Waffo Pancake wallet checkout and
webhook settlement while still keeping Waffo Pancake subscription checkout
hidden until the subscription order settlement path is migrated:

- `POST /api/user/waffo-pancake/pay` requires user session auth, payment
  compliance, configured `WaffoPancakeMerchantID`,
  `WaffoPancakePrivateKey`, and a valid `WaffoPancakeProductID`.
- The payable amount reuses the Go-compatible Waffo Pancake formula:
  `WaffoPancakeMinTopUp`, `WaffoPancakeUnitPrice`, `QuotaPerUnit`,
  `TopupGroupRatio`, token-display mode, and
  `payment_setting.amount_discount`.
- The Worker writes the D1 pending topup before calling Waffo. Because Rust D1
  defines `topups.amount` as final quota-to-credit, order creation translates
  Go's Waffo Pancake token-display behavior into final quota:
  `max(IntPart(amount / QuotaPerUnit), 1) * QuotaPerUnit`.
- Checkout calls match the Go SDK's authenticated flow:
  `/v1/actions/auth/issue-session-token` plus
  `/v1/actions/checkout/create-session`, stable buyer identity
  `cinatoken-user-{id}`, two-decimal USD price snapshot, `saas` tax category,
  `45m` expiry, `orderMerchantExternalId = trade_no`, and response
  `checkout_url` with `#token=...`.
- If external checkout creation fails after the local row is created, the
  Worker marks the pending Waffo Pancake topup failed for the expected provider,
  matching Go's `Update` behavior and avoiding indefinite local pending rows.
- `POST /api/waffo-pancake/webhook/:env` verifies `X-Waffo-Signature`
  (`t=...,v1=...`) as RSA-SHA256/PKCS#1 v1.5 over `t + "." + raw_payload`,
  enforces a 5-minute replay window, uses Waffo test/prod public keys keyed by
  the route env, and then enforces `event.mode == :env`.
- Only `order.completed` wallet events credit. The handler verifies local
  provider, buyer identity, and amount before calling the provider-aware D1
  credited-anchor batch. Signature-valid but permanent mismatches are recorded
  in `payment_events` and ACKed with `OK`; partial credit failures return
  `retry`.
- `GET /api/user/topup/info` now exposes Waffo Pancake wallet topup only when
  compliance and merchant/private/product configuration are complete. A new
  frontend guard field keeps Waffo Pancake subscription checkout hidden even
  when wallet checkout is enabled, preventing a broken
  `/api/subscription/waffo-pancake/pay` button.

Updated local evidence:

- route audit: 212 frontend calls, 242 Worker routes, 37 missing calls;
- debt categories: 13 auth-deferred, 22 capability-hidden-product,
  2 payment-deferred;
- route-set SHA-256:
  `15339560f12bfb286e08b72afe867ce802b72f7bd3fcd0d21ae741c089ba0af7`;
- `cargo test -p cinatoken-worker --lib`: 298 passed;
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed.

Remaining boundary: `/api/user/creem/pay`, `/api/user/waffo/pay`,
`/api/subscription/creem/pay`, `/api/subscription/waffo-pancake/pay`,
subscription Epay checkout/callback, and other external subscription
checkout/callback routes remain payment-deferred or capability-hidden until
their provider-specific order model, signature verification, amount/product/env
match checks, idempotency, replay, and reconciliation evidence is in place.

### 22.19 2026-07-04 Creem Wallet Topup/Webhook Delta

This increment supersedes the 22.18 route-debt number for the default frontend
wallet audit. The Rust Worker now owns Creem wallet checkout and webhook
settlement while still keeping Creem subscription checkout hidden until the
subscription order settlement path is migrated:

- `POST /api/user/creem/pay` requires user session auth, payment compliance,
  configured `CreemApiKey`, non-empty valid `CreemProducts`, and
  `CreemWebhookSecret`. Requiring the webhook secret before exposing checkout
  avoids a paid-but-unsettleable production state.
- The Worker selects the configured product by frontend `product_id`, stores a
  D1 pending topup before calling Creem, and uses the product `quota` as the
  final Rust D1 quota-to-credit, matching Go `RechargeCreem`.
- Order IDs keep the Go-visible `ref_` + SHA1 shape over
  `creem-api-ref-{user}-{UnixMilli}-{rand4}`. Checkout requests call
  `https://api.creem.io/v1/checkouts` or the test endpoint, prefill the user's
  email, and include username/reference/product/quota metadata.
- Creem outbound checkout creation uses explicit JSON headers, redirect
  rejection, a 30 second timeout, JSON content-type validation, `Content-Length`
  precheck, and streamed response-size guarding.
- `POST /api/creem/webhook` verifies the `creem-signature` header as
  `hex(hmac_sha256(raw_payload, CreemWebhookSecret))` before parsing JSON.
- Only `checkout.completed` + `order.status == paid` + `order.type == onetime`
  wallet events credit. The handler rejects provider mismatches and
  `amount_paid`/stored-money mismatches before calling the provider-aware D1
  credited-anchor batch.
- Signature-valid permanent mismatches are recorded in `payment_events` and
  ACKed with `OK`; partial complete/credit/mark failures return `retry`.
  Duplicate paid deliveries are `OK` no-ops only when the stored row is already
  success+credited with matching provider/method/money.
- When a verified Creem customer email is present, the Worker backfills
  `users.email` only if it is currently empty, preserving Go's convenience
  behavior without overwriting user-managed email.
- `GET /api/user/topup/info` now exposes `enable_creem_topup` and
  `creem_products` only when compliance, API key, products, and webhook secret
  are all configured.

Updated local evidence:

- route audit: 212 frontend calls, 244 Worker routes, 36 missing calls;
- debt categories: 13 auth-deferred, 22 capability-hidden-product,
  1 payment-deferred;
- route-set SHA-256:
  `5cdffd5d02a44c03b55467410820893a988a9303d18be2cb1f03b55acb1409fd`;
- `cargo test -p cinatoken-worker --lib`: 303 passed;
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed.

Remaining boundary: `/api/user/waffo/pay`,
`/api/subscription/creem/pay`, `/api/subscription/waffo-pancake/pay`,
subscription Epay checkout/callback, and other external subscription
checkout/callback routes remain payment-deferred or capability-hidden until
their provider-specific order model, signature verification, amount/product/env
match checks, idempotency, replay, and reconciliation evidence is in place.

### 22.20 2026-07-04 Legacy Waffo Wallet Topup/Webhook Delta

This increment supersedes the 22.19 route-debt number for the default frontend
wallet audit. The Rust Worker now owns legacy Waffo wallet checkout and webhook
settlement while still keeping external subscription checkout providers hidden
until their subscription order settlement paths are migrated:

- `POST /api/user/waffo/pay` requires user session auth, payment compliance,
  `WaffoEnabled`, active-mode sandbox/prod Waffo credentials, and a configured
  public cert/private key/API key set.
- The Worker mirrors Go's default Waffo pay-method contract: Card
  (`CREDITCARD,DEBITCARD`), Apple Pay, and Google Pay are used when
  `WaffoPayMethods` is empty or invalid; an explicit empty array disables
  Waffo exposure in `topup/info`.
- The payable amount uses the Go-compatible wallet formula:
  `WaffoUnitPrice`, `WaffoMinTopUp`, `QuotaPerUnit`, `TopupGroupRatio`,
  token-display mode, and `payment_setting.amount_discount`.
- Rust D1 keeps `topups.amount` as final quota-to-credit. For Waffo
  token-display mode, order creation translates Go `RechargeWaffo` semantics
  into `max(IntPart(amount / QuotaPerUnit), 1) * QuotaPerUnit`.
- Waffo order IDs keep the Go-visible
  `WAFFO-{user}-{UnixMilli}-{rand6}` shape. The Worker creates the D1 pending
  topup before calling Waffo and marks it failed if external order creation
  fails after local row creation.
- Outbound Waffo `/api/v1/order/create` requests sign the exact JSON body with
  RSA-SHA256/PKCS#1 v1.5 using the merchant private key, send the Go SDK header
  shape (`X-API-KEY`, `X-SIGNATURE`, `X-API-VERSION`, `X-SDK-VERSION`), reject
  redirects, enforce a 30 second timeout, validate JSON response type, bound
  response reads, and verify Waffo `X-SIGNATURE` response bodies when present.
- `POST /api/waffo/webhook` verifies the raw-body `X-SIGNATURE` with the
  configured Waffo public cert before parsing JSON. Only
  `PAYMENT_NOTIFICATION` + `PAY_SUCCESS` wallet events credit; non-success
  events mark pending Waffo topups failed for the expected provider.
- The webhook verifies local provider and amount before calling the
  provider-aware D1 credited-anchor batch. Permanent mismatches are recorded in
  `payment_events` and signed as success/no-credit so provider retries do not
  create retry storms; partial credit failures return a signed failed body.
- Waffo webhook responses sign the exact Go-compatible JSON body
  `{"message":"success"}` or `{"message":"failed"}` with the merchant private
  key and return it in `X-SIGNATURE`.
- `GET /api/user/topup/info` now exposes legacy Waffo wallet topup only when
  compliance, active-mode Waffo credentials, and a non-empty method list are
  complete. This removes the final `payment-deferred` frontend route-debt
  category.

Updated local evidence:

- route audit: 212 frontend calls, 246 Worker routes, 35 missing calls;
- debt categories: 13 auth-deferred, 22 capability-hidden-product,
  0 payment-deferred;
- route-set SHA-256:
  `47cecc965627ac5c9ee04118b842dad4d1aaa5416e607449998ffa64c45e79d5`;
- `cargo test -p cinatoken-worker --lib`: 308 passed;
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed.

Remaining boundary: `/api/subscription/creem/pay`,
`/api/subscription/waffo-pancake/pay`, subscription Epay checkout/callback, and
other external subscription checkout/callback routes remain capability-hidden
or auth-deferred until their provider-specific subscription order model,
signature verification, amount/product/env match checks, idempotency, replay,
and reconciliation evidence is in place.

### 22.21 2026-07-04 Stripe Subscription Checkout/Settlement Delta

This increment removes the default frontend's Stripe subscription checkout
route from the route-debt set and gives the existing Stripe webhook a
subscription-first settlement branch:

- `POST /api/subscription/stripe/pay` requires user session auth, payment
  compliance, a configured Stripe API secret + webhook secret, an enabled plan,
  and a non-empty plan `stripe_price_id`.
- The Worker creates a pending `subscription_orders` row before calling Stripe
  Checkout. This deliberately follows the safer Rust wallet-payment invariant:
  a paid external checkout must always have a local settlement record.
- Subscription order IDs keep the Go-visible hashed reference shape:
  `sub_ref_{sha1("sub-stripe-ref-{user}-{UnixMilli}-{rand4}")}`.
- Stripe Checkout uses `mode=subscription`, `client_reference_id`, plan
  `price`, and either saved `stripe_customer` or `customer_email` +
  `customer_creation=always`; success/cancel both return to
  `/console/topup` under `FRONTEND_BASE_URL` or the request origin.
- Outbound Stripe requests reject redirects, enforce a 30 second timeout,
  require JSON responses, and bound response reads to 64 KiB.
- `POST /api/stripe/webhook` now handles subscription orders before wallet
  topups. `checkout.session.completed` completes the pending subscription
  order through a D1 batch that inserts the user subscription, updates any
  upgrade group, records a success topup-history row with `credited=1`, and
  marks the order success. `checkout.session.expired` marks pending
  subscription orders expired before falling back to wallet topup expiry.
- Signature-valid subscription replays are ACKed as idempotent no-ops when the
  order is already success or expired; only NotFound falls back to wallet
  topup settlement.
- `tools/frontend_route_debt_baseline.json` is intentionally updated for the
  new route set.

Updated local evidence:

- route audit: 212 frontend calls, 247 Worker routes, 34 missing calls;
- debt categories: 13 auth-deferred, 21 capability-hidden-product,
  0 payment-deferred;
- route-set SHA-256:
  `792603717515eec247bb086b8136b4e37293d673bbe7d808491af1854c8fcde3`;
- `cargo test -p cinatoken-worker --lib`: 311 passed;
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed;
- `bun run check`: passed.

Remaining boundary: `/api/subscription/creem/pay`,
`/api/subscription/waffo-pancake/pay`, subscription Epay checkout/callback, and
the deployment/io.net feature family remain capability-hidden or auth-deferred
until their provider-specific order model, signature verification,
amount/product/env checks, replay handling, and staging reconciliation evidence
are in place.

### 22.22 2026-07-04 Creem Subscription Checkout/Settlement Delta

This increment removes the default frontend's Creem subscription checkout route
from the route-debt set and upgrades the existing Creem webhook from
subscription deferral to subscription-first settlement:

- `POST /api/subscription/creem/pay` requires user session auth, payment
  compliance, `CreemApiKey`, `CreemWebhookSecret`, an enabled plan, and a
  non-empty plan `creem_product_id`.
- The Worker creates a pending `subscription_orders` row before calling Creem
  Checkout. This keeps the same Rust payment invariant used by wallet topups
  and Stripe subscriptions: every externally paid checkout must have a local
  settlement row before the provider is allowed to collect money.
- Subscription order IDs keep the Go-visible hashed reference shape:
  `sub_ref_{sha1("sub-creem-ref-{rand6}{UnixMilli}{username}")}`.
- Creem checkout creation reuses the existing bounded Worker-native Creem
  client: JSON request body, explicit `x-api-key`, no redirects, 30 second
  timeout, response content-type checks, and a 64 KiB response cap.
- `POST /api/creem/webhook` now looks up `subscription_orders` before wallet
  topups. Signature-valid `checkout.completed` + `paid` events with a matching
  local `payment_provider=creem`, plan `creem_product_id`, and amount complete
  the pending order through the shared subscription D1 settlement batch.
- Subscription settlement inserts the user subscription, applies any plan group
  update, records a success topup-history row with `credited=1`, and marks the
  order success. Verified duplicate deliveries are ACKed as idempotent no-ops
  when the order is already success or otherwise terminal.
- Signature-valid provider/product/amount mismatches are recorded in
  `payment_events` as rejected/ignored and ACKed without credit, so permanent
  mismatches do not create provider retry storms.
- `tools/frontend_route_debt_baseline.json` is intentionally updated for the
  new route set.

Updated local evidence:

- route audit: 212 frontend calls, 248 Worker routes, 33 missing calls;
- debt categories: 13 auth-deferred, 20 capability-hidden-product,
  0 payment-deferred;
- route-set SHA-256:
  `cda3a9b64f6b5d611724852f02448df910ae650218273b296d99e564560e19e6`;
- `cargo test -p cinatoken-worker --lib`: 314 passed;
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed;
- `bun run check`: passed.

Remaining boundary: `/api/subscription/waffo-pancake/pay`, subscription Epay
checkout/callback, and the deployment/io.net feature family remain
capability-hidden or auth-deferred until their provider-specific order model,
signature verification, amount/product/env checks, replay handling, and staging
reconciliation evidence are in place.

### 22.23 2026-07-04 Epay Subscription Checkout/Notify/Return Delta

This increment removes the default frontend's Epay subscription checkout route
from the route-debt set and adds the source Go Epay subscription callback pair:

- `POST /api/subscription/epay/pay` requires user session auth, payment
  compliance, configured `PayAddress` / `EpayId` / `EpayKey`, a selected
  configured Epay payment method, an enabled plan, and `price_amount >= 0.01`.
- The Worker creates a pending `subscription_orders` row before returning the
  signed Epay form. Order IDs keep the Go-visible shape
  `SUBUSR{user_id}NO{rand6}{UnixSeconds}` while using the Rust CSPRNG
  `random_base62` helper for the suffix.
- The Epay form params reuse the existing Go-compatible Epay SDK translation:
  `pid`, `type`, `out_trade_no`, `notify_url`, `return_url`, `name=SUB:{plan}`,
  `money` with two decimals, `device=pc`, `sign_type=MD5`, and
  `sign=md5(sorted_nonempty_params + EpayKey)`.
- `GET/POST /api/subscription/epay/notify` parses bounded form/query callbacks,
  verifies the MD5 signature with constant-time comparison, requires
  `TRADE_SUCCESS`, checks local provider and pending-order amount, and settles
  through the shared subscription D1 batch.
- `GET/POST /api/subscription/epay/return` uses the same verification and
  settlement path, then redirects the browser to `/console/topup?pay=success`,
  `?pay=fail`, or `?pay=pending` under `FRONTEND_BASE_URL` or the request
  origin.
- Subscription settlement inserts the user subscription, applies any plan group
  update, records a success topup-history row with `credited=1`, updates the
  actual payment method from the Epay callback type, and marks the order
  success. Verified duplicate deliveries are ACKed as idempotent no-ops.
- Signature-valid local provider, amount, or order mismatches are recorded in
  `payment_events` as rejected/unmatched without credit.
- `tools/frontend_route_debt_baseline.json` is intentionally updated for the
  new route set.

Updated local evidence:

- route audit: 212 frontend calls, 253 Worker routes, 32 missing calls;
- debt categories: 13 auth-deferred, 19 capability-hidden-product,
  0 payment-deferred;
- route-set SHA-256:
  `516ec5b5419f85268a569b96893f3b76920dc404ba5edd9982f75bb82c47bd48`;
- `cargo test -p cinatoken-worker --lib`: 316 passed;
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed;
- `bun run check`: passed.

Remaining boundary: `/api/subscription/waffo-pancake/pay` and the
deployment/io.net feature family remain capability-hidden or auth-deferred
until their provider-specific order model, signature verification,
amount/product/env checks, replay handling, and staging reconciliation evidence
are in place.

### 22.24 2026-07-04 Waffo Pancake Subscription Checkout/Webhook Delta

This increment removes the default frontend's last payment-provider route from
the route-debt set and migrates Waffo Pancake subscription checkout/settlement:

- `POST /api/subscription/waffo-pancake/pay` requires user session auth,
  payment compliance, configured Waffo Pancake merchant credentials, an enabled
  plan, `price_amount >= 0.01`, and a valid plan
  `waffo_pancake_product_id`.
- The Worker creates a pending `subscription_orders` row before calling Waffo
  Pancake authenticated checkout. Order IDs keep the Go-visible shape
  `WAFFO_PANCAKE_SUB-{user_id}-{UnixMilli}-{rand6}` while using the Rust
  CSPRNG `random_base62` helper for the suffix.
- Checkout creation reuses the existing Worker-side Pancake action helpers:
  stable `cinatoken-user-{id}` buyer identity, optional buyer email,
  two-decimal USD price snapshot, 45-minute expiry, SDK-compatible signed action
  requests, deterministic idempotency keys, and token-fragment checkout URLs.
- If external checkout creation fails after the local pending order is created,
  the Worker CAS-marks the subscription order `failed` for
  `payment_provider=waffo_pancake`, avoiding indefinitely pending local rows.
- `POST /api/waffo-pancake/webhook/:env` now dispatches
  `WAFFO_PANCAKE_SUB-...` trade numbers before wallet topups. It verifies
  `X-Waffo-Signature`, enforces the test/prod route env, checks local provider,
  buyer identity, and event amount, then settles through the shared subscription
  D1 batch.
- Signature-valid local order, provider, buyer-identity, or amount mismatches
  are recorded in `payment_events` as subscription rejected/unmatched and ACKed
  as no-credit permanent mismatches. Successful first-time and duplicate
  deliveries are recorded as `subscription_paid`.
- `/api/user/topup/info` now exposes `enable_waffo_pancake_subscription` when
  payment compliance and Pancake merchant credentials are present; the frontend
  still requires each selected plan to have its own
  `waffo_pancake_product_id`.
- `tools/frontend_route_debt_baseline.json` is intentionally updated for the
  new route set.

Updated local evidence:

- route audit: 212 frontend calls, 254 Worker routes, 31 missing calls;
- debt categories: 13 auth-deferred, 18 capability-hidden-product,
  0 payment-deferred;
- route-set SHA-256:
  `098ee3dc3d0f38dcd443d31e58306a264c61cb60fe7b2ce983fffe143fb99ebc`;
- `cargo test -p cinatoken-worker --lib`: 317 passed;
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed;
- `bun run check`: passed.

Remaining boundary: the default frontend no longer has a payment-provider
route gap. Remaining production gates are staging browser smoke, provider
replay/reconciliation evidence, custom OAuth public callbacks, and incomplete
product families such as deployment/io.net.

### 22.25 2026-07-04 io.net Deployment Admin Compatibility Delta

This increment removes the default frontend's deployment/io.net route family
from the route-debt set and ports the Go `controller/deployment.go` admin
surface into the Worker:

- Added Worker-owned AdminAuth routes for deployment settings, connection
  tests, list/search/detail, containers, raw logs, hardware types, locations,
  available replicas, price estimation, cluster-name checks, create, update,
  rename, extend, and delete.
- The routes preserve the Go option keys
  `model_deployment.ionet.enabled` and `model_deployment.ionet.api_key`.
  `/api/status` now exposes only the non-sensitive
  `enable_deployments` flag from D1 options; the io.net API key remains hidden
  from public status and option-list responses.
- External io.net calls are centralized in a Worker-native client using
  explicit `X-API-KEY`, no forwarded browser auth headers, redirect-error
  fetches, `DEPLOYMENT_HTTP_TIMEOUT_SECONDS` with a 30 second cap, and a
  bounded 1 MiB response-body reader.
- The compatibility layer preserves Go response shapes expected by the React
  deployment UI: list `items/status_counts`, mapped deployment/container DTOs,
  raw log string data, hardware/location catalogs, availability, price
  estimation, and mutation result envelopes.
- Disabled or unconfigured io.net returns the Go-compatible envelope message
  `io.net model deployment is not enabled or api key missing` instead of a
  Worker 500. Connection testing may use an explicit request `api_key` before
  the setting is saved, matching the Go admin settings flow.
- `tools/frontend_route_debt_baseline.json` is intentionally updated for the
  new route set.

Updated local evidence:

- route audit: 212 frontend calls, 274 Worker routes, 13 missing calls;
- debt categories: 13 auth-deferred, 0 capability-hidden-product,
  0 payment-deferred;
- route-set SHA-256:
  `5dc8efd5873d9fd4fbeb7e2f4c8eac2e15b5d872b440894ccf73ba5ebc6654ab`;
- `cargo test -p cinatoken-worker --lib`: 320 passed;
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed;
- `bun tools/audit_frontend_routes.mjs --summary --fail-on-unclassified`:
  passed.

Remaining boundary at this checkpoint: deployment/io.net is now Worker-owned
but still needs staging evidence with real io.net credentials: settings save +
connection test, catalog reads, price estimation, list/detail/log smoke, one
reversible mutation smoke, and rollback documentation. At this point the only
default-frontend route debt left was the 13 auth-deferred routes for email
verification/reset/bind, WeChat OAuth, Passkey, and admin passkey reset.

### 22.26 2026-07-04 Admin Passkey Reset Compatibility Delta

This increment removes the default frontend's admin Passkey reset route from
the route-debt set and lays the D1 foundation for the remaining full Passkey
ceremonies:

- Added `migrations/d1/0016_passkey_credentials.sql`, mirroring Go
  `model/passkey.go` with base64 WebAuthn credential fields, one active
  credential per user, 0/1 boolean columns, unix-second timestamps, and a
  `deleted_at` import-compatibility column.
- Added Worker D1 repository helpers to check a user's active Passkey
  credential with `deleted_at IS NULL` and hard-delete all credentials for a
  user, matching Go's `DeletePasskeyByUserID` `Unscoped()` behavior.
- Added AdminAuth route `DELETE /api/user/:id/reset_passkey` with the same
  manage-target role boundary used by the other user recovery routes. It
  returns a 200 `success:false` envelope when the target has no Passkey,
  hard-deletes on success, and records a `user.reset_passkey` admin audit row.
- `tools/frontend_route_debt_baseline.json` is intentionally updated for the
  new route set.

Updated local evidence:

- route audit: 212 frontend calls, 275 Worker routes, 12 missing calls;
- debt categories: 12 auth-deferred;
- route-set SHA-256:
  `d51581aed82f7f8a3024885b5fd075834c8dc96b983b74aec6e0144b579905fe`.

Remaining boundary: full WebAuthn/Passkey register, login, and step-up
ceremonies are still deferred; they should reuse the new D1 table plus the
existing `flow_state` challenge TTL boundary. Email verification/reset/bind,
WeChat OAuth, and password reset confirmation also remain in the 12
auth-deferred default-frontend route gaps.

### 22.27 2026-07-04 Email Verification And Password Reset Compatibility Delta

This increment removes the default frontend's email verification, email bind,
password reset email, and password reset confirmation routes from the
route-debt set:

- Added Worker-owned routes for `GET /api/verification`,
  `GET /api/reset_password`, `POST /api/user/reset`, and
  `POST /api/oauth/email/bind`.
- Replaced Go's process-local verification map with `flow_state` KV entries:
  `EmailVerification` and `PasswordReset`, each with a 10-minute TTL matching
  Go `VerificationValidMinutes`.
- Verification/reset flow-state ids hash the normalized email before writing
  KV keys, so emails are not exposed in key names.
- Email delivery uses Cloudflare's native `send_email` binding named `EMAIL`
  instead of SMTP sockets, while preserving the existing operator-facing
  `SMTPFrom`/`SMTPAccount` option fallback as the sender address. Missing
  `EMAIL` binding or sender config fails verification-email sends and is
  logged-but-enumeration-safe for password-reset email sends, matching Go's
  password-reset success envelope.
- Email verification enforces the Go admin options
  `EmailDomainRestrictionEnabled`, `EmailDomainWhitelist`, and
  `EmailAliasRestrictionEnabled`, and treats soft-deleted users as occupying an
  email address just like Go `IsEmailAlreadyTaken` with `Unscoped()`.
- Registration now honors `EmailVerificationEnabled`: when enabled, a valid
  emailed code is required and the verified email is persisted to the new user;
  when disabled, unverified registration keeps email empty as in Go.
- Password reset validates the KV token, generates a 12-character CSPRNG hex
  password, bcrypt-hashes it, updates the active user by email, deletes the
  reset token, and returns the plaintext generated password in the Go-compatible
  response `data`.
- `/api/status` now exposes `email_verification` from the
  `EmailVerificationEnabled` option instead of hardcoding false.
- `tools/frontend_route_debt_baseline.json` is intentionally updated for the
  new route set.

Updated local evidence:

- route audit: 212 frontend calls, 279 Worker routes, 8 missing calls;
- debt categories: 8 auth-deferred;
- route-set SHA-256:
  `65f9ed7547e329d29cd3b7bfb6e9b1cccdf23290c112a87bf2cd5b5db5ca0f99`;
- `cargo test -p cinatoken-worker --lib`: 324 passed;
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed.

Remaining boundary: the email routes are Worker-owned but need deployed smoke
with a real Cloudflare Email Service binding and verified sender address:
send-code, bind email, registration with `EmailVerificationEnabled=true`,
password reset email, reset confirmation, and negative tests for missing
binding/sender, expired token, reused reset token, taken email, domain
whitelist, and alias restriction. The only default-frontend route debt left is
WeChat OAuth (2 routes) and full Passkey register/login/step-up ceremonies
(6 routes).

### 22.28 2026-07-04 WeChat OAuth Compatibility Delta

This increment removes the default frontend's WeChat login and bind route debt
from the tracked route set:

- Added Worker-owned routes for `GET /api/oauth/wechat`,
  `GET /api/oauth/wechat/bind`, and the Go-compatible
  `POST /api/oauth/wechat/bind`.
- `GET /api/oauth/wechat` reads `code`, verifies it against the operator
  WeChat Server endpoint `/api/wechat/user?code=...`, finds an active local
  user by `wechat_id`, or creates `wechat_<max_user_id+1>` with display name
  `WeChat User`, common role, enabled status, default group, and the configured
  `QuotaForNewUser` grant.
- `GET|POST /api/oauth/wechat/bind` requires a Rust session, verifies the code
  with the same WeChat Server, treats soft-deleted rows as occupying the
  WeChat id just like Go `IsWeChatIdAlreadyTaken` with `Unscoped()`, and binds
  the id to the active user.
- `/api/status` now exposes `wechat_login` from `WeChatAuthEnabled` and
  `wechat_qrcode` from `WeChatAccountQRCodeImageURL`, so the default React
  login/register pages can show the existing WeChat QR-code flow.
- Worker-specific hardening over the Go/VPS path: `WeChatServerAddress` must
  be a public HTTPS URL without query/fragment, redirects are rejected, and the
  outbound code-verification fetch uses a 5-second abort timeout. This is safer
  for Cloudflare egress but requires operators with HTTP/private WeChat Server
  deployments to move that service behind a public HTTPS endpoint before
  enabling the feature on Rust.
- `tools/frontend_route_debt_baseline.json` is intentionally updated for the
  new route set.

Updated local evidence:

- route audit: 212 frontend calls, 282 Worker routes, 6 missing calls;
- debt categories: 6 auth-deferred;
- route-set SHA-256:
  `8bcefa9b62aaa9473541032cc28e21d6e31e9711db66b6f5706b3976c736b457`;
- `cargo test -p cinatoken-worker --lib`: 327 passed.

Remaining boundary: WeChat routes are Worker-owned but need deployed smoke
with a real WeChat Server and QR/code flow: disabled option, missing/invalid
code, expired code, soft-deleted taken WeChat id, first-time registration with
`RegisterEnabled=true`, registration blocked with `RegisterEnabled=false`,
login for an existing enabled user, disabled-user rejection, GET bind for the
current default frontend, POST bind for Go-compatible clients, and invalid
HTTP/private/query WeChat Server configuration. The only tracked default
frontend route debt left is the six full Passkey register/login/step-up
ceremony routes.

Audit caveat: the current frontend route audit only proves the explicit
call-expression route set. It does not yet fully cover constant-driven
endpoints, JSX `href`/`src`, dynamic custom OAuth callbacks, or navigation-only
targets such as `/pg/chat/completions` and `/v1/videos/:task_id/content`.
Those remain tracked in the production readiness matrix until the audit script
is broadened.

### 22.29 2026-07-04 Playground Chat Relay Compatibility Delta

This increment moves the default frontend playground chat path from a
matrix-only route gap to Worker-owned implementation evidence:

- Added `POST /pg/chat/completions` to the Worker router, sharing the normal
  OpenAI-compatible chat-completions relay pipeline so JSON/SSE behavior,
  model mapping, channel selection, read-through cache, rate limits, audit
  logging, and tiered billing preflight/settlement stay on the same code path
  as `/v1/chat/completions`.
- Added a session-backed playground auth mode that mirrors Go
  `controller.Playground`: it reads the Rust session, loads the active user,
  enforces enabled/quota checks, resolves optional request `group` overrides,
  checks the requested group against `UserUsableGroups` plus
  `group_ratio_setting.group_special_usable_group`, and builds a synthetic
  token context with `token_id = 0` and `token_name = playground-{group}`.
- Updated D1 quota mutation helpers so the synthetic playground token debits
  and settles user quota and channel usage without touching the `tokens` table,
  matching Go's playground quota behavior while preserving audit/request-count
  updates.
- Scoped relay token rate limits for playground traffic by user
  (`playground-user:{user_id}`) instead of sharing one `token:0` bucket across
  all logged-in users.
- Stripped the local-only playground `group` field from the upstream JSON body
  before forwarding, preserving Go's typed OpenAI request behavior and avoiding
  unknown-field rejections by strict OpenAI-compatible providers.
- Reused the same Worker-side bounded JSON request and streaming response
  practices as the existing relay routes; local implementation was checked
  against Cloudflare Workers best-practice guidance for request bounds,
  streaming, environment bindings, and no global mutable request state.

Updated local evidence:

- route audit: 212 frontend calls, 283 Worker routes, 6 missing calls;
- debt categories: 6 auth-deferred;
- route-set SHA-256:
  `8bcefa9b62aaa9473541032cc28e21d6e31e9711db66b6f5706b3976c736b457`;
- `cargo test -p cinatoken-worker --lib`: 331 passed;
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed;
- `cargo fmt --all --check`: passed;
- `bun run check`: passed.

Remaining boundary: playground is Worker-owned locally, but production
readiness still needs logged-in staging smoke for non-stream and stream
requests, group allow/deny paths, user quota debit, channel quota/audit rows,
per-user rate-limit scoping, token-table non-mutation for the synthetic token,
and logout/disabled/quota-exhausted error shapes. The tracked default-frontend
route debt remains the six full Passkey register/login/step-up ceremony routes.

Audit caveat update: `/pg/chat/completions` was not part of the explicit route
debt set because it is constant-driven by the playground frontend. It is now
closed by direct source and matrix evidence rather than by a route-debt SHA
change. The audit script still needs broader coverage for constant-driven
endpoints, JSX `href`/`src`, dynamic custom OAuth callbacks, and
navigation/content targets such as `/v1/videos/:task_id/content`.

### 22.30 2026-07-04 Passkey Route Boundary Compatibility Delta

This increment removes the default frontend's final six tracked Passkey route
gaps from the explicit route-debt baseline while keeping the cryptographic
finish ceremony blocked until a production-safe verifier is selected:

- Added Worker-owned routes for `GET /api/user/passkey`,
  `DELETE /api/user/passkey`, `POST /api/user/passkey/register/begin`,
  `POST /api/user/passkey/register/finish`,
  `POST /api/user/passkey/login/begin`,
  `POST /api/user/passkey/login/finish`,
  `POST /api/user/passkey/verify/begin`, and
  `POST /api/user/passkey/verify/finish`.
- Moved those routes ahead of dynamic `/api/user/:id` admin routes so
  self-service Passkey calls are matched deterministically.
- Added D1 projection for active `passkey_credentials` rows so status,
  delete, register exclusion, and verify allow-credential options can reuse
  Go-compatible imported credential data.
- Added register/login/verify begin challenge generation with 32-byte CSPRNG
  challenges, URL-safe base64 WebAuthn publicKey options, RP settings derived
  from `passkey.*`, `ServerAddress`, or request origin, and short-TTL
  `flow_state::PasskeyChallenge` storage.
- Added an HttpOnly, Secure, SameSite=Strict short-TTL flow cookie for
  anonymous login begin/finish correlation without process-local state.
- Kept all finish routes fail-closed with a 501 envelope after single-use
  challenge consumption. They must not return success until attestation or
  assertion verification validates signature, challenge, origin/RPID,
  credential id, user handle, sign count, and credential import/update.
- `/api/status` now exposes Passkey configuration metadata for the frontend,
  but intentionally keeps `passkey_login=false` until the finish verifier lands.
- `tools/frontend_route_debt_baseline.json` is intentionally updated to the
  empty missing-route set.

Updated local evidence:

- route audit: 212 frontend calls, 291 Worker routes, 0 missing calls;
- debt categories: none;
- route-set SHA-256:
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`;
- `cargo test -p cinatoken-worker --lib`: 337 passed;
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed;
- `cargo fmt --all --check`: passed;
- `bun run check`: passed.

Remaining boundary: the route audit now reports zero explicit frontend route
gaps, but Passkey is not production-complete until a Worker-safe WebAuthn
verifier, service binding, or Container path is implemented and staged against
real browsers and authenticators. Production cutover still needs a clear
forced reset/import policy for existing Passkey credentials if verifier or data
compatibility cannot be proven.

### 22.31 2026-07-04 Token-Authenticated Model List Compatibility Delta

This increment replaces the Rust placeholder `/v1/models` response with
Worker-owned model-list compatibility that is materially closer to Go
`controller.ListModels` / `RetrieveModel`:

- `GET /v1/models` now requires relay token authentication instead of returning
  an anonymous placeholder list.
- `GET /v1/models/:model` now returns an OpenAI-compatible model object for
  models visible to the authenticated token and a Go-shaped
  `model_not_found` error envelope when the model is not visible.
- `GET /v1beta/models` returns the Gemini model-list shape
  `{ models, nextPageToken }` from the same visible model set.
- `GET /v1beta/openai/models` returns the OpenAI-compatible list for Gemini
  OpenAI-compatible clients.
- Visible models are derived from token `model_limits` when enabled; otherwise
  they come from the token effective group and D1 `abilities`. The `auto`
  token group expands through the user's configured auto groups.
- Model-list auth uses the existing relay token read-through cache with a
  model-list-specific cache key, refreshes token/user quota state from D1 on
  cache hits, and validates token/user status, expiry, quota, and IP allowlist.
- Existing relay request authentication keeps its model-specific model-limit
  gate, so this list path does not weaken request-time enforcement.
- The local matrix also now reflects already-implemented
  `/v1/responses/compact` and `/v1/moderations` Worker routes as `Partial`
  instead of stale `Planned` rows.

Updated local evidence:

- route audit: 212 frontend calls, 294 Worker routes, 0 missing calls;
- debt categories: none;
- route-set SHA-256:
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`;
- `cargo test -p cinatoken-worker --lib`: 341 passed;
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed;
- `cargo fmt --all --check`: passed;
- `bun run check`: passed.

Remaining boundary: owner/provider metadata still uses a conservative
`owned_by=custom` default for D1-derived models, and the Go
`AcceptUnsetRatioModel` / billing-config visibility filter is not yet fully
ported for the list endpoint. Production evidence still needs live token smoke
for unrestricted tokens, limited tokens, auto groups, Anthropic/Gemini shapes,
missing model errors, disabled/exhausted tokens, and provider owner metadata.

### 22.32 2026-07-04 Model Metadata Frontend Enrichment Delta

This increment tightens the default-frontend `features/models` contract. Route
debt was already zero, but the Worker model metadata responses were thinner
than Go `controller/model_meta.go` and did not populate display fields the
React model table reads.

Implemented in Rust:

- `GET /api/models/` and `GET /api/models/search` now return enriched model
  rows with `bound_channels`, `enable_groups`, `quota_types`,
  `matched_models`, `matched_count`, and endpoint backfill.
- `GET /api/models/:id` now uses the same enrichment path for detail/drawer
  reads.
- List responses now include `vendor_counts`, including an `all` count for the
  default frontend's vendor filter label.
- The frontend query params `status=enabled|disabled` and
  `sync_official=yes|no` now become D1 filters instead of being ignored.
- Enrichment reuses the same pricing-row context as `/api/pricing` and a
  batched `abilities` + `channels` D1 lookup, matching Go's batch approach and
  avoiding per-row D1 queries.
- The readiness matrix now reflects that model/vendor/prefill routes and
  token/user admin routes are `Partial` rather than stale `Planned` rows.

Updated local evidence:

- route audit: 212 frontend calls, 294 Worker routes, 0 missing calls;
- debt categories: none;
- route-set SHA-256:
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`;
- `cargo test -p cinatoken-worker --lib`: 344 passed;
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed;
- `cargo fmt --all --check`: passed.

Remaining boundary: this is still local contract evidence. Production readiness
needs authenticated browser/operator smoke for model list/search/filter/detail,
model/vendor/prefill create/update/delete, official metadata preview/sync, and
proof that model metadata mutations invalidate or refresh the pricing/model
mapping views used by relay and the frontend.

### 22.33 2026-07-04 CSPRNG Hardening Delta

This increment does not add routes; it closes a production security gap found
during the Go-to-Cloudflare Worker migration audit. Cloudflare Workers best
practice treats `Math.random()` as unsuitable for security-sensitive tokens and
IDs, so the Worker now avoids it for the user/admin credentials and subscription
balance order suffixes that are generated on the Rust side.

Implemented in Rust:

- `GET /api/user/token` now generates its 32-character user access token through
  `getrandom` with base62 rejection sampling instead of `js_sys::Math::random`.
- Admin user creation, public registration, and lazy affiliation-code creation
  now use the same Worker CSPRNG-backed base62 helper for 4-character
  `aff_code` values.
- Subscription balance-pay order numbers keep the Go-visible
  `SUBBALUSR{user_id}NO{six_digits}{millis}` shape, but the six-digit suffix is
  now produced from CSPRNG bytes with digit rejection sampling.
- Balance-pay order-id generation happens before quota debit or subscription
  creation, so a random-source failure fails closed before state mutation.
- Tests cover generated access-token length/alphabet/distinctness, affiliation
  code length/alphabet, zero-length base62 handling, and balance-pay digit
  suffix formatting.

Updated local evidence:

- fetched current Cloudflare Worker references and latest
  `@cloudflare/workers-types` version `5.20260704.1`;
- `cargo fmt --all --check`: passed;
- `cargo test -p cinatoken-worker --lib`: 348 passed;
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed;
- `bun tools/audit_frontend_routes.mjs --summary --fail-on-unclassified --check-baseline`:
  212 frontend calls, 294 Worker routes, 0 missing calls, categories `{}`;
- `bun run check`: passed;
- `rg` confirms `admin_user.rs` and `admin_subscription.rs` no longer contain
  `Math.random()` generation. The then-remaining relay weighted selection
  `Math.random()` hit is closed by 22.34.

Remaining boundary: this slice did not change relay traffic distribution; see
22.34 for the relay weighted-selection RNG source update. Production still needs
G3/G6 staging evidence for weighted distribution, retry, affinity, and
provider-family selection behavior.

### 22.34 2026-07-04 Relay Weighted Selection CSPRNG Delta

This increment closes the remaining direct Worker `Math.random()` usage without
rewriting the Go-compatible channel-selection algorithm. The pure selector in
`cinatoken_core::channel_select::select_weighted` remains RNG-injected; the
Worker now provides a CSPRNG-backed bounded draw instead of
`js_sys::Math::random()`.

Implemented in Rust:

- `plan_relay_attempts` now accepts a fallible `worker::Result<u64>` RNG and
  propagates random-source failures instead of silently biasing to a channel.
- `random_u64_below(total)` uses `getrandom` and u64 rejection sampling to
  produce unbiased values in `[0,total)`, matching the selector contract.
- The single-group and auto-group retry planners still use the same
  priority-tier, smoothing, pool-shrink, and cross-group state-machine behavior.
- Tests cover bounded random outputs and RNG error propagation, while the
  existing deterministic plan tests continue to prove retry order and
  cross-group behavior.

Updated local evidence:

- fetched current Cloudflare Worker references and latest
  `@cloudflare/workers-types` version `5.20260704.1`;
- `cargo fmt --all --check`: passed;
- `cargo test -p cinatoken-worker --lib relay::tests::`: 102 passed;
- `cargo test -p cinatoken-worker --lib`: 350 passed;
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed;
- `bun tools/audit_frontend_routes.mjs --summary --fail-on-unclassified --check-baseline`:
  212 frontend calls, 294 Worker routes, 0 missing calls, categories `{}`;
- `bun run check`: passed;
- `rg -n "Math::random|js_sys::Math" crates/worker/src`: no matches.

Remaining boundary: this removes the runtime anti-pattern and preserves local
selector behavior, but it is not a substitute for staging distribution evidence.
G3 still needs live or replayed proof for weighted channel spread, auto-group
retry, affinity preference/recovery, provider-family filters, and retry/auto-ban
interactions.

### 22.35 2026-07-05 Multipart Upload Binary Parser And WAV Estimate Delta

This increment tightens the multipart upload relay paths that replace Go's
Gin multipart parsing for OpenAI-compatible uploads. The previous Rust parser
could only extract text fields when the entire multipart body was valid UTF-8,
which is not true for real audio/image binaries. A binary `file` part could
therefore hide the `model` field from the relay and fail routing/auth/billing
before the upstream request.

Implemented in Rust:

- `cinatoken_relay::multipart` now scans multipart bodies at the byte level and
  parses only each part's ASCII headers, so binary file bytes no longer block
  extraction of text fields such as `model`.
- Added `extract_multipart_file`/`MultipartFile` for first-file extraction
  without decoding or copying the uploaded bytes.
- Multipart `Content-Type` validation now uses the shared exact media-type
  policy instead of a substring check.
- Worker audio transcription/translation preflight now derives extra
  Go-compatible prompt-token estimates from PCM WAV duration:
  `round(ceil(duration_seconds) / 60 * 1000)`.
- `/v1/audio/transcriptions`, `/v1/audio/translations`, and `/v1/images/edits`
  remain byte-for-byte upstream multipart forwards; the Worker does not rewrite
  the upload body.

Updated local evidence:

- `cargo test -p cinatoken-relay multipart`: 12 passed;
- `cargo test -p cinatoken-worker --lib multipart_audio_wav_duration_feeds_prompt_estimate`:
  passed.

Remaining boundary: this is not full STT production billing parity. MP3, FLAC,
M4A/MP4, OGG/Opus, AIFF, WebM, and AAC duration parsing still need a
header-parser, size-estimate, or Container offload decision; live upstream
smoke and billing shadow/reconciliation evidence are still required before
audio upload routes own production paid traffic.

### 22.36 2026-07-05 Common Audio Duration Parser Delta

This increment supersedes the non-WAV parser gap left in 22.35 for request-time
STT preflight estimates. It keeps the Cloudflare Worker upload path bounded and
WASM-local: no ffmpeg/ffprobe, no external process, and no heavyweight decoder
dependency.

Implemented in Rust:

- `cinatoken_core::audio_duration::audio_duration_seconds` dispatches by upload
  filename, part `Content-Type`, and magic bytes.
- Header/frame-level parsers now cover WAV, MP3, FLAC STREAMINFO, M4A/MP4
  `mvhd`, OGG/Vorbis granule position, OGG/Opus granule position, AIFF/AIFC
  `COMM`, and AAC ADTS frames.
- Worker multipart audio preflight now passes the uploaded file name and part
  `Content-Type` into the common duration parser before applying the
  Go-compatible `round(ceil(duration_seconds) / 60 * 1000)` token formula.
- WebM was left for a follow-up EBML parser or Container offload decision in
  this increment. That follow-up landed in 22.37.

Updated local evidence:

- `cargo test -p cinatoken-core audio_duration`: 12 passed;
- `cargo test -p cinatoken-worker --lib multipart_audio_flac_duration_feeds_prompt_estimate`:
  passed.

Remaining boundary: this is still preflight-estimate parity, not production
billing proof. The next audio slice should replay real MP3/FLAC/M4A/OGG/Opus/
AIFF/AAC fixtures from source-compatible samples, run live
transcription/translation smoke, and capture billing shadow/reconciliation
evidence.

### 22.37 2026-07-05 WebM EBML Duration Parser Delta

This increment closes the WebM duration-strategy decision left by 22.36 without
introducing a Container or heavyweight decoder. WebM is a Matroska subset; the
Matroska spec defines `TimestampScale` with a default of `1000000` nanoseconds
and `Duration` as Segment ticks based on that scale. The Worker only needs that
metadata for pre-consume estimates, so full media decode is unnecessary.

Implemented in Rust:

- `cinatoken_core::audio_duration` now parses EBML variable-length element IDs
  and sizes, including unknown-size `Segment` elements commonly seen in
  Matroska/WebM streams.
- `audio_duration_seconds` now handles `audio/webm` / `video/webm` uploads when
  the `Segment.Info.Duration` element is present, using explicit
  `TimestampScale` or the Matroska default.
- Worker multipart audio preflight automatically benefits through the existing
  common duration parser; no relay body rewriting or upstream forwarding change
  was required.

Updated local evidence:

- `cargo test -p cinatoken-core audio_duration`: 14 passed;
- `cargo test -p cinatoken-worker --lib multipart_audio_webm_duration_feeds_prompt_estimate`:
  passed;
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed.

Remaining boundary: WebM files that omit the optional `Duration` metadata still
cannot be estimated locally; they continue to forward upstream and simply do not
add extra preflight tokens. Production ownership still requires real-file
fixture replay across the supported upload formats, live transcription/
translation smoke, and billing shadow/reconciliation evidence.

### 22.38 2026-07-05 Broadened Frontend Route Audit Delta

This increment supersedes the audit caveat left in 22.28/22.29 for local
frontend route-debt evidence. The previous audit proved explicit API call
expressions, but it missed constant-driven endpoint objects, SSE constructors,
navigation assignments/calls, and API-prefixed JSX `href`/`src` attributes.

Implemented in Rust/tooling:

- `tools/audit_frontend_routes.mjs` now resolves imported constant endpoint
  objects such as the playground `API_ENDPOINTS`, including `as const` object
  literals and property access.
- The audit now recognizes `new SSE(path, { method })`, `window.open(...)`,
  `location.assign/replace(...)`, `window.location.href = ...`, and
  API-prefixed JSX `href`/`src` attributes as Worker-facing frontend routes.
- `tools/frontend_route_debt_baseline.json` now pins the audit surface itself:
  214 unique Worker-facing frontend routes with detection kinds
  `call=243`, `jsx-attribute=1`, `navigation=1`, and `stream=1`, in addition
  to the missing-route digest.
- The broadened audit surfaced the task-log video preview link
  `GET /v1/videos/:task_id/content`, which is present in Go
  `router/video-router.go` under `TokenOrUserAuth`. Rust now owns that path as
  a structured fail-closed 501 route rather than leaving it as a 404.

Updated local evidence:

- `bun tools/audit_frontend_routes.mjs --summary --fail-on-unclassified --check-baseline`:
  214 frontend routes, 295 Worker routes, 0 missing calls;
- `cargo fmt --all --check`: passed;
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed.

Remaining boundary: this is stronger local route-ownership evidence, not a
browser-production proof. Dynamic runtime OAuth/provider redirects,
feature-flag-hidden UI branches, credentialed redirects, and routes only
visible with production data still require deployed browser smoke. The
`/v1/videos/:task_id/content` route is deliberately fail-closed until the G7
Queue/R2/video proxy design, provider-specific replay, and task billing
settlement evidence exist.

### 22.39 2026-07-05 OpenAI Video Create/Fetch Shell Delta

This increment narrows the `router/video-router.go` gap without claiming full
video artifact ownership.

Implemented in Rust:

- `POST /v1/videos` now uses the existing Worker task-submit orchestration
  (token auth, video channel selection, base quota reserve, upstream submit,
  task insert) and returns an OpenAI-compatible video shell:
  `id`, `object: "video"`, `model`, `status: "queued"`, `progress: 0`, and
  `created_at`.
- `GET /v1/videos/:task_id` now uses the same owner-scoped token auth as
  `/v1/video/generations/:task_id`, but serializes the stored D1 task as an
  OpenAI video status object instead of the internal TaskDto envelope. The
  response maps Go task statuses to OpenAI video statuses, parses `"45%"`
  progress strings, uses `properties.origin_model_name` when present with a
  `platform` fallback, emits `metadata.url` from `private_data.result_url`
  (falling back to `fail_reason` for legacy rows), and includes a basic
  `error` object for failed tasks with a fail reason.
- `POST /v1/videos/:video_id/remix` is now Worker-owned as a structured 501
  boundary, rather than a 404 or accidental generic submit alias.
- `GET /v1/videos/:task_id/content` remains the structured 501 boundary from
  22.38.

Updated local evidence:

- `cargo fmt --all`: passed;
- `cargo test -p cinatoken-worker --lib`: 356 passed, including OpenAI video
  submit/fetch JSON-shape tests;
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed;
- `bun run check`: passed, including frontend type/build, route-debt audit
  (214 frontend routes, 298 Worker routes, 0 missing calls), Rust workspace
  tests excluding the Worker, and Worker wasm check.

Remaining boundary: Go provider adaptors still carry richer
`ConvertToOpenAIVideo` behavior from stored upstream `task.Data`, and Sora remix
still requires `ResolveOriginTask` parity (origin task lookup, ratio inheritance,
and channel lock). Real artifact delivery still requires the G7 Queue/R2 video
content proxy plus provider replay and task billing settlement evidence.

### 22.40 2026-07-05 Task Data Persistence And OpenAI Video Enrichment Delta

This increment narrows the provider-conversion gap left in 22.39 by preserving
the same task data substrate that Go's task adaptors use for later
`ConvertToOpenAIVideo` conversion. It still does not claim full artifact
delivery or exact provider-by-provider serializer parity.

Implemented in Rust:

- Task submit now stores both the upstream task id and the raw upstream submit
  response body in D1. `submit_task` returns a `SubmitTaskOutcome` containing
  the parsed upstream id plus raw `task_data`, and `insert_task` writes it to
  `tasks.data`.
- Task polling now passes the raw provider poll response into the CAS status
  update path, so successful or failed poll rows retain the latest provider
  JSON in `tasks.data` for DTOs and OpenAI video conversion.
- New task inserts now persist Go-compatible model properties:
  `upstream_model_name` and `origin_model_name`. Video task `platform` now uses
  the selected channel type string, matching Go `GetTaskPlatform`, instead of
  overloading the platform field with the requested model name.
- `private_data` now also stores `upstream_task_id` alongside the reserving
  `token_id`, while the dedicated `upstream_task_id` column remains the Rust
  fast path.
- `GET /v1/videos/:task_id` now enriches the OpenAI video object from stored
  provider data: progress fallback from raw data, Sora/OpenAI passthrough fields
  such as `seconds`, `size`, `remixed_from_video_id`, `expires_at`,
  `created_at`, and `completed_at`, provider URL fallback from common
  `content.video_url` / `output.video_url` / `data.video_url` / `video_url` /
  `url` shapes, first-video URL extraction for Kling/Vidu-style arrays, and
  provider error-message fallback.
- Non-Sora provider data no longer overwrites the local task `created_at`, so
  provider-specific JSON can improve metadata without corrupting the task
  timeline.

Updated local evidence:

- `cargo fmt --all`: passed;
- `cargo test -p cinatoken-worker --lib`: 360 passed, including task/video
  data-enrichment tests for Sora passthrough, provider URL fallback, nested
  first-video URL extraction, and non-Sora `created_at` protection;
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed;
- `bun run check`: passed, covering frontend type/build, route-debt baseline,
  `cargo fmt --all --check`, Rust workspace tests excluding the Worker, and
  Worker wasm check. The route audit reported 214 frontend Worker-facing
  routes, 298 Worker routes, 0 missing calls, categories `{}`.

Remaining boundary: exact Go adaptor serializers are still not complete for
Ali, Doubao, Kling, Jimeng, Vidu, Gemini, Vertex, and Hailuo, and Sora remix
still needs `ResolveOriginTask` parity. The `/v1/videos/:task_id/content`
artifact path remains fail-closed until the Queue/R2 proxy, retention policy,
provider replay, and task billing settlement evidence exist.

### 22.41 2026-07-05 Provider-Specific OpenAI Video Serializer Delta

This increment builds on the persisted `tasks.data` substrate from 22.40 and
ports the no-extra-I/O portions of Go `ConvertToOpenAIVideo` into the Worker
status serializer. It keeps artifact retrieval out of `GET /v1/videos/:task_id`
until the Queue/R2 content proxy exists.

Implemented in Rust:

- `GET /v1/videos/:task_id` now detects task provider identity from the stored
  channel-type `platform`, including Ali, Doubao, Kling, Vidu, Jimeng, Gemini,
  Vertex, Hailuo, and Sora/OpenAI.
- Ali video status now follows Go `convertAliStatus` from
  `data.output.task_status`, including `PENDING`, `RUNNING`, `SUCCEEDED`,
  `FAILED`, `CANCELED`, `UNKNOWN`, and unknown-status fallback.
- Provider-specific OpenAI video errors now prefer each provider's task data
  shape: Ali top-level/output codes, Doubao `error`, Kling top-level or
  `data.task_status_msg`, Vidu `err_code`, Jimeng numeric `code`, and Hailuo
  `base_resp`.
- Provider-specific time and metadata overlays now match source behavior where
  no extra fetch is required: Ali/Doubao/Vidu/Jimeng/Hailuo/Vertex use local
  `updated_at` for `completed_at`; Kling uses provider `created_at` /
  `updated_at` and first-video `duration` as `seconds`; Doubao emits the
  legacy-compatible `task_id`; Gemini/Vertex extract the Veo model from the
  encoded upstream operation name with the Go fallback model.

Updated local evidence:

- `cargo fmt --all`: passed;
- `cargo test -p cinatoken-worker --lib task_orchestration::tests::`: 10
  passed, including Ali status/error mapping, Kling provider time/seconds/error
  mapping, and Veo operation-name model extraction;
- `cargo test -p cinatoken-worker --lib`: 363 passed;
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed;
- `bun run check`: passed, including frontend type/build, route-debt audit,
  `cargo fmt --all --check`, Rust workspace tests excluding the Worker, and
  Worker wasm check.

Remaining boundary: this is serializer parity for stored task JSON, not full
video production ownership. Hailuo's authenticated file retrieval, Vertex/Gemini
artifact delivery, `/v1/videos/:task_id/content`, Sora remix origin-task
resolution, provider replay fixtures, and async task billing settlement evidence
remain required before G7 video cutover.

### 22.42 2026-07-05 OpenAI Video Content Proxy First Slice

This increment starts closing the Go `VideoProxy` parity gap for
`GET /v1/videos/:task_id/content` without pretending that full artifact
ownership is complete. The Worker now owns the safe subset that can be served
from already persisted task state.

Implemented in Rust:

- `/v1/videos/:task_id/content` is now an async Worker route instead of a
  structured 501 boundary.
- The route reuses the task-fetch token authentication and owner scoping:
  clients can only fetch completed tasks belonging to the authenticated token's
  user.
- Content source resolution follows Go `Task.GetResultURL` compatibility where
  possible: prefer `private_data.result_url`, fall back to legacy
  `fail_reason`, then stored provider URLs in `tasks.data`.
- Self-referential `/v1/videos/:task_id/content` URLs are skipped so the Worker
  does not recursively proxy itself.
- Vertex stored responses can produce a Go-compatible `data:<mime>;base64,...`
  URL from `response.videos[0].bytesBase64Encoded`,
  `response.bytesBase64Encoded`, or raw `response.video` payloads.
- `data:` URLs are decoded only when they are base64 and under the Worker
  inline-content cap. HTTP(S) URLs are checked by the existing strict SSRF
  policy before the upstream response body is streamed through a fresh mutable
  Worker response with `Cache-Control: public, max-age=86400`.
- The video proxy keeps Go's OpenAI-style error envelope for this route:
  `{"error":{"message":...,"type":...}}`.

Updated local evidence:

- `cargo fmt --all`: passed;
- `cargo test -p cinatoken-worker --lib task_orchestration::tests::`: 16
  passed, including content-source fallback, self-proxy skip, Vertex data URL
  extraction, and bounded data URL decode tests;
- `cargo test -p cinatoken-worker --lib`: 369 passed;
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed;
- `bun run check`: passed, including frontend type/build, route-debt audit,
  `cargo fmt --all --check`, Rust workspace tests excluding the Worker, and
  Worker wasm check.

Remaining boundary: this is not the final Queue/R2 artifact system. Session
auth parity for dashboard media elements, provider credential refetch
(`Gemini`, `Vertex`, `OpenAI`/`Sora` content endpoints), R2 retention policy,
provider replay fixtures, Sora remix origin-task/channel-lock resolution, and
async task billing settlement evidence remain required before G7 video cutover.

### 22.43 2026-07-05 OpenAI Video Content TokenOrUserAuth Parity

This increment closes the dashboard media-link auth gap for
`GET /v1/videos/:task_id/content`. Source Go wires this route through
`middleware.TokenOrUserAuth()`, which tries browser session auth first and then
falls back to API-token auth. The Rust route now follows that shape for the
already-owned stored-URL/data-URL proxy slice.

Implemented in Rust:

- The content proxy now attempts Rust session-cookie auth first using the
  existing `admin::parse_session_claims` codec.
- Session access is still owner-scoped: the route reloads the session user from
  D1, requires `USER_STATUS_ENABLED`, and then queries `tasks` by that user id
  plus `task_id`.
- If no valid session is present, the route falls back to the existing
  Bearer/x-api-key token authentication for API clients.
- The route keeps the OpenAI-style error envelope used by Go `VideoProxy`
  instead of returning the task-fetch `{code,message,data}` envelope.
- API-token clients are not forced to configure browser session auth; when an
  unparseable session cookie is accompanied by a valid API key, token fallback
  remains available.

Updated local evidence:

- `cargo fmt --all`: passed;
- `cargo test -p cinatoken-worker --lib task_orchestration::tests::`: 17
  passed, including the new enabled/missing/disabled session-user owner check.
- `cargo test -p cinatoken-worker --lib`: 370 passed;
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed;
- `bun run check`: passed, including frontend type/build, route-debt audit,
  `cargo fmt --all --check`, Rust workspace tests excluding the Worker, and
  Worker wasm check.

Remaining boundary: this completes the session-auth slice for dashboard video
media links, not full video artifact ownership. Credentialed provider refetch,
R2 retention policy, provider replay fixtures, Sora remix provider/billing
replay, and async task billing settlement evidence remain required before G7
video cutover.

### 22.44 2026-07-05 OpenAI Video Sora Remix Submit Slice

This increment replaces the explicit `POST /v1/videos/:video_id/remix` 501
boundary with the first Worker-owned Sora/OpenAI remix submit path. Source Go
uses `ResolveOriginTask` before task submit: it owner-scopes the public origin
task id, locks the request to the origin task's channel, and submits remix
through the Sora adaptor.

Implemented in Rust:

- `/v1/videos/:video_id/remix` is now an async Worker route with the same token
  authentication class as the Go video submit group.
- The route loads the origin task by authenticated user id and public task id,
  rejects missing origin tasks, and reads the stored upstream task id from
  `private_data.upstream_task_id`.
- The route locks channel selection to the origin task's enabled channel via a
  new D1 repository helper returning the existing relay-channel shape.
- Only Sora/OpenAI channel types are accepted for this OpenAI-compatible remix
  slice; other provider remix semantics remain explicit future work.
- The submit context uses action `remixGenerate`, so the existing Sora submit
  URL builder posts to `{base}/v1/videos/{upstream_origin_id}/remix`.
- Remix billing precharge derives Go-compatible old-style ratios from origin
  task data: `seconds` defaults to 4 and large `size` values
  `1792x1024`/`1024x1792` apply the `1.666667` multiplier.
- The success response returns the same Rust OpenAI video queued shell as
  `POST /v1/videos`, while the inserted task keeps `action=remixGenerate` for
  downstream polling/status.

Updated local evidence:

- `cargo fmt --all`: passed;
- `cargo test -p cinatoken-worker --lib task_orchestration::tests::remix_`: 2
  passed, covering origin-model precedence and origin-data remix billing
  ratios.
- `cargo test -p cinatoken-worker --lib task_orchestration::tests::`: 19
  passed;
- `cargo test -p cinatoken-worker --lib`: 372 passed;
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed;
- `bun run check`: passed, including frontend type/build, route-debt audit,
  `cargo fmt --all --check`, Rust workspace tests excluding the Worker, and
  Worker wasm check.

Remaining boundary: this is submit-path ownership, not provider replay proof or
full artifact ownership. Live/provider replay, final async-task settlement
shadow evidence, credentialed artifact refetch, and Queue/R2 retention still
gate G7 cutover.

### 22.45 2026-07-05 Kling Official Video Route Aliases

This increment ports the Go `router/video-router.go` Kling official route
surface into the Worker task orchestration path without adding a second task
pipeline. Source Go uses `middleware.KlingRequestConvert()` to wrap the
official Kling request body into the unified task submit shape before token
auth, channel distribution, provider submit, and task persistence.

Implemented in Rust:

- Added Worker-owned `POST /kling/v1/videos/text2video` and
  `POST /kling/v1/videos/image2video` submit routes.
- Added owner-scoped fetch aliases for
  `GET /kling/v1/videos/text2video/:task_id` and
  `GET /kling/v1/videos/image2video/:task_id`, reusing the existing TaskDto
  fetch path.
- Added a Kling official-body converter that maps `model_name` (falling back
  to `model`) and `prompt` into the unified task request while preserving the
  original official body under `metadata` for provider-specific fields such as
  `image`, `negative_prompt`, `camera_control`, and `image_tail`.
- The official submit routes force Go-compatible action selection:
  `textGenerate` for text2video and `generate` for image2video. Generic Kling
  task submits now also derive `textGenerate` when no top-level/metadata image
  or `image_tail` is present, so submit and poll URLs stay aligned with the
  Kling provider URL builder.
- The Kling official submit response uses the existing OpenAI video `queued`
  shell, matching the Go Kling adaptor's client-facing submit behavior while
  keeping the inserted task in the unified D1 `tasks` table.
- The shared video submit core was refactored so legacy
  `/v1/video/generations`, OpenAI `/v1/videos`, and Kling official aliases all
  reuse the same token auth, channel selection, quota reservation, upstream
  submit, and D1 insert flow.

Updated local evidence:

- `cargo fmt --all`: passed;
- `cargo test -p cinatoken-worker --lib task_orchestration::tests::kling_`: 2
  passed, covering official body conversion and Kling text/image action
  selection;
- `cargo test -p cinatoken-worker --lib task_orchestration::tests::`: 21
  passed;
- `cargo test -p cinatoken-worker --lib`: 374 passed;
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed;
- `bun run check`: passed, including frontend type/build, route-debt audit,
  `cargo fmt --all --check`, Rust workspace tests excluding the Worker, and
  Worker wasm check. The route audit reported 214 frontend Worker-facing
  routes, 302 Worker routes, 0 missing calls, categories `{}`, and SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

Remaining boundary: this is official-route ownership, not full provider replay
or artifact ownership. Live Kling text/image submit replay, stored task status
conversion replay, async settlement evidence, Jimeng official route ownership,
and Queue/R2 artifact retention remain G7 gates.

### 22.46 2026-07-05 Jimeng Official Video Route Aliases

This increment ports the Go `router/video-router.go` Jimeng official route
surface into the Worker task orchestration path. Source Go mounts `/jimeng`
with `middleware.JimengRequestConvert()`, token auth, channel distribution, and
the shared task relay. The converter requires a non-empty `Action` query
parameter, wraps official submit bodies into the unified video-generation
shape, and maps `CVSync2AsyncGetResult` bodies containing `task_id` to the
task fetch path.

Implemented in Rust:

- Added Worker-owned `POST /jimeng/` and `POST /jimeng` route aliases.
- Added Go-compatible `Action` handling: missing/empty `Action` returns a
  client error, `CVSync2AsyncGetResult` reads body `task_id` and reuses the
  existing owner-scoped TaskDto fetch path, while other non-empty actions use
  the submit path.
- Added a Jimeng official-body converter that maps `req_key` and `prompt` into
  the unified task request while preserving the original official body under
  `metadata`.
- Matched the Go image rule for submit action selection: a missing or empty
  `image` field uses `textGenerate`; a non-empty `image` field uses
  `generate`.
- Ported the Jimeng submit-response parser so provider `code == 10000` returns
  `data.task_id`, while non-success responses surface the upstream message
  instead of falling through to the unported-provider path.
- Marked `/jimeng` and `/jimeng/` as Worker router paths in the static-asset
  split so official Jimeng aliases are never served by the frontend fallback.

Updated local evidence:

- `cargo fmt --all`: passed;
- `cargo test -p cinatoken-tasks jimeng --lib`: 9 passed, covering Jimeng
  request signing, status parsing, and the newly ported submit parser;
- `cargo test -p cinatoken-worker --lib task_orchestration::tests::jimeng_`:
  3 passed, covering official body conversion, fetch body validation, and
  Go-compatible image/action selection;
- `cargo test -p cinatoken-worker --lib tests::static_asset_path_routes_api_paths_to_router`:
  passed, covering `/jimeng` and `/jimeng/` router ownership;
- `cargo test -p cinatoken-worker --lib task_orchestration::tests::`: 24
  passed;
- `cargo test -p cinatoken-worker --lib`: 377 passed;
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed;
- `bun run check`: passed, including frontend type/build, route-debt audit,
  `cargo fmt --all --check`, Rust workspace tests excluding the Worker, and
  Worker wasm check. The route audit reported 214 frontend Worker-facing
  routes, 304 Worker routes, 0 missing calls, categories `{}`, and SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

Remaining boundary: this is official-route ownership, not full provider replay
or artifact ownership. Live Jimeng text/image submit/fetch replay, stored task
status conversion replay, async settlement evidence, and Queue/R2 artifact
retention remain G7 gates.

### 22.47 2026-07-05 Legacy Engines Embeddings Alias

This increment closes the Go route parity gap for
`POST /v1/engines/:model/embeddings`. Source Go registers the route in
`router/relay-router.go`; even though the route is mounted with the legacy
Gemini relay format, `Path2RelayMode` and distributor model extraction both
treat paths ending in `embeddings` as embeddings mode and fall back to
`c.Param("model")` when the JSON body omits `model`.

Implemented in Rust:

- Replaced the previous structured 501 placeholder for
  `/v1/engines/:model/embeddings` with a Worker-owned bounded JSON relay path.
- Reused the existing `/v1/embeddings` OpenAI-compatible relay core, response
  limits, auth, channel selection, model mapping, usage parsing, audit logging,
  and billing flow instead of adding a second embeddings pipeline.
- Added a narrow JSON body fallback that injects the path `:model` only when
  the request body has a missing or blank `model`, preserving explicit body
  models.
- Kept the alias on `upstream_path = "embeddings"` so upstream URL generation,
  embeddings response limits, and request transforms stay identical to
  `/v1/embeddings`.
- Added static-asset routing coverage for
  `/v1/engines/text-embedding-3-small/embeddings`.

Updated local evidence:

- `cargo fmt --all`: passed;
- `cargo test -p cinatoken-worker --lib json_model_fallback`: passed,
  covering path-model fallback insertion and non-overwrite behavior;
- `cargo test -p cinatoken-worker --lib static_asset_path_routes_api_paths_to_router`:
  passed, covering the legacy engines alias router ownership.
- `cargo test -p cinatoken-worker --lib`: 378 passed;
- `cargo check -p cinatoken-worker --target wasm32-unknown-unknown`: passed;
- `bun run check`: passed, including frontend type/build, route-debt audit,
  `cargo fmt --all --check`, Rust workspace tests excluding the Worker, and
  Worker wasm check. The route audit reported 214 frontend Worker-facing
  routes, 304 Worker routes, 0 missing calls, categories `{}`, and SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

Remaining boundary: this is route compatibility and bounded relay ownership,
not live embeddings upstream proof. Live legacy-engine embeddings smoke,
provider-specific embeddings adapters, batch-size checks, and billing shadow
evidence remain G3/G4 gates.

### 22.48 2026-07-05 Frontend Bundle Redaction Audit

This increment closes the first local frontend bundle-redaction evidence gap in
the production readiness matrix. The original Go/VPS deployment serves the
compiled React frontend from the VPS process; the Rust/Cloudflare migration
serves static assets through Worker Static Assets, so the production gate needs
an executable check that the shipped bundle contains only public configuration.

Implemented in Rust migration tooling:

- Added `tools/audit_frontend_bundle_redaction.mjs`, a Bun/Node script that
  scans built frontend text assets in `apps/web/source/default/dist` and
  `apps/web/dist`.
- The scanner covers high-confidence leakage classes: PEM private keys,
  OpenAI/Anthropic/xAI-style secret keys, Stripe secret or webhook keys,
  GitHub/GitLab/Hugging Face/Google API tokens, literal bearer tokens, and
  credential-bearing URLs.
- Findings are reported with file, line, column, pattern id, and a redacted
  match/snippet so verification logs do not echo the full candidate secret.
- Optional absent dist roots are ignored, but at least one frontend dist root
  must exist; this keeps the check compatible with local builds while still
  failing if no bundle was produced.
- Root package scripts now expose `bun run audit:web:bundle` for manual
  inspection and `bun run check:web:bundle` for failure-on-findings mode.
- The main `bun run check` chain now runs the bundle redaction audit after
  frontend type/build and before the frontend route audit.

Updated local evidence:

- `bun run check:web:bundle`: passed, scanning 460 files / 37,280,170 bytes in
  `apps/web/source/default/dist` and `apps/web/dist`, with 0 findings.
- `bun run check`: passed, including frontend type/build, bundle redaction
  audit, route-debt audit, `cargo fmt --all --check`, Rust workspace tests
  excluding the Worker, and Worker wasm check. The route audit reported 214
  frontend Worker-facing routes, 304 Worker routes, 0 missing calls,
  categories `{}`, and SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

Remaining boundary: this is local built-bundle redaction evidence, not full G5
sign-off. CI retention, explicit allowlist documentation if benign findings are
ever introduced, staging artifact/hash evidence, lint debt closure,
bundle-size budget enforcement, and deployed browser smoke remain required
before production frontend cutover.

### 22.49 2026-07-05 Frontend Bundle-Size Budget Gate

This increment turns the G5 frontend bundle-size budget from a planning note
into an executable check. The goal is not to claim that the imported React
frontend is already optimized; it is to stop unnoticed growth while the
Go/VPS-hosted frontend is being moved to Worker Static Assets and while heavy
route-specific chunks are split in later performance work.

Implemented in Rust migration tooling:

- Added `tools/frontend_bundle_budget.json` with explicit raw and gzip budgets
  for the canonical build output in `apps/web/source/default/dist`.
- Added `tools/audit_frontend_bundle_budget.mjs`, a Bun/Node script that scans
  all built static assets, calculates gzip size with deterministic Node gzip,
  groups total, JavaScript, CSS, initial JavaScript, and largest JavaScript
  chunk metrics, and reports budget failures without mutating the bundle.
- Root package scripts now expose `bun run audit:web:bundle-budget` for manual
  inspection and `bun run check:web:bundle-budget` for fail-on-budget mode.
- The main `bun run check` chain now runs the budget gate after frontend
  type/build and bundle redaction, before the frontend route audit.
- `docs/frontend-deploy.md` now records the budget command, current measured
  output, and the explicit caveat that this is a ratchet gate rather than full
  performance approval.

Updated local evidence:

- `bun run check:web:bundle-budget`: passed, scanning 245 files in
  `apps/web/source/default/dist`: 18.94 MB raw / 4.49 MB gzip total,
  18.25 MB raw / 4.14 MB gzip JavaScript, 4.29 MB raw / 1.23 MB gzip initial
  JavaScript, and 5.28 MB raw / 1.00 MB gzip for the largest JavaScript chunk;
  all 10 configured budgets passed.
- `bun run check`: passed, including frontend type/build, bundle redaction
  audit, bundle budget audit, route-debt audit, `cargo fmt --all --check`,
  Rust workspace tests excluding the Worker, and Worker wasm check.
- `bun run check:web:routes`: passed with 214 frontend Worker-facing routes,
  304 Worker routes, 0 missing calls, categories `{}`, and SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

Remaining boundary: this closes the missing executable bundle-budget gate, not
the broader frontend performance gate. Strict lint cleanup, heavy
route-specific chunk splitting, deployed desktop/mobile browser smoke, staging
artifact/hash evidence, and performance/capacity report evidence remain
required before production frontend cutover.

### 22.50 2026-07-05 Frontend Lint Debt No-Regression Gate

This increment turns the imported frontend strict-lint debt into an executable
no-regression gate. The React source still needs real cleanup before G5 can pass
with zero lint debt, but the migration now prevents new ESLint debt while the
larger React Hooks/React Compiler fixes are paid down in safer batches.

Implemented in the Rust migration repository:

- Removed one stale `react-hooks/set-state-in-effect` disable comment from
  `use-debounced-column-filter.ts`; the warning was no longer suppressing an
  active diagnostic.
- Added `tools/frontend_lint_debt_baseline.json`, capturing the initial
  imported frontend ESLint baseline: 101 errors, 3 warnings, 69 files with
  findings, and per-rule counts.
- Added `tools/audit_frontend_lint_debt.mjs`, which runs the default frontend
  ESLint config through JSON output and fails only when total counts, affected
  file count, or any rule-family count exceeds the baseline.
- Root package scripts now expose `bun run audit:web:lint-debt` for manual
  inspection and `bun run check:web:lint-debt` for fail-on-regression mode.
- The main `bun run check` chain now runs the lint-debt gate after frontend
  type/build, bundle redaction, and bundle budget checks.

Updated local evidence:

- `bun run check:web:lint-debt`: passed with 101 errors, 3 warnings, 69 files
  with findings, and 0 regressions against
  `tools/frontend_lint_debt_baseline.json`.
- `bun run format:check` in `apps/web/source/default`: passed.
- `bun run check`: passed, including frontend type/build, bundle redaction
  audit, bundle budget audit, lint-debt baseline, route-debt audit,
  `cargo fmt --all --check`, Rust workspace tests excluding the Worker, and
  Worker wasm check.

Remaining boundary: this does not make `bun run check:web:quality` green. The
largest remaining rule family is `react-hooks/set-state-in-effect`; strict
lint cleanup must continue by fixing React state/effect patterns and lowering
the baseline after each verified batch.

### 22.51 2026-07-05 Frontend Static Component Lint Paydown

This increment starts paying down the strict lint baseline rather than only
tracking it. The first target was the highest single-file frontend lint hotspot,
`apps/web/source/default/src/features/usage-logs/components/dialogs/user-info-dialog.tsx`.

Implemented in the imported React frontend:

- Hoisted the render-local `InfoItem` component to module scope, following the
  React performance rule that components should not be created during render.
- Preserved the existing user-info dialog markup and translated labels; callers
  now pass the same `label` and `value` props to a stable component type.
- Lowered `tools/frontend_lint_debt_baseline.json` from 101 errors / 3 warnings
  to 92 errors / 3 warnings, and removed the `react-hooks/static-components`
  allowance because that rule family is now at zero.

Updated local evidence:

- File-scoped ESLint for `user-info-dialog.tsx`: reduced from 10 errors to 1
  remaining `react-hooks/set-state-in-effect` error.
- `bun run check:web:lint-debt`: passed with 92 errors, 3 warnings, 69 files
  with findings, and 0 regressions.

Remaining boundary: strict lint is still not green. The next high-value
paydown batches should target `react-hooks/set-state-in-effect` and
`react-hooks/refs` in small UI-owned slices, lowering the baseline after each
verified batch.

### 22.52 2026-07-05 Frontend Ollama Dialog Lint Paydown

This increment continues turning G5 frontend lint cleanup into verified,
incremental migration progress. The target was the default frontend Ollama
models management dialog because it had a compact cluster of React Hooks /
React Compiler diagnostics in one operator-owned surface.

Implemented in the imported React frontend:

- Moved the `fetchOllamaModels` callback before the effect that schedules it,
  removing the stale "accessed before declared" diagnostic without weakening
  lint rules.
- Replaced the open-triggered synchronous effect call with a microtask
  scheduled fetch guarded by effect cleanup, so the dialog still fetches models
  when opened but avoids a synchronous state update cascade from the effect
  body.
- Centralized close cleanup for local model list, selection, search, pull name,
  pull progress, and abort controller state in the dialog close path.
- Lowered `tools/frontend_lint_debt_baseline.json` from 92 errors / 3 warnings
  / 69 files to 89 errors / 3 warnings / 68 files. The rule-family deltas are:
  `react-hooks/set-state-in-effect` 64 -> 63,
  `react-hooks/immutability` 6 -> 5, and
  `react-hooks/preserve-manual-memoization` 2 -> 1.

Updated local evidence:

- File-scoped ESLint for
  `apps/web/source/default/src/features/channels/components/dialogs/ollama-models-dialog.tsx`:
  passed with no findings.
- `bun run audit:web:lint-debt`: passed with 89 errors, 3 warnings, 68 files
  with findings, and 0 regressions.
- `bun run check`: passed, including frontend type/build, bundle redaction
  audit (460 files / 37,280,201 bytes, 0 findings), bundle budget audit,
  lint-debt baseline, route-debt audit, `cargo fmt --all --check`, Rust
  workspace tests excluding the Worker, and Worker wasm check. The Worker
  check still reports the existing `d1_repositories.rs` dead-code warnings.

Remaining boundary: strict lint is still not green, and this does not replace
deployed browser smoke for the Ollama admin flow. Continue with small
React-owned batches and lower the baseline only after each batch is verified.

### 22.53 2026-07-05 Frontend Mobile Table Lint Paydown

This increment continues the G5 frontend strict-lint cleanup in a shared but
low-risk UI primitive: the mobile table list renderer used by imported admin
tables. The target was the last `react-hooks/use-memo` rule family debt.

Implemented in the imported React frontend:

- Removed two `useMemo` wrappers in
  `apps/web/source/default/src/components/data-table/layout/mobile-card-list.tsx`
  whose dependency arrays contained computed `map(...).join(...)` expressions.
- Derived the per-cell column metadata directly during render in both compact
  and fallback mobile row renderers. This preserves the same visible rows while
  avoiding non-simple Hook dependency arrays and deleting the paired
  `react-hooks/exhaustive-deps` disable comments.
- Lowered `tools/frontend_lint_debt_baseline.json` from 89 errors / 3 warnings
  / 68 files to 87 errors / 3 warnings / 67 files, and removed the
  `react-hooks/use-memo` allowance because that rule family is now at zero.

Updated local evidence:

- File-scoped ESLint for
  `apps/web/source/default/src/components/data-table/layout/mobile-card-list.tsx`:
  passed with no findings.
- `bun run typecheck` in `apps/web/source/default`: passed.
- `bun run audit:web:lint-debt`: passed with 87 errors, 3 warnings, 67 files
  with findings, and 0 regressions.
- `bun run check`: passed, including frontend type/build, bundle redaction
  audit (460 files / 37,280,117 bytes, 0 findings), bundle budget audit,
  lint-debt baseline, route-debt audit, `cargo fmt --all --check`, Rust
  workspace tests excluding the Worker, and Worker wasm check. The Worker
  check still reports the existing `d1_repositories.rs` dead-code warnings.

Remaining boundary: strict lint is still not green. The largest remaining
family is still `react-hooks/set-state-in-effect`, followed by `react-hooks/refs`.
Continue reducing these in small UI-owned batches before G5 production cutover.
