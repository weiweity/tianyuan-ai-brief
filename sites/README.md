# 公共站点发布区

这里只负责发布两个彼此独立的页面，不维护业务状态。

| 发布单元 | 生命周期 | 仓库源 | 网址 |
|---|---|---|---|
| AI 赋能立项汇报 | **2026-07-31 业务快照 · 2026-08-09 安全维护** | [`../archive/2026-08-09-ai-project-brief-security-maintenance/`](../archive/2026-08-09-ai-project-brief-security-maintenance/) | <https://weiweity.github.io/tianyuan-ai-brief/> |
| 客服 Agent 一期启动会 | **PRE-D0 / 需求阶段会议快照 · 非当前设计 SSOT** | [`../business-docs/01-客服Agent项目/09-客服Agent需求会汇报.html`](../business-docs/01-客服Agent项目/09-客服Agent需求会汇报.html) | <https://weiweity.github.io/tianyuan-ai-brief/customer-agent/> |

## 边界

- `archive/2026-07-31-ai-project-brief/` 与旧 [`archive-manifest.json`](../archive/archive-manifest.json) 保持字节不动；当前发布快照按独立的 [`2026-08-09...manifest.json`](../archive/2026-08-09-ai-project-brief-security-maintenance.manifest.json) 校验文件数、入口哈希和整棵目录哈希。
- 历史站点的构建脚本只有只读 `--check` 模式；不提供原地重建命令。
- 客服页面只从客服项目真源生成；品牌素材归客服项目自己所有，不依赖历史归档目录。
- `scripts/build-pages-artifact.mjs` 只做发布编排：归档页发布到 `/`，客服安全视图发布到 `/customer-agent/`。
- `dist/` 和 `test-results/` 是本地生成物，不提交。

`package.json` 中的 `dompurify@3.4.13` 与 `mermaid@10.9.8` 是当前公开快照本地 vendor 的 **audit/SBOM mirror**。页面运行时只加载 `archive/2026-08-09-ai-project-brief-security-maintenance/vendor/`，不从 `node_modules` 或 CDN 加载；锁文件、vendor 文件名、许可证、Mermaid SRI 与测试必须同步。旧归档中的 3.4.12 / 10.9.6 只作为不再发布的原始证据保留，不允许用 package-only 升级制造假修复。

## 校验与预览

最小环境：Node.js 24.x（`package.json` 允许 24–25，CI 锁 24）、npm 11.x、Python 3、bash 与 zsh（测试会显式调 `/bin/zsh`，Linux 必须另行安装 zsh）。首次 clone 必须先安装锁文件依赖与 Chromium；不得用 floating `latest` 替代 lockfile。

```bash
cd sites
npm ci --ignore-scripts
npx playwright install chromium
npm run verify:archive
npm run test:all
npm run serve
```

Linux CI 如需同时补系统依赖，使用 `npx playwright install --with-deps chromium`。`npm run test:all` 包含基础测试、四视口 UI/Axe、架构图看板、业务真源、Redocly OpenAPI、固定 `@libpg-query/parser@17.6.10` 的 SQL/函数体 grammar gate、37 项架构合同、7 图同步与依赖审计。

日常迭代不必每次运行整套浏览器和依赖审计。按本次逻辑改动选择最小可证明门禁；长期脏工作树中不要根据全部 `git status` 自动升级，否则旧改动会让每次文案修订都误跑全量：

| 本次改动 | 命令 | 证明边界 |
|---|---|---|
| 纯 Markdown 措辞、索引、历史说明 | `npm run test:docs:fast` | 空白与 diff 结构，不证明状态或页面 |
| 客服 `00`–`06`、状态解析、生成源清单 | `npm run test:customer-contracts` | 状态/合同与 `07/08/09` 稳定点；真源有意变化时先运行 `npm run sync:business-surfaces` |
| 公开/私有边界、代号、EVD、URL/token 规则 | `npm run test:customer-boundary` | 脱敏与仓外私有工作区边界 |
| `20-设计-进行中/` 人读设计或图 | `npm run test:design-contracts` | Python 架构不变量与 7 图一致性；改图源时先运行 `npm run sync:arch-diagrams` |
| schema / OpenAPI | `npm run test:machine-contracts` | SQL grammar 与 OpenAPI lint，不证明真 PG/runtime |
| 阶段收口、发布候选、PR/部署前 | `npm run test:release` | 等价完整 `test:all`，包含 UI、业务 QA、依赖审计及所有静态合同 |

轻量门只缩短反馈回路，不降低发布标准。HTML 模板、交互、可访问性、构建/归档、依赖、锁文件、CI 或发布工具发生变化时，仍须补对应浏览器/归档检查，并在形成发布候选前运行 `test:release`。

`npm run create:security-archive` 只用于首次创建 2026-08-09 快照，若目标已存在会拒绝覆盖；日常只运行 `npm run verify:archive`。生成器从旧归档与锁定的 `node_modules` 在临时目录重建，白名单校验通过后才发布新目录和独立 manifest，禁止手改 Bundle。

客服设计 changeset 进入当前 Public origin 前，人工运行 `npm run prepare:customer-agent-publish-manifest`。它只在 ignored `output/` 生成完整工作树 inventory 与精确 stage manifest，并把路径、原始字节、Git mode、HEAD/branch/origin 绑定为 bundle；结果固定为“候选未批准”，不会执行 Git 写操作。候选 README 与审批模板会显式列出 `customer-agent` / `design-research` / `security-maintenance-archive` / `shared-repository` / `supply-chain` 五个评审分组及路径数。Product / Security / Tech 三方受控 EVD 必须确认同一 bundle SHA 并覆盖其中全部分组；如任一分组不应交付，须先调整工作树并重生 bundle，不得对同一 bundle 做局部批准。三方确认前不得 stage、commit 或 push，始终禁止 `git add .`。获批后只可按清单精确暂存，并在 commit 前运行 `node ../business-docs/08-工具/prepare_customer_agent_publish_manifest.mjs --verify-staged=<bundle>`；只有 index blob/mode 与候选完全一致时才返回 `STAGED_MATCH`，且仍不自动提交或推送。

本地预览地址为 <http://localhost:8765/> 和 <http://localhost:8765/customer-agent/>。
