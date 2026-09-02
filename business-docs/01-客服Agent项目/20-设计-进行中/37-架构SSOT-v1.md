# 37 · 客服 Agent 架构 SSOT v1

> **状态：** **ARCHITECTURE DESIGN FROZEN · PASS-WITH-CONDITIONS（静态设计）· 2026-08-10**（当前 v1.16；v1.13 已冻结 DEC-042 人读基线，v1.14 对齐受控检索、审核与质量证据不变量，v1.15 完成 postfix 安全收口，v1.16 登记当前 reference DDL 本地隔离 PG15 预检及证据边界；实现/迁移须在已签 Ddev 的 DEV-M0 及后续逐里程碑补证）\
> **效力：** 架构北极星。与现行 [`31`](31-产品契约-v1.md) / [`32`](32-ADR-一期技术栈.md) / [`33`](33-schema-v1-草案.sql) / [`25`](25-PRD草案-客服Agent一期.md)，以及历史输入 [34 · 技术栈计划](../99-历史/2026-08-06-架构设计收口/34-技术栈计划-autoplan.md) / [36 · 冲 10 分方案](../99-历史/2026-08-06-架构设计收口/36-冲10分方案.md) 冲突时 **以本文为准**。\
> **图与关卡：** [`40-架构图与关卡状态.md`](40-架构图与关卡状态.md)\
> **NFR（拓展/并发/AI 可写/防改崩）：** [`41-NFR扩展并发与防改崩.md`](41-NFR扩展并发与防改崩.md)\
> **历史交叉终裁快照：** [`2026-08-06_架构交叉验证终裁快照.md`](../90-评审/2026-08-06_架构交叉验证终裁快照.md)（**HISTORICAL / NON-NORMATIVE**；仅作当时评审追溯，不再提供任何规范性合同输入）\
> **阶段：** 需求分析关已通过；**架构设计关 PASS-WITH-CONDITIONS（静态设计）**；**实现设计关 `Pass · 文档包 Ready`**；独立组织授权门已通过：G0=`EVD-G0-SIGN-20260831`，Ddev=`EVD-DDEV-AUTH-20260831`；当前为 `DEV-M0 · IN_PROGRESS`，`W0` 已完成，下一切片为 `W1`。\
> **不是：** 生产授权、运行时代码实现、压测认证；Ddev 不放行真实数据、真实飞书接入、Pilot 或部署。
> **CR-002 增量：** [`47-CR-002搜索复制证据闭环.md`](47-CR-002搜索复制证据闭环.md)；只扩展既有 search / events / Dashboard，不替换本文，不影响 CR-001 `work_order_*`。
> **CR-003 预埋：** [`49-CR-003一期训练预埋与多教师蒸馏.md`](49-CR-003一期训练预埋与多教师蒸馏.md) / [`50-CR-003测试计划.md`](50-CR-003测试计划.md) / [`training-artifacts/`](training-artifacts/)；一期只冻结离线合同、空模板与纯合成 fixture，不新增 public 训练 API，不授权真实数据、teacher、训练或付费。
> **CR-004 来源治理：** 每个 release 恰好绑定售前/活动/售后/产品四域不可变来源版本；canonical/current 由 `content_current` + release bindings 唯一推导；来源暂停永久只追加，全链 fail-closed；人读合同与 33/OpenAPI 静态机器合同由同一 CR-004 changeset 对齐，迁移、生成类型、服务端/客户端代码与动态运行证据仍未实现。
> **ENG-T1 合同修正：** `announce_ack` 的来源门/离线租约拒绝与 current/snapshot 一致，主事务回滚后必须经 runtime wrapper 独立幂等提交最小 source denial audit；adoption/escalation 公共请求为 closed schema。该修正只闭合静态合同冲突，不替代已签 Ddev，也不授权 DEV-M0 以外的 runtime、部署或 Pilot。
> **DEC-042 内容资产治理：** 稳定 Question 身份/版本、显式平台与商品范围、版本化 intent taxonomy、风险审核、受控占位符、受限治理快照 hash 与分层质量门的人读合同，已与 schema v1.12（SHA-256 `47b667958e522a28df1c04d7c79a56c930bfe0ac04598321824b55744ac4a801`）/ OpenAPI 1.11.0（SHA-256 `06698f233702591c8f981c7b08ebac4b7d5bc5cc2d69d36014ef2a9f5a6802e4`）静态机器合同同批对齐；迁移、生成类型、代码与动态证据须从已签 Ddev 放行的 DEV-M0 起逐里程碑实现，G0、Scope 与 Ddev 均不替代运行证明，也不扩大当前授权边界。

---

### 证据等级：为什么叫“静态设计通过”

“静态”修饰的是**架构关的证据等级**，不是架构完成度，也不表示架构关只能停在文档。当前 SSOT、API、DDL、NFR、架构图与关卡语义已经一致，所以**架构设计关已通过；实现设计关也已完成文档级收口**。独立组织授权门现已通过，代码开发已进入 `DEV-M0`，`W0` 已完成，下一切片为 `W1`。2026-08-07 与 2026-08-10 的本机 PostgreSQL 15.18 结果只覆盖各自旧 hash。2026-08-21 已对 ENG-T1 修正后的当前 `schema.v1.12` clean-install reference DDL 按 SHA-256 `47b667958e522a28df1c04d7c79a56c930bfe0ac04598321824b55744ac4a801` 重跑本地隔离 PostgreSQL 15.18 预检，结果为 `PASS-WITH-LIMITATION`，证据 `EVD-PG15-LOCAL-PREFLIGHT-20260821T212715+0800-47B66795`。该结果只证明 reference DDL 前置形状与 ACK wrapper 合同，不能写成迁移、应用运行态、托管库或生产态通过。

