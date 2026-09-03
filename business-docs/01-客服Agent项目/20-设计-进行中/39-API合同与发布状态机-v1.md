# 39 · API 合同与发布状态机 v1

> **状态：** DESIGN ALIGNED · PENDING G0 / Ddev · 2026-08-21 · **v1.16 ENG-T1 合同冲突修正**\
> **权威：** 服从 [`37-架构SSOT-v1.md`](37-架构SSOT-v1.md) · NFR [`41`](41-NFR扩展并发与防改崩.md)\
> **机器合同：** [`openapi.v1.yaml`](openapi.v1.yaml) 是 HTTP 路径、schema、状态码与 error enum 的优先真源；本文是人读语义、事务、权限与不变量补充\
> **范围：** 一期最小端口语义 + 发布状态机；不得再将本文声称为“等价 OpenAPI”\
> **实现语言：** TypeScript / Node Application API\
> **CR-004 机器边界：** 本文人读事务/失败语义与 33/`openapi.v1.yaml` 静态机器合同由同一 CR-004 changeset 对齐；迁移、生成类型、服务端/客户端代码与动态运行证据仍未实现。因此四域来源绑定、永久暂停、拒绝审计与离线租约不得被描述为运行时已拦截。
> **DEC-042 边界 / ENG-T1 修正：** 稳定 Question 身份/版本、显式 scope、taxonomy、风险审核、占位符与质量门的人读事务合同，以及 ACK 来源/租约拒绝独立审计与 public request closed schema，当前 DEV-M1 合同增量已对齐 schema v1.13（SHA-256 `de8b7d9bdcac4ecad844025a47228ba339dad47d61861d261c492cb16a1aea02`）/ OpenAPI 1.11.0（SHA-256 `06698f233702591c8f981c7b08ebac4b7d5bc5cc2d69d36014ef2a9f5a6802e4`）。v1.13 仅扩展 scope-only 搜索函数的安全返回投影；产品仓必须绑定最终提交 SHA 后再 intake，且不得仅凭治理合同宣称迁移、搜索 runtime 或动态测试可用。

`37` 决定产品红线；`openapi.v1.yaml` 决定线上 wire shape；本文决定机器 schema 难以表达的顺序、事务和强制语义。三者冲突时停止对应路由，同一 PR 修正后才可继续；禁止在运行时实现中自行选一份。

**术语硬门：** 业务“工单分析”统一使用 `/v1/work-orders/*` 与 `work_order_*`；内部“话术优化待办”统一使用 `/v1/metrics/iteration-tasks`、`/v1/events/iteration-tasks/*` 与 `iteration_task*`。CR-002 运行事实只包含 query、candidate impression、唯一 adoption terminal 与非终态 escalation action；修改、是否发送、是否正确只在批准试点样本里离线人工复核并单独统计。各域不得 JOIN/复制原始明细，禁止 `/tickets`、`iteration_ticket*`。这些证据**不是聊天记录**，也不存最终发送正文。

**CR-004 术语门：** `import_batches.source_ref` 是上传对象或受信上游对象的定位符；`scripts.source_ref` / `release_items.source_ref` 是由服务端绑定的内容来源血缘。两者同名但语义不同，代码与审计必须使用全限定名，禁止把上传文件中的同名列当权威。canonical/current 不存为来源版本上的可变状态，只从 `content_current` 所指 release 的四域不可变、`use_class=canonical` bindings 推导；未登记或 `reference` 来源不可发布/检索。

---

## 0. 公共约定

| 项 | 合同 |
|----|------|
| 传输 | 生产客户端→入口→API 全程 **HTTPS JSON**；内网不豁免 TLS，mTLS 可作额外身份层但不得“后补”传输加密；仅 loopback development/test 可 HTTP |
| 鉴权 | 生产：`Authorization: Bearer <feishu_session>`；开发：`X-Mock-User` + `X-Mock-Role`（**必须日志标注 MOCK**）；端用户角色只取服务端验签后的 claims，禁止取业务请求体 |
| 错误体 | `{ "error": { "code": string, "message": string, "details"?: object } }` |
| 幂等 | 写接口支持 `Idempotency-Key` header；同 scope/key/body 重放首次**终态**结果；同键异体 409 |
| 版本 | URL 前缀 `/v1` |
| 时间 | ISO-8601 UTC |

**错误码（共用）：** `UNAUTHORIZED` · `FORBIDDEN` · `VALIDATION` · `NOT_FOUND` · `CONFLICT` · `POLICY_DENIED` · `RATE_LIMITED` · `OVERLOADED` · `INTERNAL`

### 0.1 限流与背压（设计默认 · 可配置 · 见 41 §2）

| 路由 | 默认 |
|------|------|
| `POST /v1/search` | 30/min/user；一期负载边界为 ≤150 坐席、300 QPS 短突发测试目标；500/s 是保护上限，**不是已认证吞吐** |
| `POST /v1/events/*` | 60/min/user |
| `POST /v1/work-orders/imports` | 5/min/user；coach / owner；文件大小与批次配额另由安全 / 容量门冻结 |
| `GET /v1/work-orders/*` | 20/min/user；coach / owner；分析时间窗默认 ≤31d |
| `POST /v1/content/publish` | 5/min/owner；**全站单飞**（第二并发 → **409 CONFLICT** 快速失败） |
| `GET /v1/metrics/*` | 20/min/user；查询窗默认 ≤7d |
| `GET /v1/announce/snapshot` | 10/min/client |
| 超限 | **429** `RATE_LIMITED` + `Retry-After` |
| 池等待 >200ms 或 search 并发槽满（默认 64/实例） | **503** `OVERLOADED` + `Retry-After: 1` |

**跨实例限流协议（冻结）：**

| 项 | 合同 |
|----|------|
| 存储 | Postgres `rate_limit_buckets` + 函数 `rate_limit_take`（33）；可用 Redis 等价实现，**键与参数必须相同** |
| 键 | 用户：`user:{user_id}:{route}`；search 近似全局：`global:{route}:{shard_00..15}`；publish 低频单飞：`global:{route}` |
| 算法 | 令牌桶；`rate_limit_take(key, capacity, refill_per_sec, cost=1)` 原子 |
| search 用户桶 | capacity=30, refill=0.5/s（≈30/min） |
| search 全站桶 | 16 分片：`digest=SHA-256(UTF-8(user_id))`，取 `digest[0..3]` 为无符号 big-endian uint32，`shard=uint32%16`；禁止语言内置/randomized hash。金标：`u1→13`、`u-agent-001→2`、`用户A→1`。每分片 capacity=32, refill=31.25/s，合计近似 500/s；允许因倾斜早限流，不得伪装精确全局能力 |
| publish 全站 | capacity=5, refill=5/60 /s；**另** `pg_try_advisory_xact_lock` 单飞 |
| Retry-After | `ceil((cost - tokens) / refill_per_sec)` 秒，最少 1 |
| 存储故障 | 限流存储不可用 → **fail-open 仅 dev**；生产 **fail-closed 503 OVERLOADED**（配置 `RATE_LIMIT_FAIL_CLOSED=true` 默认生产） |
| 多桶顺序 | **同事务**内先 `user:*` 再 `global:*`；任一步 `allowed=false` → 整笔回滚（不扣另一桶）并 429 |
| Retry-After | 使用 `rate_limit_take` 返回的 `retry_after_sec`（deny 时 ≥1） |
| publish 顺序 | ① **先查终态幂等记录并直接 replay（不扣限流）** ② 未命中才在独立短事务内 user→global `rate_limit_take` ③ 同一业务事务内 claim→`publish_content_release`→complete；锁失败 409，已扣限流不退 |

**DEC-CAP-01（实现/扩容门）：** 16 分片是一期 PostgreSQL 内的有界近似算法，不等于精确全局计数。任一条件成立就必须转公司网关/Redis 等原子限流实现并重跑压测：坐席 >150；目标突发 >300 QPS；限流行锁等待 p95 >10ms 持续 5min；因分片倾斜产生不可接受的误限流。未完成对应压测，不得声称 300/500 QPS 已认证。

### 0.5 DB 异常 → HTTP 映射（冻结）

| SQLSTATE | HTTP | error.code |
|----------|------|------------|
| `ZA001` | 400 | `VALIDATION` |
| `ZA002` | 404 | `NOT_FOUND` |
| `ZA003` | 409 | `CONFLICT` |
| `ZA004` | 403 | `POLICY_DENIED` |
| `ZA005` | 403 | `FORBIDDEN` |
| `ZA006` | 409 | `CONFLICT` |
| 限流 `allowed=false` | 429 | `RATE_LIMITED` |
| 池/槽过载 | 503 | `OVERLOADED` |
| 其它 | 500 | `INTERNAL` |

DB 函数必须用 `RAISE ... USING ERRCODE='<上表>', DETAIL='<allowlisted reason 或 JSON>'`；`DETAIL` 仅允许 reason token，或含 `reason`、受控实体 ID 与重试信息的 JSON，不得含 SQL、路径、token 或 PII。API 只按 SQLSTATE 决定稳定顶层 `error.code`，再将经 allowlist/schema 验证的 DETAIL 放入 `error.details.reason`；**禁止解析 DB `MESSAGE` 文案或前缀**。`ZA005` 的 `INV_BYPASS`与 `ZA006` 的 `OUTBOX_LEASE_LOST|IDEMPOTENCY_LEASE_LOST` 都不发明新顶层 code。在 33 迁移与负测完成前，相关业务路由不得注册。

**503 合同不得漏声明：** 任一需要 DB 池、共享限流存储或内容存储的路由都必须在 OpenAPI 显式声明 503 `OVERLOADED` + `Retry-After`；不得只在本节用文字统一映射。

### 0.2 幂等状态机（跨实例 · 见 33）

- 写接口（至少 `publish`、`rollback`、`adoption`、`escalate`、`notices/{version}/decision`、内容 `import` / `cancel`、工单 `imports`、话术优化待办 `start` / `close`、`policy flags`）**必须**带 `Idempotency-Key`；`search` 以 `query_id` 充当幂等键。`announce ack` 依赖 DB 单调游标实现业务幂等，header 可选；提供时仍走共用幂等状态机
- `scope` = `"{METHOD} {path}:{user_id}"`（例 `POST /v1/content/publish:u1`）
- `request_hash` 是带版本的摘要：不含原始 PII 的端口用 `sha256(utf8(canonical_json(body)))` 且 `request_hash_key_version=sha256-jcs-v1`；会携带原始客户话术的 search 必须用 `HMAC-SHA256(idempotency_secret, key_version || "\0" || canonical_json(raw_body))` 且同存 key version。原始 body 不落库、不进日志。\
  **canonical_json（冻结 = RFC 8785 JCS 子集）：**
  1. UTF-8；对象键按字典序排序\
  2. 无多余空白；数组保序\
  3. 数字用 JSON 最短十进制，禁止 `1.0`/`1e1` 混用——统一 JS `JSON.stringify` 经 `canonicalize` 库或等价 JCS\
  4. `null` 保留；禁止 `NaN`/`Infinity`\
  5. 参考向量：`{"b":1,"a":2}` → 规范串 `{"a":2,"b":1}` → SHA-256 `d3626ac30a87e6f7a6428233b3c68299976865fa5508e4267c5415c76af7a772`，实现以单元测试钉死
