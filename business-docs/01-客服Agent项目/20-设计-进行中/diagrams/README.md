# 客服 Agent 架构图生成说明

本目录的 `01`～`07` `.puml` 是可编辑真源；`svg/` 与上级
`架构图-PlantUML浏览器.html` 中的内嵌 SVG 都是生成物，禁止单独手改。

在仓库的 `sites/` 目录执行：

```bash
npm ci
npx playwright install chromium
npm run sync:arch-diagrams
npm run check:arch-diagrams
```

生成器使用锁定版本的 `@plantuml/core` 在本地无头浏览器内渲染，不把图源上传到外部服务。
`sync` 同时重建 7 个 SVG 并替换 HTML 中 7 个对应 `<svg>`；`check` 重新渲染并比较，任一
`.puml`、独立 SVG、内嵌 SVG 漂移都会非零退出。

CI 必须在 `npm ci` 后显式安装 Playwright Chromium；不得假设 `npm ci` 会自带浏览器。
本机开发可回退到已安装的 Chrome，CI 则故意 fail-closed。脚本先将 7 张图全部渲染/校验到内存，
再经临时目录原子 rename SVG，最后替换 HTML；中途失败不会让 HTML 引用一组半渲染产物。

阶段边界：这只是设计文档生成链，不代表 Ddev、运行时代码、真机或生产验证已经通过。
