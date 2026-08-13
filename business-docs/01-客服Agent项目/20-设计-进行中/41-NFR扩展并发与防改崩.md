# 41 · NFR 冻结包 v1.13：可拓展 · 扛并发 · AI 可写 · 防改崩

> **状态：** **DESIGN ALIGNED · PENDING G0 / Ddev · NFR 目标合同（运行证据待实现/待复核）** · 2026-08-09\
> **效力：** 架构 NFR 权威；服从 [`37`](37-架构SSOT-v1.md) 产品红线；**本文管非功能与变更安全**\
> **配套：** [`39`](39-API合同与发布状态机-v1.md) · [`33`](33-schema-v1-草案.sql) · [`40`](40-架构图与关卡状态.md) · [`47`](47-CR-002搜索复制证据闭环.md) · [`48`](48-CR-002测试计划.md) · [历史自评 `42`](../99-历史/2026-08-06-架构设计收口/42-多视角架构再评分.md) · [历史终裁快照 `44`](../90-评审/2026-08-06_架构交叉验证终裁快照.md)\
> **评分口径：** v1.4 的 **10/10** 仅是历史设计目标/自评尺，属于**静态设计证据**；不是本次独立复核得分，也不等于**运行时证据**，不证明实现、压测或恢复演练已绿。\
> **明确不在本分内：** 实测压测绿、生产 G0 签字、真机 OAuth 联调（属实现/组织门禁，见 §9）
> **CR-004 边界：** 本版冻结来源治理、拒绝审计与离线短租约的 NFR 人读合同，33/OpenAPI 静态机器合同由同一 CR-004 changeset 对齐；迁移、生成类型、服务端/客户端代码与动态运行证据仍未实现。

---

## 0. 四条硬要求（冻结 · 历史 10 分目标定义）

| 要求 | 10 分定义（可检查） |
|------|---------------------|
| **可拓展** | 二期 rewrite / 向量 / 自动填 / auto_send **均有 SPI 合同**；稳定面与可换面表齐全；扩展不改浮窗与 SoR 语义 |
| **扛并发** | 50–150 有**容量模型 + 池化 + 限流 + 背压 + 发布锁 + 公告扇出**书面数字；幂等 SoR 表；无状态 API |
| **适合 AI 编写** | 端口字段/错误/游标/hash/claims **可照抄实现**；目录与禁止项；INV 测试清单可进 CI |
| **防改崩** | 核心路径 **DB 角色 + 发布函数 + CHECK + flag 默认关 + fail-closed**；旁路改 published 正文在规格层被否决 |

---

## 1. 可拓展（原 10 分目标）

### 1.1 稳定面 vs 可换面

| 稳定（改 = major / ADR） | 可换（adapter / 实现） |
|--------------------------|------------------------|
| 9 端口职责 · URL `/v1` · `work_order_*` / `iteration_task*` 分域 | FTS/BM25/分词实现 |
| SoR 实体语义 · INV-\* | 向量库选型、embedding 模型 |
| 发布状态机 · Answer 单源 | 飞书/Excel 解析 adapter |
| 每 release 四域不可变来源绑定 · 永久暂停 · 短租约到期停检索 | 受信来源解析 adapter、租约 token 的具体编码 |
| 禁代发 · 一期 rewrite=OFF | DeepSeek ranker 权重 |
| 剪贴板主 CTA 产品语义 | autofill 平台适配器 |
| CR-002 自动事实、重选父链、双口径与 G1a/G1b 分账 | 平台检测 fallback 实现；未来 `native_integration` |

### 1.2 租户策略（一期冻结，避免后期返工）

| 项 | 冻结 |
|----|------|
| 一期 | **单租户 / 单品牌**，`tenant_id = 'default'` |
| 预留 | **33 已落列**：话术 / 事件域含 `tenant_id='default'`；业务工单域以 `tenant_scope` 作为强制范围键 |
| 禁止 | 一期业务逻辑使用第二租户值；唯一键后续可升为 `(tenant_id, script_id)` ADR |

### 1.3 插件 SPI（二期/实验必须遵守）

#### A. `SearchBackend` + 冻结 DTO

```ts
type SearchQuery = {
  query_id: string
  parent_query_id: string | null
  interaction_reason: 'original' | 'reselection'
  query_text_redacted: string
  release_id: string          // 必须 = content_current
  top_k: 1 | 2 | 3
  platform: 'qianniu' | 'douyin' | null
  sku_hint: string | null
  tenant_id: 'default'        // 一期固定
}

type RankedHit = {
  script_id: string
  score: number               // 越高越优；NaN 禁止
  // 不得携带 answer_text；由 port 层从 release_items 填充
}

interface SearchBackend {
  search(q: SearchQuery): Promise<RankedHit[]>
  // 去重：同一 script_id 保留 score 最大的一条；再截断 top_k
  // 排序：score desc, script_id asc（稳定）
  onReleasePublished(release_id: string): Promise<void>
}
```

- **强制交集：** port 层只有在该 `release_id` 恰好具备 `presale/campaign/aftersale/product` 四条不可变 binding、条目来源匹配且四个 source version 均无永久暂停记录时，才可调用 backend；hits 的 script_id ⊆ 该 `release_id` 的 release_items，且 effective 窗内。任一条件失败整次 fail-closed，不得变成普通 no-hit。\
- **禁止：** 直查 `scripts` 旁路 snapshot。

#### B. `RankingStage`

```ts
type Candidate = {
  release_id: string
  script_id: string
  script_version: number
  content_hash: string
  title: string
  category: string
  answer_text: string         // 来自 release_items，只读
  score: number
}

interface RankingStage {
  timeout_ms: 400
  rerank(q: SearchQuery, candidates: Candidate[]): Promise<Candidate[]>
  // 输出必须同一 script_id 多重集；不得改 answer_text；可改顺序与 score
}
```

- `llm_ranker=true` 才加载；熔断：30s 窗错误率>50% 或连续失败 5 → OPEN 60s。

#### C. `ImportValidationWorker`（一期 Must）

