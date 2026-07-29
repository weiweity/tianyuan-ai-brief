# HTML 架构说明（给 AI / 人）

> 大厂投屏页标准拆法：**内容 SSOT 与渲染壳分离**。  
> 目标：AI 改内容不碰布局；人可在浏览器改字/改图并写回源码；满屏自适应少留白。

---

## 1. 目录（禁止乱放）

```
docs/
├── index.html              # 壳：只挂载 DOM 节点，几乎无文案
├── ARCHITECTURE.md         # 本文件 —— AI 改前必读
├── css/app.css             # 布局/主题/满屏自适应（无业务文案）
├── js/app.js               # 渲染 + 编辑 + 写回（无业务文案）
├── data/content.json       # ★ 唯一内容 SSOT（字、表、mermaid、图路径）
├── data/content.schema.json
└── assets/logo.png         # 静态资源；换 logo 只换文件
```

| 你想改什么 | 改哪个文件 | 禁止 |
|-|-|-|
| 改一句话 / 表 / 勾选 / mermaid | **`data/content.json`** | 不要改 `index.html` 塞文案 |
| 改颜色、间距、满屏策略 | `css/app.css` | 不要在 json 写 style |
| 改交互（Tab/保存/编辑） | `js/app.js` | 不要复制粘贴整页 HTML |
| 换 logo | `assets/logo.png` + json `meta.logo` | 不要 base64 塞进 html |

---

## 2. 稳定定位 ID（AI 定位契约）

每个可改块有 **永不重排的 id**（`tabId.blockName`）：

| id | 含义 |
|-|-|
| `t1.role` | 您批/您不背 |
| `t1.kpi` | 建议/请勾/钱/工期表 |
| `t1.swap` / `t1.scope` | 换/不立、本场不做 |
| `t2.chart` | 取舍 mermaid |
| `t2.trigger` / `t2.brake` | 后置触发、旁线刹车 |
| `t3.chart` | 做/不做 mermaid |
| `t4.chart` / `t4.dod` | 路径图、门禁表 |
| `t5.chart` / `t5.money` | 费用图、钱表 |
| `t6.check` / `t6.gate` / `t6.bound` | 勾选、门禁、边界 |
| `t7.raci` / `t7.weekly` / `t7.speak` | 会后、周报、口播 |

**AI 改内容时：**

1. 只打开 `data/content.json`
2. 用 id 定位，例如：`blocks` 里 `"id": "t1.kpi"` 的 `rows[2].html`（钱）
3. 不要全文重写 json；不要改 id 字符串
4. 改完在 PR/说明里写：`touch: t1.kpi.rows[2]`

DOM 上同 id 渲染为 `data-block-id="t1.kpi"`，浏览器检查/脚本也可定位。

---

## 3. 编辑写回源码（不是 localStorage 假改）

### 3.1 三种保存通道（优先级）

| 通道 | 行为 | 刷新后 |
|-|-|-|
| **A. File System Access** | 点「绑定 content.json」选中 `docs/data/content.json`，之后「保存」直接 **写入磁盘文件** | ✅ 真写源码 |
| **B. 下载** | 「导出 content.json」下载文件，你覆盖仓库里的 json 再 commit | ✅ 真写源码（多一步） |
| **C. 草稿** | 自动 `localStorage` 备份，防误关页 | 仅本机草稿，**不是源码** |

Chrome/Edge 支持 A；Safari 等走 B。

### 3.2 编辑什么

- 工具栏 **编辑**（或按 `E`）：所有 `data-editable` 区域 `contenteditable`
- 点 logo / 图：选本地图片 → 写入 `assets/` 需你本机替换文件；编辑态会把 **dataURL 暂存到 json 的 `meta.logoDataUrl`（可选）**，导出后你可再落地为文件
- **保存**（或 `S`）：把 DOM 读回 content 对象 → 通道 A 或 B

### 3.3 投屏模式

默认 **只读**。不要在金主会场开编辑。

---

## 4. 满屏自适应原则

- 根布局：`100dvh` 网格 = 顶栏 + Tab + 内容 + 底栏
- 内容区 `flex:1; min-height:0`，块之间均分，**不靠大 padding 撑**
- 图（mermaid）：`height:100%` + `max-height` 吃满侧栏/主栏
- 字号：`clamp()` 随视口缩放
- 禁止：固定 800px 内容宽 + 两侧大留白（已用 `max-width:100%` 满宽）

---

## 5. 数据块类型

| type | 用途 | 主要字段 |
|-|-|-|
| `callout` | 提示条 | `html`, `variant` |
| `kv-table` | 键值表 | `rows[].key/html/variant` |
| `gate-table` | 门禁/结果表 | `rows[].gate/html` |
| `check-table` | 勾选表 | `rows[].no/html` |
| `mermaid` | 流程图 | `source`（纯 mermaid 文本） |
| `image` | 图 | `src`, `alt` |

`layout`：`stack` | `split` | `fill`  
`split` 时 block 可带 `slot`: `main` | `side`

---

## 6. 发布

```bash
# 改内容
vim docs/data/content.json

# 本地
python3 -m http.server 8080 -d docs
# 打开 http://localhost:8080

# 推送 Pages
git add docs && git commit -m "content: touch t1.kpi" && git push
# https://weiweity.github.io/tianyuan-ai-brief/
```

> 注意：`file://` 打开时 **fetch content.json 会失败**。必须用 http.server 或 Pages。

---

## 7. 反模式（越改越乱的根源）

1. ❌ 在 `index.html` 里贴大段业务字  
2. ❌ 复制整页生成 `index-v2.html`  
3. ❌ 改 mermaid 时重写整个 app.js  
4. ❌ 只靠 localStorage「改完刷新还在」却不导出 json  
5. ❌ 给块随机改 id（AI/脚本全部失效）

---

## 8. 与飞书 SSOT 关系

- 飞书少字画板 XML = 组织侧 SSOT（上会定稿）  
- `content.json` = **Web 呈现 SSOT**（应与飞书 v5.6 表述一致）  
- 改口径：先改飞书 XML / 或先改 json，再人工对齐另一边；不要两套长期漂移


---

## 9. 多端一屏与触屏（v1.1）

- 布局：`100dvh` + `safe-area-inset`；手机压顶栏、工具进「⋯」
- 翻页：左右滑（水平主导阈值）· 圆点 · 边缘 ‹ › · 键盘 ←→ / 1–7
- 编辑态关闭滑动，避免改字时误翻页
- 测法：Chrome 设备模拟 iPhone + 真机 Safari