| 已经通过 | 仍须在后续关卡补证 |
|----------|--------------------|
| 架构边界、九端口、数据模型、状态机、NFR 目标、图文与静态合同门禁；当前 `schema.v1.12` clean-install reference DDL（SHA-256 `47b667958e522a28df1c04d7c79a56c930bfe0ac04598321824b55744ac4a801`）已在本机隔离 PG15.18 通过 clean-install（40 tables / 2 views / 143 functions）、ACL 8/8、约束 3/3、ACK runtime wrapper 正向/幂等/异体冲突、完整幂等重跑与 COMMIT 前故障原子回滚；证据 `EVD-PG15-LOCAL-PREFLIGHT-20260821T212715+0800-47B66795`，旧 SHA 结果仅作历史追溯 | **仍待补证：** immutable migration / N/N-1 / application runtime / managed PostgreSQL / backup-restore / concurrency-deadlock / production；真飞书 OAuth/RBAC；API/worker/E2E；压测与故障注入；RPO/RTO；Windows Electron 真机与生产安全。这些仍 `NOT_CERTIFIED / NOT_IMPLEMENTED` |

因此当前结论是：**Architecture Design = PASS-WITH-CONDITIONS；Implementation Design = Pass · Document Package Ready；Organization Gate / G0 / Ddev = PASS；Code Development = DEV-M0 IN PROGRESS / W0 COMPLETE；Current Schema v1.12 Reference DDL Local PG15 Preflight = PASS-WITH-LIMITATION；Immutable Migration / N/N-1 / Application Runtime / Managed PG / Backup-Restore / Concurrency-Deadlock / Production = NOT_CERTIFIED / NOT_IMPLEMENTED；Runtime / Production Readiness = NO-GO。** 预检证据保存在本地 Git ignored 目录，fresh clone 须按 [08 工具入口](../../08-工具/README.md) 重跑 `npm --prefix sites run preflight:customer-agent-pg15`。已签 Ddev 只允许从 DEV-M0 开始合成数据开发；真实数据、飞书运行接入、试点、付费调用与部署仍未授权。

## 0. 北极星（必须先读）

| 陈述 | 冻结 |
|------|------|
| **08-12 Demo** | **仅业务终轮确认**（附页 DoD）。**不是**架构裁剪依据，**不是**战略 S1 北极星。 |
| **架构目标** | 支撑 **50～150** 坐席：**中心权威内容 + 发布/公告 + 浮窗人在环检索 + Dashboard 运营 / 工单分析**。 |
| **产品双表面** | Windows Electron **浮窗（一线）** + **Dashboard（coach/owner）**；macOS 后续，iOS / Android 不进一期。 |
| **两域门** | 业务工单分析=`work_order_*`；内部话术优化待办=`iteration_task*`。分名、分表、分 API、分权限。 |
| **路线** | **A 全自研**；不上 Dify/RAGFlow 整套中台；一期 **禁止自动代发**。 |
| **CR-002 证据边界** | 自动记录脱敏搜索问法、不可变候选、成功复制、明确放弃/无命中退出/客户端生命周期超时，以及非终态升级动作；修改、是否发送、是否正确只做试点抽样人工复核并单独统计。**不是聊天记录**，不证明平台发送、正确性或满意度。 |
| **规模口径** | 验收最低 3；计划首批 4（2 新+2 老）；允许 3～5；业务扩面 50～100；架构容量仍为 50～150。 |

---

## 1. 系统上下文（C4 逻辑）

```text
┌─────────────────────────────────────────────────────────────┐
│ Electron Client                                             │
│  · Float UI：粘贴/热键 → TopK → 点选 → push(clipboard|autofill) │
│    → adopted / dismissed / no_hit_exit / 生命周期 timeout 唯一终态 │
│    → 再选/再搜创建新 query，并链接已终态 parent_query_id            │
│  · Dashboard UI：自动事实流水/双口径 KPI/工单分析/话术待办/公告    │
│  · 可选：本地 SQLite 只读快照（released 话术 + 本地 FTS）       │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTPS /v1（内网不豁免 TLS）
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ Application API（TypeScript / Node 24 LTS）                 │
│  ports: auth · search · events · metrics · workorders ·     │
│         content · policy · redaction · announce             │
│  禁止依赖 electron；可单实例部署                                │
└──────────────────────────┬──────────────────────────────────┘
                           │
           ┌───────────────┼───────────────┐
           ▼               ▼               ▼
    PostgreSQL SoR    Shared Object   Phase1 TS Worker
    (权威)            (导入原稿)      (import_validate + outbox)
                                             └─ 二期 Python 清洗旁路
           │
           ▼
    content_releases · scripts · events · iteration_tasks
    work_order_import_batches · work_order_records · announcements
```

**部署拓扑（一期生产形态）：** **本机壳 + 中心 API + Postgres + 持久共享导入存储 + TypeScript import worker**。多实例 API 只能使用对象存储或 RWX 持久卷；普通本地目录仅属单主机 API + worker 共卷 profile，不得声称无状态水平扩展。生产客户端到 API 全程 HTTPS，“内网”不是明文 HTTP 豁免理由。\
纯单机 SQLite 作为**唯一权威** = **否决**（与全员同步/公告矛盾）。

---

## 2. 权威数据（SoR）

