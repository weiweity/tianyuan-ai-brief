# 08 · 客服立项校验工具

本目录维护客服 Agent `07/08` 现行生成视图、`09` D0 冻结快照与 `00–06` 真源之间的生成、合同和浏览器验收工具。历史 Python 核验脚本不属于本轮日常门禁，也不应随本轮提交。

| 文件 | 唯一用途 |
|------|----------|
| `customer_project_status.mjs` | 从章程、G0、Scope 与费用真源推导受控状态；拒绝伪 G0、伪 Ddev、伪 cap 与无证据状态 |
| `check_customer_agent_prd_sources.mjs` | 校验 PRD 的状态、里程碑、验收和费用动态合同，并维护 7 份真源清单 |
| `generate_customer_agent_hub.mjs` | 从 00–06 生成只读执行中心；`--check` 拒绝过期页面 |
| `templates/customer-agent-hub.template.html` | 执行中心唯一 HTML 模板 |
| `generate_customer_agent_meeting.mjs` | 在 D0 生命周期开放时从 00–06 生成启动会主屏；D0 已结束后拒绝直接重写，由同步链只校验既有冻结快照 |
| `templates/customer-agent-meeting.template.html` | 启动会主屏唯一 HTML 模板 |
| `test_customer_agent_prd.mjs` | PRD 五视口、交互、打印、深色与无障碍验收 |
| `test_customer_agent_hub.mjs` | 执行中心五视口、筛选、复制、打印、深色与无障碍验收 |
| `test_customer_agent_meeting.mjs` | 启动会主屏的泄漏门禁、五视口、交互、离线、打印与无障碍验收 |
| `verify_customer_agent_pg15.mjs` | 在临时 PostgreSQL 15 cluster 中预检当前 reference DDL；只用 Unix socket、禁用 TCP，结束时删除 PGDATA/WAL，结果写入已忽略的 `output/` |
| `export_customer_agent_contract_set.mjs` | 只从调用方指定的完整 40 位来源 commit 读取 OpenAPI / DDL 与规范锚点，校验双哈希后在 ignored `output/` 原子生成只读、不可覆盖的版本化合同集；不读脏工作树、不写产品仓 |
| `verify_customer_agent_g009_intake.mjs` | 校验 G0-09 四域接收清单的公开安全投影；允许预填态盘点，最终用 `--require-ready` 拒绝缺域、证据错配、质量分母错误和敏感值 |
| `inspect_customer_agent_source.py` | 只读检查售前/售后 `.xlsx/.csv`：输出文件指纹、匿名工作表统计、受控字段候选和敏感命中计数，不复制正文、不写数据库 |
| `prepare_customer_agent_g009_workpack.py` | 将安全模板与售前/售后技术报告组装为仓外待签工作包；技术行数与正式质量/EVD严格分账，不自动推进 READY |
| `run_customer_agent_g009_intake.py` | 一键编排售前/售后只读检查与待签工作包；内存完成检查后再原子写出，失败不留半成品，仓内只能写 ignored `output/` |
| `prepare_customer_agent_publish_manifest.mjs` | 为 `DEC-PUBLISH-01` 双采样完整工作树，校验迁移配对、生成链、敏感路径、断链与未暂存边界，并在 ignored `output/` 生成绑定 HEAD/origin 的 exact-file 候选；获批并由人工精确暂存后还可核对 index blob/mode；绝不执行 Git 写操作 |
| `project_workspace.mjs` | 强制公开模板 / 仓外私有工作区二选一；私有模式须有标记且不得位于公开仓内 |
| `prepare_private_customer_project.mjs` | 在公开仓外创建不覆盖的私有副本，供 A 路径和真实状态使用 |
| `customer_service_staging_importer.py` | 离线读取产品 QA、活动话术、VOC Excel，输出高置信标识符已遮罩的 JSONL、批次 manifest 和质量报告；非完整匿名化，只写受控 staging，不连接 PostgreSQL |
| `customer_service_staging_schema.sql` | 隔离的 `customer_service_staging` 表结构；不接入客服 Agent 在线发布链，也不授予 `app_runtime` |
| `customer_service_staging_loader.py` | 校验 staging 批次并生成 PostgreSQL dry-run SQL；默认不连接数据库，显式 `--apply` 才执行 |
| `customer_service_staging_api.py` | 本地预览/人工审阅 API 原型；默认只读，启用写入时用服务端角色 + 本次启动 Bearer token；不连接 PostgreSQL、不晋级正式话术 |
| `test_customer_service_staging_pipeline.py` / `test_customer_service_staging_api.py` | importer → loader 端到端、受控覆盖、凭据/SQL 失败门禁、审阅鉴权和幂等合同测试 |

