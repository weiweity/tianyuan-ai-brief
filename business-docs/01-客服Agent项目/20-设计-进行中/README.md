# 20 · 设计阶段（已收口 · 稳定兼容路径）

> **更新：** 2026-08-10 · **实现设计已通过；目录名仅为兼容旧链接；现行设计与历史草案已分离；CR-002、CR-003、CR-004、DEC-042 与扩展治理已纳入静态增量复核**\
> **架构北极星：** [`37-架构SSOT-v1.md`](37-架构SSOT-v1.md)\
> **历史交叉验证快照：** [`2026-08-06_架构交叉验证终裁快照.md`](../90-评审/2026-08-06_架构交叉验证终裁快照.md)（非现行 SSOT）\
> **Codex 交叉检查（冻结评审证据）：** [`2026-08-10_Codex交叉检查报告.md`](../90-评审/2026-08-10_Codex交叉检查报告.md)\
> **实现设计开工包：** [`46-实现设计-开工包.md`](46-实现设计-开工包.md)（实现设计关 Pass · 文档包 Ready；Ddev 未授权）\
> **CR-002 增量设计：** [`47-CR-002搜索复制证据闭环.md`](47-CR-002搜索复制证据闭环.md) · **测试计划：** [`48-CR-002测试计划.md`](48-CR-002测试计划.md)\
> **CR-003 训练预埋：** [`49-CR-003一期训练预埋与多教师蒸馏.md`](49-CR-003一期训练预埋与多教师蒸馏.md) · **测试计划：** [`50-CR-003测试计划.md`](50-CR-003测试计划.md) · **合成制品：** [`training-artifacts/`](training-artifacts/)\
> **CR-004 权威来源硬门：** `26 / 31 / 37 / 39 / 41 / 46 / 33 / OpenAPI` 同批冻结；每个发布版本绑定售前、活动、售后、产品四类不可变来源版本，导入、发布、回滚、检索均 fail-closed；**当前仅为静态合同，不代表运行能力已实现**\
> **DEC-042 内容资产治理：** `25 / 26 / 31 / 37 / 40 / 46 / 48 / 50 + 33 / OpenAPI` 已冻结稳定 Question 身份/不可变版本与 origin HMAC key version、显式 platform/product scope、版本化 taxonomy、固定角色异人双审、受控 `search_recommendable_scripts`、审核决定与质量 plan/evidence 信任边界、placeholder 客户端内存渲染/二次确认/零持久，以及 postfix 约束：Question hash 纳入 `promoted_by_role`；固定 ASCII 键集按 `COLLATE "C"` 排序的受限治理 hash（非通用 JCS）；`population_manifest_hash` 防同计数换行；semantic asset 先退役留墓碑再删来源 query；完整不可变 snapshot 由客户端按 `[effective_from,effective_to)` 过滤；封闭最小 public mapper 与“来源/租约 denial、内容/质量/hash 标准审计”分流。**人读与静态机器合同已锁，迁移、生成类型、服务端/客户端代码与动态证据尚未实现**\
> **扩展治理：** `37 §3.1` 变更分级 · `39 §0.3` 签名客户端 N/N-1 · `41 §1.3 E` 只读 PlatformAdapter · `46 §6.1.1` 迁移兼容矩阵；**不新增端口、路由或表，不代表运行验证已完成**\
> **架构图 + 瀑布关卡：** [`40-架构图与关卡状态.md`](40-架构图与关卡状态.md)\
> **架构图看板（推荐打开）：** [`架构图-PlantUML浏览器.html`](架构图-PlantUML浏览器.html) · 源码 [`diagrams/`](diagrams/)\
> **技术栈全景 L0–L16：** [`43-技术栈全景清单-部署向.md`](43-技术栈全景清单-部署向.md)\
> **NFR 四硬要求：** [`41-NFR扩展并发与防改崩.md`](41-NFR扩展并发与防改崩.md)\
> **API：** [`39`](39-API合同与发布状态机-v1.md) · **OpenAPI 机器合同：** [`openapi.v1.yaml`](openapi.v1.yaml) · **DDL：** [`33`](33-schema-v1-草案.sql) Postgres\
> **本机直达：** `http://127.0.0.1:8766/架构图-PlantUML浏览器.html` · `http://127.0.0.1:8766/openapi.v1.yaml`\
> **局域网预览：** `http://<本机IP>:8766/架构图-PlantUML浏览器.html`（需本机已起静态服务）

从仓库根目录启动 8766 静态服务：

```bash
python3 -m http.server 8766 --directory business-docs/01-客服Agent项目/20-设计-进行中
```

## 现在关卡（瀑布）

