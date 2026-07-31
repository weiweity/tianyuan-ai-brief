# 08 · 客服立项校验工具

本目录只维护客服 Agent 现行双页与 00–06 真源之间的生成、合同和浏览器验收工具。历史 Python 核验脚本不属于本轮日常门禁，也不应随本轮提交。

| 文件 | 唯一用途 |
|------|----------|
| `customer_project_status.mjs` | 从章程、G0、Scope 与费用真源推导受控状态；拒绝伪 G0、伪 Ddev、伪 cap 与无证据状态 |
| `check_customer_agent_prd_sources.mjs` | 校验 PRD 的状态、里程碑、验收和费用动态合同，并维护 7 份真源清单 |
| `generate_customer_agent_hub.mjs` | 从 00–06 生成只读执行中心；`--check` 拒绝过期页面 |
| `templates/customer-agent-hub.template.html` | 执行中心唯一 HTML 模板 |
| `test_customer_agent_prd.mjs` | PRD 五视口、交互、打印、深色与无障碍验收 |
| `test_customer_agent_hub.mjs` | 执行中心五视口、筛选、复制、打印、深色与无障碍验收 |
| `project_workspace.mjs` | 强制公开模板 / 仓外私有工作区二选一；私有模式须有标记且不得位于公开仓内 |
| `prepare_private_customer_project.mjs` | 在公开仓外创建不覆盖的私有副本，供 A 路径和真实状态使用 |

从仓库根执行：

```bash
# 进入真实状态或 A 路径前，仅执行一次；目标父目录必须已存在
node business-docs/08-工具/prepare_private_customer_project.mjs --target=/绝对路径/客服Agent项目
export CUSTOMER_PROJECT_MODE=private
export CUSTOMER_PROJECT_ROOT=/绝对路径/客服Agent项目

# 真源变更后，先更新衍生物
node business-docs/08-工具/check_customer_agent_prd_sources.mjs --update
node business-docs/08-工具/generate_customer_agent_hub.mjs

# CI / 会前只读检查
node business-docs/08-工具/check_customer_agent_prd_sources.mjs --check
node business-docs/08-工具/generate_customer_agent_hub.mjs --check

# 浏览器交叉验收
node business-docs/08-工具/test_customer_agent_prd.mjs --round=ci
node business-docs/08-工具/test_customer_agent_hub.mjs --round=ci
```

## 数据边界

- 本仓只接受 `ROLE-*` / `USR-*` 人员代号与 `EVD-*` 证据 ID。
- 真实姓名、客户原文、审批原话、原始协作链接、精确 cap、PII 与安全细节只存受控系统。
- Git 远端为公开仓；含真实状态的本地分支不得直接推送，除非先迁移到私有仓或完成正式安全复核。
- 公共 Pages 只发布已收尾历史 Web，不读取或复制客服项目资料。

返回 [`业务文档地图`](../README.md)。