- **换钥 + replay：** API 先通过 `idempotency_request_hash_version(scope,key,user)` 取 TTL 内已存版本；search 对该版本保留旧 HMAC key 至少 `IDEMPOTENCY_TTL_HOURS`，以同一版本重算后再 lookup。不得因日常换钥把同请求误判为异体。\
- **原子 claim（禁止自写竞态）：** 调用 `idempotency_claim(scope,key,user,hash,request_hash_key_version,instance_id,lease_seconds)`，返回 `lease_version`\
  - `proceed` → 执行业务 → `idempotency_complete(..., instance_id, lease_version, ok=true/false)`\
  - `replay` → 直接返回 `status_code`+`response_body`\
  - `conflict` + detail `IDEMPOTENCY_IN_FLIGHT|IDEMPOTENCY_BODY_MISMATCH` → **409**
- **同步 DB 写冻结：** claim、业务 DML、complete 必须在**同一个 DB 事务**；事务回滚时三者一起回滚，禁止 claim 单独提交后再做同步业务。
- **跨事务/异步冻结：** 仅 import 校验、search 外部 ranker 等确需跨事务时使用 lease；worker 必须 heartbeat，complete 必须同时匹配 `lease_owner + lease_version`，迟到 worker 收到 `IDEMPOTENCY_LEASE_LOST` 后不得覆盖结果或继续副作用。
- `idempotency_lookup` 对已过期/空 pending lease 必须返回 `miss + lease_reclaimable`，使后续 claim 递增 fencing token；只有未过期 lease 才返回 `IDEMPOTENCY_IN_FLIGHT`，禁止崩溃后一直卡到 TTL。
- 默认 lease=60s（必须大于 publish 30s statement timeout，并给网络/提交留余量）；TTL ≥24h。`expires_at` 到期前 key 不可换 body；到期后才可重用。
- `failed` 是已落库的终态错误并照样 replay；不希望缓存的瞬态 429/503 **不得调用 complete**。终态 replay 检查先于限流；未命中才扣桶。
- `adoption` 与 query_id PK：**先** idempotency 层，**再**业务约束；PK 冲突且 idem 已终态以 idem 回放为准。

### 0.6 Platform 健康合同（不计入九业务端口）

### `GET /health`
- 无鉴权、无 DB/外部依赖；仅证明进程 event loop 存活。
- 200: `{ "status":"ok", "service":"cs-ai-api", "version":"<build_version>" }`；非 200 交由编排器重启，不泄露环境变量或依赖细节。

### `GET /ready`
- 无鉴权但响应不得含密钥/DSN；检查 DB 最小查询、必要 schema/migration version、生产 auth 配置、import storage 写入+按 key/hash/size 重读完整性探测与 `content_current` 首发就绪。可选 ranker 失败不得拉低 readiness。
- 200: `{ "status":"ready", "checks": { "database":"ok", "schema":"ok", "auth":"ok", "storage":"ok", "content":"ok" } }`。
- 503: `{ "status":"not_ready", "checks": { ... } }` + `Retry-After: 1`；check 值只能是 `ok|not_ready`，禁止返回异常文本。首次 owner publish 前 `content=not_ready`。

### 0.3 API 演进

- **生效起点：** 首个签名 Pilot 客户端建立版本 `N`；首个版本发布前只有当前 DEV build，不得虚构 `N-1` 生产兼容证据。从第二个签名客户端版本起，服务端 `/v1` 必须同时支持当前 `N` 与上一签名版本 `N-1`。
- **最短支持窗：** `N-1` 自 `N` 发布日起至少保留 **90 个自然日**，且只有“受管客户端清单连续 30 日无活跃 `N-1` + 已签名回滚窗口结束”后才可退出，取较晚者。可延长；缩短必须另开 ADR，并由 Tech Owner + Ops Owner 签发。
- **`/v1` 可加性边界：** 只允许新增可选请求/响应字段（请求字段必须有服务端默认）、只读路由或向后兼容的 `error.details`；客户端必须忽略未知 JSON 字段。新增顶层 error code / enum 值只有在 `N`、`N-1` 都有 unknown-safe fallback 的合同测试时才允许，否则走 `/v2`。
- **必须走 `/v2`：** 删除/改名/改类型、增加必填请求字段、改变既有字段/枚举/default 的语义、放宽鉴权/权限、增加既有写路由副作用，或改变 SoR/自动发送边界。禁止在 `/v1` 静默复用旧字段表达新含义。
- **弃用顺序：** 先在版本说明与客户端升级提示中公告，再覆盖 `N/N-1` 合同夹具；支持窗内旧字段/旧行为保持可用。满足退出条件后只在下一 major 删除，禁止同一版本“公告即删除”。
- 本节是版本治理合同。CR-004 所需静态 wire/schema 元素在同一 changeset 与 OpenAPI/33 对齐；它们仍须保持 `/v1` 可加性，新增请求字段必须有服务端安全默认。生成类型、`N/N-1` 夹具、迁移和代码未落地前不得注册路由或声称运行支持。

### 0.4 身份 claims（最小）

生产会话解析后必须得到：`{ "user_id": string, "role": "agent"|"coach"|"owner" }`。缺 role → **403 FORBIDDEN**。\
`AUTH_MODE` 是鉴权模式唯一真源：dev 可为 `mock`，prod 必须为 `feishu`。生产若 `AUTH_MODE=mock`、缺飞书验签配置、或仍注册 `/v1/auth/mock-login`，进程必须在监听端口前退出；不得用 DB flag 或热更新绕过。Mock 每请求日志含 `[AUTH_MOCK]`。

---

## 1. Port: `auth`

### `POST /v1/auth/mock-login`（仅非生产）
- Req: `{ "user_id": string, "role": "agent"|"coach"|"owner" }`
- Res 200: `{ "token": string, "user": { "user_id", "role" } }`

### `GET /v1/auth/me`
- Res 200: `{ "user_id", "role", "auth_mode": "feishu"|"mock" }`

---

## 1A. `auth` 端口子能力：`notices`（首次明确告知；不是第十端口）

### `GET /v1/notices/current`
- 角色：agent / coach / owner；返回唯一 `privacy_notices.status=current` 的 notice 与当前 token 用户决定。
- Res 200：`{ "notice": { "version", "content", "content_hash", "published_at" }, "decision":"accepted|declined|null", "decided_at":"iso|null" }`。
- `decision=null` 时客户端必须展示一次明确告知；页面浏览、安装或继续使用均不得推定为接受。没有 current notice → 404；notice 存储不可用时 `pilot_recorded` 搜索 fail-closed。

### `POST /v1/notices/{version}/decision`
- 角色：agent / coach / owner；header `Idempotency-Key`；Req：`{ "decision":"accepted|declined" }`。
- 只接受当前 notice version；`user_id` 只取 token。`notice_decisions` 对 `(version,user_id)` 一条且 app_runtime 无 UPDATE/DELETE 权限；同键同体重放首次 200，不同决定或不同 body → 409，不得覆盖首次证据。
- Res 200：`{ "ok":true, "version", "decision", "decided_at" }`。

---

## 2. Port: `search`