| 数据 | 权威位置 | 客户端 |
|------|----------|--------|
| 话术版本、发布、audit | **PostgreSQL** | 拉 release 快照可选缓存 |
| 四域来源版本、release 绑定、永久暂停与拒绝审计 | **PostgreSQL**；来源版本与 binding 不可变，暂停/拒绝只追加 | 客户端只消费 current release 的已校验绑定与短租约，不自行判定 canonical |
| 内容审核决定与质量计划/证据 | **PostgreSQL 受限 append-only 对象**：`content_review_decisions`、`content_quality_review_plans/evidence`；普通 normalized row 不得自报审核主体、结论或质量通过 | public wire 只消费 OpenAPI 白名单投影，不暴露受控审核主体 ID |
| query / impression / adoption terminal / escalate auxiliary | **PostgreSQL**（按 user 归集）；候选四元组绑定不可变 `release_items` | 可先本地缓冲再上送；`CLIENT_ACTION_TIMEOUT_MS` 由客户端生命周期策略配置 |
| 晋级后的语义问法 | **PostgreSQL `script_questions`**；`from_log` 必须保留 `source_query_id` + 人审 EVD 引用，源删除前先撤下衍生项 | 不是运行事件，不进一期 public 复核/训练 API |
| 话术优化待办 `iteration_tasks` | **PostgreSQL**（由事件信号生成） | Dashboard 受权处理 |
| 业务工单导入批次与标准化明细 | **PostgreSQL `work_order_import_batches` / `work_order_records`** | Dashboard 仅按授权范围访问 |
| 公告 announcements | **PostgreSQL** | 拉取 last_seen_release |
| 导入批次 import_batch | **PostgreSQL** | Dashboard 触发 |
| 导入原稿 | **共享持久存储**（object/RWX） | 客户端不持有服务端路径 |
| 导入校验任务 | **PostgreSQL `outbox_jobs` + 一期 TypeScript worker** | claim/heartbeat/complete 使用 `lease_version` |
| 本地 SQLite/sql.js | **非 SoR** | Demo profile 或只读缓存 |

**迁移：** 开发可用 Postgres 单容器；schema 不以 SQLite 方言为终态。本地 FTS 可从 release 快照重建。

---

## 3. 服务端口（稳定合同）

| Port | 职责 | 一期行为 |
|------|------|----------|
| `auth` | 身份（飞书 OAuth 目标；开发 Mock）+ 首次明确告知/决定 | Mock 可开发；生产需真身份；`/v1/notices/*` 归本端口子能力，不增加第十端口 |
| `search` | 检索 TopK；返回库内 `answer_text` | **PostgreSQL 字符 bigram + normalize + exact/ILIKE 回退是线上主路**；运行角色唯一调用受控 `search_recommendable_scripts`，不得直读 backing view/底表；实现端口可替换但语义不变 |
| `events` | 写 query/impression/adoption terminal/escalate auxiliary | `query_id` 贯通 Dashboard；保留 `adoption_events` / `push_method` 机器兼容；无事后问卷、在线复核或训练路由 |
| `metrics` | 根问题与搜索操作双口径的自动事实 | 禁止发送、正确性、满意度、转化率推断进 App |
| `workorders` | 批准文件预检 / 映射 / 标准化 / 聚合 / 下钻 / 脱敏导出 | 一期只读分析；不接班牛写回；原始载荷不默认入库 / 出域 |
| `content` | 受信来源版本 → import → staging → **publish + 四域 binding**；来源切换与发布同一原子操作 | 见 §4 |
| `announce` | 发布后公告与客户端游标 | 见 §4 |
| `policy` | rewrite / auto_send 开关 | 一期：`rewrite=OFF`，`auto_send=OFF`；`/v1` **不得开启**，ADR 不能单独越过期别 |
| `redaction` | 日志脱敏 | 落库前执行 |

**可编码合同：** 请求/响应/错误码/幂等/发布状态机 → **[`39-API合同与发布状态机-v1.md`](39-API合同与发布状态机-v1.md)**。\
**SoR DDL：** **[`33-schema-v1-草案.sql`](33-schema-v1-草案.sql)** = **PostgreSQL 15+**（非 SQLite 生产方言）。

**首次发布前：** `content_current` 无行是合法启动态，但 search / announce 业务就绪必须为 false；`POST /v1/search` 与 `GET /v1/announce/current` 返回 503 `OVERLOADED` + `details.reason=CONTENT_NOT_READY`，不得伪造空 release 或从 `scripts` 旁路。首个 staged batch 经 Owner publish 成功后才切换业务就绪。

**不变量（引擎级 · 可测）：**