```ts
type ImportValidatePayload = {
  import_batch_id: string
  source_type: 'csv' | 'xlsx' | 'feishu_api'
  source_ref: string            // import_batches.source_ref：共享持久存储/受信上游的不透明定位符，不是内容权威来源
  source_sha256: string
  source_size_bytes: number
}

interface ImportValidationWorker {
  runtime: 'typescript-node'
  job_type: 'import_validate'
  validate(payload: ImportValidatePayload): Promise<void>
}
```

- 一期必须实现独立 **TypeScript / Node worker**；Python 清洗 worker 仅为 Deferred，不能承担一期必经路径。
- 文件表头/行不得自报内容 `source_ref/source_version`；出现即整批拒绝。内容来源版本只由服务端受信 import 上下文冻结并附加，worker payload 与文件行都无权覆盖。
- API 只在原文已持久化，且 `import_batches + outbox_jobs` 同事务提交后返回 202；worker 不接收进程内临时文件指针。
- worker 仅经 `claim_content_import_validation` 领取，长任务经 `heartbeat_content_import_validation` 续租，重试经 `retry_content_import_validation`；三者均硬绑 `import_validate`，返回的 `lease_version` 是 fencing token。
- `finalize_content_import_validation(...)` 必须在单一 DB 事务中完成 `staging_scripts + import_batches 终态 + outbox complete` 的 fenced finalize；失租/取消后旧 worker 整个事务回滚，不得直写终态补偿。
- `app_import_worker` 仅获得 import 专用 claim/heartbeat/retry/finalizer 的 EXECUTE；不得获得通用 `outbox_complete` 或 staging/batch/outbox 直接 DML。

#### C2. `WorkOrderImportWorker`（一期 Must · 独立 capability）

```ts
type WorkOrderImportPayload = {
  import_batch_id: string
  tenant_scope: 'default'
  source_ref: string
  source_sha256: string
  source_size_bytes: number
  mapping_version: string
}

interface WorkOrderImportWorker {
  runtime: 'typescript-node'
  job_type: 'work_order_import_validate'
  validateAndNormalize(payload: WorkOrderImportPayload): Promise<void>
}
```

- 可与内容 worker 同进程部署，但必须使用 `app_work_order_worker`、独立 job type / object prefix / tables / finalizer；不得取得 `app_import_worker` 能力。
- 领取、续租、重试和收口分别只经 `claim_work_order_import_validation`、`heartbeat_work_order_import_validation`、`retry_work_order_import_validation`、`finalize_work_order_import_validation`；claim 前由 `reconcile_exhausted_work_order_imports` 有界回收毒任务。
- 输出仅为 39/33 的白名单标准化字段；任意 raw row JSON、原始客户 / 订单 / 工单编号、未知列和敏感列均 fail-closed。
- `finalize_work_order_import_validation(...)` 必须在同一 fenced 事务写 records、batch 终态与 outbox complete；旧 lease 不得补写。
- retry / reconciler 必须按 batch → outbox 锁顺序原子写 `job=dead + batch=failed + diagnostic_id`；通用 outbox claim/retry/complete 不得直接终结本域任务，禁止永久 `validating`。
- 本域无班牛写凭据、写 SPI 或副作用；未来写回必须另开 ADR、Scope 和 API major version。

#### D. `RewriteWorker`（二期）

```ts
// outbox_jobs.job_type = 'rewrite_candidate'（33 已枚举）
type RewriteJobPayload = {
  source_query_id?: string
  source_script_id?: string
  proposed_text: string
  model: string
  prompt_hash: string
  tenant_id: 'default'
}
// claim: UPDATE outbox_jobs SET status='running', lease_owner=$id, lease_expires_at=now()+60s
//        WHERE status='pending' OR (status='running' AND lease_expires_at < now())
//        RETURNING * LIMIT 1
// 产出 → rewrite_logs(pending_review) 或 staging；禁止直写 search 路径
```

#### E. `PlatformAdapter`（平台上下文只读候选）

```ts
type PlatformDetectContext = {
  trigger_id: string
  trigger: 'search_hotkey' | 'search_submit' | 'manual_check'
}

type PlatformHint = {
  detected_platform: 'qianniu' | 'douyin' | null
  platform_source: 'foreground_process' | 'native_integration' | 'unknown'
  user_confirmation_required: true
}

interface PlatformAdapter {
  readonly id: 'foreground_process_allowlist' | 'native_qianniu' | 'native_douyin'
  detectAtUserIntent(context: PlatformDetectContext): Promise<PlatformHint>
}
```

- 仅在用户主动触发搜索热键、提交搜索或点击平台检查时执行一次；允许按本地签名 allowlist 识别前台**进程标识**，禁止后台轮询、读取窗口标题、聊天正文、剪贴板内容/历史或键盘输入。
- 返回值只是候选，不得直接写 `query_events`、canonical `platform` 或其他 SoR；Phase 1 一律 `user_confirmation_required=true`，用户确认后也只允许按 39/33 的 `manual|foreground_process|unknown` 三态写入。
- `native_qianniu/native_douyin` 在 Phase 1 不注册、不加载；客户端无论是否声称已确认，只要提交 `platform_source=native_integration`，服务端都必须返回 403 `POLICY_DENIED` 且 query/impression/event 零写入。未来启用前必须同时具备 ADR、Scope、平台权限/数据合同、Security Owner 证据与服务端受信 adapter。
- adapter 不得自动发送、写回外部平台或绕过 `PushAdapter`；超时/异常只返回 `unknown` 或 `null`，不得阻塞手选。

#### F. `PushAdapter`

```ts
type PushMethod = 'clipboard' | 'autofill' | 'failed' | 'pending'

interface PushAdapter {
  id: 'clipboard' | 'autofill_qianniu' | 'autofill_douyin'
  push(text: string): Promise<{ ok: boolean; method: PushMethod }>
}
```

- 主 CTA 绑定 clipboard（§4.5）；`autofill_adapter=false` 不加载模块。

#### G. `AutoSendChannel`（三期）

- 独立 ADR + `/v2`；`auto_send=false` → 403。

### 1.4 扩展检查单（PR 必过）