### `POST /v1/search`
- 角色：agent / coach / owner\
- 输入上限：所有 JSON 请求体在解码前限制为 **32 KiB**；`query_text` 按原始 Unicode code point 计 **1～500**，非空 `product_context_ref` **1～128**。任一超限返回 400 `VALIDATION`，不得进入 redaction、2-gram、HMAC 或 LLM。
- Req:
```json
{
  "query_id": "uuid",
  "parent_query_id": null,
  "interaction_reason": "original|reselection",
  "query_text": "客户原话",
  "collection_mode": "synthetic|approved_redacted|pilot_recorded",
  "detected_platform": "qianniu|douyin|unknown|null",
  "platform": "qianniu|douyin|unknown|null",
  "platform_source": "manual|foreground_process|native_integration|unknown",
  "product_context_type": "category|sku|null",
  "product_context_ref": "string|null",
  "top_k": 3
}
```
- 服务端行为（强制）:
  1. `query_id` = 本路由幂等键；`request_hash=HMAC-SHA256(idempotency_secret, key_version || "\0" || JCS({parent_query_id,interaction_reason,query_text,collection_mode,detected_platform,platform,platform_source,product_context_type,product_context_ref,top_k}))`，并同存 `request_hash_key_version`。计算只在受控内存中发生，原始 query 不落库/日志；不得用无密钥 SHA 代替。同 user/query_id/hash/version 的终态请求重放首次响应；同 query_id 异体 → 409 `CONFLICT` + `IDEMPOTENCY_BODY_MISMATCH`。
  2. `interaction_reason=original` 必须 `parent_query_id=null`；`reselection` 必须引用同一当前用户、已经存在唯一 adoption terminal 的父 query。每次重选创建新 query，禁止覆盖父行；DB guard 再保证父链无环且 lineage 字段 append-only。
  3. `platform` 是用户确认后的 canonical 值，可为 `unknown|null`；`detected_platform` 只记录本次触发时的候选。`platform_source=manual` 表示用户直接选择或修正；`foreground_process` 只做本次前台进程提示，仅当用户确认该提示后才可提交，且必须 `detected_platform=platform`。禁止全局剪贴板、键盘或聊天软件监控；用户修正提示时必须提交修正后的 `platform` 与 `platform_source=manual`。`platform_source=unknown` 时 `platform` 只能为 `unknown|null`。`native_integration` 是未来保留值：Phase 1 服务端未注册原生 adapter，客户端提交该值必须返回 403 `POLICY_DENIED` 且 query/impression/event **零写入**；客户端不得自行声明“原生已验证”。未来只有已批准 ADR + Scope + 平台权限/数据合同 + Security Owner 证据与服务端受信 adapter 同时成立时才能启用。
  4. `collection_mode=pilot_recorded` 时，服务端先校验当前 `privacy_notices.status=current` 且本用户 `notice_decisions.decision=accepted`；缺失、declined 或校验依赖不可用 → 403 `POLICY_DENIED` / 503，**fail-closed** 且不写事件。`synthetic|approved_redacted` 不得伪装 pilot 授权。
  5. 先执行 redaction 与 DLP；引擎失败 **fail-closed**：不落原文、不调 LLM、不写请求 body 日志，返回 500 `INTERNAL`（reason=`REDACTION_FAILED|DLP_FAILED`）。DLP 判定可检索但不可存文本时继续在受控内存检索，落 `text_storage_status=suppressed` 且 `query_text_redacted/query_text_hash=null`；普通通过时落 `stored` 且两字段非空。
  6. 读取 `content_current`；首次发布尚未完成时不存在 current release，返回 **503 `OVERLOADED`** + `details.reason=CONTENT_NOT_READY` + `Retry-After`，不调 ranker、不写 query/impression、不完成幂等终态。CR-004 运行实现必须在同一快照读取中证明该 release 恰好绑定 `presale/campaign/aftersale/product` 四个不可变来源版本，且四者均无永久暂停记录；缺失、重复、不匹配或已暂停一律按内容不就绪 fail-closed，禁止创建空 release 或直扫 `scripts` 伪造“已可用”。
  7. 正常遥测路径写 `query_events`：必须写 `parent_query_id/interaction_reason`、`collection_mode`、detected/confirmed platform、`platform_source`、`redaction_policy_version` 与配置生成的 `text_expires_at/event_expires_at`。成功响应、query_event、candidate_impressions、idem complete 在同一最终事务提交；跨 ranker 等待用 lease_version fencing。
  8. **仅 telemetry 写入故障的有界降级：** auth、DLP、当前内容快照与检索均健康时，可返回 `telemetry_status=collection_disabled` 的无状态搜索；不得写 `query_events`、`candidate_impressions`、adoption 或 escalate，不完成可持久 replay，且天然排除全部指标。DLP/Auth/content 任一失败不得走此降级。正常路径返回 `telemetry_status=recorded`。
  9. **Answer 单源与唯一 SQL 边界：** API / `app_runtime` 只能调用 SECURITY DEFINER 函数 `search_recommendable_scripts(platform, product_context_type, product_context_ref)`。该函数在同一 statement snapshot 内从 `content_current` → 四域不可变 bindings → 当前 `release_items` 复核来源、永久暂停、有效期与显式范围；`app_runtime` 对 `v_scripts_recommendable`、`release_items`、`content_current` 无直接 SELECT。**禁止**API 自拼 `WHERE`、直扫 `scripts`、读取 backing view、可变来源标记或旧离线 snapshot 旁路。
  10. **显式范围匹配：** `platform_scope` 必填非空且只允许 `qianniu/douyin`，两者全含才表示 both；请求 `platform=unknown|null` 时没有通用空 scope fallback，须先由用户确认平台。商品范围必须是 `product_scope_type=storewide|category|sku`：`storewide` 的 `product_scope_refs=[]`；`category/sku` 的 refs 必须非空。请求的 `product_context_type/product_context_ref` 必须成对出现或同时为 null；`category` 只命中同 ref 的 category scope，`sku` 只命中同 ref 的 sku scope，二者都为空时只命中 `storewide`。禁止 category/sku 跨类型猜测、空 `sku_scope` 解释为全部，以及 `NULL/[] platform_scope` 放行；该请求形状未进入同批机器合同时，category/sku-scoped 条目均不得放行。
  11. `policy.rewrite=false` 时 API 返回的 `answer_text` **字节级**等于该 `release_items.answer_text` 模板，并同时返回声明的 `placeholder_keys`。客户端只可在受控内存将 `{订单号}/{日期}` 按 `order_id/date` 确定性替换；缺必填值禁止复制并要求二次确认。值与渲染正文不得回传、落库或写日志，复制事件仍只绑定模板 `release_id/script_id/script_version/content_hash`。该四元组必须外键指向同一次 query release 的不可变 `release_items`。handler 只可用显式 public mapper 组装 OpenAPI 封闭白名单，禁止 DB row spread；审核主体/EVD、来源 query/HMAC/key version、晋级凭据、内部 locator 和 search 内部字段一律不出 wire。
  12. 正常遥测路径写 `candidate_impressions`（0–3 行）；`hit_status=hit` 当且仅当 ≥1 条；**禁止**垫假卡到 3。
  13. 在线召回主路固定为字符 bigram + normalize + exact/ILIKE 回退。可选 LLM ranker 只能通过默认关闭、可替换的 adapter 启用，timeout ≤400ms；失败/熔断 → **fallback bigram/规则序**，**不得** 5xx 整单（除非主路本身失败），也**不得**改 `answer_text`。`EmbeddingProvider` 仅允许离线影子评测，不注册在线 search 路径。
  14. 连接池耗尽/过载 → **503** 或 **429** 背压，不拖死进程。
  15. CR-004 **来源/离线租约 reason** 拒绝发生时，query/impression/正常幂等终态保持零写入；失败业务事务回滚后，以独立、幂等短事务追加最小 `source_denial_audit`，并在返回 HTTP denial 前提交。底层 writer 仅内部可达；runtime 包装函数只接受 import/search/current/snapshot，admin 包装函数只接受 publish/rollback/source suspend。内容合同、治理 hash、Question 身份或质量门拒绝走标准受控 change/error audit，禁止混写来源审计表。审计允许安全 `srcv_* source_version_id`，但不得包含 `source_ref`、raw query、answer、token、内部路径或任意上传原文；审计自身不可持久化时继续 fail-closed，不得返回正常 no-hit。
- Res 200:
```json
{
  "query_id": "uuid",
  "hit_status": "hit|no_hit",
  "release_id": "string",
  "source_binding_hash": "64-char-hex",
  "telemetry_status": "recorded|collection_disabled",
  "candidates": [
    {
      "rank": 1,
      "release_id": "string",
      "script_id": "string",
      "script_version": 1,
      "content_hash": "string",
      "title": "string",
      "category": "string",
      "answer_text": "库内模板原文，例如：您的订单{订单号}预计于{日期}更新",
      "platform_scope": ["qianniu"],
      "product_scope_type": "sku",
      "product_scope_refs": ["sku-001"],
      "effective_from": "iso",
      "effective_to": "iso|null",
      "intent_taxonomy_version": "itax_2026_08_v1",
      "intent_id": "intent_order_status",
      "risk_level": "low",
      "risk_categories": [],
      "has_conflict": false,
      "placeholder_keys": ["order_id", "date"],
      "review_due_at": "iso"
    }
  ]
}
```
- 错误: `VALIDATION`（空 query / top_k∉[1,3] / product context 未成对、类型非法或 ref 为空）

### 2.1 中文检索物化合同

- Import validator 对每条 upsert 生成 `release_items.search_document`（`tsvector`）与 `search_fallback_text`；publish 只复制已校验结果，缺任一字段不得发布。
- 规范化：Unicode NFKC、ASCII 小写、全角标点转半角、连续空白折叠；按 Unicode code point 取重叠 **2-gram**，不得按 UTF-16 code unit 截断代理对。
- 权重：questions=`A`、title=`B`、answer=`C`；查询同样 normalize + 2-gram，主路径对 `search_document` 做 GIN `@@`/`ts_rank_cd`，再按 `score desc, script_id asc` 稳定排序。
- 1 字 query、2-gram 无命中或 parser 失败：对 `search_fallback_text` 做 exact/ILIKE；`pg_trgm` 仅为该 fallback 的索引加速，**它是 3-gram，不得冒充 2-gram 主索引**。
- 33 必须提供 `search_document` GIN 与 fallback trigram GIN。老数据升级先由同版本 validator 回填并核对 hash，再加 NOT NULL；禁止填空向量骗过迁移。

---

## 3. Port: `events`（唯一操作终态 / 升级辅助动作）

### `POST /v1/events/adoption`
- **冻结语义：** 保留 `adoption_events`、`adopted` 与 `push_method` 线协议兼容；`adopted` 只表示候选已成功复制/推送到客户端输入载体，不表示已发送、正确或客户已接受。当前主路径是 `clipboard`，`autofill` 仅保留兼容且也必须实际成功后才能记录。
- Req:
```json
{
  "query_id": "uuid",
  "outcome": "adopted|dismissed|no_hit_exit|timeout",
  "chosen_rank": "1|2|3|null",
  "chosen_script_id": "string|null",
  "push_method": "clipboard|autofill|failed|pending|null"
}
```
- 服务端校验（强制）:
  - `query_id` 必须属于当前 token 的 `user_id`；客户端不得提交/覆盖 user_id
  - `outcome=adopted` ⇒ `push_method ∈ {clipboard, autofill}`，否则 `POLICY_DENIED`
  - `outcome=adopted` ⇒ `chosen_rank`、`chosen_script_id` 非空，且必须与同 query_id 的 `candidate_impressions(rank,script_id)` 完全一致
  - `outcome∈{dismissed,no_hit_exit,timeout}` ⇒ `chosen_rank=null` 且 `chosen_script_id=null`
  - 每个 query 只能写一条 terminal；`dismissed` 只用于明确放弃，`timeout` 只在客户端关闭/切后台/idle 达到部署配置 `CLIENT_ACTION_TIMEOUT_MS` 后上报，服务端不得按 HTTP 延迟猜测
  - 上述归属、候选对应与 DB CHECK/FK 一致；伪造他人 query → `FORBIDDEN`，候选不一致 → `VALIDATION`
- Res 200: `{ "ok": true, "query_id": "uuid" }`
- 幂等：scope=`POST /v1/events/adoption:{user_id}`；同 key/body 重放首次 200，body 变化 → 409；禁止把相同重试一律报 409

### `POST /v1/events/escalate`
- Req: `{ "query_id", "action": "open_feishu|copy_contact|other" }`
- `query_id` 必须属于当前用户；同一 query 可依次执行多个不同 action，但 `(query_id,action)` 唯一。每次调用必须带 `Idempotency-Key`；同 key/body 或同一已存在动作返回首次事实，异体 409。
- escalation 是辅助动作，**不是 terminal**：它不阻止后续 adoption terminal，也不证明飞书已打开成功之外的外部人工接单、发送或解决。
- Res 200: `{ "escalate_id", "query_id", "action" }`

---

## 4. Port: `metrics`

### `GET /v1/metrics/tool`
- 角色：coach / owner\
- Query: `from` · `to` · 可选 `user_id`\
- 时间窗固定为半开区间 `[from,to)`；必须 `to > from` 且 `to - from ≤ 7 天`，否则返回 400 `VALIDATION`。长窗报表另走离线任务/ADR，不得静默截断。
- Res 200:
```json
{
  "root_question_count": 0,
  "search_operation_count": 0,
  "reselection_count": 0,
  "root_adopted_count": 0,
  "operation_adopted_count": 0,
  "root_adoption_rate": 0.0,
  "operation_adoption_rate": 0.0,
  "operation_no_hit_count": 0,
  "operation_no_hit_rate": 0.0,
  "top1_copy_share": 0.0,
  "root_escalated_count": 0,
  "escalate_action_count": 0,
  "root_escalation_rate": 0.0,
  "p95_latency_ms": null
}
```
- root question = `interaction_reason=original` 的 query 及其全部 reselection 后代；operation = 每条 query。链内任一 `adopted` 只让该 root 计一次 `root_adopted_count`。
- `root_adoption_rate=root_adopted_count/root_question_count`；`operation_adoption_rate=operation_adopted_count/search_operation_count`；`operation_no_hit_rate=operation_no_hit_count/search_operation_count`；`top1_copy_share=rank1 copied/operation_adopted_count`。任一分母为 0 返回 0。
- `root_escalated_count` 按链内是否至少一个 action 去重；`escalate_action_count` 按 `(query_id,action)` 计数；`root_escalation_rate=root_escalated_count/root_question_count`。动作不代表已解决。
- `p95_latency_ms` 在空窗口返回 `null`，不用 0 冒充未知。
- `collection_disabled` 搜索不存在 query/impression/event 行，必须从所有分子与分母排除。
- **禁止**返回经营三指标（响应时间/满意/转化）