```text
phase1: policy.rewrite=OFF
  → API search 输出的 answer 模板字节级 === SoR 中 published 模板
  → 客户端仅可对已声明 {订单号}/{日期} 做内存确定性渲染；值/渲染正文零落库零日志
  → 禁止 LLM 改写 Answer
INV-EFF: effective_from/review_due_at 必填；app_runtime 仅调用 search_recommendable_scripts(platform, product_context_type, product_context_ref)，不得直读 v_scripts_recommendable/release_items/content_current
INV-CONTENT-ID: question_id 为上游给定稳定随机 ID，不得按行序派生；(question_id,question_version) 为不可变版本键；question_hash + semantic_family_id + HMAC origin_fingerprint + origin_fingerprint_key_version + source_asset_id 齐全；Question 正文先脱敏
INV-CONTENT-SCOPE: platform_scope 必填非空且仅 qianniu/douyin；product_scope_type=storewide|category|sku 与 refs 形状匹配；禁止 NULL/[] 放宽平台或 category/sku 范围
INV-INTENT-TAXONOMY: intent_taxonomy_version + intent_id 必填；未知意图隔离；旧 ID 不删除/改义，变更只走新版本与显式迁移映射
INV-CONTENT-RISK: risk_level=low|medium|high 且 risk_categories 受控；普通项固定 ROLE-CONTENT-LEAD 单审；high 或冲突必须固定 ROLE-CONTENT-LEAD + ROLE-CS-MANAGER 两个不同伪名主体双审；未决冲突隔离
INV-PLACEHOLDER: placeholder_keys 只允许 order_id/date，对应 {订单号}/{日期}；API 返回模板原字节；缺必填值禁止复制并二次确认；事件只绑定模板四元组
INV-CONTENT-HASH: content_hash=SHA-256(固定 ASCII 合同键的 JCS 子集治理快照)；对象键以 C 排序，非通用 Unicode JCS；Answer、Question 映射/晋级角色、scope、risk、effective、intent、placeholder 任一变化均递增 script_version/hash
INV-CONTENT-REVIEW-TRUST: normalized row/普通 import worker 不得自报 review_mode、审核主体/角色/EVD/结论或 quality_gate_passed；授权审核池经 record_content_review_decision 写受限事实，finalizer 解析固定角色并验证双审异人
INV-CONTENT-QUALITY: 普通 worker 仅经 freeze_content_quality_review_plan 冻结计划，授权审核池经 record_content_quality_review_evidence 写证据；plan/evidence/finalizer 同绑由稳定安全行元组生成的 population_manifest_hash，同数量换行也失败。结构/安全/来源错误整批失败；质量问题行可 quarantine；clean<=500 全审，501–5000 抽10%(min100,max300)，问题率>2%扩30%、>5%阻断，high/冲突100%审
INV-SEMANTIC-RETIRE: from_log Question 通过非 PII semantic source asset 关联运行 query；active 时 query FK+HMAC/key version/EVD 齐全，删源前先撤下并单向 retire/tombstone、释放直接 query 引用；retired 永不复活且血缘不可丢
INV-ADOPT: adopted ⇒ push_method ∈ {clipboard, autofill}（DB CHECK + API）
INV-COPY-SEMANTICS: adopted 只表示 push 成功；人读称“复制”，不得推断已发送 / 正确
INV-TERMINAL: 每 query 仅一条 adoption terminal；timeout 只由 CLIENT_ACTION_TIMEOUT_MS 客户端生命周期触发
INV-RESELECT: reselection 必须指向同用户、已终态父 query；父链 append-only 且无环
INV-CANDIDATE: 每条 impression 强制 (release_id,script_id,script_version,content_hash) 外键绑定不可变 release_items
INV-ESCALATE: (query_id,action) 幂等；同 query 可多 action；动作是辅助事实，绝不终结 query
INV-STATELESS: telemetry 不可用可安全搜索但 collection_disabled/stateless 不入指标/语义晋级/G1b；DLP/Auth/content 仍 fail-closed
INV-REL: publish 事务含 release_items 冻结 answer_text + announcements
INV-SOURCE-BINDING: 每个 release 恰好有 presale/campaign/aftersale/product 四条不可变且 use_class=canonical 的 binding；未登记/reference 来源拒绝；canonical/current 仅由 content_current 所指 release 推导
INV-SOURCE-SUSPEND: 暂停事实只追加且永久；被暂停 source_version 永久不得 import/publish/rollback/search，恢复只能新版本 + 新 release
INV-SOURCE-IMPORT: 导入文件行不得自报或覆盖内容来源；服务端只从受信 import 上下文附加 source_version/source_ref
INV-SOURCE-ATOMIC: 来源切换、release、四域 binding、current、announcement 与 change audit 同一事务；失败保持旧 current
INV-SOURCE-DENIAL-AUDIT: 仅来源/离线租约 reason 的业务拒绝在回滚后以独立幂等事务提交最小 source_denial audit；底层 writer 不授予应用角色，runtime/admin 只能调用各自的 operation 白名单包装函数；内容合同/hash/质量拒绝走标准受控 change/error audit，禁止混表；审计失败则管理写动作继续 fail-closed
INV-SNAPSHOT-EFFECTIVE: snapshot 返回完整不可变 release 并保持稳定分页；客户端每次本地检索仍强制 effective_from <= now < effective_to，now==effective_to 排除，租约到期停止本地检索
INV-PUBLIC-PROJECTION: public response 全部 closed schema + 显式 mapper，禁止 DB row spread；SnapshotQuestion 仅最小公开字段，不得暴露 query/HMAC/key version/晋级审核/EVD/内部 locator
INV-OFFLINE-LEASE: 客户端只读快照短租约到期即停止本地检索；ACK 只确认同步游标且不续租；取得新租约前不得使用旧快照
INV-WO-RO: workorders 不存在外部建单/填单/改单/写回副作用
INV-DOMAIN: work_order_* 与 iteration_task* 不共表、不共 ID、不共越权路径
INV-API-COMPAT: 首个签名 Pilot 发布建立 N；从第二个签名版本起，/v1 同时支持 N 与 N-1；删改字段/语义或新增必填请求必须走 /v2
INV-PLATFORM-ADAPTER: 平台识别只在用户显式动作时给候选；不得直接写 SoR、自动发送、后台轮询或读取窗口标题/聊天正文/剪贴板历史
INV-MIGRATION-COMPAT: 迁移按 expand→backfill→validate→contract；fresh install、N-1 upgrade（存在签名基线后）、中断重试、旧应用回退与 ACL 必须逐项取证
```

### 3.1 扩展与兼容治理（不新增第十端口）

| 变更级别 | 允许方式 | 必须升级治理的情况 |
|----------|----------|--------------------|
| **A · 可加性** | 配置、内部 adapter、可选请求/响应字段、只读指标；保持九端口与既有语义 | 同一 changeset 同步 39/41/46 与机器护栏 |
| **B · 过渡性** | 新旧字段/实现并存，采用 expand/backfill/validate，N 与 N-1 客户端均可工作 | 必须有弃用周期、迁移兼容矩阵与旧应用回退证据 |
| **C · 破坏性** | 新 major API、独立 ADR、Scope/安全/费用与 Owner 决策 | 删除/改名/改义、增加必填请求、SoR 迁移、多租户、聊天正文、写回或自动发送 |

本节只冻结“怎么安全扩展”，不批准任何新增功能。客户端弃用周期详见 39 §0.3，平台上下文适配器详见 41 §1.3，数据库兼容矩阵与 DEV-M0 证据详见 46 §6.1.1 / §11 / §12。当前 G0 / Ddev 已 Pass，`DEV-M0` 已开始且 `W0` 已完成；`schema.v1.12` reference DDL 的本地隔离 PG15 预检已 `PASS-WITH-LIMITATION`，但 immutable migration / N/N-1 / application runtime / managed PG / backup-restore / concurrency-deadlock / production 仍 `NOT_CERTIFIED / NOT_IMPLEMENTED`。

---

## 4. 内容管线 Import → Publish → Announce

