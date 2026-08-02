# 公共站点发布区

这里只负责发布两个彼此独立的页面，不维护业务状态。

| 发布单元 | 生命周期 | 仓库源 | 网址 |
|---|---|---|---|
| AI 赋能立项汇报 | **已归档 · 2026-07-31** | [`../archive/2026-07-31-ai-project-brief/`](../archive/2026-07-31-ai-project-brief/) | <https://weiweity.github.io/tianyuan-ai-brief/> |
| 客服 Agent 一期启动会 | **当前会议视图** | [`../business-docs/01-客服Agent项目/09-客服Agent需求会汇报.html`](../business-docs/01-客服Agent项目/09-客服Agent需求会汇报.html) | <https://weiweity.github.io/tianyuan-ai-brief/customer-agent/> |

## 边界

- `archive/` 是冻结快照，构建前按 [`archive-manifest.json`](../archive/archive-manifest.json) 校验文件数、入口哈希和整棵目录哈希。
- 历史站点的构建脚本只有只读 `--check` 模式；不提供原地重建命令。
- 客服页面只从客服项目真源生成；品牌素材归客服项目自己所有，不依赖历史归档目录。
- `scripts/build-pages-artifact.mjs` 只做发布编排：归档页发布到 `/`，客服安全视图发布到 `/customer-agent/`。
- `dist/` 和 `test-results/` 是本地生成物，不提交。

## 校验与预览

```bash
cd sites
npm run verify:archive
npm run test:all
npm run serve
```

本地预览地址为 <http://localhost:8765/> 和 <http://localhost:8765/customer-agent/>。