### `GET /v1/metrics/stream`
- 角色：coach / owner（agent 仅本 user）\
- Query: 必填 `from/to`（半开区间且最大 7 天）；可选 `user_id`、`platform`、`hit_status`、`chosen_rank`、`release_id`、`limit`（默认 50，最大 200）、`cursor`（不透明）。agent 提交非自己 `user_id` 必须 403，管理角色仍受服务端授权范围约束。\
- **cursor 编码（冻结）：** `base64url(iso_created_at + "|" + query_id)`\
- **翻页语义：** 倒序；`created_at < ts OR (created_at = ts AND query_id < id)`\
- Res 200 每行至少含：`query_id/root_query_id/parent_query_id/interaction_reason/user_id/query_text_redacted/text_storage_status/platform/platform_source/hit_status/outcome/chosen_rank/push_method/release_id/latency_ms/created_at/escalate_actions/candidates`。`suppressed` 时 `query_text_redacted=null`。候选投影须带 `release_id/script_version/content_hash/source_ref/effective_from/effective_to/review_due_at`；升级动作按 action 去重；不返回最终发送正文或人工复核判断。
- 筛选只作授权范围内的窄化，不得扩大数据可见性；`collection_disabled/stateless` 因无事件行天然不会出现。

### `GET /v1/metrics/iteration-tasks`

- UI 名称：**话术优化待办**；角色：coach / owner；agent → 403\
- Query：可选 `status=open|in_progress|resolved|wont_fix`、`signal_id`、`assignee_role`、`limit`（默认 50，最大 200）、`cursor`\
- Res 200：`{ "items": [IterationTask], "next_cursor": "string|null" }`\
- 详情中的 `sample_query_ids` 只返回调用者授权范围内的脱敏引用；不得附业务工单原始明细。

### `POST /v1/events/iteration-tasks/{task_id}/start`

- 角色：coach / owner；header `Idempotency-Key`；Req：`{ "expected_version": integer }`\
- 唯一合法迁移：`open → in_progress`；同一当前版本并发只有一个成功，其余 409 `CONFLICT`\
- Res 200：`IterationTask`；写只追加 `iteration_task_status_audits`。

### `POST /v1/events/iteration-tasks/{task_id}/close`

- 角色：coach / owner；header `Idempotency-Key`\
- Req：`{ "expected_version": integer, "status": "resolved"|"wont_fix", "resolution_note": string }`；结论 1～2000 字\
- 唯一合法迁移：`in_progress → resolved|wont_fix`；关闭不等于内容已经 Publish，涉及改库时可选关联 `release_id`，但不得自动改 Answer\
- Res 200：`IterationTask`；越权、非法迁移、旧版本分别返回 403 / 409，不做 last-write-wins。

---

## 4A. Port: `workorders`（业务工单分析）

> 本端口只处理批准的班牛 / 业务系统导出文件。它不调用源系统写接口，也不与 `iteration_tasks` 混表、混 ID 或共享原始明细。

### 状态机 `work_order_import_batches.status`

```text
received → validating → ready
                └──────→ failed
```

`ready` 表示批准字段已标准化并可分析，不表示原始文件可长期保留。原稿隔离存储、延迟清理和保留期必须服从安全批准；数据库只保存允许字段和安全摘要。

### `POST /v1/work-orders/imports`

- 角色：coach / owner；header `Idempotency-Key`；Body：multipart `file`（CSV/XLSX）+ `source_system` + `mapping_version` + 可选 `data_from` / `data_to`\
- 受理前执行扩展名、MIME、大小、压缩炸弹、恶意公式、表头与租户范围校验；未知列不得静默入库\
- 持久化与 202 提交门复用内容导入 §5 的 quarantine → checksum / size 校验 → batch + outbox 同事务合同，但对象前缀、表、job type 和 worker capability 必须独立：`work-orders/...`、`work_order_import_batches`、`work_order_import_validate`\
- worker 只经 `claim_work_order_import_validation` → `heartbeat_work_order_import_validation` → `retry_work_order_import_validation` / `finalize_work_order_import_validation` 工作；claim 为独立短事务，重试耗尽必须由 `reconcile_exhausted_work_order_imports` 在同一事务将 `job=dead`、`batch=failed` 并写安全 `diagnostic_id`，禁止留下永久 `validating` 批次\
- 标准化前必须显式绑定已批准 `mapping_version`；worker 只输出白名单字段，不得把任意行 JSON / 原始客户、订单、工单编号或文件路径写入公开错误\
- 重复 `source_sha256 + mapping_version + tenant` 依幂等合同 replay，不重复生成 records\
- Res 202：`{ "import_batch_id", "status":"validating" }`。

### `GET /v1/work-orders/imports/{import_batch_id}`

- 角色：coach / owner；仅授权业务范围\
- Res 200：`{ "import_batch_id", "status", "source_system", "mapping_version", "record_count", "accepted_count", "rejected_count", "data_from", "data_to", "error_report", "created_at", "completed_at" }`\
- `record_count = accepted_count + rejected_count`；公开错误仅含枚举 issue、行号 / 列号安全定位、计数与 `diagnostic_id`。

### `GET /v1/work-orders/analysis`

- 角色：coach / owner；Query：`import_batch_id` 可选，`from` / `to` 必填且半开区间 `[from,to)`，可选 `channel`、`category`、`issue_type`、`status`、`error_type`、`escalated`\
- 时间窗默认 / 最大 31 天；更长窗口走批准离线报表，不得静默截断\
- Res 200：`{ "scope", "totals", "by_category", "by_issue_type", "by_error_type", "handling_time", "trend", "refreshed_at" }`；所有聚合携带批次 / 筛选口径，未知值不得冒充 0。

### `GET /v1/work-orders/records`

- 角色：coach / owner；沿用 analysis 筛选；`limit` 默认 50、最大 200；cursor 不透明且稳定倒序\
- Res 200：`{ "items": [WorkOrderRecord], "next_cursor": "string|null", "scope": WorkOrderAnalysisScope }`\
- `WorkOrderRecord` 只含标准化白名单字段和内部 UUID / 安全 hash；不得返回原始客户、订单或工单长编号。

### `GET /v1/work-orders/analysis/export`

- 角色：coach / owner；沿用 analysis 筛选；同步导出上限由容量门冻结，超过返回 400 `VALIDATION` 并引导批准的离线报表\
- Res 200：`text/csv; charset=utf-8`，仅批准字段；`Content-Disposition` 文件名只含生成时间与批次短标识\
- 即使是 GET，也必须只追加记录操作者、筛选摘要、字段集、行数、时间和结果的导出审计；审计不得记录原始筛选值中的 PII\
- API / 数据库不存在班牛凭据或写回适配器；任何未来外部写操作必须另立 ADR、Scope、权限与版本，不得塞进本端口。

---

## 5. Port: `content` + Publish 状态机

### 状态机 `import_batches.status`

```text
                ┌──────────┐
     upload ──► │validating│──fail──► failed
                └────┬─────┘
                     │ ok
                     ▼
                  staged ──► publishing ──ok──► published
                     │            │
                     │            └──事务失败──► staged（current 不移动）
                     └── (coach cancel) ──► failed
 published（batch 终态；后续 rollback 不改原 batch）
```

### 状态机 `content_releases.status`

```text
published ──► superseded（被更新的 current 取代）
```

`rolled_back` 仅兼容旧数据，不再作为新迁移写入状态；回滚的事实由新 release 的 `rollback_of_release_id` 与 `change_audits` 表达。

### CR-004 来源上下文（人读 + 33/OpenAPI 同批静态合同；runtime 待实现）

- 售前、活动、售后、产品各有不可变 `authoritative_source_versions`；每个 release 必须恰好绑定四域各一个 `use_class=canonical` 版本。未登记或 `use_class=reference` 的来源只能作为参考，不能进入 import/publish/rollback/search。`canonical/current` 仅由 `content_current` + 该 release 的 bindings 推导，不存在来源版本上的可变 current 标记。
- 暂停记录只追加且永久。一旦 `source_version` 有暂停记录，它永久不得再次 import、publish、rollback 或 search；恢复业务只能登记新的 source version，并通过新的 release 绑定。
- 文件行不得携带或覆盖内容来源 `source_ref/source_version`。受权操作者选择的受信导入上下文由服务端解析、校验并绑定到 batch；worker 只消费服务端已冻结的上下文。无法解析或文件出现自报来源列时整批拒绝。
- 现有 `import_batches.source_ref` 继续仅表示上传对象/受信上游对象定位符，不等于内容来源权威。CR-004 的新表、字段、reason token 与 wire 输入由本 changeset 同步 33/OpenAPI 静态合同；生成类型、迁移、服务端/客户端代码与动态测试仍待后续里程碑，不得冒充已上线能力。

