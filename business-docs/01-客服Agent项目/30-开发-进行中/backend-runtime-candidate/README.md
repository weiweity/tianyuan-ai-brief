# 后端机器合同候选

状态：DRAFT · 三项合同补齐，未冻结、未激活、未 intake。基线为 OpenAPI 1.12.0 / schema 1.15，现行导出和生成器保持不变。

- [设计](../../20-设计-进行中/51-后端身份与内容闭环-合同设计草案.md)
- [OpenAPI 增量](openapi.delta.json)：登录、审核列表/详情分页、决定、逐项质量检查、恢复与取消入口。
- [存储增量](storage.delta.sql)：身份、会话、能力、等待和逐项检查。
- [事务增量](transactions.delta.sql)：登录单次消费；主体资格、幂等回执；停放/恢复/取消/finalizer；有限角色 ACL。

## 分页与审核

详情必须携带 batch_id 和 review_revision，after 为该不可变数组已经消费的位置（默认 0），limit 默认 20、最大 100。位置按冻结数组顺序，next_after 为 null 表示结束。版本不同或取消返回 REVIEW_STALE；不得将旧位置用于新版本。SQL 用显式投影返回话术、适用范围、风险、生效时间、公开问题字段及初审/扩样标记，不返回原始对象定位、token、问题来源 HMAC 或审核人身份。

sample_ids 是样本集合唯一计算者：普通行按 SHA256(seed:script_id:content_hash)、再按 C 排序的 script_id 排序；高风险/冲突始终全审。selection_manifest_hash 是初审与扩样两个有序 ID 数组的 JSONB 文本 SHA256，park 时验证与冻结计划一致。revision 是规范化 JSONB rows 文本摘要，与原上传文件摘要不是同一种摘要。

质量请求以 revision 唯一绑定 plan/population，不重复提交两者。逐项检查必须精确覆盖该阶段样本和强制全审集合，同条目跨阶段不能翻转缺陷结果。初审与扩样阈值沿用既有函数；低于阻断阈值但发现缺陷时返回 revision_required，先修订/隔离并重新导入，不修改冻结 rows，也不将它谎称为阈值阻断。真正超阈值仍为 blocked。此切片不实现就地修订编辑器。

## 受限事务与锁

app_backend_auth、app_backend_review、app_backend_worker 都是 NOLOGIN 角色，不授予真实登录用户成员关系。角色只执行指定函数，不能直接读写私有表，worker 不能提交审核。SQL 函数的 token 参数仅由服务端网关传递；HTTP 不提供 SQL 执行能力或数据库角色选项。真实提供方与凭据仍未接入。

内容事务先取得同一个 advisory xact lock，再进入原业务函数；12 个既有内容入口以固定名称集合应用该门，并验证数量，保留旧 body、签名、owner 与 ACL。cs_ai_definer 仅额外取得锁函数执行权。这解决既有 job-first / batch-first 锁顺序混用；人工等待、磁盘读写、解析和网络请求不得占此事务。首轮串行写入，未来提高并发需单独设计并压测，不能直接移除门。

停放将本次解析任务完成并创建等待记录，人工等待不消耗重试；恢复要求通过质量证据及必要异人审核，唯一创建后续验证任务。最终 staging 仍通过既有 finalizer 重验来源、内容摘要与质量门；resume 不代表发布成功。cancel 先使 batch 失败并终止任务，再标记等待取消。

## 验证

在 sites 下运行：

```sh
npm run test:backend-candidate
npm run test:backend-candidate:pg
```

静态候选检查已接入 `test:release`；PG 检查保留上述独立命令，需要本机 PostgreSQL 15。PG 测试使用 PG_BIN 或 pg_config 定位二进制，启动前检查主版本并核对运行服务器版本；创建独立临时集群，仅 Unix socket，finally 回收并等待锁持有子进程后停止数据库；保留临时日志。已实际验证 PG15 安装、重复兑换、撤销、审核重放与异内容拒绝、分页过期版本、质量覆盖不足/质量门未过、异人审核缺经理拒绝、质量通过、恢复唯一性、取消后恢复拒绝、实际认证/审核/worker 角色调用与越权拒绝、无能力主体与跨能力拒绝，以及双连接内容事务串行。过期版本、幂等冲突和撤销断言同时核对 SQLSTATE 与错误原因。另以故障注入验证非 PG15 拒绝、锁持有子进程启动失败不产生未处理 Promise 拒绝且数据库停止。

本轮并非完整阶段验收，也不构成合同冻结：真实 HTTP/worker 构建入口、完整发布链、5,000 行负载、所有崩溃点及全面并发矩阵仍待后续。正式版本生成、产品 intake 与真实运行均未获准。
