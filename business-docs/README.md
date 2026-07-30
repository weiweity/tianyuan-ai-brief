# 业务文档 · 导航

> 更新：2026-07-30 · 全部业务资料集中在 **`business-docs/`**  
> 软件在同级 **`../web-decision-brief/`**，勿混放。

---

## 0. 统一入口

| 场景 | 入口 |
|------|------|
| **软件 / 开会演示** | [`../web-decision-brief/`](../web-decision-brief/) · https://weiweity.github.io/tianyuan-ai-brief/ |
| **软件本地** | `cd ../web-decision-brief && npm run serve` |
| **工作区总览** | [`../README.md`](../README.md) |
| **分类明细** | [`分类汇总.md`](分类汇总.md) |
| **主线上会** | `01-立项主线/`（10 / 11 / 12 / 19） |
| **历史过程稿** | `99-归档/` |
| **对外周会** | 飞书总册 https://my.feishu.cn/docx/Q6vVdWQxNoXH9gxoNu1ckpIdnbc |

---

## 1. 本目录结构

```
business-docs/
├── README.md                 ← 业务导航（本文件）
├── 分类汇总.md
├── SESSION-MEMORY.md         ← 本机会话快照（不进 git）
├── 01-立项主线/              ★ 主交付
├── 02-角色与边界/
├── 03-调研与叙事/            + notes/
├── 04-实施参考-立项后/
├── 05-供应链布局/
├── 06-周会与周报/
├── 07-图与素材/
├── 08-工具/
└── 99-归档/                  过程打分 · 计划 · 飞书 XML
```

| 夹 | 放什么 | 不要放 |
|----|--------|--------|
| `01` | 门禁、立项卡、费用、金主包 | 软件源码、过程打分 |
| `02`–`08` | 角色 / 调研 / 实施 / 供应链 / 周报 / 图 / 工具 | 决策台 package |
| `99` | 废稿与过程稿 | 当周要交的终稿 |
| 软件 | → `../web-decision-brief/` | 业务 md 不要塞进去 |

---

## 2. 30 秒导航

| 你要… | 打开 |
|--------|------|
| **开会 / 投手机** | `../web-decision-brief` 或线上 Pages |
| 改会场文案 | `../web-decision-brief/docs/data/content.json` |
| 立项上会 | `01/11` |
| 费用 | `01/12` |
| 金主包 | `01/19` |
| 供应链会后 | `05/18` |
| 旧打分 / 计划 | `99-归档/` |

---

## 3. 校验

```bash
cd ../web-decision-brief && npm test && npm run test:ui
python3 08-工具/verify_term_ssot.py
python3 08-工具/verify_name_rename.py
```

（后两条在 `business-docs/` 下执行。）

---

## 4. 变更记录

| 日期 | 变更 |
|------|------|
| 2026-07-30 | **业务文档集中到 `business-docs/`** |
| 2026-07-30 | 软件集中到 `web-decision-brief/` |
| 2026-07-29 | 上海会后；金主 01/19 |

*导航 SSOT · 明细见 `分类汇总.md`*
