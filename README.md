# 天元 · AI 立项决策台

## 在线浏览

**https://weiweity.github.io/tianyuan-ai-brief/**

## 架构（防越改越乱）

详见 **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**

| 层级 | 文件 | 职责 |
|-|-|-|
| 壳 | `docs/index.html` | 挂载点，无业务文案 |
| 协议启动 | `docs/js/bootstrap.js` | HTTP 加载在线模块；file 加载离线 Bundle |
| 样式 | `docs/css/app.css` | 满屏自适应 |
| UI 编排 | `docs/js/app.js` | 渲染 / 导航 / 编辑 / 写回 |
| 决策域 | `docs/js/modules/decision-model.js` | 项目级 A/B/C、门禁、结论与凭证 |
| 状态兼容 | `docs/js/modules/meeting-state.js` | 版本隔离、字段白名单与草稿合并 |
| 内容安全 | `docs/js/modules/html-policy.js` | 富文本、资源 URL 与 SVG 统一清洗 |
| 图表运行时 | `docs/js/modules/mermaid-runtime.js` | Mermaid 渲染、无障碍与缩放灯箱 |
| **内容 SSOT** | **`docs/data/content.json`** | **所有字、表、mermaid** |
| 离线生成物 | `docs/js/app.offline.bundle.js` | 由 SSOT 自动生成，禁止手改 |
| 固定依赖 | `docs/vendor/` | Mermaid 10.9.6、DOMPurify 3.4.12 与许可证 |
| 质量门禁 | `tests/` + `.github/workflows/quality.yml` | 单测、Schema、三视口 UI、a11y、截图、依赖审计 |

**AI 改内容：只改 `content.json` 里带稳定 id 的块（如 `t1.kpi`）。**

## 本地预览

```bash
npm install
npm run serve
# 打开 http://localhost:8765
```

HTTP 是作者编辑和获取最新内容的推荐方式。直接双击 `docs/index.html` 或历史 HTML 也能演示，但页面会明确标记为“本地离线快照”，不会轮询远端，也不会宣称内容最新。

`npm run serve` 会先自动重建离线 Bundle；若 `content.json` 与 Bundle 不一致，`npm test` 会阻断。

## 浏览器内编辑 → 写回源码（无感）

1. 打开 `http://localhost:8765/?edit=1`，点 **编辑** 改字
2. 点 **保存并更新** → 自动写文件 + **本页热刷新**（不整页跳转，保留当前 Tab）  
3. 运行 `npm run build:web`，再按下方 PR 发布流程提交 → 在线客户约 **30 秒内自动同步**（静默轮询）

> C 端客户：打开即最新；后台有更新会自动刷新内容，无需手动 F5。

## 浏览器内编辑 → 写回源码（完整）

1. 打开页面并加 `?edit=1` → 点 **编辑**（或 `E`）改字
2. 点 **绑定源码** → 选中本仓库 `docs/data/content.json`（Chrome/Edge）  
3. 点 **保存到源码**（或 `S`）→ **直接写入磁盘文件**  
4. 若不支持写盘：用 **导出 JSON** 覆盖 `docs/data/content.json`  
5. 运行 `npm run build:web`，再按架构文档的白名单方式提交 PR

> 仅 localStorage 草稿 ≠ 源码。刷新后草稿还在，但 Git 里仍是旧文件，除非「保存到源码/导出」。

## 键盘

`1`–`7` 切 Tab · `←` `→` 翻页 · 作者模式（`?edit=1`）：`E` 编辑 · `S` 保存

## 项目级结论与凭证

- 客服 Agent、供应链备案识别可分别选择 A / B / C，不再共用一条路径。
- A / B 项目分别要求自己的 Owner，并共同确认费用止损与超线停扩。
- 可复制会议结论，也可下载带 SHA-256 的 JSON 凭证。
- 两者仍是本机会议草稿；贴入飞书 / 邮件并由相关人确认后才构成正式留痕。

## 自动验收

```bash
npm run build:check
npm test          # 决策模型 + Schema + 内容 / 依赖 / Bundle 契约
npm run test:ui   # 三视口 × 七页、file://、打印、a11y、截图、凭证
npm run audit:deps
npm run test:all
```

Pull Request 和 `main` 推送会在 Node 24 + 固定 Playwright Chromium 上复跑同一套逻辑门禁，并上传逐页截图和七页打印 PDF。发布应走 PR，并把 `quality / test` 设为必需检查。

## 历史 HTML

`01-立项主线/print/AI赋能立项_金主一页汇报.html` 仅保留兼容跳转，不再保存第二份业务正文。HTTP 下进入在线正式页；双击打开时进入同一正式壳的离线快照。打印统一生成七页 A4 PDF。

## 飞书定稿（仍为 v5.6，待与 Web v5.20 对齐）

https://my.feishu.cn/docx/CgGWdRkmaowkAZxA0nLcqvbfnde （v5.6）

## 版本

v5.20 项目级决策 + 可校验凭证 · UI contract v2 · 2026-07-29