### `POST /v1/content/import`
- 角色：coach / owner\
- Body: multipart file（csv/xlsx）或 `{ "source_type":"feishu_api", "source_ref":"..." }`；header `Idempotency-Key`\
- 上述 JSON `source_ref` 只定位受信飞书对象；multipart 的最终 `import_batches.source_ref` 只定位受控存储对象。两者均不得直接成为 `scripts/release_items.source_ref`，内容来源由服务端受信导入上下文附加。\
- **持久化先于受理：** multipart 边接收边写受控 quarantine 并流式计算 `source_sha256=sha256(raw_bytes)` / `source_size_bytes`。对象存储不假设存在文件系统式原子 rename：最终 `source_ref=imports/{tenant_id}/{source_sha256}` 使用 conditional create/server-side copy（最终 key 不存在才写）；已存在时必须 HEAD/重读并校验 hash + size 元数据，不符即 fail-closed。**最终 key 存在且 checksum/size 相符才是提交点**；quarantine 只在安全窗后延迟清理。filesystem 只可在同一持久卷内临时文件 fsync 后 atomic rename。multipart `request_hash=sha256(JCS({source_type,source_sha256,source_size_bytes}))`，**不含**服务端随机 key、boundary、临时路径或原文件名；Feishu JSON 请求则包含客户端稳定 `source_ref`。
- `UPLOAD_BACKEND=object` 时先完成对象写入及完整性确认；`UPLOAD_BACKEND=filesystem` 仅允许 `DEPLOYMENT_PROFILE=single_host`，API 与 TypeScript worker 必须使用同一可持久共享卷。filesystem 提交顺序固定为临时文件 `fsync` → 同卷 atomic rename → **parent directory fsync**，目录同步成功才算 durable commit。多实例只允许对象存储或已证明跨节点共享的 RWX 持久卷；任意本地目录、无亲和约束的节点路径和临时盘均拒绝启动。
- **202 提交点：** 只有受控原文已持久化，且 `import_batches(status=validating)` + `outbox_jobs(job_type=import_validate,status=pending)` 在同一 DB 事务成功提交后才返回 202。存储不可用、DB 事务失败或只把任务放入内存队列，都不得返回 202。
- **一期 worker Must：** `import_validate` 由与主库共用合同的 **TypeScript / Node worker** 执行；Python 只能是二期清洗等 Deferred 路径，不能成为一期 import 受理前提。
- **worker fencing（冻结）：** TypeScript worker 只能用 import 专用 `claim_content_import_validation(instance_id, lease_seconds)` 领取任务，用 `heartbeat_content_import_validation(...)` 续租、`retry_content_import_validation(...)` 有界重试；不得调通用 outbox API。`claim_content_import_validation` 与每次 `heartbeat_content_import_validation` 必须各自在**独立短事务**内调用并立即 `COMMIT`；只有 claim `COMMIT` 后才可做文件 I/O；`retry_content_import_validation` / `finalize_content_import_validation` 各开**新事务**，禁止 claim→文件 I/O→retry/finalize 共用显式事务。import 终结只能调用 `finalize_content_import_validation(...)`；该函数必须在**同一事务**内写 `staging_scripts`、batch 终态并将 outbox complete。
- **重试耗尽闭环：** `retry_content_import_validation` 或 claim 前 `reconcile_exhausted_content_imports` 必须以 batch→outbox 锁顺序在同一事务同时落 `job=dead` + `batch=failed` + 结构化 `error_report(code=MAX_ATTEMPTS_EXHAUSTED)`，并递增 fencing token；禁止留下永久 `validating`。
- **reconciler 批界：** claim 前置清理每次最多 1 条；调度器只能在独立短事务中调用 `reconcile_exhausted_content_imports(p_limit<=10)`，每批立即 COMMIT，禁止把大批 reaper 与 claim 或文件 I/O 合并为长事务。
- **公开错误边界：** `error_report` 只允许枚举 `code`、不透明 `diagnostic_id`、安全行/列/计数与**有限枚举** `issue_codes`，机器 schema 必须 `additionalProperties:false`；SQL finalizer 必须拒绝未知字段并重建公开对象。`diagnostic_id` 只能由 DB 以随机 UUID 生成，worker 不得提供，也不得由文件/路径/异常文本派生；原始诊断仅可进入脱敏、限长、最小权限的运维日志，并通过受限 `diagnostic_id → job_id` 审计映射关联。禁止复制任意 worker JSON、原始 `last_error`、文件内容、主机路径、token 或栈；该边界和泄漏负测完成前 import 路由不得注册。
- finalizer 的 upsert payload 必须分别提供 `questions_grams_text` / `title_grams_text` / `answer_grams_text`；DB 用 `setweight(to_tsvector(...),'A'|'B'|'C')` 合并，禁止传单一无类型 `search_document_text` 丢失权重。title/answer grams、fallback 必须非空，生成结果 `length(tsvector)>0`；正/反例与中文金标仍必须在 PG15 + TS validator 集成测证明映射正确。
- CR-004 运行实现中，finalizer 还必须校验 batch 的服务端来源上下文、domain、immutable source version 与文件 hash；文件表头/行出现内容来源自报字段即整批 `failed`。只有服务端可把已核验的来源血缘投影到 staging；worker payload 和行数据均无权覆盖。
- DEC-042 finalizer 必须先做结构/安全/来源级校验，再做质量级校验。稳定随机 `question_id` 由上游给定且不得按行序生成；`(question_id,question_version)` 是不可变版本键，正文、映射、taxonomy 或来源语义变化只能追加新版本。Question 正文先脱敏，再计算 `question_hash` 与 HMAC `origin_fingerprint`，并同存 `origin_fingerprint_key_version`。`platform_scope`、商品范围、有效期、taxonomy、risk/categories、placeholder 声明不合法，属于结构错误并整批失败。
- **审核信任边界：** normalized worker row 不接 `review_mode`、审核主体/角色/EVD、审核结论或 `quality_gate_passed`。授权审核池只能经 `record_content_review_decision` 向受限 `content_review_decisions` 追加决定；finalizer 按 `script_id + content_hash` 解析固定 `ROLE-CONTENT-LEAD` 与条件必需的固定 `ROLE-CS-MANAGER`，并验证 dual 两个伪名主体不同。审核主体 ID 是 DB 受控审计字段，不扩入坐席 public wire。
- **质量分层与证据：** 文案清晰度、重复、分类建议等质量问题只将对应行置 quarantine；clean 行才进入审核/发布候选。每个质量审查批次最多 5,000 条；clean `<=500` 全审，`501–5000` 抽 10% 且 `min=100,max=300`。样本问题率 `>2%` 扩至 30%，`>5%` 阻断该质量批次；`risk_level=high` 与冲突行 100% 审核且不进入普通分母。普通 import worker 只能经 `freeze_content_quality_review_plan` 冻结 `content_quality_review_plans` 的策略版本、cutoff、分母、样本目标、`population_manifest_hash`、seed/selection manifest hash 与算法；总体 hash 来自按稳定键排序的安全行元组，至少覆盖 `script_id/content_hash/risk_level/has_conflict/quality_status`。授权审核池完成检查后，才经 `record_content_quality_review_evidence` 向 `content_quality_review_evidence` 追加同一 plan/batch/population hash、样本/缺陷/强制全审/quarantine 数、`passed|blocked` 与 EVD；长期审核事实绑定冻结计划，不依赖短 worker lease。finalizer 必须从最终 payload/staging 重算总体 hash并重验 plan/evidence；同数量换行、hash 漂移或 row 布尔自报均失败。
- **capability role：** `app_import_worker` 只授权 import 专用的 claim/heartbeat/retry、`freeze_content_quality_review_plan` 与上述 finalizer；不授权 `record_content_review_decision`、`record_content_quality_review_evidence`、通用 `outbox_complete`，也不授权对 `staging_scripts` / `import_batches` / `outbox_jobs` / 审核或质量证据表直接 INSERT/UPDATE/DELETE。审核池 capability 只调用对应记录函数；finalizer 内部清理/写入 staging、batch 和 job 收口必须同成同败。
- `finalize_content_import_validation` 必须匹配 `status=running + lease_owner + lease_version + lease_expires_at>clock_timestamp()`（按真实墙钟，不用事务起点时间）；失租或被 cancel 后用 SQLSTATE `ZA006` + `DETAIL=OUTBOX_LEASE_LOST` 失败，API 稳定映射为 409 `CONFLICT` + `error.details.reason=OUTBOX_LEASE_LOST`。该事务内 staging/batch/outbox 写入必须整体回滚，旧 worker 不得继续副作用。过期 running job 被新 worker claim 时必须递增 `lease_version`。对应 DB 函数迁移、权限收紧与负测完成前，该路由不得注册。
- Res 202: `{ "import_batch_id", "status":"validating" }`\
- 异步完成后：`staged` 或 `failed` + 上述公开白名单 `error_report`

### `GET /v1/content/import/{import_batch_id}`
- Res 200: `{ "import_batch_id", "status", "error_report", "staged_count", "preview": [...] }`

### `POST /v1/content/import/{import_batch_id}/cancel`
- 角色：owner；coach 仅可取消自己发起的 batch\
- Header: `Idempotency-Key`；Req: `{ "reason": "string|null" }`\
- 只能调用 `cancel_content_import(...)`，在单事务中以原子条件更新争抢 `validating|staged → failed`，并写 `error_report.code=CANCELLED`；同事务将未完成的 `import_validate` outbox 标为 `dead`、清空 lease 并递增 `lease_version`。worker 提交结果前必须再次检查 batch 仍为 `validating`；其旧 lease finalizer 必须失败并回滚。
- **cancel/publish 互斥：** publish 与 cancel 都必须依赖 DB 原子状态迁移的受影响行数，不得在 API 先 SELECT 后 UPDATE。cancel 先将 staged 转 failed 时 publish 失败；publish 先将 staged 转 publishing 时 cancel 失败；不存在两者都成功的中间态。
- Res 200: `{ "ok": true, "import_batch_id", "status":"failed" }`\
- 已 `publishing|published` → 409 `CONFLICT`

### `POST /v1/content/publish`
- 角色：**一期仅 owner**；coach 无配置旁路\
- Req: `{ "import_batch_id", "title", "summary" }` + header `Idempotency-Key`\
- 事务（与 `33` + NFR 41 §2.4 一致）:
  **实现冻结：** 调用 `publish_content_release(...)`（33 SECURITY DEFINER）；内含：
  1. 角色校验 **一期仅 owner**\
  2. `pg_try_advisory_xact_lock` — **false → 立即 409**\
  3. 在发布事务中用单条原子条件更新争抢 batch：`UPDATE ... SET status='publishing' WHERE import_batch_id=? AND status='staged'`，并检查受影响行数必须为 1；0 行按实际存在性/状态返 `NOT_FOUND|CONFLICT`。任何事务失败都连同该迁移回滚为 staged；空 ok 行 / invalid 行 → `VALIDATION`\
  4. `operation=upsert`：按 `SHA-256(JCS(规范化治理快照))` 校验/重算 `content_hash` 后 upsert scripts。数据库 JCS helper 仅处理固定 ASCII 合同键并以 `C` 排序，不是任意 Unicode key 的通用 serializer。治理快照覆盖 Answer、稳定 Question 映射（含 from_log 晋级角色）及 origin key version、平台/商品 scope、risk/categories、effective、intent taxonomy、placeholder、审核角色/EVD 与来源版本；任一变化必须递增 `script_version` 并产生新 hash。`operation=withdraw` 将 scripts 标记 archived\
  5. 只允许 quality=`clean`、冻结质量 plan/evidence=`passed` 且审核完成的行进入候选快照：`low/medium + 无冲突` 必须有固定 `ROLE-CONTENT-LEAD` 单审；`high` 或冲突必须同时有固定 `ROLE-CONTENT-LEAD` 与固定 `ROLE-CS-MANAGER` 两个不同伪名主体的独立通过决定。finalizer 只从受限事实表解析，拒绝 normalized row 自报。高风险最小枚举为退款/赔付、价格/折扣、活动规则、功效/安全宣称、账号/隐私、投诉/升级、法律承诺，命中任一类不得降级；未决冲突、未知 intent、quarantine、占位符声明不匹配或缺审核一律拒绝发布。普通建议 90 天、高风险建议 30 天复核窗仍待内容政策批准，不能由实现硬编码成已授权默认值\
  6. **MERGE 快照：** `(prev release_items − 本批全部 script_id) ∪ 本批 clean+approved upsert`；正文模板、稳定 Question 版本、来源、责任人、审核角色/EVD（审核主体仅保留在受控 DB 审计投影）、复核期、生效窗、显式 scope、taxonomy、risk/categories 与 placeholder 必须一起复制；withdraw 与 quarantine 不进入新 snapshot；**禁止**「仅 batch = 新世界」。CR-004 必须对这个**完整合并候选快照**重新校验来源，而不是只校验本批新增行\
  7. CR-004 运行实现中，候选 release 必须恰好形成 `presale/campaign/aftersale/product` 四条不可变、`use_class=canonical` source bindings；任一来源未登记或仅供 `reference`、绑定缺失/重复、条目来源不匹配、hash/EVD 不一致或 source version 已有永久暂停记录，则整笔拒绝。来源切换不得独立修改 current 来源，只能随本次新 release 一起完成\
  8. 新 release、四域 bindings、`content_current`、announcements、change_audits 与 batch=`published` 同一事务提交；任一步失败保持旧 current 和旧四域 bindings 不变
- Res 200: `{ "release_id", "release_seq", "announcement_id" }`
- 错误: `CONFLICT`（锁）、`VALIDATION`（空批/非法行）
- CR-004 的**来源 reason**拒绝后，另开独立幂等短事务写最小 source denial audit；不得在将被 `RAISE` 回滚的发布事务里先 INSERT 审计。`GOVERNANCE_HASH_MISMATCH`、`QUALITY_GATE_NOT_PASSED` 等内容拒绝走标准 change/error audit，不混入来源表。审计失败时不返回伪造的已审计业务错误，继续 fail-closed。

