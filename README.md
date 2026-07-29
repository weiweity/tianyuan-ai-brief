# 天元 · AI 赋能立项（金主一页）

## 在线浏览

**https://weiweity.github.io/tianyuan-ai-brief/**

## 架构（防越改越乱）

详见 **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**

| 层级 | 文件 | 职责 |
|-|-|-|
| 壳 | `docs/index.html` | 挂载点，无业务文案 |
| 样式 | `docs/css/app.css` | 满屏自适应 |
| 引擎 | `docs/js/app.js` | 渲染 / 编辑 / 写回 |
| **内容 SSOT** | **`docs/data/content.json`** | **所有字、表、mermaid** |
| 资源 | `docs/assets/` | logo 等 |

**AI 改内容：只改 `content.json` 里带稳定 id 的块（如 `t1.kpi`）。**

## 本地预览（必须 http，不要 file://）

```bash
cd docs && python3 -m http.server 8080
# 打开 http://localhost:8080
```

## 浏览器内编辑 → 写回源码

1. 打开页面 → 点 **编辑**（或 `E`）改字  
2. 点 **绑定源码** → 选中本仓库 `docs/data/content.json`（Chrome/Edge）  
3. 点 **保存到源码**（或 `S`）→ **直接写入磁盘文件**  
4. 若不支持写盘：用 **导出 JSON** 覆盖 `docs/data/content.json`  
5. `git add docs/data/content.json && git commit && git push`

> 仅 localStorage 草稿 ≠ 源码。刷新后草稿还在，但 Git 里仍是旧文件，除非「保存到源码/导出」。

## 键盘

`1`–`7` 切 Tab · `←` `→` 翻页 · `E` 编辑 · `S` 保存

## 飞书定稿

https://my.feishu.cn/docx/CgGWdRkmaowkAZxA0nLcqvbfnde （v5.6）

## 版本

v5.6 P0 闭环 · 内容驱动架构 v1 · 2026-07-29