| 关卡 | 状态 |
|------|------|
| 需求 | **Pass** |
| **架构** | **PASS-WITH-CONDITIONS（含 CR-002、CR-003、CR-004、DEC-042 与扩展治理静态增量；不等于 G0、Ddev 或运行就绪）** |
| PG15 设计前置验证 | **PASS-WITH-LIMITATION（current schema v1.12 reference DDL local preflight only）**：本机隔离 PostgreSQL 15.18 已对 ENG-T1 修正后的 SHA-256 `47b667958e522a28df1c04d7c79a56c930bfe0ac04598321824b55744ac4a801` 完成 clean-install（40 tables / 2 views / 143 functions）、ACL 8/8、约束 3/3、ACK runtime wrapper 正向/幂等/异体冲突、幂等与原子回滚；证据 `EVD-PG15-LOCAL-PREFLIGHT-20260821T212715+0800-47B66795`。immutable migration / N/N-1 / application runtime / managed PG / backup-restore / concurrency-deadlock / production 仍 **NOT_CERTIFIED / NOT_IMPLEMENTED**；本地证据目录被 Git ignore，fresh clone 须按 [08 工具入口](../../08-工具/README.md) 重跑 `npm --prefix sites run preflight:customer-agent-pg15` |
| **实现设计** | **Pass · 文档包 Ready（技术设计已收口；不等于开发授权）** |
| **组织授权门（不计入八关）** | **Current · G0 未签 / Ddev 未授权；费用路径及 G0-14 WBS / 容量 / 成本条件已归档；外部责任包 13/14、Scope 14/15，仅 G0-09 / Scope #9 开放** |
| 代码开发 / 单元测试 / 系统测试 / 发布 / 运维 | **Not started** |

## 文档树

| 文档 | 角色 |
|------|------|
| **46** | Phase B 实现设计开工包：目录、合同、迁移、里程碑与门禁；DEV-M0 执行迁移兼容矩阵 |
| **47 / 48** | CR-002 自动事实增量 SSOT / 测试计划；取消旧在线结果回填，根问题 / 操作分账，修改 / 发送 / 正确性离线三维抽样 |
| **49 / 50** | CR-003 一期训练合同预埋 / 测试计划；`0/14/30`、双审晋级、问答解耦、train/G1a/G1b 隔离、多教师替换与预算 / 删除门 |
| **CR-004（跨 26 / 31 / 37 / 39 / 41 / 46 / 33 / OpenAPI）** | 权威来源系统硬门：不可变来源版本 + 每个 release 四域 binding；非当前权威、已暂停、域不匹配、hash 不一致或来源集合不完整时整单拒绝，离线 lease 过期停止检索 |
| **DEC-042（跨 25 / 26 / 31 / 37 / 40 / 46 / 48 / 50 + 33 / OpenAPI）** | 内容资产人读与静态机器合同：稳定 Question、显式 scope/请求 product context、taxonomy/risk 审核、受控 search、审核/质量证据信任边界与 placeholder；postfix 锁定 promoted role 入受限治理 hash、固定 ASCII+C 排序、population manifest、semantic 退役墓碑、完整 snapshot+客户端半开过滤、封闭最小 public mapper及审计分流。46/48/50 已拆 DEV-M0～M3 任务/负例，迁移、生成类型、runtime 与动态 EVD 仍未实现 |
| [`training-artifacts/`](training-artifacts/) | 单一 schema、空模板、纯合成 fixture；不含真实数据、教师真实输出或模型权重 |
| **90 · 2026-08-10** | [`Codex 交叉检查终版报告`](../90-评审/2026-08-10_Codex交叉检查报告.md)：冻结的 P0/P1/P2、证据等级与残余门禁评审；非现行实现规范 |
| **44（已归档）** | 2026-08-06 架构交叉验证快照；现行规则已吸收至 37 / 39 / 41 / 43 |
| **43** | 技术栈 L0–L16 部署向 |
| **40** | 架构图 + 关卡板 |
| **41** | NFR 非功能与变更安全权威；PlatformAdapter 只产生待确认的平台候选，不监听聊天、剪贴板或键盘 |
| **37 / 39 / 33** | SSOT · API 演进与 N/N-1 · Postgres DDL；破坏性变更走 `/v2`，CR-004 为首个签名客户端前的 pre-N 合同修正，当前 DDL 不冒充已执行迁移 |
| [`31`](31-产品契约-v1.md) / [`29`](29-Dashboard产品说明.md) | 产品契约（含浮窗搜索行为）/ Dashboard；Dashboard 明确分开业务“工单分析”与内部“话术优化待办” |
| [`25`](25-PRD草案-客服Agent一期.md) / [`26`](26-话术库与自动事实数据模型.md) / [`32`](32-ADR-一期技术栈.md) | PRD / 自动事实数据模型 / ADR |
| [历史设计包](../99-历史/2026-08-06-架构设计收口/) | 已被替代的初始草案、选型对照、补洞过程与自评；不得按现行执行 |

## 护栏测试

```bash
PYTHONDONTWRITEBYTECODE=1 python3 tests/test_arch_ssot_invariants.py
# 期望：summary fail=0（总数以当前测试输出为准）
```

当前结论：**技术第 1～3 关已通过；当前停在第 3→4 关之间的组织授权门。G0 待签、Ddev 未授权、代码开发未开始；真实数据、外部教师调用、训练、模型发布与 Pilot 均为 NO-GO。**