从仓库根执行：

```bash
# 进入真实状态或 A 路径前，仅执行一次；目标父目录必须已存在
node business-docs/08-工具/prepare_private_customer_project.mjs --target=/绝对路径/客服Agent项目
export CUSTOMER_PROJECT_MODE=private
export CUSTOMER_PROJECT_ROOT=/绝对路径/客服Agent项目

# 首次使用 Excel staging 工具时，在受控 Python 环境安装精确依赖
python3 -m pip install --requirement business-docs/08-工具/requirements-customer-agent-tools.txt

# 客服数据先进入离线 staging（不创建/连接/写入 PostgreSQL）
python3 business-docs/08-工具/customer_service_staging_importer.py --self-test
python3 business-docs/08-工具/customer_service_staging_importer.py \
  --qa-file '/绝对路径/达肤妍产品QA&话术.xlsx' \
  --campaign-file '/绝对路径/8月活动话术.xlsx' \
  --voc-file '/绝对路径/达肤妍核心产品VOC反馈.xlsx' \
  --output-dir '/绝对路径/output/customer-service-staging-YYYYMMDD' \
  --batch-id 'BATCH-PREFILL-YYYYMMDD-001'
# 只有该目录已带工具生成的 managed marker 时，才允许追加 --overwrite 原子替换；
# 任意非托管目录、公开仓非 ignored 目录和宽泛目录都会 fail-closed。

# staging 批次只生成 SQL（默认 dry-run，不连接数据库）
python3 business-docs/08-工具/customer_service_staging_loader.py --self-test
python3 business-docs/08-工具/customer_service_staging_loader.py \
  --staging-dir '/绝对路径/output/customer-service-staging-YYYYMMDD' \
  --sql-out '/绝对路径/output/customer-service-staging-YYYYMMDD/staging_load.sql'

# 本地只读预览；仅监听 127.0.0.1，不连接 PostgreSQL
python3 business-docs/08-工具/customer_service_staging_api.py --self-test
python3 business-docs/08-工具/customer_service_staging_api.py \
  --staging-dir '/绝对路径/output/customer-service-staging-YYYYMMDD' \
  --port 8787

# 确需追加本地审阅事件时，角色由服务端启动参数绑定，token 只走环境变量；
# 请求体不得自报 reviewer_role，同一幂等键异体请求返回 409。
export CUSTOMER_STAGING_REVIEW_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
python3 business-docs/08-工具/customer_service_staging_api.py \
  --staging-dir '/绝对路径/output/customer-service-staging-YYYYMMDD' \
  --reviewer-role 'ROLE-QA-001' \
  --port 8787

# 只有明确授权且确认连接目标为隔离 staging 库时，才允许实际执行；
# 不得把这个命令指向客服 Agent 正式发布库。连接信息与凭据必须预先放入
# 受控 libpq service / pgpass；工具只接收非敏感 service 名。
python3 business-docs/08-工具/customer_service_staging_loader.py \
  --staging-dir '/绝对路径/output/customer-service-staging-YYYYMMDD' \
  --sql-out '/绝对路径/output/customer-service-staging-YYYYMMDD/staging_load.sql' \
  --apply --pg-service 'customer_agent_staging'

# 真源变更后同步 07/08；09 仅在生命周期开放时生成，关闭后只校验冻结快照
node business-docs/08-工具/sync_customer_agent_surfaces.mjs

# CI / 会前只读检查
node business-docs/08-工具/sync_customer_agent_surfaces.mjs --check

# 浏览器交叉验收
node business-docs/08-工具/test_customer_agent_prd.mjs --round=ci
node business-docs/08-工具/test_customer_agent_hub.mjs --round=ci
node business-docs/08-工具/test_customer_agent_meeting.mjs --round=ci

# 显式人工运行的 PG15 设计前置预检；不在 test:all 中自动执行
npm --prefix sites run preflight:customer-agent-pg15

# 来源 commit 固定后先只读检查；必须显式给完整 SHA 和当前双哈希
CONTRACT_SOURCE_SHA='<40位来源commit>'
npm --prefix sites run export:customer-agent-contract-set -- \
  --check \
  --source-git-sha="$CONTRACT_SOURCE_SHA" \
  --expect-openapi-sha256='<64位OpenAPI哈希>' \
  --expect-database-sha256='<64位DDL哈希>'

# 检查通过后才可写入 ignored output/；不会复制到产品仓、暂存或提交
npm --prefix sites run export:customer-agent-contract-set -- \
  --write \
  --source-git-sha="$CONTRACT_SOURCE_SHA" \
  --expect-openapi-sha256='<64位OpenAPI哈希>' \
  --expect-database-sha256='<64位DDL哈希>'

# 四域资料到达后复制安全模板到仓外受控区；默认只盘点缺口
cp business-docs/08-工具/templates/customer-agent-g009-intake.template.json /受控路径/g009-intake.json
npm --prefix sites run preflight:customer-agent-g009 -- --manifest=/受控路径/g009-intake.json

# Content Lead 最终签发前使用严格模式；未达到四域 READY 时返回 exit 2
npm --prefix sites run preflight:customer-agent-g009 -- --manifest=/受控路径/g009-intake.json --require-ready

# 售前/售后文件到达时先做技术接收；输出目录必须位于已忽略的 output/
python3 business-docs/08-工具/inspect_customer_agent_source.py --self-test
python3 business-docs/08-工具/inspect_customer_agent_source.py \
  --domain presale \
  --input '/受控路径/售前话术.xlsx' \
  --output-dir 'output/customer-agent-g009-intake/presale-YYYYMMDD'

# 两域文件检查完成后生成待签工作包；不会自动填证据或修改台账
python3 business-docs/08-工具/prepare_customer_agent_g009_workpack.py \
  --template business-docs/08-工具/templates/customer-agent-g009-intake.template.json \
  --presale-report output/customer-agent-g009-intake/presale-YYYYMMDD/technical_prefill.json \
  --aftersale-report output/customer-agent-g009-intake/aftersale-YYYYMMDD/technical_prefill.json \
  --output-dir output/customer-agent-g009-intake/workpack-YYYYMMDD

# 推荐的一键入口：可先只给一个域，后续用新目录重新生成两域完整工作包
npm --prefix sites run intake:customer-agent-g009 -- \
  --presale-file '/受控路径/售前话术.xlsx' \
  --aftersale-file '/受控路径/售后话术.xlsx' \
  --output-dir output/customer-agent-g009-intake/workpack-YYYYMMDD

# DEC-PUBLISH-01 人工审批前生成只读候选；输出不是批准，不会暂存
npm --prefix sites run prepare:customer-agent-publish-manifest

# 仅在三方批准同一 bundle 且已按清单人工精确暂存后运行；仍不会 commit/push
node business-docs/08-工具/prepare_customer_agent_publish_manifest.mjs --verify-staged=<64位bundle-sha>
```

