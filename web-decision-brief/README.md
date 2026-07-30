# 天元 · AI 立项决策台

本场 Goal：选项目 · 定预算 · 定 Owner · 授权止损。  
**在线：** https://weiweity.github.io/tianyuan-ai-brief/

本目录是 **软件工程根**（包名 `tianyuan-ai-decision-brief`）。  
业务资料在上一级工作区，导航见 **[../README-文档怎么用.md](../README-文档怎么用.md)**。  
技术架构见 **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**。

## 产品能力（v5.24）

- **七页会议壳：** 拍板 → 取舍 → 边界 → 门禁 → 预算 → 当场确认 → 会后责任
- **项目级 A/B/C：** 客服 Agent 与供应链备案识别可分别选路径，不再共用一条
- **门禁与凭证：** Owner / 费用 / 超线停扩；可复制结论；可下载 SHA-256 JSON 凭证（本机草稿，飞书/邮件确认后才算正式留痕）
- **手机适配：** 页签与按钮短文案；t6 路径/预算/Owner 单屏；触控 ≥44px；四视口 UI 审计
- **品牌：** 标签页 = 狐狸头 favicon；顶栏 = 狐狸 + 英文横版 wordmark（两套图）
- **离线：** `file://` 用构建时快照；HTTP 用 release + content SHA 热更

## 本目录结构

```text
web-decision-brief/
├── package.json          # npm 脚本与依赖
├── docs/                 # 站点与运行时（Pages 发布此目录）
├── scripts/build-web.mjs # Bundle / release 生成
└── tests/                # 单测 + UI 审计
```

## 架构（防越改越乱）

| 层级 | 文件 | 职责 |
|-|-|-|
| 壳 | `docs/index.html` | 挂载点，无业务文案；favicon / apple-touch-icon |
| 协议启动 | `docs/js/bootstrap.js` | HTTP 版本化 Bundle；file 离线 Bundle |
| 样式 | `docs/css/app.css` | 满屏自适应 + 手机/桌面分层 |
| UI 编排 | `docs/js/app.js` | 渲染 / 导航 / 编辑 / 写回 |
| 决策域 | `docs/js/modules/decision-model.js` | 项目级 A/B/C、门禁、结论与凭证 |
| 状态兼容 | `docs/js/modules/meeting-state.js` | 版本隔离、字段白名单与草稿合并 |
| 内容安全 | `docs/js/modules/html-policy.js` | 富文本、资源 URL 与 SVG 清洗 |
| 内容加载 | `docs/js/modules/content-loader.js` | release、SHA、超时与可信缓存 |
| 图表 | `docs/js/modules/mermaid-runtime.js` | Mermaid、字号随 body、灯箱 |
| **内容 SSOT** | **`docs/data/content.json`** | **所有字、表、mermaid** |
| 发布 | `docs/data/release.json` + 生成 Bundle | 禁止手改生成物 |
| 质量门禁 | `tests/` + `.github/workflows/quality.yml` | 单测、Schema、四视口 UI、a11y |

**AI 改内容：只改 `content.json` 里带稳定 id 的块（如 `t1.kpi`）。**

## 本地预览

```bash
npm install
npm run serve
# 打开 http://localhost:8765
```

推荐用 HTTP 做作者编辑与最新内容。双击 `docs/index.html` 可演示离线快照（不轮询远端）。

`npm run serve` 会先重建离线 Bundle；`content.json` 与 Bundle 不一致时 `npm test` 会阻断。

## 浏览器内编辑 → 写回源码

1. 打开 `http://localhost:8765/?edit=1`，点 **编辑** 改字  
2. 点 **保存并更新** → 写文件 + 本页热刷新（保留当前 Tab）  
3. 或 **绑定源码** 后写盘；不支持时用 **导出 JSON** 覆盖 `docs/data/content.json`  
4. `npm run build:web` 后走 PR 发布；在线约 30 秒内可静默同步正文  

> 仅 localStorage 草稿 ≠ 源码。未「保存到源码/导出」时 Git 仍是旧文件。

## 键盘

`1`–`7` 切 Tab · `←` `→` 翻页 · 作者模式（`?edit=1`）：`E` 编辑 · `S` 保存

## 自动验收

```bash
npm run build:check
npm test          # 决策模型 + Schema + 内容 / 依赖 / Bundle 契约
npm run test:ui   # 四视口 × 七页、故障降级、file://、打印、a11y、截图、凭证
npm run audit:deps
npm run test:all
```

PR 与 `main` 推送在 Node 24 + 固定 Playwright Chromium 上复跑门禁。发布走 PR，`quality / test` 为必需检查。

## 历史 HTML

上一级 `../01-立项主线/print/AI赋能立项_金主一页汇报.html` 仅兼容跳转至本目录 `docs/`，无第二份业务正文。

## 飞书

- 总册 / 画板 / 汇报方案：见 [../README-文档怎么用.md](../README-文档怎么用.md)  
- 开会演示以本决策台为准，投屏以会场飞书稿为准。

## 版本

**v5.24.0** · 2026-07-30  
软件已集中到本目录 `web-decision-brief/`。