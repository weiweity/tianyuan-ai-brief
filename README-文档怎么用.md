# AI 赋能立项 · 文档导航

> 更新：2026-07-30 · **软件已集中到 `web-decision-brief/`**  
> 原则：**软件与业务资料分离** · 一层一 SSOT · 过程稿进 99。

---

## 0. 统一入口

| 场景 | 入口 |
|------|------|
| **软件 / 开会演示** | [`web-decision-brief/`](web-decision-brief/) · https://weiweity.github.io/tianyuan-ai-brief/ |
| **软件本地** | `cd web-decision-brief && npm run serve` → http://localhost:8765 |
| **工作区总览** | 根 [`README.md`](README.md) |
| **对外周会** | 飞书总册 https://my.feishu.cn/docx/Q6vVdWQxNoXH9gxoNu1ckpIdnbc |
| **分类明细** | [`分类汇总.md`](分类汇总.md) |
| **主线上会材料** | `01-立项主线/`（10 / 11 / 12 / 19） |
| **历史过程稿** | `99-归档/` |

---

## 1. 目录结构

```
ai-赋能立项/
├── README.md                 ← 工作区总览
├── README-文档怎么用.md      ← 业务文档导航（你在这里）
├── 分类汇总.md
├── web-decision-brief/       ★ 软件：决策台（npm / docs / tests）
├── 01-立项主线/              ★ 业务主交付
├── 02-角色与边界/
├── 03-调研与叙事/
├── 04-实施参考-立项后/
├── 05-供应链布局/
├── 06-周会与周报/
├── 07-图与素材/
├── 08-工具/
└── 99-归档/
```

| 夹 | 放什么 | 不要放 |
|----|--------|--------|
| `web-decision-brief/` | 决策台代码、content.json、测试 | 立项打分 md、纪要 |
| `01` | 门禁、立项卡、费用、金主包 | 软件源码 |
| `99` | 过程打分 / 计划 / XML | 当周要交的东西 |

---

## 2. 30 秒导航

| 你要… | 打开 |
|--------|------|
| **开会 / 投手机** | `web-decision-brief` 或线上 Pages |
| 改会场文案 | `web-decision-brief/docs/data/content.json` |
| 立项上会 | `01/11` |
| 费用 | `01/12` |
| 金主包 | `01/19` |
| 供应链会后 | `05/18` |
| 旧打分 / 计划 | `99-归档/` |

---

## 3. 校验

```bash
cd web-decision-brief && npm test && npm run test:ui
python3 08-工具/verify_term_ssot.py
python3 08-工具/verify_name_rename.py
```

---

## 4. 变更记录

| 日期 | 变更 |
|------|------|
| 2026-07-30 | **软件迁入 `web-decision-brief/`**，与业务资料分离 |
| 2026-07-30 | Web v5.24；过程稿进 99 |
| 2026-07-29 | 上海会后；金主 01/19 |

*导航 SSOT · 明细见 `分类汇总.md`*