### `POST /v1/content/rollback`
- 角色：**一期仅 owner**；header `Idempotency-Key`\
- Req: `{ "target_release_id", "title":"string|null", "summary":"string|null" }`\
- 行为（唯一实现）：调用 `rollback_content_release(...)`，在单事务内获取同一 publish try-lock。先重新校验目标 snapshot 的四域 immutable bindings、条目来源匹配与全部永久暂停记录；任一来源已暂停或绑定不完整时整次拒绝，禁止过滤目标 snapshot。通过后将目标 snapshot 的正文模板、稳定 Question 版本、来源血缘、`owner_role/review_due_at`、有效窗、显式 scope、taxonomy、risk、placeholder 与四域 bindings **完整复制为新 release_seq**，新 release 写 `rollback_of_release_id=target_release_id`，更新 `content_current`、创建 announcement 与 change_audit；**绝不**就地修改目标历史或直接把 current 指针指回旧 release。
- Res 200: `{ "release_id", "release_seq", "announcement_id", "rollback_of_release_id" }`
- 错误：目标不存在/空 snapshot → 404 `NOT_FOUND`；目标已是 current → 409 `CONFLICT`；锁冲突/幂等冲突 → 409；非 owner → 403 `FORBIDDEN`
- CR-004 来源拒绝同样在主事务回滚后独立、幂等追加 source denial audit；内容治理 hash 拒绝走标准 change/error audit；被暂停 source version 永久不可通过 rollback 复活。

---

## 6. Port: `announce` + 客户端同步

### `GET /v1/announce/current`
- 响应可 `Cache-Control: max-age=10`；ETag = `W/"<release_seq>"`（匹配 → 304）\
- 客户端：启动拉取 + **抖动 0–15s** 周期轮询\
- 首次 owner 发布前无 current release：返回 **503 `OVERLOADED`** + `details.reason=CONTENT_NOT_READY` + `Retry-After`；`/ready` 同时为 false。不返虚构 release_seq=0，不自动发布空快照。\
- DB 唯一读取边界：身份层取得受信 `user_id` 后调用 `read_current_announcement_with_lease(client_id,user_id,ttl_seconds)`；该 DEFINER 函数在同一受控边界内完成 current / 四域 source gate 复核、短租约签发与最小公告投影。`app_runtime` 不得直接读取 `content_current / content_releases / release_source_bindings / announcements` 等 SoR 底表。\
- Res 200:
```json
{
  "current_release_id": "string",
  "release_seq": 12,
  "source_binding_hash": "64-char-hex",
  "offline_lease": {
    "token": "opaque-token",
    "expires_at": "2026-08-09T10:10:00Z",
    "release_id": "string",
    "source_binding_hash": "64-char-hex"
  },
  "announcement": { "title", "summary", "created_at" } | null
}
```

**CR-004 短租约（33/OpenAPI 同批静态 wire 合同；runtime 待实现）：** `current` 签发 opaque bearer token 与 `expires_at`，绑定 `client_id + user_id + release_id + source_binding_hash`；默认 600 秒，允许 60～900 秒，DB 只存 token SHA-256。`snapshot` 每页校验 token 及绑定；ACK 必须校验同一有效 token、只记录 token hash/同步游标且不续租。`If-None-Match` 只有在原租约仍有效时才可 304 并回显原 token/expiry，否则必须 200 签新租约。current/snapshot/ack 的来源门或租约拒绝也执行“主事务回滚 → 独立幂等 source denial audit commit → HTTP denial”。客户端离线时只能在租约有效期内使用完整 snapshot；到期立即停止本地 FTS/检索并提示联网同步，无宽限期、无旧 snapshot fallback。生成类型、客户端/服务端代码和动态 EVD 未完成前不得宣称该能力已上线。

### `GET /v1/announce/snapshot`
- Query: **`release_id` 必填**（首次从 `current` 响应拷贝，后续页 **禁止** 省略或改成别的 release）· `limit`（默认 200，最大 500）· `cursor`（可选，`script_id`）；同时携带受信 `client_id` 与 `current` 签发的 opaque offline lease token。\
- **唯一分页边界：** 调用 `read_snapshot_page(offline_lease_token,client_id,user_id,release_id,cursor,limit)`；函数在同一 SQL statement snapshot 内先验 lease + source gate，再按 `script_id` 稳定游标读取 `limit+1` 并只投影 wire 白名单字段。为保证跨页集合稳定，服务端返回该 release 的完整不可变条目，不按每页请求时钟删行；客户端每次本地检索都必须执行 `effective_from <= now < effective_to`（空上界为 +∞），`now == effective_to` 必须排除。API / `app_runtime` 禁止直接 SELECT `release_items` 或自行拼 `WHERE` 旁路。\
- `next_cursor` = 本页最后 `script_id`；无更多则 null\
- Res 200:
```json
{
  "release_id": "string",
  "release_seq": 12,
  "source_binding_hash": "64-char-hex",
  "offline_lease": {
    "token": "opaque-token",
    "expires_at": "2026-08-09T10:10:00Z",
    "release_id": "string",
    "source_binding_hash": "64-char-hex"
  },
  "items": [
    {
      "script_id": "string",
      "script_version": 1,
      "content_hash": "string",
      "title": "string",
      "category": "string",
      "answer_text": "string",
      "platform_scope": ["qianniu"],
      "product_scope_type": "sku",
      "product_scope_refs": ["sku-001"],
      "effective_from": "2026-08-10T00:00:00Z",
      "effective_to": null,
      "intent_taxonomy_version": "itax_2026_08_v1",
      "intent_id": "intent_order_status",
      "risk_level": "low",
      "risk_categories": [],
      "has_conflict": false,
      "placeholder_keys": ["order_id"],
      "questions": [{
        "question_id": "q_random_stable_id",
        "question_version": 1,
        "question_hash": "sha256_hex",
        "semantic_family_id": "sf_order_status",
        "question_text": "已脱敏典型问法"
      }]
    }
  ],
  "next_cursor": "string|null"
}
```
- 客户端：落后 → 横幅 → 固定 release_id **分页拉完整 release** → 验证四域 binding 摘要与短租约 → 重建可选 FTS → ack；每次本地召回仍按半开有效窗过滤，租约到期即停本地检索，取得新租约前不得继续。SnapshotQuestion 仅含公开检索所需最小字段；任何 query/HMAC/key version/晋级审核/EVD/内部 locator 泄漏均视为合同失败\
- 错误：缺 release_id / 空 cursor / limit 越界 → `VALIDATION`；lease 无效、过期或错绑 → 403；source gate 不完整、hash 不一致或已永久暂停 → fail-closed，且不返回部分快照

### `POST /v1/announce/ack`
- `Idempotency-Key` **可选**；DB 的 user-bound 单调 `release_seq` 是业务幂等真源，提供 header 时叠加共用 replay 状态机。
- Req: `{ "client_id", "release_id", "release_seq", "offline_lease_token" }`\
- Res 200: `{ "ok": true }`\
- 服务端从受信 OAuth / JWT 身份声明取得 `user_id`；只调用 `ack_client_release(client_id,user_id,release_id,release_seq,offline_lease_token)`。该受控函数先校验 lease 的 client / user / release / source binding / expiry，再以行锁保证 `release_seq >= last_seen_release_seq`；只记录 token hash 与同步游标，不更新 lease。乱序旧 ACK 返回 200 但不得回退游标；同 client_id 被另一 user 使用 → 403。
- `app_runtime` 仅可读 `client_sync_state`，不得直接 INSERT/UPDATE；写入能力只授予上述 DEFINER 函数。

**顺序规则：** 必须先拉到 snapshot 成功（含分页完成）、验证四域 binding 与有效短租约后再 ACK；ACK 不表示用户已读，只表示客户端内容游标，也不延长租约。租约续期只能由受信 current/snapshot 响应签发。

---

## 7. Port: `policy` / `redaction`

### `GET /v1/policy`
- Res 示例:
```json
{
  "rewrite": false,
  "auto_send": false,
  "autofill_adapter": false,
  "llm_ranker": false,
  "metrics_experimental_kpi": false,
  "auth_mode": "mock|feishu"
}
```
- 未知 flag 读取 → **最严 OFF**；`auth_mode` 来自部署配置，只读且不属于 `policy_flags`

### `POST /v1/policy/flags`（唯一写入口）
- 角色：**仅 owner**\
- Header: `Idempotency-Key`\
- Req: `{ "flag_key": "rewrite|auto_send|autofill_adapter|llm_ranker|metrics_experimental_kpi", "flag_value": false, "adr_id": "ADR-xxx|null" }`\
- 服务端 **必须** 调用 `set_policy_flag(...)`（33）；禁止 SQL 直改 `policy_flags`\
- **一期硬禁：** `rewrite=true` 或 `auto_send=true` 无条件 403 `POLICY_DENIED`；即使带 ADR 也不能越期。启用 rewrite 需二期迁移/新合同；auto_send 需独立立项 + `/v2`。
- `mock_auth` 不在可写 flag 集；提交未知 key 或 `mock_auth` → 400 `VALIDATION`
- Res 200: `{ "ok": true, "flag_key", "flag_value" }`

### Redaction（内部）
- 必须在 request-body 日志、落库、LLM/ranker 调用之前执行；redaction 异常 fail-closed，原文不得进入日志或持久层\
- **最小规则（一期冻结）：** 连续 11 位手机号、身份证 15 位或 18 位（末位含 X/x）→ 替换为 `[REDACTED]`；其余策略 ADR 可扩；实现必须带正/反例 test vectors\
- `query_text_hash`：`HMAC-SHA256(secret_key, key_version || "\0" || normalize(query_text_redacted))` 小写 hex；`secret_key` 只来自 secrets，日志另带 `hash_key_version`，不得对原始 query 做无密钥裸 SHA\
- `text_storage_status=stored` 时 `query_text_redacted/query_text_hash` 都必须非空；DLP 选择抑制持久化时为 `suppressed` 且两者都必须为 null。两种状态都不得保存原始未脱敏 query。
- `redaction_policy_version`、`collection_mode`、detected/confirmed platform 与 `platform_source` 是事件审计字段；不得从自由文本日志事后猜测。
- `text_expires_at/event_expires_at` 由已批准的部署配置写入。运行表只允许 Security / Privacy Owner 从 **0/14/30 天**三档签发：0 天表示 suppressed/不保存正文，试点建议脱敏正文 14 天、事件 30 天；这些是设计建议，不构成授权值。清理任务必须先撤下所有带 `source_query_id` 的衍生语义项，再删/置空到期文本与事件，并保留不含正文的执行审计，防止恢复后复活。
- **content_hash（DEC-042 冻结）：** `SHA-256(JCS(规范化治理快照))` 十六进制小写。数据库实现仅允许固定 ASCII 合同键并以 `C` 排序；不是任意 Unicode key 的通用 RFC8785 实现。治理快照至少覆盖 Answer 模板、稳定 Question 映射及晋级角色、平台/商品 scope、risk、effective、intent taxonomy、placeholder 与来源版本；其中任一项变化都必须递增 `script_version` 并生成新 hash，禁止继续使用仅对 `answer_text` 裸 hash 的旧口径。

### 7.1 语义资产与训练预埋（离线边界，不是 API）