```text
飞书表 / Excel·CSV
      │  Adapter（飞书 API 或文件上传）→ 原稿先持久化
      │  服务端受信导入上下文解析 domain + immutable source_version
      │  文件行不得自报 source_ref
      ▼
 import_batches(validating) + outbox_jobs(import_validate)
      │ 同一 DB 事务后才可 202
      ▼
 TypeScript import worker（claim / heartbeat / lease_version）
      │ fenced finalize：失租则 staging/batch/complete 同事务回滚
      ▼
 staging_scripts (validation_ok 才可 publish)
      │ coach 预览/修正 · **owner** 确认 → POST /v1/content/publish（单事务）
      ▼
 content_releases (release_seq 单调) + release_items(冻结 answer_text)
      │  + presale/campaign/aftersale/product 四域不可变 source bindings
      │  content_current 指针 · announcements · change_audits（同事务）
      ▼
announcements(release_id, title, summary)
      │
      ▼
 客户端：GET /v1/announce/current → 落后则 snapshot → ACK
```

| 规则 | 冻结 |
|------|------|
| 编辑工作台 | 飞书或 Excel **皆可**；**系统生效以 Publish 为准** |
| 一期默认路径 | **Excel/CSV 导入向导 + Publish + 公告**（可控、可审） |
| 飞书 API | **正式规格预留 adapter**；有权限后增强，不阻塞架构 |
| 导入异步化 | **一期 Must**：持久 `outbox_jobs` + TypeScript import worker；Python 仅二期清洗旁路 |
| 导入存储 | 多实例只允许 object/RWX；filesystem 仅单主机共卷 profile，上传对象先持久化并校验 hash 后才提交 batch+outbox |
| 四域 binding | 每个 release 必须恰好绑定 `presale/campaign/aftersale/product` 各一个 immutable、`use_class=canonical` source version；未登记、`reference`、缺失、重复、hash/EVD 不匹配即整步拒绝 |
| canonical/current | 不存在可变来源开关；只由 `content_current` 所指 release 及其四域 bindings 推导 |
| 导入来源 | `import_batches.source_ref` 仅是存储对象/受信上游定位；文件行不得自报内容 `source_ref`。内容来源由服务端导入上下文解析并附加，无法核验即整批拒绝 |
| 来源暂停 | 只追加永久暂停事实；被暂停 `source_version` 永久不得再次 import/publish/rollback/search，不存在恢复旧版本；恢复业务只能登记新 source version 并发布新 release |
| 发布/切换原子性 | 对完整 MERGE 候选快照校验四域来源；来源切换、release、四域 bindings、current、announcement、change audit 同事务，失败保持旧 current |
| 回滚 | 仅 owner 调用 `rollback_content_release`；先按 CR-004 重新校验目标的四域 bindings 与永久暂停记录，任一失败则整次拒绝；通过后将目标快照完整复制成**新的单调 `release_seq`** 再更新 current；禁止过滤目标、就地改历史或直指回旧 release |
| 拒绝审计 | import/publish/rollback/search 及 current/snapshot/ack 的来源/租约拒绝先回滚业务事务，再由独立幂等短事务追加最小审计；不得在随后抛错会回滚的同一事务内写审计 |
| 离线租约 | snapshot 由服务端签发绑定 `client_id/user_id/release_id/source_binding_hash` 的 opaque 短租约（默认 600 秒、允许 60～900 秒，DB 只存 token hash）；ACK 只确认同步游标且不续租；离线客户端租约到期立即停用本地检索，联网取得 current snapshot 与新租约后才恢复；无宽限期旧快照旁路 |
| 有效期 | 检索 **永远** `published AND in effective window`；空 from/to 语义：from 缺省 -∞，to 缺省 +∞；**禁止关闭过滤** |
| 演示数据 | seed **必须**在有效窗内；可另备过期行 **仅测过滤** |

CR-004 的 import、publish、rollback、search 任一环节都必须对来源治理 fail-closed：来源未登记或仅供 `reference`、四域绑定缺失/重复、来源版本不匹配、存在永久暂停记录或拒绝审计不可持久化时，不得降级为普通 no-hit 或部分发布。离线租约是客户端本地 search 的附加硬门：到期后不得继续使用旧快照，不作用于 import/publish/rollback。本节与 33/OpenAPI 构成同批静态合同；对应 migration、生成类型、服务端/客户端行为和动态测试证据须按已签 Ddev 从 DEV-M0 起逐里程碑落地。

---

## 5. 三期演进（不重写）

| 期 | 产品 | 架构动作 |
|----|------|----------|
| **一期** | 只选库内原文；人在环；禁代发 | `policy.rewrite=OFF`；content release；只记录自动事实；训练侧仅合同、空模板与纯合成 fixture，不执行真实 embedding / teacher / student 训练，不建在线复核/训练 API |
| **二期** | 受控语义资产晋级 + 受控改字 + 受控训练 | **另行取得范围、数据、安全、费用与训练授权后**，才可执行 embedding 影子、teacher batch 与 student 训练；仅训练检索 / 意图 / 重排，双周不可变版本、人工审核与人工发布 |
| **三期** | 客服 Agent；自动回复 / 场景改字另立项 | 只有二期质量、安全与运行门通过且三期单独立项 / 授权后，才评估 Agent 与 `auto_send`；不从一期或二期自动继承授权 |

**稳定：** 双表面、query_id、release/announce、search/events/content/workorders 端口、两域隔离、禁代发红线。\
**后插：** 向量/embedding 召回、清洗、rewrite、自动发送适配器。DeepSeek 只能通过默认关闭、可替换 adapter；GLM 未取得覆盖目标数据和蒸馏用途的书面授权时禁止作为 teacher 或蒸馏来源。

---

## 6. 客户端与推送