`verify_customer_agent_pg15.mjs` 只认证它所锁定 SHA 的 clean-install reference DDL 本机隔离预检。它不连接现有数据库，不保存密码、连接串、PGDATA、WAL 或 dump，也不能代替 migration、N/N-1、runtime、托管 PG、备份恢复、生产证据或 G0/Scope/Ddev 签发。Windows 本机需在 WSL/Linux 中执行，不得为了跨平台改成 TCP 连接既有服务。

`prepare_customer_agent_publish_manifest.mjs` 默认拒绝已有 staged 变更、未解决冲突、单边历史迁移、缺失 07/08 或 PUML/SVG/HTML 配对、符号链接、私密/ignored 路径和高置信凭据。它把完整非忽略工作树的 M/A/D、原始字节 SHA-256、Git file mode、Base HEAD、branch 与脱敏 origin 绑定成 bundle SHA；候选只写入 ignored `output/customer-agent-publish-gate/`。README 与 `approvals.template.json` 会同时投影 `customer-agent` / `design-research` / `security-maintenance-archive` / `shared-repository` / `supply-chain` 五个评审分组及路径数。Product / Security / Tech 三方必须在受控系统用 `EVD-*` 分别确认同一个 bundle SHA 并批准全部分组；不允许对同一 bundle 做局部批准，若分组范围不对必须先调整工作树并重新生成。确认前和任一漂移后都不得 stage、commit 或 push，且始终禁止 `git add .`。三方批准后也只能按 `stage-manifest.tsv` 人工精确暂存，再用 `--verify-staged=<bundle>` 核对 index 路径、状态、blob、mode、零剩余 unstaged/untracked 与生成稳定点；该复核仍不会执行 Git 写操作，也不能替代当下有效的 commit/push 授权。

