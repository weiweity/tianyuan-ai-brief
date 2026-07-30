# AI 立项决策台 · 架构契约

> 当前版本：Web v5.24 · 决策状态 Schema v2  
> 软件工程根：仓库内 **`web-decision-brief/`**（与业务资料 `01`–`99` 分离）  
> 原则：内容、决策规则、渲染和样式各有唯一归属；默认入口只负责开会，作者能力必须显式进入。

## 1. 目录与职责

```text
web-decision-brief/                    # 软件包根（在此 npm install / test / serve）
├── package.json
├── .node-version                      # CI 基线 Node 24
├── docs/                              # 站点与运行时（Pages 发布此目录）
│   ├── index.html                     # 安全壳、挂载点、固定依赖
│   ├── css/app.css                    # UI contract v2
│   ├── js/bootstrap.js                # 协议感知启动
│   ├── js/app.js                      # UI 编排
│   ├── js/app.bundle.js               # 生成物：HTTP 原子运行时
│   ├── js/app.offline.bundle.js       # 生成物：离线快照
│   ├── js/modules/…                  # decision / meeting / html-policy / content-loader / mermaid
│   ├── data/content.json              # 内容 SSOT
│   ├── data/release.json              # 生成物：releaseId + SHA
│   ├── vendor/                        # Mermaid / DOMPurify 固定版
│   └── assets/
│       ├── logo.png                   # Header 横版 wordmark（狐狸+英文）
│       ├── favicon*.png               # 浏览器标签：单独狐狸头
│       └── apple-touch-icon.png
├── scripts/build-web.mjs
└── tests/                             # 单测 + ui-audit

仓库根 .github/workflows/              # quality（cwd=本目录）+ pages 发布 docs/
```

| 改动 | 唯一落点 | 禁止 |
|---|---|---|
| 业务文案、表格、图源 | `data/content.json` | 在 HTML / CSS / JS 写业务正文 |
| A/B/C、Owner、费用门禁、凭证 | `decision-model.js` | 在点击事件里复制一份判断逻辑 |
| 旧会议草稿合并 | `meeting-state.js` | 按对象展开或跨 Schema 猜测合并 |
| 富文本、资源地址、SVG 安全 | `html-policy.js` | 未清洗地写入 `innerHTML` |
| Mermaid 渲染与灯箱 | `mermaid-runtime.js` | 在 `app.js` 维护第二套实现 |
| 内容加载、完整性与可信降级 | `content-loader.js` | 用时间戳穿透缓存或未校验混用内容 |
| HTTP / file 启动选择 | `bootstrap.js` | 放宽浏览器安全策略或让页面永久骨架 |
| HTTP 模块图发布 | `build-web.mjs` 生成 `app.bundle.js` | 直接部署无版本的 ESM 子模块 |
| 离线快照 | `build-web.mjs` 生成 | 手改 `app.offline.bundle.js` |
| 发布指纹 | `build-web.mjs` 生成 `release.json` 并注入入口 | 人工维护多套 `?v=` |
| DOM 渲染、导航、保存 | `app.js` | 把业务规则塞回 UI 编排 |
| 颜色、间距、响应式 | `app.css` 对应分层 | 文件尾追加“vN 修复补丁” |
| 内容字段结构 | `content.schema.json` | 无版本地改变本机会议状态 |

## 2. 运行模式

- `/`：会议演示入口。作者工具和 E / S 快捷键不可见、不可触发。
- `/?edit=1`：作者入口。可编辑、绑定 `content.json`、写回或导出。
- `file:///.../docs/index.html`：离线演示入口。读取构建时快照，显示离线标记，不执行远端轮询。
- 历史 HTML 在 HTTP 和 file 两种协议下都跳入同一正式壳，不拥有业务正文。
- 会议勾选会保存到当前设备，用于刷新恢复，但始终是本机草稿。
- 飞书 / 邮件确认才是组织留痕；页面不宣称“已审批”。

启动顺序固定为 `release/content → renderAll → booted`。IndexedDB、热轮询和 Mermaid
预热均在正文 ready 之后；Mermaid 仅在空闲时或首次进入图表页时加载。图表库失败时显示
从同一 Mermaid 源提取的安全文字摘要，不阻断七页正文和决策交互。

## 3. 项目级决策模型

`content.decisionSchemaVersion` 是本机会议状态的兼容边界。结构性变化必须递增；版本不同的旧状态不会合并。

每个候选项目都有独立 `projectId`、`projectLabel` 和 A / B / C：

- A：同意启动；前置齐后按止损线开工。
- B：先认方向；只补前置，未批不开发、不烧工具费。
- C：不立；记录原因，不排期。

散会门禁由 `evaluateCheckGate()` 唯一计算：

1. 每个项目必须独立选 A / B / C。
2. 每个 A / B 项目必须有自己具名且确认的 Owner。
3. 只要存在 A / B，就必须确认共享费用口径和超线停扩权。
4. 全部 C 时，不强制费用与 Owner。
5. 目标预算、首月止损、全期止损必须为正数，且目标预算与首月止损不能高于全期止损。

## 4. 可校验会议凭证

页面可复制人类可读结论，也可下载 JSON 凭证。凭证包含：

- 内容版本、决策 Schema 版本、生成时间和源版本戳；
- 每个项目的路径和 Owner；
- 费用、止损、停扩授权和缺项；
- `localDraft: true`；
- 对规范化 payload 计算的 SHA-256。