| 项 | 冻结 |
|----|------|
| 壳 | Windows Electron + TypeScript + React；macOS 后续；iOS / Android 不进一期 |
| 浮窗 | 粘贴/热键 → TopK（标题+分类+全文）→ 点选 |
| 推送 | **主路径：复制到剪贴板**（诚实可验）；自动填 = 适配器实验项，**不得**默认主 CTA、不得 toast「已发送」 |
| 复制 | `outcome=adopted` **仅当** `push_method ∈ {clipboard, autofill}` 成功；失败不计复制分子；保留机器名兼容 |
| 操作终态 | 每个 query 只写 `adopted / dismissed / no_hit_exit / timeout` 之一；`dismissed` 仅明确放弃，静默离开按客户端生命周期策略形成 `timeout` |
| 重选 | 再选/再搜必须新建 `query_id`，写 `interaction_reason=reselection` 与已终态 `parent_query_id`；禁止覆盖原 query |
| 升级 | `escalate_actions` 是可多动作的辅助事实，按 `(query_id,action)` 幂等；不代替 terminal，不证明外部人工已接单 |
| 平台 | 人读 confirmed 映射 wire/DDL canonical=`platform`，Phase 1 必须经用户确认；直接手选/修正=`platform_source=manual`，接受热键瞬时 `detected_platform` 提示=`foreground_process`，提示本身非自动真源；禁止轮询、窗口标题与剪贴板历史；未来 `native_integration` 另走 ADR |
| hit | 过滤后 ≥1 条可点选；**禁止**垫假卡到 3 |
| Dashboard | **话术零写**；“工单分析”与“话术优化待办”独立导航；coach/owner 可导入工单文件、处理待办和内容预览，**一期仅 owner 发布/回滚** |
| 离线只读缓存 | 只缓存 current release 的完整 snapshot、四域 binding 摘要与服务端短租约；租约到期立即停止本地检索并提示联网同步，不得把旧快照当正常 no-hit |
| 语言 | **TS 主栈**（壳+Node 24 LTS API/worker，精确 patch 锁定）；**Python** 仅二期清洗旁路；**Rust** 一期不上 |

---

## 7. 事件与指标

| 指标 | 定义 | 位置 |
|------|------|------|
| 根问题复制率 | 任一链上 `adopted` 的去重 root / original root | Dashboard 工具侧；只表示至少一次成功复制 |
| 操作复制率 | `outcome=adopted` 的 query / 全部 query operation | 与根问题口径并列返回，禁止混分母 |
| 操作无命中率 | no_hit operation / all operation | 重选也是独立操作；另报 reselection_count |
| 升级率 | 有任一 action 的去重 root / original root；另报 action 总数 | action 非终态、非已解决 |
| 经营：响应/满意/转化 | 平台后台 | **禁止进 App 主 KPI** |

事件与内部改进最小集：`query_events`、`candidate_impressions`、`adoption_events`、`escalate_actions`、`iteration_tasks`。是否修改、是否发送、是否正确只在批准的试点样本里人工复核并以离线 EVD 三字段单独统计，**不进入一期运行表、public API 或自动事实 KPI**。业务工单分析另用 `work_order_import_batches`、`work_order_records`，不得混入工具分母。

---

## 8. 安全基线（架构合同）

- API 鉴权：开发 / 演示 Mock **必须标注非鉴权**；试点和生产必须真实飞书 OAuth + 服务端 RBAC，生产注册 mock-login 必须拒绝启动\
- Electron：`contextIsolation`、sandbox、无 nodeIntegration、preload 白名单、payload 校验\
- Electron 强制基线：限制性 CSP；每个 IPC 校验 sender 且 contextBridge 一消息一方法；默认拒绝 permission request；限制 navigation / new-window / `shell.openExternal` 到 allowlist；禁用 `file://` 加载应用资源，使用受控 custom protocol；锁定受支持 Electron 版本与 fuses；Windows 包必须签名、更新元数据验签且可回滚\
- 导入仅受控共享持久存储；服务端校验 schema/大小/key/hash；多实例本地路径拒启\
- 内容导入文件行不得携带或覆盖权威来源；服务端从受信导入上下文附加 immutable source version。四域 binding 缺失/重复/不匹配或来源已永久暂停时全链拒绝\
- 来源暂停只追加且永久；禁止删除暂停事实或恢复旧 source version。仅来源/租约拒绝进入 `source_denial_audits`；内容合同、治理 hash 和质量门拒绝走标准受控 change/error audit。所有拒绝记录均在失败业务事务之外提交，且不含正文、内部路径、token 或 PII\
- 日志 redacted + hash；密钥与 DeepSeek 出域另批\
- 多用户：坐席不可看全站敏感流水（RBAC）
- 角色扩展：审核、隐私、排障均是既有 `agent / coach / owner` 上的最小 capability，不替换业务角色，不因 owner 身份自动获得全员问法正文权限\
- CR-002 raw 问法只在受控内存；运行表保留期只允许 G0-11 从 **0/14/30 天**三档签发，建议试点脱敏正文 14 天、事件 30 天，0 天用于 suppressed/无正文；未签前不构成真实数据授权\
- DEC-042 Question 持久化前必须脱敏；`origin_fingerprint` 只能是 HMAC，且必须同存 `origin_fingerprint_key_version`；`(question_id,question_version)` 是不可变版本键，旧版本只追加不可覆盖。占位符值和客户端渲染正文只存在于受控内存，不得进入 API 回传、事件、日志、trace、缓存、截图或训练 artifact\
- 内容审核主体/结论和质量通过事实不得来自上传文件或普通 normalized row；受限 `content_review_decisions` 只经 `record_content_review_decision` 追加，质量计划/证据分别只经 `freeze_content_quality_review_plan` 与 `record_content_quality_review_evidence` 建立，并与最终 staging 的 `population_manifest_hash` 完全一致。public wire 采用封闭白名单与显式 mapper，不暴露受控审核主体、EVD、来源 query/HMAC/key version 或内部 locator\
- `review_due_at` 始终必填；普通 90 天、高风险 30 天只是提交内容政策的建议复核窗，批准前不得冒充已授权默认值\
- 运行事件保留与语义资产晋级分账：`script_questions.source=from_log` 只有人审通过才可绑定非 PII 语义来源资产；active 资产保存 query FK、来源 HMAC/key version 与批准 EVD。撤回/删除先撤下衍生项，再单向 retire/tombstone 资产并受控释放直接 query 引用；retired 永不复活，禁止“删原文同时丢血缘”或让向量/数据集/模型继续用\
- Phase 1 训练侧只允许合同、空模板与纯合成 fixture，不自动训练、不完整导出运行数据集，也不提供在线人工复核/训练 API；Phase 2 须另批后，受控离线 artifact 才可包含 embedding / teacher / student，并必须有许可证明、purpose-lock、train/eval 隔离、删除清单、预算 cap 与逐版本 EVD；Phase 3 客服 Agent 另立项\
- DeepSeek adapter 可替换且默认关；任何出域先过 G0/合同/地域/不留存门。GLM 未取得覆盖蒸馏用途的书面许可一律禁止进入 teacher batch\
- 工单导入：只接批准 CSV/XLSX；字段白名单、保留期、脱敏和业务范围先签；不保存未批准原始载荷，不默认发送第三方模型\
- 工单导出：仅 coach/owner 的授权范围与批准字段；导入、映射、查询、导出和拒绝均只追加审计；无班牛写回凭据 / 端口\

