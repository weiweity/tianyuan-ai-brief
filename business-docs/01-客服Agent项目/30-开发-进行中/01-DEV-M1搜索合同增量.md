# DEV-M1 搜索合同增量

> **状态：** `GOVERNANCE CONTRACT · PRODUCT NOT CONSUMED`
> **适用里程碑：** `DEV-M1`
> **父基线：** 已签 Ddev 冻结的 `schema.v1.12` / OpenAPI `1.11.0`；本文件不修改、替代或重新签发 37/46 的历史授权投影。
> **DEV-M1 机器合同增量：** `schema.v1.13`（SHA-256 `de8b7d9bdcac4ecad844025a47228ba339dad47d61861d261c492cb16a1aea02`）/ OpenAPI `1.11.0`（SHA-256 `06698f233702591c8f981c7b08ebac4b7d5bc5cc2d69d36014ef2a9f5a6802e4`）。
> **实际产物必须精确匹配：** schema SHA `de8b7d9bdcac4ecad844025a47228ba339dad47d61861d261c492cb16a1aea02` 与 OpenAPI SHA `06698f233702591c8f981c7b08ebac4b7d5bc5cc2d69d36014ef2a9f5a6802e4`，并绑定本候选最终治理仓完整提交 SHA。

## 1. 增量边界

1. 保留既有 `search_recommendable_scripts(platform, product_context_type, product_context_ref)` scope-only 入参和 `SECURITY DEFINER` 边界。
2. 仅向该函数的返回投影增加 `questions`、`search_document`、`search_fallback_text`：`questions` 必须经 `content_public_questions(candidate.questions_json)` 白名单包装；其余两个字段只承载预计算检索证据。
3. 原始 `questions_json`、reviewer / EVD、来源定位符及其他内部治理字段继续不可见；`app_runtime` 仍不得直读 backing view、`release_items` 或 `content_current`。
4. OpenAPI wire shape 不变；本增量不增加路由、业务范围、真实数据、外部模型、自动学习、自动发送、生产环境或付费授权。

## 2. 规范来源与交接顺序

- 当前 reference DDL：`20-设计-进行中/33-schema-v1-草案.sql`
- 当前事务与公开边界：`20-设计-进行中/39-API合同与发布状态机-v1.md`
- 冻结设计与 Ddev 历史输入：`20-设计-进行中/37-架构SSOT-v1.md`、`20-设计-进行中/46-实现设计-开工包.md`，保持原字节不变。
- 交接必须按“治理仓候选验证 → 明确提交授权 → 精确完整提交 SHA 导出只读合同集 → 产品仓 intake → 不可变 v1.12→v1.13 migration → runtime 与动态负例”推进；任一哈希、来源提交或公开投影不一致即 fail-closed。

## 3. 治理仓交接条件

- 治理仓机器合同、架构合同、项目状态与 PG15 预检通过。
- Ddev 已签投影保持原哈希，不以本增量冒充重新签发。
- 合同导出器从精确提交读取本文件，并同时校验 39 与本文件中的当前双哈希。
- 产品仓未完成 intake、migration 和动态测试前，本文件只证明治理合同一致，不证明 Search runtime 已实现。
