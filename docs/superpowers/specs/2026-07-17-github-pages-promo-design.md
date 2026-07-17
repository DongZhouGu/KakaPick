# KakaPick GitHub Pages 宣传站设计

## 目标

为 KakaPick 提供一个可公开访问的 GitHub Pages 宣传站，清楚说明本地选片价值、核心工作流、隐私边界、macOS 下载方式和开源入口，并与 README 使用同一套品牌文案。

## 方案

采用 `site/` 下的纯静态 HTML/CSS 页面，由 GitHub Actions 将 `site/` 发布到 GitHub Pages。页面不依赖运行时框架、第三方脚本、外部字体或分析服务，使用内嵌 KakaPick Logo 和 CSS 绘制的产品界面示意，保证在项目路径和自定义域名下都能工作。

## 页面结构

- 首屏：咔咔选 KakaPick、主口号、产品定位、下载 DMG 与查看源码行动按钮。
- 痛点与价值：拍摄量大、相似画面难比较、导出交付不安心；对应自动整理、快速判断、安心本地。
- 工作流：导入文件夹 → 自动成组 → 并排高清比较 → 键盘评分 → Lightroom 或精选文件夹导出。
- 产品示意：深色工作台卡片，展示组导航、照片比较、评分和导出状态，不伪造真实用户数据。
- 能力与信任：RAW+JPEG、同步放大、快速恢复、无云上传、Apple Silicon、MIT。
- FAQ/下载：macOS 13+、Apple Silicon、ad-hoc 签名提示、GitHub 源码入口。

## 发布与安全

GitHub Actions 使用官方 Pages Actions，发布分支为公开仓库的 `main`。DMG 通过 GitHub Release 附件提供，页面只引用固定的 release 下载地址；不把 release、marketing、videos、缓存或本地应用数据提交进仓库。页面不收集访问者数据，不加载第三方 JavaScript。

## 验收标准

1. 静态页面在桌面和窄屏下可读、无横向滚动，主要行动按钮可用。
2. 下载按钮指向公开 Release 的 DMG，源码按钮指向公开仓库。
3. 页面文案与 README 的产品能力、隐私和签名限制一致。
4. 静态站测试检查关键标题、链接、无外部脚本和 Pages workflow 配置。
5. `pnpm test`、`pnpm typecheck`、`pnpm lint` 通过，GitHub Pages workflow YAML 结构清晰。