---

## 9. Demo Profile（附页 · 非北极星）

**用途：** 业务终轮确认「粘贴 → Top3 → 复制 → 同 query_id 流水」，以及用批准脱敏样例 / 合成文件确认“工单预检 → 聚合 → 下钻 → 导出”。

| 允许 | 禁止声称 |
|------|----------|
| 本地/单实例临时库 seed | 「生产已上 Postgres」若实际未部署 |
| 单窗 Tab 壳 | 「已验收终态浮窗」 |
| Mock 角色 | 「飞书登录/权限已完成」 |
| 剪贴板主路径 | 「自动填已生产可用」若未真机 |
| 脱敏 / 合成工单样例 | 「班牛已连接」「真实工单已合规接入」或「可写回」 |

Demo **不得**关闭有效期过滤；seed 数据自洽即可。

---

## 10. 明确 NOT

- Dify/RAGFlow 主中台\
- 一期自动代发\
- App 内经营大盘\
- 班牛实时 API、自动建单 / 填单 / 改单 / 写回\
- 用 `iteration_ticket` / 单独“工单”混指内部待办与业务工单\
- 把搜索原句 + 复制话术称为完整聊天记录，或把成功复制 / 升级动作称为平台已发送、回答正确、人工已接单或客户满意\
- 后台监听剪贴板历史、轮询前台应用、读取窗口标题；一期在线人工复核、自动训练、public 训练 API 或完整运行事件批量导出\
- SQLite 作为跨用户唯一 SoR\
- 无 Publish 的「每人各导一份」\
- 把 08-12 演示成败当作架构成败\

---

## 11. 架构目标证据（不自证 10/10）

| 维度 | 当前证据 | 独立终裁前的必要证明 |
|------|----------|--------------------------|
| 业务与边界 | §0–§1、§6 | 产品红线与真 OAuth/RBAC 权限矩阵通过 |
| 数据与事务 | §2–§4、33、39 | 真 PG clean/upgrade/ACL/fencing/并发负测通过 |
| 安全与客户端 | §8、41、46 | Electron 安全、上传、脱敏、密钥和越权测试通过 |
| 容量与恢复 | 41、43 | 容量/存储包络、压测、备份恢复演练有真实证据 |
| 合同与交付 | 39、46、`openapi.v1.yaml` | 机器合同、生成类型、编号迁移与 CI 无漂移 |

> **评分纪律：** 本文只定义目标和证据门，不能为自己签发 10/10。静态文档绿不等于 OpenAPI、PostgreSQL、OAuth、Electron、压测或恢复已验证；分数由交叉复核基于当期证据另行签发。

---

## 12. 残余风险（规格已知 · 实现期消化）

- 缓存与 SoR 短暂分叉：以 `release_id` / ACK 对齐（39 §6）\
- Announce 离线客户端：`client_sync_state` + 启动拉取\
- CR-004 离线陈旧读：短租约到期必须停本地检索；静态 wire/schema 字段由同批机器合同冻结，服务端签发、客户端验租与 clock-skew 动态负例仍待实现取证\
- 并发 Publish：release_seq 单调 + Idempotency-Key + CONFLICT\
- 导入半成功：import_batch 状态机 + 事务\
- 中文检索质量：现行合同固定为 **字符 bigram + normalize + exact/ILIKE 回退 + ≥50 冻结验收集**；固定构成为 20 正例 + ≥12 安全负例（6 类×2）+ ≥18 长尾/错别字/改写/上下文；调参与验收集互斥，调参不改 search 端口合同；实现细节见 46 §8，历史评审快照不提供规范性来源\
- G1a / G1b 数据循环：G1a 固定使用独立 `20+12+18` 预检集；真实 Pilot 前瞻取得的 REAL-FWD 仅用于 G1b / 扩面，不得回填 G1a 或调参集\
- telemetry 可用性：仅 telemetry / 事件链故障时允许显著标记的 `collection_disabled/stateless` 安全搜索，并排除指标 / 语料 / G1b；DLP、Auth、当前内容快照未就绪仍 fail-closed\
- 重选链与双口径：实现必须证明同用户、父 query 已终态、无环；Dashboard 同时展示 root question 与 search operation，禁止只挑有利分母\
- 语义资产删除：`from_log` 衍生项用 FK/EVD 保留源血缘；若未来进入 embedding/index，删除时必须按 manifest 级联重建；进入模型权重则停用该模型版本并从清洁 manifest 重训，不能承诺单样本“自动遗忘”\
- 业务工单真实数据：字段白名单、保留期、脱敏、业务口径、安全批准与 EVD 未签前只允许合成 / 批准脱敏样例，不得接真数\
- 导入文件与无状态扩容：生产多实例依赖共享持久存储；存储不可达时不返回 202\
- 首次发布空窗：业务 readiness 不绿，禁止空 release 或 `scripts` 旁路\
- 限流热点：一期用 16 分片近似全局搜索桶，仅在已批规模内使用；超界或锁等待超门槛时切网关/Redis 并重跑压测
- CR-004 运行落地缺口：33/OpenAPI 静态机器合同同批包含四域 binding、永久暂停、独立拒绝审计和短租约，但 migration、生成类型、服务端/客户端代码与动态测试仍未实现；不得注册或宣传运行硬拦截
- DEC-042 运行落地缺口：人读合同与 schema v1.12 / OpenAPI 1.11.0 静态机器合同已同批对齐；迁移、生成类型、服务端/客户端实现和动态负测仍未完成，因此稳定 Question、显式 scope、taxonomy、风险双审、placeholder 与质量抽检均不得宣称为运行能力，对应路由仍受 Ddev 与里程碑注册门约束

