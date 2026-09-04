# 30 · 正式开发阶段（进行中）

> **状态：** `DEV-M1 COMPLETE` · `G1A-E0 T1～T3 COMPLETE · MERGED` · `T4 READY` · `T5 NOT STARTED`
> **进入与推进证据：** 设计评审、G0 / Ddev、DEV-M0 / DEV-M1 退出证据；产品仓 comparison v2 合同 PR #23（`main@b0a52d9`）与 CI run `33889553752`；仓外 `EVD-G1A-DATA-01`、`EVD-G1A-EVALSET-01`、`EVD-G1A-BLIND-01`、`EVD-G1A-COMPARISON-02`、`EVD-G1A-HOST-01`、`EVD-G1A-PACKAGE-01`
> **下一动作：** 展示 T5 最终 dry-run 后，另行授权一次受控离线运行；当前不运行、不签发 T6

目录名保持技术第 4 关兼容入口。本项目记录仓只保存阶段、决定和证据；产品代码继续只在独立产品实施仓中维护。`DEV-M0`、`DEV-M1` W0～W5 与 G1A-E0 T1～T3 退出证据已完成；comparison v2 合同已通过 PR #23 合并。仓外 T4 输入包以四个 0600 成员装配，实际产品解析器静态校验通过；宿主网络沙箱与异常残留回收只以纯合成数据预演通过。T5 尚未运行，结果仍固定为 `NOT_SIGNED / NOT_EVALUATED`，不自动放行真实 G1a、`DEV-M2`、飞书运行接入、desktop adapter、部署、Pilot 或付费调用。

当前决定与执行入口：

- [`../90-评审/2026-09-04_DEC-SEARCH-01真实G1a准入复核.md`](../90-评审/2026-09-04_DEC-SEARCH-01真实G1a准入复核.md)
- 产品仓 `docs/plans/2026-09-04-g1a-search-admission.md`
