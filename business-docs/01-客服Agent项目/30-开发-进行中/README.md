# 30 · 正式开发阶段（进行中）

> **状态：** `DEV-M1 COMPLETE` · `G1A-E0 T1～T3 COMPLETE · MERGED` · `T4 READY` · `T5 ATTEMPTED / BLOCKED · NOT_EVALUATED`
> **进入与推进证据：** 设计评审、G0 / Ddev、DEV-M0 / DEV-M1 退出证据；产品仓 comparison v2 合同 PR #23（`main@b0a52d9`）与 CI run `33889553752`；仓外 `EVD-G1A-DATA-01`、`EVD-G1A-EVALSET-01`、`EVD-G1A-BLIND-01`、`EVD-G1A-COMPARISON-02`、`EVD-G1A-HOST-01`、`EVD-G1A-PACKAGE-01`、`EVD-G1A-RUN-01`、`EVD-G1A-CLEANUP-01`
> **下一动作：** 展示 T5 重试 dry-run，重新核验包有效期、权限与外部 manifest 锚点后，另行授权一次受控离线重试；当前不重试、不签发 T6

目录名保持技术第 4 关兼容入口。本项目记录仓只保存阶段、决定和证据；产品代码继续只在独立产品实施仓中维护。`DEV-M0`、`DEV-M1` W0～W5 与 G1A-E0 T1～T3 退出证据已完成；comparison v2 合同已通过 PR #23 合并。仓外 T4 输入包以四个 0600 成员装配，实际产品解析器静态校验通过；宿主网络沙箱与异常残留回收先以纯合成数据预演通过。首次 T5 在任何 case 执行前因临时目录别名与 sandbox profile 不一致而失败关闭，RUN/CLEANUP 证据确认 0 条评测与 0 残留；共享来源修复经 PR #24 合并至 `main@4dbee4b`，合并后 CI run `33930030132` 三路全绿；仍只具备合成验证证据，修复后真实重试尚未执行，结果仍固定为 `NOT_SIGNED / NOT_EVALUATED`，不自动放行真实 G1a、`DEV-M2`、飞书运行接入、desktop adapter、部署、Pilot 或付费调用。

当前决定与执行入口：

- [`../90-评审/2026-09-04_DEC-SEARCH-01真实G1a准入复核.md`](../90-评审/2026-09-04_DEC-SEARCH-01真实G1a准入复核.md)
- 产品仓 `docs/plans/2026-09-04-g1a-search-admission.md`