- [ ] 新能力落在 adapter 或新 flag，而非改 `answer_text` 语义\
- [ ] 若新 HTTP 字段：先改 39\
- [ ] 若新表：先改 33 + 迁移\
- [ ] 浮窗仍只消费 `candidates[].answer_text` 形状\
- [ ] 平台 adapter 只产候选，不写 SoR、不自动发送；`native_integration` 未经 ADR/Scope/安全批准不得加载\
- [ ] 客户端/API 变更符合 39 §0.3 的 `N/N-1` 支持窗；破坏性变更走 `/v2`\

---

## 2. 扛并发（原 10 分目标；设计态容量合同）

### 2.1 容量模型（冻结数字）

| 项 | 设计值 |
|----|--------|
| 同时在线坐席 | **50～150** |
| 活跃突发检索 | 按 **2 QPS/活跃坐席 × 150 = 300 QPS** 作短突发**压测目标**；压测前不得宣称已承载 |
| 复制事件写（adoption 兼容名） | ≤ search 同量级；按 query_id 幂等 |
| 升级辅助动作写 | ≤ search × 3；按 `(query_id,action)` 幂等，同 query 多动作且非终态 |
| 发布 | ≤ **5/min 全站**；**全局单飞** |
| API 实例 | 一期建议 **2**（可 1）；会话不在进程内 |
| 单实例 search 应用内预算 | p95 **< 300ms**（仅 API 内部检索/排序，不含网络与可选 LLM）；用户端到端目标以 [`43` L15](43-技术栈全景清单-部署向.md#l15--可观测性--运维--稳定性observability--sre) 的 800/1200ms 为准，仍待实现与压测取证 |

### 2.2 连接池与超时（实现必遵）

| 参数 | 值 |
|------|-----|
| 每 API 实例 `pool.max` | `min(20, ceil(150 / instance_count) + 5)`；**2 实例 → 各 20 可接受，合计 ≤ 40** |
| Postgres `max_connections` | ≥ `pool.max * instance_count + 10`（超管/迁移保留） |
| `connectionTimeoutMillis` | 2000 |
| `statement_timeout` | search/events **3s**；publish **30s**；metrics **5s** |
| `idle_in_transaction_session_timeout` | 10s |
| 禁止 | 请求内 `new Client()` 无池；长事务包住 LLM HTTP |

### 2.3 限流与背压（与 39 一致并补全）

| 路由 | 限流 |
|------|------|
| `POST /v1/search` | **30/min/user**；全站 **500/s 保护上限**，不是吞吐认证 |
| `POST /v1/events/*` | **60/min/user** |
| `POST /v1/content/publish` | **5/min/owner** + **全站单飞** |
| `GET /v1/metrics/*` | **20/min/user**；`metrics/tool` 强制 `0 < to-from ≤ 7 天`，越界 400，不静默截断 |
| `POST /v1/work-orders/imports` | **5/min/user**；coach / owner；文件大小与批次 cap 由 DEC-WORKORDER-01 冻结 |
| `GET /v1/work-orders/*` | **20/min/user**；coach / owner；分析窗 `0 < to-from ≤ 31 天` |

输入预算同样是 DoS 边界：所有 JSON body 在解析前上限 **32 KiB**；search 原始 `query_text` 按 Unicode code point **1～500**、非空 `sku_hint` **1～128**。超限必须在 redaction、2-gram、HMAC 与可选 LLM 之前返回 400 `VALIDATION`。
| `GET /v1/announce/snapshot` | **10/min/client**；响应可缓存 |

| 背压条件 | 响应 |
|----------|------|
| 池等待获取连接 > **200ms** | **503** `OVERLOADED` + `Retry-After: 1` |
| 进程内 search 并发槽满（默认 **64**/实例） | **503** `OVERLOADED` |
| 限流触发 | **429** `RATE_LIMITED` |

#### 2.3.1 PostgreSQL 限流的规模边界

- search 的近似全局桶固定为 16 分片：`global:{route}:{shard_00..15}`，`shard=stable_hash(user_id)%16`；每分片 `capacity=32` / `refill=31.25/s`，合计约 500/s。
- 这是一期保护性近似算法：分片倾斜可以早限流，不得把其宣传为精确全局计数或 500 QPS 实测能力。
- **DEC-CAP-01 升级门：** 坐席 >150、目标突发 >300 QPS、限流行锁等待 p95 >10ms 持续 5min，或分片倾斜造成业务不可接受的误限流，任一成立就必须切公司网关/Redis 等原子实现并重跑容量测试。

### 2.4 发布并发（DB 级）

```text
-- 非阻塞；失败立即 CONFLICT（禁止用阻塞版 pg_advisory_xact_lock 冒充快速失败）
got := pg_try_advisory_xact_lock(hashtext('cs_ai_content_publish'));
IF NOT got THEN raise CONFLICT; END IF;
-- 然后 publish_content_release(...) 事务体
```

- 第二并发：**立即 409**，不排队。\
- `release_seq`：`content_release_seq`（33）。
- publish 获得单飞锁后必须以单条条件更新 `staged → publishing` 并校验受影响行数=1；cancel 也只能原子争抢 `validating|staged → failed`。两者禁止 API 层先 SELECT 后 UPDATE，竞态中只能一方成功。
- CR-004 来源切换不得另起可变 current-source 事务。完整 MERGE 候选校验、新 release、`presale/campaign/aftersale/product` 四条 immutable bindings、`content_current`、announcement 与 change audit 必须在这一个 publish/rollback 单飞事务中同成同败；任一步失败旧 current 保持不动。

### 2.5 公告扇出（防羊群）

| 规则 | 冻结 |
|------|------|
| `GET /v1/announce/current` | 可 **Cache-Control: max-age=10**；客户端启动 + **抖动 0–15s** 轮询 |
| snapshot | **分页**：`limit` 默认 200，`cursor=script_id`；禁止无分页一次拉全库 |
| ETag | `W/"release_seq"`；匹配则 304 |
| offline lease | current 签发绑定 `client_id/user_id/release_id/source_binding_hash` 的 opaque 服务端短租约（默认 600 秒、允许 60～900 秒，DB 只存 token hash）；snapshot 每页验租，ACK 验租但不续期；离线客户端到期立即停本地检索，取得新租约前无宽限/旧快照 fallback |
| 事件上送 | 客户端 outbox；服务端 `idempotency_keys` 或 query_id PK 去重 |

### 2.5.1 幂等事务边界（防崩溃后重复副作用）

- 同步 DB 写（至少 publish / rollback / adoption）必须在**同一 DB 事务**内完成 `idempotency_claim → 业务写 → idempotency_complete → COMMIT`；中间禁止外部 HTTP/LLM/文件 I/O。
- 异步工作若必须跨事务，claim 必须返回 `lease_version` fencing token；heartbeat/complete 均校验 `lease_owner + lease_version + status=running`，旧 worker 不得覆盖新 claimant。
- lease 必须大于端到端超时并可续租；`expires_at` 到期清理由独立任务完成，不能在业务请求中静默丢幂等历史。
- replay 在 rate-limit 扣减前返回；同 key 异 body 永远 409。精确状态机与签名见 39 §0.2 / 33。

### 2.5.2 import 持久 outbox（一期 Must）

| 阶段 | 不变量 |
|------|--------|
| 上传 | 原文先写入对象存储或共享 RWX 持久卷，确认 key/hash/size 可重读 |
| 受理 | `import_batches(validating)` + `outbox_jobs(import_validate,pending)` 同事务提交后才 202 |
| 执行 | TypeScript worker 使用 claim + heartbeat + `lease_version`；任务不依赖 API 进程内存 |
| 收口 | `finalize_content_import_validation` 在同事务完成 staging + batch + outbox complete；lease 不匹配时全回滚 |
| 部署 | 多实例只允许 object/RWX；filesystem 只允许单主机 API+worker 共卷 profile |

业务工单导入复用上述持久性原则，但使用 `work_order_import_batches + outbox_jobs(work_order_import_validate)`、独立 capability 和 `finalize_work_order_import_validation`；内容 staging 与业务工单 records 不得交叉写入。

### 2.6 明确不承诺（不扣 NFR 设计分）

- 未跑压测前，**不得**对外写「已通过高并发认证」。\
- 万级坐席 / 多活 = 另 ADR。\
- **本分 10 = 设计合同无洞**；压测绿 = 测试关另计。

### 2.7 数据增长包络与 EXPLAIN 门

> 下表是容量演算基线，不是业务预测或已压测事实。

| 项 | 一期规划包络 |
|----|----------------|
| 平均检索假设 | 150 在线坐席 × 0.05 QPS/座席 × 12 活跃小时 ≈ **324,000 query/day** |
| impression 上界 | 每 query 最多 3 候选，约 **972,000 rows/day** |
| 30 天热数据演算 | 约 **9.72M query_events + 29.16M candidate_impressions**；必须连同 idempotency/outbox/client_sync 增长一起造数 |
| 突发演算 | 300 QPS 持续 60s = 18,000 queries；单独验证池、限流分片、WAL 与写放大 |
| 业务工单数据 | **不得猜日量 / 月量**；由 DEC-WORKORDER-01 用真实导出样例冻结单文件行数、月批次、热保留、导出 cap 与聚合查询包络 |

- **DEC-DATA-01：** Owner + Tech Owner + 隐私责任人必须在生产开启 metrics 路由前签字确认 hot retention、归档/删除、分区或汇总策略；签字前 30 天只是演算基线，不自动变成数据保留授权。
- 生产放行前必须在不小于上表 30 天事件量（或等价分布统计）上对 search、metrics、snapshot 分页、outbox claim 执行 `EXPLAIN (ANALYZE, BUFFERS)`；工单分析另按已签包络验证 import、analysis、records cursor、export，归档 plan 与参数。
- 任一关键查询 actual total time ≥3s、出现不受约束的全历史扫描、临时盘 spill，或超出连接池/WAL 预算，都必须通过索引、分区、预聚合或缩短 retention 修复后重跑。顺序扫描本身不自动失败，但必须证明扫描边界受时间分区/小维表约束。

### 2.8 一期可观测合同

| 信号 | 最小门槛/动作 |
|------|---------------|
| `outbox_pending_oldest_seconds{job_type}` | >120s warning，>600s critical；至少按 content import / work-order import / rewrite 分类 |
| `outbox_dead_total` / `outbox_lease_lost_total` | dead 增量 >0 告警；lease lost 5min 内≥3 调查 worker 超时/重抢 |
| `worker_heartbeat_age_seconds` | >2 倍 lease 告警，禁止靠手工改 complete 消警 |
| `client_release_lag` / `client_last_ack_age_seconds` | 在线客户端 p95 落后 >1 release 持续 15min 告警，可定位 snapshot 失败 |
| `content_current_present` | 首发前 readiness=false；首发成功后从 1 变 0 立即 critical |
| `import_storage_readable` / 容量 | 不可写或不可重读时 readiness=false，不受理 202 |
| `work_order_import_*` / `work_order_export_*` | 未批准列=0、敏感列=0、外部写回=0；任一非零立即停用本域并保全审计 |
| `rate_limit_lock_wait_ms` + 分片拒绝分布 | p95 >10ms 持续 5min 或倾斜不可接受 → DEC-CAP-01 |
| `content_source_binding_invalid_total{reason,domain}` | 任一增量告警；来源缺失/重复/hash-EVD 不匹配必须阻断 import/publish/rollback/search，不能归为 no-hit |
| `content_source_suspended_denied_total{operation,domain}` | 任一增量保全独立拒绝审计；旧 source version 永久不可恢复，禁止人工改状态消警 |
| `content_denial_audit_commit_failed_total` | 任一非零 critical；管理写动作保持 fail-closed，先修复审计持久层，不允许先放业务 |
| `client_snapshot_lease_expired_total` | 监测离线停检索是否执行；到期仍产生本地 search 为安全事件 |

- 链路日志至少携带 `request_id`，并按路径连接 `query_id | import_batch_id | job_id | release_id | client_id_hash`；禁止原 query、token、原始文件路径与未脱敏 outbox error。
- 看板必须同时展示延迟、错误、积压和数据新鲜度；只看 API 2xx 不能代表 import 或客户端同步正常。

### 2.9 备份、恢复与积压重放

| 恢复对象 | 必须纳入 |
|----------|----------|
| PostgreSQL | 包含 release/current、四域 source versions/bindings、永久 suspension、独立 denial audit、idempotency、outbox、client_sync、iteration_tasks 与批准的 work_order_* 的一致备份/PITR，及已证明可执行的 restore 脚本 |
| import 原文 | 内容与工单对象分前缀 / 分保留期；通过 source_sha256 校验 DB 引用与文件一致；过期原稿按批准规则可证明删除 |
| 部署物 | 锁定版本、迁移、配置 schema、签名的 Electron 安装包/更新元数据；secret 只备份引用/恢复流程，不落入业务备份 |

恢复顺序冻结为：停 import/publish 受理 → 恢复 PG 和存储到一致点 → 先验证 current release 的四域 bindings 与永久 suspension/denial audit 连续性 → 逐个 hash 验证待重放原文 → 用受控管理函数递增 lease_version 并将确认可重放的 running job 回收为 pending → 启动 TypeScript worker 清积压 → 验证 current/release 快照与公告 → 作废灾前客户端短租约并要求固定 release 全量重同步。禁止直改来源暂停、outbox complete/batch staged 或延长旧租约“做绿”。

RPO/RTO 数字由 Owner + Tech Owner 在 G0 前签字；在真实备份恢复、outbox 重放和客户端重同步演练成功前，不得声称 RPO/RTO 已达标。

### 2.10 CR-002 数据、降级与扩面 NFR

| 项 | 冻结目标 |
|----|----------|
| 语义真实性 | 自动事实仅为脱敏问法、不可变候选、唯一 adoption terminal 与升级辅助动作；不得推断发送、正确、满意或外部接单 |
| 重选 / timeout | reselection 新建 query 并链接同用户已终态 parent，父链无环；timeout 只由可配置 `CLIENT_ACTION_TIMEOUT_MS` 生命周期触发 |
| 平台识别 | canonical `platform` 在 Phase 1 必须经用户确认；直接手选/修正=`platform_source=manual`，接受热键瞬时 `detected_platform` 提示=`foreground_process`，提示本身非自动真源；禁止定时轮询、窗口标题与剪贴板历史 |
| telemetry 降级 | 仅 telemetry / event API 不可用时允许 `collection_disabled/stateless` 安全搜索；全链排除指标、语料候选、REAL-FWD 与 G1b 分母，并在 UI 明示 |
| 安全阻断 | DLP、Auth 或当前内容快照不就绪继续 fail-closed；不得借 stateless 绕过 |
| 数据最小化 | raw 问法仅受控内存；运行表只允许 0/14/30 天获批档，建议正文 14 天/事件 30 天，均须 G0-11 签发后才生效 |
| 角色 | `agent / coach / owner` 保持业务角色；审核、隐私、排障是附加 capability，需 scope / 时限 / 审计 |
| Phase 1 | 无在线复核/训练 API；只生成人工审核候选。语义晋级须 source_query_id + EVD；teacher/dataset/embedding 只走 49/50 受控离线 artifact |
| 训练预埋 | 在线只走 bigram；EmbeddingProvider 仅离线影子；DeepSeek adapter 可替换且默认关；GLM 无书面蒸馏许可禁用；批次须 purpose-lock、train/eval 隔离、删除 manifest、预算 cap |
| 样本分账 | G1a 固定独立 `20+12+18`；REAL-FWD 只用于 G1b / 扩面，禁止回填 G1a 或调参集 |
| 人数 / 容量 | 最低 3、计划 4（2 新+2 老）、允许 3～5；业务扩面 50～100；既有 50～150 / 300 QPS 架构包络不降低 |

CR-002 不增加新的业务端口；parent/reselection、候选四元组、唯一 terminal、升级辅助动作和双口径与契约测试的静态机器合同已对齐。实现、注册真实数据路由、生成/执行迁移和动态测试仍须等待 Ddev。

### 2.11 CR-004 来源治理、拒绝审计与离线租约 NFR

| 项 | 冻结目标 |
|----|----------|
| 来源不可变 | source version 与 release binding 均只追加；每 release 恰好四域各一条 `use_class=canonical` binding，未登记/reference 来源拒绝，canonical/current 仅从 current release 推导 |
| 永久暂停 | suspension 只有追加事实，不存在恢复、更新或删除动作；旧 source version 一经暂停永久不可再进入任一业务链，恢复业务必须新版本 + 新 release |
| 全链拒绝 | import/publish/rollback/search 任一步发现来源未登记或仅供 reference、绑定缺失/重复、条目来源不匹配、hash/EVD 不一致或永久暂停即整步 fail-closed，不得部分发布、过滤回滚或返回普通 no-hit |
| 来源切换原子性 | 新 source version 的选择只随新 release 发布生效；release、四域 bindings、current、announcement、change audit 同事务，禁止先切来源后发布 |
| 拒绝审计 | import/publish/rollback/search/current/snapshot/ack 的来源/租约拒绝在主事务失败/回滚后，以独立幂等短事务提交最小 denial audit，且先 commit 再返回 HTTP denial；同事务先 INSERT 再 RAISE 的实现不合格。审计失败时管理写动作继续拒绝 |
| 离线安全 | snapshot 使用绑定 `client_id/user_id/release_id/source_binding_hash` 的服务端短租约（默认 600 秒、60～900 秒）；到期停止本地 FTS/search，联网重新核验 current release + 四域 bindings 并取得新租约后才恢复；ACK 不续租 |

拒绝审计只允许 `denial_key/operation/reason_code/actor_subject_hash/hash_key_version/actor_role/release_id/source_version_id/source_binding_hash/diagnostic_id/committed_at`；`source_version_id` 必须是安全 `srcv_*` 标识，禁止 `source_ref`、正文、raw query、上传原文、内部路径、token、SQL 或栈。CR-004 changeset 已在 39/33/OpenAPI/46 静态合同冻结 source/denial 表与 reason enum，以及 opaque 离线租约的 60～900 秒包络、绑定字段和只存 token hash；时钟偏差动态负例、迁移、生成类型、服务端/客户端代码与动态测试仍标记 `NOT IMPLEMENTED`。

---

## 3. 适合 AI 编写（原 10 分目标）

### 3.1 工程规则

| 规则 | 说明 |
|------|------|
| 合同先于代码 | 新字段/路由先改 39 |
| 一 PR 一面 | 仅一个 port **或** 一个 adapter |
| 严格 TS | `strict: true`；handler 入参出参与 39 同名 |
| 禁止 | renderer 直连 DB；main 进程写业务 SQL；复制第二套 publish |
| AI 生成代码 | autofill/DeepSeek **仅** `adapters/`，默认不注册 |

### 3.2 目录与依赖方向

```text
apps/desktop/                 # 只 UI + IPC 调 API
apps/api/
  src/ports/{auth,search,...}/  # 可依赖 domain + infra
  src/adapters/                 # 只被 ports 调用；禁止反向依赖 ports 内部
  src/domain/                   # 纯函数，零 I/O
  src/infra/postgres/           # 唯一 SQL 出口
```

依赖单向：`ports → domain|adapters|infra`；`adapters ↛ infra.scripts 直写`；`infra` 不依赖 ports。

### 3.3 实现者零发明字段合同

| 主题 | 冻结 |
|------|------|
| **content_hash** | `sha256(utf8(answer_text))` 小写 hex；**不含** title |
| **redaction** | 连续 11 位手机、15/18 位身份证 → `[REDACTED]`；可扩展但不得弱化 |
| **import 列** | 见 39：script_id, category, title, answer_text, question_text?, effective_*?, platform_scope?；文件不得出现内容 `source_ref/source_version`，来源只由服务端受信上下文附加 |
| **CR-004 来源模型** | immutable source versions + 每 release 四域 immutable bindings；current/canonical 为推导值；suspension/denial audit 只追加，禁止可变 current/suspended 布尔真源 |
| **work-order 列** | 仅 `source_record_hash, category, issue_type, product_ref_hash, channel, record_status, opened_at, closed_at, handling_seconds, error_type, escalated, quality_tags, normalization_version`；无 raw row / 原编号 |
| **两域 ID** | 业务工单=`record_id/import_batch_id`；内部待办=`task_id`；禁止 `ticket_id` 与交叉复用 |
| **metrics cursor** | 不透明字符串：`base64url(iso_created_at + "|" + query_id)`；下一页 `created_at < cursor_ts OR (eq AND query_id < cursor_id)` 倒序 |
| **snapshot cursor** | `script_id` 字典序；`WHERE script_id > $cursor ORDER BY script_id LIMIT n` |
| **Feishu claims（最小）** | JWT/session 解析后必须得到 `{ user_id, role ∈ {agent,coach,owner} }`；缺 role → 403 |
| **Mock auth** | Header `X-Mock-User` + `X-Mock-Role`；每请求日志 `[AUTH_MOCK]`；Pilot / 生产构建拒绝 |

### 3.4 CI 门禁清单（设计强制 · 实现挂接）

| 测试 ID | 断言 |
|---------|------|
| INV-NR | search 返回 answer === 当前 release_items.answer_text |
| INV-EFF | 过期 script 不在 candidates |
| INV-ADOPT | adopted + failed push → 4xx 且 DB 拒绝 |
| INV-PAD | candidates.length ≤ 真实命中，不垫到 3 |
| INV-REL | publish 后 current + announcement + release_items 同在 |
| INV-FB | llm 超时仍 200 + FTS 序 + 有 query_events |
| INV-RL | 超限 429 |
| INV-PUB-LOCK | 并发 publish 仅一成功 |
| INV-CTA | （UI）主按钮文案/data-testid=`cta-clipboard` |
| INV-FIRST-REL | 无 current release 时 search/current 503 `CONTENT_NOT_READY`，业务 readiness=false |
| INV-IMPORT-DURABLE | 存储持久 + batch/outbox 同事务前不返 202；多实例本地路径拒启 |
| INV-OUTBOX-FENCE | 失租旧 worker 的 staging/batch/complete 整事务回滚 |
| INV-CANCEL-PUBLISH | staged batch 的 cancel/publish 用 DB 原子条件更新争抢，仅一方成功 |
| INV-ELECTRON-BOUNDARY | 非 allowlist sender/navigation/window/openExternal/permission 全拒绝，无 nodeIntegration 旁路 |
| INV-TASK-DOMAIN/CAS | iteration-task 不接业务工单明细；start/close 只走合法迁移并匹配 expected_version |
| INV-WO-DOMAIN/ALLOWLIST | `/work-orders/*` 只访问 `work_order_*`；未知 / 敏感 / raw / 原始编号零入库、零日志、零默认出域 |
| INV-WO-IDEM/RO/RBAC | 同 hash+mapping 不重复；无外部写回；agent 全拒绝，导出只追加审计 |
| INV-AUTH-PROD | Pilot / production 非 Feishu、缺验签或注册 mock-login 时监听前拒启 |
| INV-SOURCE-BINDING/SUSPEND | 每 release 四域各一 binding；旧 source version 一经暂停永久无法 import/publish/rollback/search，恢复只能新版本 + 新 release |
| INV-SOURCE-ATOMIC/DENIAL-AUDIT | 来源切换/发布全事务原子；业务拒绝回滚后 denial audit 独立幂等提交，审计失败继续 fail-closed |
| INV-OFFLINE-LEASE | 短租约有效时可离线读；到期立即停本地检索，ACK 不续租，联网取得新租约后恢复 |

结构测试：`tests/test_arch_ssot_invariants.py` 必须继续断言本文与 33/39 关键实体。

---

## 4. 防改崩（原 10 分目标）

### 4.1 红线模块

| 模块 | 允许 | 禁止 |
|------|------|------|
| search | 换 SearchBackend / RankingStage | 旁路 release_items；关有效期；改 answer |
| events | 兼容加字段 | 假 adopted |
| iteration tasks | 加只读投影 / 信号 | 连接业务工单明细；绕过 version CAS；自动改 Answer |
| workorders | 加批准聚合字段 / adapter | raw row、未知列、原始编号、外部写回、与 iteration_task 混表 |
| content.publish | 加强校验 | 非事务多步；跳过冻结 snapshot |
| policy | 受控开 flag | 默认 ON 危险开关 |

### 4.2 DB 防旁路（规格强制 · 33 已给 DDL）

| 规则 | 说明 |
|------|------|
| 角色 | `app_runtime`：见 33 文末部署 ACL；**无** release_items/content_current/policy_flags 直接写权限；迁移先撤销 `PUBLIC EXECUTE` |
| 发布/回滚 | **仅** `publish_content_release(...)` / `rollback_content_release(...)` SECURITY DEFINER；内含 try 锁 + `app.publishing=on` |
| import 收口 | 内容仅 `finalize_content_import_validation(...)`；工单仅 `finalize_work_order_import_validation(...)`；两 worker 分 DB role，无通用 `outbox_complete` 与表直写权 |
| 待办状态 | `start_iteration_task` / `close_iteration_task` + guard/audit；app_runtime 无 UPDATE 旁路 |
| 工单导出审计 | 仅 `record_work_order_export` 追加；app_runtime 无 audit UPDATE/DELETE |
| CR-004 来源治理 | future migration 必须使 source versions / release bindings 不可变，source suspension 与 denial audit 只追加；app/runtime/worker 均无 UPDATE/DELETE 暂停事实或直接改 current 来源的权限 |
| 触发器 | `scripts_protect_published` + `release_items_immutable` |
| 策略写 | **仅** `set_policy_flag` + API `POST /v1/policy/flags` |
| 快照完整 | `release_items` 含 answer + questions_json + platform/sku scope |

### 4.3 Feature flag（默认）

| flag | 默认 | 失败 |
|------|------|------|
| rewrite | false | 403 |
| auto_send | false | 403 |
| autofill_adapter | false | 不加载 adapter |
| llm_ranker | false | 跳过 rerank |
| metrics_experimental_kpi | false | 不计算 |

一期 `/v1` 对 `rewrite=true` / `auto_send=true` **无条件 `POLICY_DENIED`**；Owner 与 ADR 也不能越过期别。二/三期须以版本化迁移替换 DB 函数、独立 ADR、Owner 审批与 change_audits 一起开放。

`AUTH_MODE` 是部署配置中的鉴权模式唯一真源，**不是** `policy_flags` 键；Pilot / production 构建必须为 `feishu`，且不得注册 mock-login 路由，否则在监听端口前拒绝启动。

**身份边界说明：** Feishu token → role 的真实性由 API 鉴权层负责；DB 函数参数只作审计与防误用，不能宣称可独立认证终端用户。生产必须用专用 DB、撤销 PUBLIC schema/function 权限，并仅向受控 runtime role 授权。

### 4.4 Fail-closed

- LLM 失败 → FTS，不 5xx 整单（除非 FTS 失败）\
- autofill 失败 → failed，不计 adopted\
- publish 失败 → 不移动 content_current\
- 首次 owner 发布前无 `content_current` → search/current 返 503 `CONTENT_NOT_READY`，业务 readiness=false；禁止空 release 和 scripts 旁路\
- import 持久存储不可写/不可重读 → 拒绝受理，不返 202\
- 工单映射版本 / 字段白名单 / 保留期 / Security EVD 缺失 → `/work-orders/imports` 不注册；只允许合成 / 批准脱敏原型\
- 工单 worker 看到未知 / 敏感列或 raw 字段 → 整批 fail-closed；不得“先入库后清洗”\
- CR-002 telemetry / event API 单独失败 → 可降级 `collection_disabled/stateless` 安全搜索并排除指标 / 语料 / G1b；不得把它等同 DLP 失败\
- CR-002 DLP、Auth、当前内容快照失败 → 继续 fail-closed，不得搜索或借 stateless 绕过\
- CR-004 文件行自报来源、四域 binding 缺失/重复/不匹配、来源已有永久暂停记录 → import/publish/rollback/search 整步 fail-closed，不得忽略、部分发布、过滤回滚或返回普通 no-hit\
- CR-004 来源切换/发布任一步失败 → 旧 current 与旧四域 bindings 不动；拒绝审计只能在主事务回滚后独立幂等提交，审计失败时管理写动作继续拒绝\
- 客户端 snapshot 短租约到期 → 本地 FTS/search 立即停用；必须联网重新核验并取得新租约，不允许宽限或静默使用陈旧内容\
- 未知 flag → `400 VALIDATION`（禁止静默拼写错误）\

### 4.5 UI 主 CTA 合同（防产品回归）

| 项 | 冻结 |
|----|------|
| 主按钮 `data-testid` | `cta-clipboard` |
| 主按钮可见文案 | 必须含「复制」或「剪贴板」之一 |
| 自动填 | 不得使用 primary 按钮样式令牌；不得默认聚焦 |
| Toast | 禁止「已发送」；允许「已复制」 |
| 重选 | 再选/再搜新建 query 并带 parent/reselection；不得覆盖上一条事件 |
| timeout | 窗口关闭/切后台/idle 达 `CLIENT_ACTION_TIMEOUT_MS` 才上报；不得显示“系统确认已发送/正确” |

### 4.6 PR 熔断清单

- [ ] 单 port/adapter\
- [ ] 39/33 已更新（若接口/表变）\
- [ ] CR-002 变更先对齐 47/48；机器字段 / 路由变化必须同一变更更新 39/33/OpenAPI，未更新时只保留设计不得注册路由\
- [ ] INV-\* 相关测试计划\
- [ ] 新 flag 默认 false\
- [ ] 未直接 UPDATE published answer_text\

### 4.7 Electron 安全基线合同（一期 Must）

- renderer 必须 `contextIsolation=true`、`sandbox=true`、`nodeIntegration=false`；preload 通过 `contextBridge` 暴露最小、每消息单职责 API，禁止通用 `send(channel, ...args)`。
- 每个 IPC handler 在业务校验前校验 `event.senderFrame` 的 origin/URL 与预期 WebContents；payload 经 schema 校验，不信任 renderer 传入路径、role 或 shell 参数。
- 限制性 CSP 至少禁止任意远程脚本/eval；导航、新窗口、`shell.openExternal` 均使用精确 allowlist，非 HTTPS/非预期 host 不得打开。
- `session.setPermissionRequestHandler` 与 permission check 默认 deny，只对确认的 origin + 必要权限显式允许；生产页面用受控 custom protocol，不直接依赖 `file://` 特权语义。
- 构建时启用并验证 Electron fuses（禁用外部 `ELECTRON_RUN_AS_NODE`、禁用未打包 app 加载等）；固定受支持 Electron 版本，安全补丁升级须通过回归。
- Windows 安装包和更新包必须签名，更新元数据签名校验、防降级且保留可回滚的上一已签名版本；验签失败只中止更新，不运行未签名产物。

---

## 5. 与 33 / 39 落点索引

| NFR 项 | 落点 |
|--------|------|
| 幂等表 | 33 `idempotency_keys` · 39 §0.2 |
| outbox / import worker | 33 `outbox_jobs` · 39 import · 本文 §1.3C/§2.5.2 |
| work-order worker / 两域 | 33 `work_order_*` / `iteration_task*` · 39 §4A · 本文 §1.3C2/§3.4/§4.2 |
| 共享 import 存储 | 39 import · 本文 §2.5.2 |
| flags | 33 `policy_flags` · 39 `/v1/policy` |
| 限流/429/503 | 39 §0.1 · 本文 §2.3 |
| Answer 单源 | 39 search · INV-NR |
| LLM 熔断 | 39 §2 · INV-FB |
| release_seq | 33 SEQUENCE · 本文 §2.4 |
| 发布锁 / 防旁路 | 33 可执行 ACL + DEFINER 函数 + 触发器合同 · 本文 §4.2 |
| 游标 / claims / hash | 本文 §3.3 · 39 |
| SPI | 本文 §1.3 |
| 数据增长 / EXPLAIN | 本文 §2.7 |
| outbox / client sync 可观测与恢复 | 本文 §2.8–2.9 |
| Electron 安全 | 本文 §4.7 |
| CR-004 来源治理 / denial audit / offline lease | 本文 §2.11/§3.3/§3.4/§4.2/§4.4；39 §2/§5/§6/§8；33/OpenAPI 静态落点同批对齐，runtime 待实现 |

---

## 6. NFR 历史目标记分卡（非本次独立评分）

| # | 维度 | 分 | 证据 |
|---|------|---:|------|
| 1 | 可拓展 | **10** | §1 全 SPI + 稳定/可换面 + 租户预留 |
| 2 | 并发设计 | **10** | §2 容量模型/池/限流/背压/锁/扇出 |
| 3 | AI 可写 | **10** | §3 零发明字段 + 目录 + CI INV |
| 4 | 防改崩 | **10** | §4 触发器合同 + 角色 + CTA + fail-closed |

**综合：10 / 10（NFR 设计完备）**

上表为 v1.4 已有的 **10 / 10** 自评目标的历史保留，用于维持原检查项；它不替代独立复核，不与现阶段门禁、压测、恢复演练、真机安全证据合并计分，本版不据此抬高任何评分。

### 不计入本分的后续门禁

| 门禁 | 说明 |
|------|------|
| 压测绿 | 用 §2.1 数字做基准测试报告 |
| G0 / 真 OAuth | 组织与安全 |
| 运行时实现 | Ddev 按 39/33/41 编码 |

---

## 7. 与历史 38 的关系

| [历史 38 · 架构 10 分记分卡](../99-历史/2026-08-06-架构设计收口/38-架构10分记分卡.md) | 41 NFR 设计 |
|-------------|-------------|
| 合同实体齐套 10 | 非功能可编码 10 |
| 不替代压测 | §2.6 仍禁止虚假「高并发认证」宣传 |

---

## 8. 修订

| 版本 | 日期 | 说明 |
|------|------|------|
| v1 | 2026-08-06 | 初版四硬要求 |
| v1.1 | 2026-08-06 | SPI/容量/池/背压/扇出/触发器/CTA/游标 |
| v1.2 | 2026-08-06 | Codex P0 骨架 |
| **v1.3** | **2026-08-06** | 发布 MERGE 语义、空批拒绝、idempotency_claim/complete、rate_limit 返回 retry_after、推荐视图改 release_items、canonical_json/JCS、HTTP 映射、questions 聚合 |
| **v1.4** | **2026-08-06** | Codex 交叉检查修补：幂等同事务/fencing；apps/api 目录统一；DEFINER ACL；一期危险 flag 硬禁；44 §3 直链 |
| **v1.5** | **2026-08-06** | 一期 TypeScript import worker + 持久 outbox；16 分片限流规模门；数据增长/EXPLAIN；outbox 与 client-sync 可观测/恢复；首发行为；Electron 安全合同；原 10 分自评降格为历史目标 |
| **v1.6** | **2026-08-06** | 九端口与两域 NFR：独立工单 worker capability、字段 allowlist、包络/观测/恢复、CAS 待办、无写回与 Pilot OAuth 门 |
| **v1.7** | **2026-08-06** | 工单 worker 补齐 claim/heartbeat/retry/reconciler/finalizer 全闭环；耗尽任务按 batch→outbox 锁序原子收口，禁止永久 validating |
| **v1.8** | **2026-08-07** | 将 38 明确标为历史记分卡并链接到归档真路径，避免历史自评分被误读为当前运行证据 |
| **v1.9** | **2026-08-08** | CR-002 NFR：平台确认、stateless 与安全 fail-closed 分流、G1a/G1b 分账、人数/容量、待批留存和 Phase 1 裁剪 |
| **v1.10** | **2026-08-08** | 自动事实、parent/reselection、候选四元组、客户端 timeout、升级辅助多动作与双口径；训练仅受控离线，补 provider 许可、删除血缘与预算门 |
| **v1.11** | **2026-08-08** | 解除对 44 历史终裁快照的规范性依赖；端到端 SLI 改由现行部署清单 43 承载，运行认证仍待实现与压测证据 |
| **v1.12** | **2026-08-09** | 新增只读 PlatformAdapter 合同：仅显式用户动作触发、只产候选、强制确认、禁止监控/直写 SoR/自动发送；Phase 1 原生来源即使声称确认也必须 403+零写入；扩展检查单接入 N/N-1 与 /v2 治理 |
| **v1.13** | **2026-08-09** | 冻结 CR-004 NFR 人读合同：四域 immutable release bindings、永久暂停、全链 fail-closed、原子来源切换/发布、独立拒绝审计与短租约到期停检索；33/OpenAPI 静态合同同批对齐，运行实现与证据待后续里程碑 |