`export_customer_agent_contract_set.mjs` 要求来源是完整 40 位 commit SHA，并要求调用方同时给出 OpenAPI / DDL 预期 SHA-256。它用 Git blob 读取固定提交，不读取当前工作树；除校验机器文件本身外，还会检查 37 / 39 的当前双哈希声明，以及 46 中“机器合同已锁定为”“实际产物必须精确匹配”锚点。任一规范锚点仍引用旧哈希即 fail-closed。`--write` 只在已忽略的 `output/customer-agent-contract-sets/<contract_set_id>/` 创建 `contract-set.json`、OpenAPI 与 DDL 三个只读文件；既有同 ID 内容或目录模式变化时拒绝覆盖。该产物只证明正式仓某个 commit 的合同快照可复现，不代表产品仓已消费，不签发 G0 / Scope / Ddev，也不允许生成 migration、运行时或部署。

## 真实表格接入（G0-03 / G0-13）

用户后续提供 `.xlsx` 或 `.csv` 时，先做字段映射和受控边界确认，不要求原表列名预先改成仓库口径，也不把原表复制进公开 Git。处理顺序固定如下：

1. 原表只在仓外私有工作区或公司受控系统读取；先识别工作表、时间范围、两类业务域、分母、去重键和缺失值，不把客户原话、工单正文、手机号、订单号、飞书链接或真实人员信息写入仓库。
2. G0-03 映射到 `02-G0责任与证据台账.md` §6：至少能区分话术查找与工单只读分析两域，并给出数据日期、样本量、平台、意图、商品 / SKU、活动阶段、班次、复杂度、上下文、升级和风险；无法取得的字段必须显式标为缺失，不能用总体均值补齐。
3. G0-13 映射到 `03-Scope与验收.md` §B：按正常正例、安全负例、鲁棒性样本分账，检查 `20 + ≥12 + ≥18`、来源 / 内容快照、可接受话术 ID、盲审人、分层覆盖和 train / G1a / G1b 隔离；看过系统输出后补写答案的样本不得进入冻结集。
4. 先向用户展示列映射、缺口和将要计算的指标，经一次确认后再计算；输出只回填脱敏聚合值、版本与 `EVD-*` 收据，不回填逐行原始数据或可逆哈希。
5. G0-03 与 G0-13 分别签发：业务基线证据不能替代评测集冻结证据，QA 职责接受也不能替代独立盲审。任一包未归档前，对应 G0 / Scope 保持未完成。

这一路径不把 Excel 解析依赖接入客服 Agent 在线运行时。收到真实表格后，使用 `customer_service_staging_importer.py` 在离线/受控环境只读解析，并遮罩 URL、token、邮箱、大陆手机号和身份证号等高置信标识符。该处理**不是完整匿名化或 DLP**，不能证明姓名、地址或上下文隐私已全部消除，所以逐行 staging 只允许留在仓外受控目录或仓内 ignored `output/`，不得进入公开 Git。若表内结构不足，先引导用户补列或确认口径，不为追求自动化猜造分母、日期、Owner 或审核结论。`customer_service_staging_loader.py` 默认只生成 SQL，不连接数据库；只有明确指定隔离 staging 库、配置受控 libpq service / pgpass 并显式传 `--apply --pg-service` 才允许落库。`psql` 固定启用 `ON_ERROR_STOP=1`，SQL 报错不得回报 `applied=true`。

### staging API 原型边界

`customer_service_staging_api.py` 是进入代码阶段的最小本地切片，不是正式客服 Agent API。它提供：

* `GET /healthz`：确认服务是本地原型且 `postgresql_written=false`；
* `GET /batches`、`GET /batches/{batch_id}`：查看预填批次摘要；
* `GET /batches/{batch_id}/records?type=qa|campaign|voc&limit=50&offset=0`：分页预览高置信标识符已遮罩、但非完整匿名化的记录；
* `GET /batches/{batch_id}/reviews`：查看追加的人工审阅事件；
* `POST /batches/{batch_id}/reviews`：只有同时提供启动时绑定的 `--reviewer-role ROLE-*` 与环境变量中的本次启动 Bearer token 才启用；请求体只提交 `hold / confirm / reject`、记录、`EVD-*` 和幂等键，禁止自报角色。服务校验 Host / Origin / JSON Content-Type，同 key 同体才重放、异体返回 409。事件写入 `review_events.jsonl`，原始记录仍保持 `prefill`。

