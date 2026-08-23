# ADR · 一期技术栈（对齐架构 SSOT 37）

> **状态：** **Accepted · 2026-08-08 · v1.3**\
> **权威：** [`37-架构SSOT-v1.md`](37-架构SSOT-v1.md)\
> **API 合同：** [`39-API合同与发布状态机-v1.md`](39-API合同与发布状态机-v1.md)\
> **SoR DDL：** [`33-schema-v1-草案.sql`](33-schema-v1-草案.sql) = **PostgreSQL 15+**\
> **不得**改：路线 A、禁改写、禁代发、Postgres 为跨用户 SoR\

## 决策

| 层 | 选择 | 理由 |
|----|------|------|
| 拓扑 | **Electron 壳 + 中心 API + PostgreSQL SoR** | 多用户一致、发布/公告、日志归集 |
| 客户端 | Electron + TypeScript + React | 浮窗/剪贴板/热键 |
| API | TypeScript / Node · 端口合同见 **39** | 与壳同合同；可单实例 |
| 权威库 | **PostgreSQL**（33 为生产方言） | 并发、事务、备份、CHECK 不变量 |
| 本地缓存 | 可选 SQLite 只读快照 + FTS | **非 SoR**；Demo 可单机临时库 |
| 检索实现 | 一期 Unicode 字符 bigram `tsvector` 主路径；exact/ILIKE 回退；`pg_trgm` 仅可辅助回退；向量后置 | 执行合同见 39 §2.1；接口 `search` 稳定（39 §2） |
| LLM | 一期可选 DeepSeek 仅排序/理解/拒答；Answer=库 | 禁改写 |
| 内容 | Excel/CSV 导入默认；飞书 API adapter 预留 | Import→Staging→Publish→Announce |
| 推送 | 主 CTA 剪贴板；自动填实验 | 诚实可验；INV-ADOPT |
| 二期旁路 | Python worker 清洗 | 不进 Electron 主进程 |
| Rust | 一期不上 | ROI 不足 |

## 禁止

- Dify/RAGFlow 主中台\
- SQLite 作为跨用户唯一权威库\
- LLM 改写 Answer（一期）\
- 自动代发\
- 无 Publish 的全员同步声称\
- 把 08-12 Demo 当作架构北极星\

## 全景展开（部署向）

分层穷尽清单（L0～L16 · Must/Optional/Deferred/Ban · 环境变量 · Tech Radar）见：

**[`43-技术栈全景清单-部署向.md`](43-技术栈全景清单-部署向.md)**

架构板 Tab 6「技术栈与部署」与之同步。

## 后续 ADR

1. 飞书 OAuth 与 RBAC\
2. 自动填千牛/抖音矩阵\
3. 向量检索实现\
4. 密钥与出域\
5. Postgres HA / 备份\

> **v1.3 修订：** 文件名与 Accepted 状态对齐；解除对 44 历史终裁快照的规范性依赖，检索合同直接指向 39。
