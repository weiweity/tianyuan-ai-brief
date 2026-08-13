# 2026-08-09 安全维护快照

> **性质：** 仅修复公开历史 Web 的第三方前端依赖，不改变 2026-07-31 的业务内容、状态、结论或审批记录。
> **派生基线：** `2026-07-31-ai-project-brief`（旧目录与旧 manifest 保持字节不动）。

## 变更

- DOMPurify `3.4.12` → `3.4.13`（GHSA-55q2-fjhq-7xh7）；
- Mermaid `10.9.6` → `10.9.8`（GHSA-c4c3-pg64-4m4v、GHSA-6x64-9x62-f2gx、GHSA-2v8p-3f2j-5mp7）；
- 同步本地 vendor、DOMPurify import、Mermaid loader/SRI，以及由构建器生成的 Bundle、release.json 和 index 资源指纹。

## 不变边界

除上述安全白名单与本说明外，所有文件必须与基础归档逐字节一致。尤其 `data/content.json`、Schema、CSS、业务源 JS、许可证与素材不得变化。
本目录仍是历史展示快照，不是当前客服 Agent 项目或任何业务状态的真源。
`ARCHITECTURE.md` 只同步上述两项依赖版本，其余历史语义不变。