## 13. 修订

| 版本 | 日期 | 说明 |
|------|------|------|
| v1 | 2026-08-06 | 多视角收敛：脱钩 demo 北极星；Postgres SoR；Publish/Announce；三期 policy |
| v1.1 | 2026-08-06 | 补 39 API/状态机；33 Postgres-first；INV 可测；staging/release_items |
| **v1.2** | **2026-08-06** | 链 40 架构图+瀑布关卡；链 41 NFR 拓展/并发/AI/防改崩 |
| **v1.3** | **2026-08-06** | Codex 交叉检查修补：一期危险 flag 硬禁；发布/回滚 owner-only；当时曾引用交叉复核 §3.1，现该文已迁入 90-评审并整体标记为非规范性历史快照，中文检索合同已回收至本文 / 46 §8 |
| **v1.4** | **2026-08-06** | Staff+ 复核收口：一期 TS import worker+outbox Must；生产共享持久存储/HTTPS；首发 readiness；Electron 安全基线；评分改为独立证据门 |
| **v1.5** | **2026-08-06** | CR-001 业务工单分析进一期；新增 `workorders` 第九业务端口；与 `iteration_tasks` 分域；冻结 Windows / OAuth / 50 条评测集边界 |
| **v1.6** | **2026-08-07** | 明确“静态”仅指证据等级：架构设计关已通过，运行/生产就绪仍待真实 PG、OAuth、E2E、压测、恢复与真机证据；历史 34/36 改为可追溯归档链接 |
| **v1.7** | **2026-08-07** | 登记本机隔离 PG15.18 reference DDL 的 clean-install、ACL/约束负例、幂等重跑与事务原子回滚；明确上一发布版本升级仍 NOT_CERTIFIED，Ddev 与生产就绪状态不变 |
| **v1.8** | **2026-08-08** | CR-002 平台确认、stateless、G1a/G1b 分账与规模口径进入静态合同；Ddev 后才执行实现、路由注册与迁移 |
| **v1.9** | **2026-08-08** | CR-002 冻结为自动事实；新增重选父链、候选四元组不可变血缘、客户端 timeout 与双口径；训练冻结为一期合同 / 合成预埋、二期另批、三期 Agent 另立项；当前 schema.v1.8 PG15 证据校正为 NOT_CERTIFIED |
| **v1.10** | **2026-08-09** | 冻结扩展治理：签名客户端 N/N-1 兼容周期、只读 PlatformAdapter 边界、迁移兼容矩阵与三项 DEV-M0 静态不变量；明确 notices 归 auth 子能力；不新增端口、路由、表或开发授权 |
| **v1.11** | **2026-08-09** | 同步阶段真值：实现设计关 `Pass · 文档包 Ready`；当前为独立组织授权门，G0 / Ddev 未授权、代码开发未开始；补齐 CR-003 与离线训练 artifact 规范链 |
| **v1.12** | **2026-08-09** | 冻结 CR-004 人读架构合同：四域 immutable source versions + release bindings 推导 canonical/current；永久追加暂停；全链 fail-closed；原子来源切换/发布；独立拒绝审计；离线短租约到期停检索。33/OpenAPI 静态合同同批对齐，运行实现与证据待后续里程碑 |
| **v1.13** | **2026-08-10** | 冻结 DEC-042 人读架构合同并与 schema v1.10 / OpenAPI 1.9.0 静态机器合同同批对齐：稳定 Question 身份/版本、显式 scope、版本化 taxonomy、风险审核、受控占位符、JCS 治理快照 hash 与分层质量门；运行实现与证据待 Ddev 后完成，G0 / Scope / Ddev 不变 |
| **v1.14** | **2026-08-10** | 对齐 DEC-042 静态机器闭环不变量：`search_recommendable_scripts` 为唯一运行检索边界；Question 同存 origin HMAC key version 且复合版本不可变；审核决定、质量计划/证据采用受限 append-only 信任边界，双审固定角色且主体不同；运行与动态证据仍待 Ddev |
| **v1.15** | **2026-08-10** | Postfix 安全收口：固定 ASCII-key JCS 子集、质量总体 manifest 身份绑定、from_log 语义来源资产单向退役、完整 snapshot + 客户端半开有效期、来源审计分表及封闭 public mapper；Gate / G0 / Scope / Ddev 不变 |
| **v1.16** | **2026-08-10** | 登记当前 schema v1.12 reference DDL 本地隔离 PostgreSQL 15.18 `PASS-WITH-LIMITATION`；锁定 SHA / EVD / 40 tables / 2 views / 143 functions / ACL 8/8 / constraints 3/3 / 幂等 / 原子回滚；明确本地 ignored 证据与 fresh clone 重跑边界；immutable migration / N/N-1 / runtime / managed PG / backup-restore / concurrency-deadlock / production 仍未认证，Gate / G0 / Scope / Ddev 不变 |