`verifyDecisionReceipt()` 可在浏览器和 Node 中复算哈希。哈希只能证明文件自生成后未被修改，不能替代审批人身份、电子签名或飞书审批。

## 5. 内容与 DOM 稳定定位

业务块使用稳定 `id`，渲染为 `data-block-id`。当前核心 ID：

| ID | 含义 |
|---|---|
| `t1.kpi` / `t1.swap` / `t1.scope` | 今日拍板 |
| `t2.chart` / `t2.dept` | 项目取舍与部门依据 |
| `t3.chart` | 做 / 不做 |
| `t4.chart` / `t4.dod` | 阶段路径与门禁 |
| `t5.chart` / `t5.money` | 费用和止损 |
| `t6.check` / `t6.gate` / `t6.bound` | 项目级确认、最低门禁、留痕边界 |
| `t7.timeline` / `t7.path` / `t7.pm` | 会后责任 |

改文案时不要改 ID；PR 说明使用 `touch: t6.check` 之类的定位。

## 6. CSS 分层契约

`app.css` 是单一有效样式源，按固定顺序组织：

1. tokens / reset
2. shell / header / tabs / stage
3. 通用内容组件
4. 页面专用布局
5. 交互状态
6. 1024 / 640 / 640×700 短手机 / 1025×800 短桌面 / 370 / 横屏响应式
7. print / reduced motion

手机（≤640）约定：页签/路径芯片/状态按钮可用 **全称 + 短文案** 双写，CSS 切换显示；`aria-label` 保留全称。t6 四步不得依赖表格内滚；可见控件触控高度 ≥44px。

旧版 5500 行级联补丁不参与加载。修复必须回到所属层，不得在文件尾追加版本覆盖。CSS 行数门禁见 `content-contract` 测试。

## 7. 依赖与安全

- Mermaid 固定为 10.9.6 并随站点发布，不依赖 CDN。
- DOMPurify 固定为 3.4.12；远端 JSON、本机草稿、编辑器富文本和 Mermaid SVG 都在进入 DOM 前经过显式白名单。
- HTTP 启动由 `bootstrap.js` 为 Mermaid 设置 SRI；file 启动不设置会触发 `origin null` CORS 的 `crossorigin`，但仍只允许仓库内固定脚本。
- Mermaid 使用 `securityLevel: "strict"` 与原生 `text/tspan`；SVG-only 清洗禁止
  `foreignObject`、全部 `on*` 属性和外部 URL。
- `release.json` 用 `releaseId` 绑定 CSS、bootstrap、HTTP 原子 Bundle 与决策 Schema；
  `contentSha256` 独立标识正文。正文变化可无感热更，壳或 Schema 变化必须整页刷新。
- 内容请求有超时和 SHA-256 校验；失败时仅回退到曾校验成功的 last-known-good，并明确标为“缓存快照”。
- HTML 保持 CSP，无运行时第三方 CDN，不要求关闭 CORS 或浏览器安全策略。
- 动态样式与 Mermaid SVG 仍需要 CSP `style-src 'unsafe-inline'`；脚本侧不允许 `unsafe-eval`，内容侧由 DOMPurify 和字段白名单收口。
- 更新 Mermaid 或 DOMPurify 时同步替换 vendor 文件、许可证、SRI（适用时）、`package.json` 和测试断言。

## 8. 本地开发与质量门禁

```bash
npm install
npm run build:web
npm run serve
# http://localhost:8765

npm test
npm run test:ui
npm run audit:deps
npm run test:all
```

本地 `test:ui` 使用系统 Chrome；CI 使用 Node 24 和 Playwright 固定 Chromium。两者执行相同逻辑门禁，但浏览器二进制证据分别保留。覆盖：

- 375×667、390×844、1366×768、1440×900；
- 四个视口的七页逐页截图、裁切/嵌套滚动与 axe；
- 手机七页可见操作区至少 44px；
- 键盘导航、演示 / 作者隔离；
- Mermaid 关键业务标签、慢 3 秒与运行时缺失的文字降级；
- t2 详情不抢滚动，t6 四步单屏，t7 桌面/手机责任矩阵单屏；
- C/C、A/C 混合路径、Owner / 费用 / 停扩门禁；
- 复制结论、下载 JSON、SHA-256 复验；
- HTTP 正式 / 历史入口和 file 直接 / 历史入口；
- 七个面板、全部 Mermaid、恰好七页的 A4 打印 PDF；
- axe WCAG 2A / 2AA / 2.1AA 每页 serious / critical 为 0；
- npm 生产 / 开发依赖已知漏洞为 0；
- Bundle / release manifest / 入口版本新鲜度、vendor SHA-384 与协议分支契约。

## 9. 历史打印入口

仓库内 `01-立项主线/print/AI赋能立项_金主一页汇报.html`（相对本包为 `../01-立项主线/print/…`）是无业务正文的兼容入口：

- 跳转到 `web-decision-brief/docs/index.html`；
- 不加载脚本、Mermaid，也不复制任何旧会议口径；
- 正式浏览和七页 A4 打印统一由本包 `docs/index.html` 提供。

## 10. 发布

```bash
cd web-decision-brief
npm run test:all
# 在仓库根提交 PR；quality 的 working-directory 为本目录
# Pages 由 .github/workflows/pages.yml 发布 docs/
```

`main` 受保护。过程计划与评审打分稿放在仓库 `99-归档/`，不要堆进本包 `docs/`。
