# CR-003 training-artifacts

> **状态：** 一期静态预埋 · 2026-08-08\
> **允许：** schema、空模板、纯合成 fixture 的结构校验\
> **禁止：** 真实数据、真实坐席 / 客户内容、生产导出、外部 teacher 输出、模型权重、训练与发布

目录只保留四个文件：

| 文件 | 作用 |
|------|------|
| `training-artifact.schema.json` | 唯一 JSON Schema，约束来源分账、用途、split、Question / Answer 绑定、行为候选、审批、teacher-run、预算与删除血缘 |
| `training-artifact.template.json` | 空模板；`items=[]`、`teacher_runs=[]`，不伪造授权或 hash |
| `training-artifact.synthetic.fixture.json` | 全虚构结构样例；没有真实人物、账号、订单、工单、聊天或外部模型调用 |
| `README.md` | 本说明 |

## 使用边界

- artifact 只允许 `retrieval / intent / reranker / shadow_embedding`；不允许生成回复训练。
- 一个 artifact 只属于 `real / policy / synthetic` 一账；item 必须与顶层分账、用途一致。
- `train / validation` 只用于训练内部切分；G1a/G1b 使用独立 manifest，禁止放入本目录。
- `behavior_signals.signal_status` 固定为 `candidate_only`；复制不能自动成为正确、发送或满意标签。
- Answer 必须绑定 `release_id + script_id + script_version + content_hash`；Question 使用独立 `semantic_asset_id / semantic_family_id`。
- external provider 的 teacher-run 必须有明确书面授权；GLM 没有写明允许蒸馏时不得建 run。当前 fixture 的 `teacher_runs=[]`。
- `0/14/30`、语义资产晋级、双审、删除血缘、许可与 cap 见 [`../49-CR-003一期训练预埋与多教师蒸馏.md`](../49-CR-003一期训练预埋与多教师蒸馏.md)。

## 最小校验

```bash
jq empty training-artifact.schema.json training-artifact.template.json training-artifact.synthetic.fixture.json
```

有 JSON Schema 2020-12 validator 时，还要用 `training-artifact.schema.json` 分别验证 template 与 fixture。实现期 validator 还必须补跨字段断言：

1. 顶层与所有 item 的 `data_account` / `purpose` 相同；
2. item ID、语义资产 ID、语义簇与 deletion key 在 bundle 内唯一；
3. `train / validation / G1a / G1b` 的精确 hash、语义簇、lineage group、template ancestor 交集均为 0；
4. `actual_cost <= run_cap` 且累计费用不超过日 / 批次 / 月 cap；
5. `approved` artifact 必须业务 + 数据安全双审、训练授权齐全，模型发布另须 publish authorization；
6. 删除 manifest 覆盖 dataset、embedding、teacher-run、checkpoint 与备份恢复重删。

## 纯合成保证

fixture 中所有 ID 以 `SYN-` 开头，问法与内容均明确虚构，hash 为占位测试值，`promotion_eligible=false`，外部调用与费用为 0。它只能证明合同能表达数据，不能证明模型效果、真实数据合规、G0、Ddev、Pilot 或发布就绪。