- 一期 OpenAPI **不得**出现人工复核、dataset、teacher、training、distillation 路由或 schema；是否修改、是否发送、是否正确仅由批准试点抽样形成三字段离线 EVD，不能回写成运行事实。
- 运行事件和语义资产分账：只有人工批准后，才可将脱敏问法晋级为 `script_questions(source=from_log)`。Question 绑定非 PII `semantic_source_asset`；active 资产保存运行 `source_query_id` FK、来源 HMAC/key version、批准 EVD/角色/时间。删除源 query 前必须先撤下衍生项，再经受限一次性 retire 写 tombstone/EVD、保留不可逆 HMAC 血缘并释放直接 query FK；retired 资产永久不得发布、检索、恢复或重新绑定。禁止简单 `SET NULL`、级联删除或覆盖历史。
- Phase 1 原始问法、最终消息、真实聊天 artifact、embedding 向量、teacher 输出与训练集正文均不得作为新 PostgreSQL 表/列保存；49/50 只在数据门后生成受控、版本化、可删除的离线 artifact。
- 在线 search 只走字符 bigram 主路。`EmbeddingProvider` 只做离线影子评测；DeepSeek 通过默认关闭、可替换 adapter；GLM 未取得覆盖输入数据、输出使用和蒸馏目的的书面许可时禁止进入 teacher batch。
- 每个离线批次必须记录 provider/model/version、许可证据、`purpose_lock`、源 query/script/release manifest、train/eval 互斥集合、删除 tombstone、预算 cap 与批准 EVD。源数据撤回后，dataset/index 必须重建；若已进入模型权重，则停用对应模型版本并从清洁 manifest 重训，禁止承诺不可证明的单样本“遗忘”。

### Import 列最小合同（CSV/Excel）

| 列名 | 必填 | 说明 |
|------|------|------|
| `script_id` | 是 | 稳定 ID |
| `operation` | 否 | `upsert|withdraw`；缺省 `upsert`；withdraw 行只要求 script_id |
| `category` | upsert 是；withdraw 否 | presale/campaign/aftersale/product |
| `title` | upsert 是；withdraw 否 | |
| `answer_text` | upsert 是；withdraw 否 | |
| `owner_role` | upsert 是；withdraw 否 | 内容责任角色；不得用发布操作者覆盖来源责任人 |
| `review_due_at` | upsert 是；withdraw 否 | ISO-8601 复核截止时间；不是自动失效时间 |
| `question_id` | 有 Question 时是 | 上游给定的稳定随机 ID；禁止按行序、数组下标或正文位置生成 |
| `question_version` | 有 Question 时是 | 整数 `>=1`；同一 Question 语义内容变化必须升版本 |
| `question_text` | 有 Question 时是 | 多问法可多行同 `script_id`；正文必须先脱敏 |
| `semantic_family_id` | 有 Question 时是 | 稳定语义族 ID；同义改写可归入同一族 |
| `source` | 有 Question 时是 | 仅 `manual|from_log|import` |
| `source_asset_id` | 有 Question 时是 | 非空稳定 ID：`manual` 指向受控人工录入资产，`from_log` 指向已批准脱敏语义资产，`import` 指向受信导入资产；不得写原始正文或可逆业务标识 |
| `intent_taxonomy_version` / `intent_id` | upsert 是；withdraw 否 | 必须命中已登记 taxonomy 版本与 ID；未知 intent 隔离待审 |
| `risk_level` | upsert 是；withdraw 否 | 仅 `low|medium|high`；退款/赔付、价格/折扣、活动规则、功效/安全宣称、账号/隐私、投诉/升级、法律承诺至少归 `high` |
| `risk_categories` | upsert 是；withdraw 否 | JSON string array；`high` 必须非空且只含七类受控高风险枚举，`low|medium` 必须为 `[]` |
| `has_conflict` | upsert 是；withdraw 否 | 布尔；true 时必须进入双审且在未决前 quarantine |
| `placeholder_keys` | upsert 是；withdraw 否 | JSON string array；仅 `order_id|date`，无占位符时必须 `[]` |
| `effective_from` | upsert 是；withdraw 否 | ISO-8601 生效时间；不得为空 |
| `effective_to` | 否 | ISO-8601 失效时间；可空表示无已知结束时间 |
| `platform_scope` | upsert 是；withdraw 否 | 非空 JSON string array；元素仅 `qianniu|douyin`，两者都含才表示 both；`NULL/[]` 非法 |
| `product_scope_type` | upsert 是；withdraw 否 | 仅 `storewide|category|sku` |
| `product_scope_refs` | upsert 是；withdraw 否 | JSON string array；`storewide` 必须 `[]`，`category/sku` 必须非空 |

**CR-004 来源列禁令：** 文件最小合同中没有内容 `source_ref` 或 `source_version` 列；表头或任一行自报这些字段都必须整批拒绝，不能忽略后继续。`scripts.source_ref/release_items.source_ref` 由服务端从受信 batch 来源上下文和 release binding 附加。这里不改变 `import_batches.source_ref` 作为存储对象定位符的既有语义。

校验分两级：任一**结构、安全或来源**非法行 → batch=`failed` + 结构化 `error_report`，本批不写 staging；文案清晰度、重复、分类建议等**质量问题**只隔离对应行为 `quarantine`，其余 clean 行可进入 staged，但 quarantine 永不进入发布快照。只有至少一条 clean 候选且服务端来源上下文已核验，才可经 fenced finalizer 写入 staging 并转 `staged`。publish 中的完整 MERGE、来源、scope、taxonomy、risk、placeholder、审核与质量状态复验是防历史数据/旁路的第二道门。`operation=withdraw` 只携带 `script_id/operation`，`owner_role/review_due_at`、正文、Question、scope、taxonomy、risk、placeholder 等 shape 字段都必须为空；目标 `script_id` 必须存在于当前 release。

**受限审核/质量字段禁令：** Import 列与 normalized row 均不得出现 `review_mode`、primary/secondary 审核主体/角色/EVD、审核结论或 `quality_gate_passed`；出现即整批拒绝。内容审核决定只由授权审核池调用 `record_content_review_decision` 写入 `content_review_decisions`。普通 worker 只调用 `freeze_content_quality_review_plan` 冻结质量计划；实际审核池再调用 `record_content_quality_review_evidence` 写入证据。finalizer 从受限事实解析固定角色、双审异人和冻结质量结论，不能采信文件或 worker 自报。

**questions_json 形状（冻结）：**
```json
[
  {
    "question_id": "q_random_stable_id",
    "question_version": 1,
    "question_hash": "sha256_hex",
    "semantic_family_id": "sf_order_status",
    "origin_fingerprint": "hmac_sha256_hex",
    "origin_fingerprint_key_version": "hmac-origin-v1",
    "source": "manual|from_log|import",
    "source_asset_id": "sa_stable_id",
    "intent_taxonomy_version": "itax_2026_08_v1",
    "intent_id": "intent_order_status",
    "question_text": "已脱敏典型问法"
  }
]
```
- CSV 同 `script_id` 可有多行 Question，但 `question_id` 必须由上游给定且跨重排/重复导入保持稳定；禁止由行序、数组下标或 `script_id + 序号` 派生。服务端在脱敏后重算 `question_hash`，并用指定 key version 的 HMAC 重算 `origin_fingerprint`，同时校验/冻结 `origin_fingerprint_key_version`；不得信任文件自报 hash/fingerprint\
- `(question_id,question_version)` 是不可变版本键；同一稳定 Question 的正文、Answer 映射、taxonomy 或来源语义发生变化时必须追加更高 `question_version`，旧版本作为不可变血缘保留，禁止 UPDATE/DELETE 后复用\
- 无 question 列 → `[]`\
- import 写入 `staging_scripts.questions_json` 后 publish 原样冻结进 `release_items`

---

## 8. 一期不变量 → 可测断言（实现门禁）

