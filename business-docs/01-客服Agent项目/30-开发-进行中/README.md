# 30 · 正式开发阶段（进行中）

> **状态：** `G1A-E0 T1～T3 · COMPLETE · MERGED` · `DEV-M1 W0 / W1 / W2 / W3 / W4 / W5 COMPLETE`
> **进入与推进证据：** 设计评审通过、G0 / Ddev、DEV-M0 退出证据，产品仓 PR #17～#20 的 DEV-M1 收口，以及 PR #21（`main@be33c0e`）与 post-merge CI run `33849888116`
> **下一动作：** 在仓外准备 T4 四域真实快照、20+12+18 评测集、DLP/删除计划与独立盲审锁；未获单独授权前不装载、不运行

目录名保持技术第 4 关兼容入口。本项目记录仓只保存阶段、决定和证据；产品代码继续只在独立产品实施仓中维护。`DEV-M0` 与 `DEV-M1` W0～W5 退出证据已完成；G1A-E0 T1～T3 又通过产品仓 PR #21 合并到 `main@be33c0e`，`pnpm test:g1a:e0` 38/38、API 115/115，合并后 CI run `33849888116` 三条 lane 全绿，通过仓外包校验、隔离 PG15、同一 SearchBackend、零事件、脱敏报告与正反清理。该结果仍固定为 `NOT_SIGNED / NOT_EVALUATED`，不自动放行真实 G1a、`DEV-M2`、真实资料、飞书运行接入、desktop adapter、部署、Pilot 或付费调用。

当前决定与执行入口：

- [`../90-评审/2026-09-04_DEC-SEARCH-01真实G1a准入复核.md`](../90-评审/2026-09-04_DEC-SEARCH-01真实G1a准入复核.md)
- 产品仓 `docs/plans/2026-09-04-g1a-search-admission.md`