审阅事件只证明“有人看过并留下决定”，不等于 G0-13 证据、正式内容发布或 `official` 数据。后续若要晋级，必须另做质量复核、四域来源绑定、正式签发和独立发布流程；本原型不会替代这些门禁。API 默认只绑定回环地址，禁止把它暴露到公网或直接指向正式客服 Agent 库。

## 四域飞书来源一次性取证（G0-09）

G0-09 不逐字段向用户反复确认。四域资料准备完后，在公司受控系统归档一个包；建议收据 ID 为 `EVD-G0-09-AUTHORITY-SOURCES-20260810`。包内必须逐域包含 `presale / campaign / aftersale / product` 四行，每行至少具备：

- 随机且无业务语义的公开 `SRC-*` 与 `srcv_*` 代号，以及它们到真实飞书文档、版本和导出快照的私有映射；
- `canonical / current` 结论、平台 / 商品 / 活动适用范围、生效 / 失效 / 复核时间；活动类必须有完整双边时间；
- 文档、父级继承、成员组、外链、管理员和机器人权限的有效 ACL 证据；已有售后 / 产品 ACL 收据可引用，售前 / 活动仍须补受控证据；
- 总行数、缺字段、重复、冲突、过期、敏感命中、可导入和隔离数量，所有质量数必须带分母；
- 冲突或未修项的隔离 / 裁决结论，以及 Content Lead 对四域整体清单的最终批准。

归档前先做一次脱敏预览；公开仓只接收随机代号、脱敏聚合数与最终 `EVD-*`，不接收飞书 URL / token / 标题、真实 revision、导出文件、原始 SHA、成员清单或内容正文。只有四行全部齐全且 Content Lead 已签发时，才允许用同一证据变更关闭 G0-09 与 Scope #9；上述建议 ID 本身不是证据，也不会预先推进状态。

`templates/customer-agent-g009-intake.template.json` 只预填仓内已有的公开安全代号和收据，售前、售后仍保持 `INCOMPLETE`。预检器不会读取话术正文、修改 `02/03`、生成 EVD 或推进 G0；它只验证四域恰好各一行、代号格式、单一证据、质量分母守恒、Content Lead 角色和敏感值边界。只有受控清单通过 `--require-ready`，且真实附件和批准可核验后，才进入 G0-09 / Scope #9 的人工原子更新。

## 运行交接一次性取证（G0-15）

G0-15 使用 `05-全栈交付计划.md` §7.1 的现行方案，不另建第二份 runbook。四方确认已归档为 `EVD-G0-15-RUN-HANDOVER-20260812`；同一个包分别记录以下四项确认，而不是只写一句“大家同意”：

- 项目负责人：确认关键路径、版本锁、停启升级链、Ddev 只授权 DEV-M0，以及应用 / 数据 / 内容 / 配置回退边界；
- 客服业务 Owner：确认试点开始、暂停、恢复、人工兜底和业务验收口径；
- QA 负责人：确认 G1a / Pilot Ready / G1b 独立门、严重失败阻断权、整集重测和证据归档；
- IT 服务 / 运维责任人：确认环境 / 账号、监控告警、备份恢复、RPO / RTO 待演练目标、值班与交接清单。

本包签的是“运行与交接方案”。真实账号、告警接入、备份恢复、回退、压测和试点运行证据继续留在 Ddev 后 / Pilot Ready 前，不能倒置成 G0 前置。G0-14 的 WBS / 容量 / 成本条件与费用路径现已共同 Pass，Scope #15 已关闭；这仍不签发 G0 或 Ddev。

## 数据边界

- 本仓只接受 `ROLE-*` / `USR-*` 人员代号与 `EVD-*` 证据 ID。
- 真实姓名、客户原文、审批原话、原始协作链接、精确 cap、PII 与安全细节只存受控系统。
- Git 远端为公开仓；含真实状态的本地分支不得直接推送，除非先迁移到私有仓或完成正式安全复核。
- 公共 Pages 发布已收尾历史 Web，并仅复制通过脱敏门禁的 `09` 启动会生成视图到 `/customer-agent/`；`00`–`08`、源 Markdown、证据和 QA 产物仍不发布。

返回 [`业务文档地图`](../README.md)。