| ID | 断言 |
|----|------|
| INV-NR | `rewrite=false` 时 search `answer_text` === 当前 release 的 `release_items.answer_text`（**单源**） |
| INV-EFF | search 仅经 `search_recommendable_scripts` 返回同一快照内已过来源、有效期与显式 scope 门的结果；`app_runtime` 直读 backing view/底表必须失败 |
| INV-ADOPT | `outcome=adopted` 且 `push_method∉{clipboard,autofill}` → API 4xx + DB 拒绝 |
| INV-PAD | search 不得为凑满 3 插入非检索结果 |
| INV-REL | publish 后 `content_current` 与 `announcements` 同事务存在 |
| INV-FB | `llm_ranker` 超时/错误时仍返回 FTS 结果且写 query_events（不整单 5xx） |
| INV-RL | 超限返回 429 `RATE_LIMITED` |
| INV-PUB-LOCK | 并发 publish 仅一成功 |
| INV-BYPASS | 非 publishing 会话改 published answer_text → DB 拒绝 |
| INV-PHASE1-FLAG | 一期设置 rewrite/auto_send=true（即使带 ADR）→ 403 + DB 函数拒绝；mock_auth/未知 flag 拒写 |
| INV-IDEM-FENCE | lease 被重抢后旧 owner/version complete → 409 `IDEMPOTENCY_LEASE_LOST`，不得覆盖终态 |
| INV-OUTBOX-FENCE | 失租/被取消的旧 worker 以旧 owner/version complete → `OUTBOX_LEASE_LOST`；同事务 staging/batch 写入回滚 |
| INV-IDEM-TX | 同步写在 commit 前崩溃 → 业务与 idem 一起回滚；业务已 commit → idem 必为可 replay 终态 |
| INV-ROLLBACK | rollback 生成新 release_seq，snapshot 字节级等于 target，current+announcement+audit 同事务 |
| INV-WITHDRAW | withdraw script 不在新 snapshot 且 scripts.status=archived；未声明的旧 script 仍由 MERGE 保留 |
| INV-ACL | PUBLIC 无 DEFINER execute；app_runtime 无 release/policy/audit/idempotency/rate_limit 直接写权限，且无 `v_scripts_recommendable/release_items/content_current` 直接 SELECT |
| INV-SEARCH-DOC | upsert release_item 必有按冻结规范生成的 2-gram search_document；pg_trgm 仅 fallback |
| INV-FIRST-REL | 无 `content_current` 时 search/current 均 503 `CONTENT_NOT_READY`，业务 readiness=false；不创建空 release 或扫 scripts 旁路 |
| INV-IMPORT-DURABLE | 原文存储可重读 + batch/outbox 同事务完成前不返 202；多实例不得使用节点本地路径 |
| INV-TASK-DOMAIN | `/iteration-tasks/*` 只读写 `iteration_tasks` / status audits；不得连接 `work_order_records` 或返回其原始明细 |
| INV-TASK-CAS | start / close 必须匹配 `expected_version` 与合法迁移；并发旧版本 409，不得覆盖 |
| INV-WO-DOMAIN | `/work-orders/*` 只读写 `work_order_*`；不得创建 `iteration_task` 或混入检索指标分母 |
| INV-WO-ALLOWLIST | 未批准列、原始客户 / 订单 / 工单编号和任意 raw row JSON 不得进入标准化表、公开错误、日志或默认模型出域 |
| INV-WO-IDEM | 同 tenant + source_sha256 + mapping_version 重试不重复 records；批次总数始终等于 accepted + rejected |
| INV-WO-RO | 代码、配置、凭据和 OpenAPI 中均不存在班牛自动建单 / 填单 / 改单 / 写回路径 |
| INV-WO-RBAC | agent 访问任一 `/v1/work-orders/*` → 403；coach / owner 仍受业务范围过滤；导出只追加审计 |
| INV-AUTH-PROD | 试点 / 生产 `AUTH_MODE!=feishu`、缺验签配置或注册 mock-login → 监听端口前退出 |
| INV-NOTICE | `collection_mode=pilot_recorded` 且当前 notice 未被本用户 accepted → 403/503 且 query/impression 零写入 |
| INV-DLP-STORE | `stored` 必须同时有脱敏文本+HMAC；`suppressed` 必须两者均 null；DLP 引擎失败不得降级 |
| INV-STATELESS | 仅 telemetry 写故障可 `collection_disabled`；query/impression/adoption/escalate 零写入且全部指标排除；Auth/DLP/content 仍 fail-closed |
| INV-RESELECT | `original=>parent=null`；`reselection=>同用户且已终态 parent`；lineage append-only、无环，覆盖父 query 必须拒绝 |
| INV-CANDIDATE-PROVENANCE | 每条候选的 `(release_id,script_id,script_version,content_hash)` 外键命中同 query release 的不可变 `release_items` |
| INV-TERMINAL | 每 query 只有一条 adoption terminal；timeout 仅由 `CLIENT_ACTION_TIMEOUT_MS` 客户端生命周期触发 |
| INV-ESCALATE-AUX | `(query_id,action)` 幂等；同 query 可多 action；action 不终结 query、不证明外部接单/解决 |
| INV-METRICS-DUAL | root question 与 search operation 两套分子/分母同时返回；不得把多次重选当多个独立客户问题或混算 |
| INV-KB-PROVENANCE | 内容 `source_ref` 只能由服务端受信 import 上下文附加，再从 staging → scripts/release_items → publish/rollback snapshot 原样贯通；文件行自报来源必须整批拒绝；withdraw shape 均为空 |
| INV-SOURCE-BINDING | 每个 release 恰好有 `presale/campaign/aftersale/product` 四条 immutable、`use_class=canonical` bindings；未登记/reference 来源拒绝；canonical/current 只从 `content_current` 所指 release 推导，无可变来源 current flag |
| INV-SOURCE-SUSPEND | source suspension 只追加且永久；命中暂停记录的 source version 永久不得 import/publish/rollback/search，恢复业务必须新版本 + 新 release |
| INV-SOURCE-ATOMIC | 完整 MERGE 来源校验、source switch、新 release、四域 bindings、current、announcement、change audit 同一事务；失败旧 current 不动 |
| INV-SOURCE-ROLLBACK | rollback 先重验目标四域 bindings 与永久暂停；任一失败整次拒绝，禁止过滤目标 snapshot 或复活已暂停来源 |
| INV-SOURCE-DENIAL-AUDIT | 仅来源/租约 reason 的业务事务先回滚，最小 source denial audit 在独立幂等事务提交；内容合同/hash/质量拒绝走标准 change/error audit，不混表；审计失败继续 fail-closed |
| INV-OFFLINE-LEASE | 客户端 snapshot 短租约到期立即停止本地检索；ACK 不续租；取得受信 current/snapshot 新租约前不得使用旧快照 |
| INV-NO-CHAT | CR-002 只记录 search、候选、唯一操作终态与升级辅助动作；schema/API 均无 conversation、transcript、final_message_text、在线复核或训练接口 |
| INV-SEMANTIC-LINEAGE | `script_questions.source=from_log` 必须绑定非 PII semantic source asset；active 时 query FK + HMAC/key version/EVD 齐全，删源前撤下并单向 retire/tombstone 后释放直接 FK；retired 永不复活，运行表与离线 artifact 分账 |
| INV-CONTENT-ID | Question ID 必须由上游给定、稳定且随机；`(question_id,question_version)` 不可变，hash、语义族、HMAC 来源指纹及 key version、来源资产和脱敏正文齐全；禁止按行序生成或覆盖旧版本 |
| INV-CONTENT-SCOPE | `platform_scope` 非空且仅含 qianniu/douyin；商品 scope type/refs 形状合法；请求 product context 成对出现，无上下文仅命中 storewide；任何 NULL/空数组宽放均拒绝 |
| INV-INTENT-TAXONOMY | taxonomy 版本与 intent ID 必填且已登记；旧 ID 不删除，迁移必须有显式映射；未知 intent 隔离且不得发布 |
| INV-CONTENT-RISK | risk 仅 low/medium/high；high 的 risk_categories 必须非空且只含七类受控枚举，low/medium 必须 `[]`；普通项固定 ROLE-CONTENT-LEAD 单审，高风险或冲突固定 ROLE-CONTENT-LEAD + ROLE-CS-MANAGER 两个不同伪名主体双审；高风险不可降级，未决冲突不得发布 |
| INV-CONTENT-REVIEW-TRUST | normalized row/普通 worker 自报审核主体、角色、EVD、结论或 quality gate → 整批拒绝；审核池只经受限记录函数追加事实，finalizer 才解析并冻结最小投影；public wire 不含受控主体 ID |
| INV-PLACEHOLDER | 仅 `{订单号}/{日期}` ↔ `order_id/date`；API 返回模板原字节，客户端内存确定性渲染；缺值禁止复制并二次确认；值/渲染正文零落库零日志，事件只绑模板四元组 |
| INV-CONTENT-HASH | `content_hash=SHA-256(固定 ASCII-key JCS 子集治理快照)`；Answer、Question mapping/晋级角色、scope、risk、effective、intent、placeholder 或来源变化均升 script_version/hash |
| INV-CONTENT-QUALITY | `content_quality_review_plans/evidence` 必须分别经 freeze/record 函数形成，且同绑由稳定安全行元组生成的 population_manifest_hash；finalizer 重算，数量不变但替换行也失败。普通 worker 不能自报 evidence；阈值、扩样、阻断与 high/冲突全审规则可重放 |
| INV-SNAPSHOT-EFFECTIVE | snapshot 返回完整不可变 release；客户端每次本地检索强制 `[effective_from,effective_to)`，now==effective_to 排除，租约到期停搜 |
| INV-PUBLIC-PROJECTION | Search/Snapshot 等 public 对象 closed + 显式 mapper，禁止 DB row spread；公开 Question 不含 query/HMAC/key version/晋级审核/EVD/内部 locator |

---

## 9. 修订

| 版本 | 日期 | 说明 |
|------|------|------|
| v1 | 2026-08-06 | 对抗评审后补：端口合同 + 发布状态机 + 同步 ACK |
| **v1.1** | **2026-08-06** | OVERLOADED、claims、cursor、snapshot 分页、publish 锁、INV-BYPASS |
| **v1.2** | **2026-08-06** | Phase1 flag/owner 硬门；无损迁移与 DEFINER ACL；rollback/withdraw/import outbox fencing；幂等 fencing；search/adoption 重试归属；中文 2-gram 落点 |
| **v1.3** | **2026-08-06** | OpenAPI 机器合同优先；生产 HTTPS；SQLSTATE/detail 稳定错误映射；16 分片限流规模门；首发未就绪、import 持久化/TypeScript worker/fenced finalize |
| **v1.4** | **2026-08-06** | 全 `/v1` 显式 503；`/ready` 增 storage；稳定分片 hash 金标；import 耗尽闭环；claim/heartbeat 独立短事务；公开 error_report 白名单 + diagnostic_id |
| **v1.5** | **2026-08-06** | 新增业务 `workorders` 端口与内部 `iteration-tasks` 路由；两域隔离、只读工单分析、CAS 待办流转、生产 OAuth 门进入可测不变量 |
| **v1.6** | **2026-08-06** | 工单 import worker 补齐专用 retry / reconciler；耗尽时 job + batch 原子失败，通用 outbox 禁止旁路终结本域任务 |
| **v1.7** | **2026-08-08** | CR-002：notice 首次告知；DLP suppressed/collection mode/platform provenance/expiry；知识来源与复核期贯通；telemetry-only stateless 降级 |
| **v1.8** | **2026-08-08** | 自动事实替代事后问卷；新增 parent/reselection、候选四元组不可变血缘、客户端 timeout、升级辅助多动作与 root/operation 双口径；Phase1 零在线复核/训练 API，语义资产仅受控离线晋级 |
| **v1.9** | **2026-08-08** | 文档收尾：中文检索合同直接由本文承载，解除对 44 历史终裁快照的规范性依赖 |
| **v1.10** | **2026-08-09** | 冻结客户端兼容与弃用合同：首个签名 Pilot 建立 N，从第二个版本起支持 N/N-1；N-1 至少 90 日且经清单/回滚门退出；破坏性变更走 /v2；补齐 Phase 1 伪造 native_integration 必须 403+零写入；明确 notices 归 auth 子能力、不增加第十端口；本次不新增请求字段或路由 |
| **v1.11** | **2026-08-09** | 冻结 CR-004 人读事务合同：四域 immutable source versions + release bindings 推导 canonical/current；永久暂停；文件行禁自报来源；import/publish/rollback/search fail-closed；原子来源切换/发布；独立拒绝审计；离线短租约到期停检索。33/OpenAPI 静态合同同批对齐，运行实现与证据待后续里程碑 |
| **v1.12** | **2026-08-09** | 收口 CR-004 announce/snapshot/ack：current 与分页快照只允许走受控 DEFINER 读取函数，补齐 source binding、offline lease、来源血缘与五参数 ACK 人读 wire；禁止 app_runtime 直读内容 SoR 底表。未改变公开路由，运行实现与真 PG 证据仍待后续里程碑 |
| **v1.13** | **2026-08-10** | 冻结 DEC-042 人读内容治理合同并与 schema v1.10 / OpenAPI 1.9.0 静态机器合同同批对齐：稳定 Question 身份/版本、显式平台与商品范围及 search product context、版本化 taxonomy、高风险最小枚举与双审、受控占位符、JCS 治理 hash 和分层质量门；运行实现/动态证据待 Ddev 后完成，G0 / Scope / Ddev 不变 |
| **v1.14** | **2026-08-10** | 对齐 DEC-042 静态机器事务边界：运行检索唯一调用 `search_recommendable_scripts`；Question 增 origin key version 与不可变复合版本；normalized row 不接审核/质量结论，内容审核与质量 plan/evidence 分别经受限 append-only 函数写入，finalizer 解析固定角色与双审异人；public wire 不扩审核主体 ID，运行/迁移/动态证据仍待 Ddev |
| **v1.15** | **2026-08-10** | Postfix 安全收口：总体 manifest 身份绑定、fixed ASCII-key JCS、from_log 来源资产单向退役、完整 snapshot + 客户端半开有效期、source denial reason 分账及 public closed mapper；Gate / G0 / Scope / Ddev 不变 |
| **v1.16** | **2026-08-21** | ENG-T1 修正：`announce_ack` 的来源门/离线租约拒绝纳入 runtime source-denial wrapper 与独立幂等审计；adoption/escalation 公共请求封闭未知字段；重算双哈希并重跑静态门与本机隔离 PG15 预检。只闭合合同冲突，不授权 runtime、G0、Ddev、部署或 Pilot |
