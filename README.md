# 咔咔选 KakaPick

![咔咔选标志](src/client/assets/kakapick-mark.svg)

**拍得多，也能选得快。**

咔咔选是一款面向摄影师的本地优先选片工具。它自动整理连拍与相似照片，帮助你并排比较、用键盘评分并安全导出，全程不上传照片。

[产品主页](https://DongZhouGu.github.io/KakaPick/) · [下载 macOS 版](https://github.com/DongZhouGu/KakaPick/releases/latest) · [English](README.en.md)

> 早期公开版本 · Apple Silicon · macOS 13+ · MIT

![咔咔选并排选片工作台](docs/assets/kakapick-workspace.png)

## 把时间留给判断，而不是整理

一组连拍可能包含几十张几乎相同的照片。咔咔选负责机械、重复的整理，让你专注判断清晰度、表情和瞬间。它不会宣称能选出“最好”的照片，也不会取代你的审美判断。

## 从文件夹到最终入选

1. **打开文件夹。** 同一目录中规范化同名的 RAW、JPEG 和 XMP 会组成一个照片单元。
2. **自动整理。** 应用根据拍摄时间、相机信息和画面相似度辅助组织连拍与相近画面。
3. **看清差异。** 自适应并排比较 1–5 张照片，并可同步缩放、平移，使用胶片栏和全组总览。
4. **连续选片。** 用键盘保留、淘汰或设置 0–5 星评分；需要时可拆分、合并或撤销分组操作。
5. **安全导出。** 写入 Lightroom 兼容评分，或将入选的 RAW、JPEG 和 XMP 复制到单独文件夹。

咔咔选适合活动、人像、婚礼、旅行和其他连拍量较大的拍摄场景。

![咔咔选自动成组与相册总览](docs/assets/kakapick-workflow.png)

## 核心能力

- **本地优先：** 照片、缩略图、评分和导出都留在你的 Mac 上；没有上传、账号或云同步。
- **快速视觉比较：** 自适应 1–5 张并排布局、同步细节检查和键盘优先导航。
- **克制而实用的辅助：** 本地图像指标可以提示模糊、过曝和欠曝，但不会假装替你做审美决定。
- **Lightroom 兼容工作流：** 可以将评分写入兼容元数据，不修改 Lightroom 目录数据库。
- **安全处理源文件：** 不修改专有 RAW 字节；导出写入使用预检和事务式文件操作。
- **快速恢复：** 已保存的会话和分析缓存可在相册未变化时避免重复工作。

## 在 macOS 上安装

从 [GitHub Releases](https://github.com/DongZhouGu/KakaPick/releases/latest) 下载当前构建，打开 DMG，再将咔咔选拖入“应用程序”。

当前公开构建面向运行 macOS 13 或更高版本的 Apple Silicon Mac。构建使用 ad-hoc 签名，未经过 Apple 公证，因此 macOS 可能阻止首次启动。如果你信任下载来源，请在 Finder 中右键咔咔选并选择**打开**。请只安装来自可信来源的构建。

## 快速开始

1. 选择照片文件夹，或重新打开最近相册。
2. 比较每组照片，完成评分或淘汰。
3. 将评分导出为 Lightroom 兼容元数据，或把入选源文件复制到单独的“精选”文件夹。

| 按键 | 操作 |
| --- | --- |
| `1`–`5` | 设置星级评分 |
| `X` | 保留 |
| `Z` | 淘汰或恢复 |
| `[` / `]` | 上一组 / 下一组 |
| `S` | 拆分当前组 |
| `M` | 与下一组合并 |
| `⌘Z` | 撤销 |
| `Space` | 临时放大 |
| `Ctrl` + 滚轮 | 同步缩放 |

快捷键和每屏显示的照片数可以在设置中调整。

## 格式与导出

支持 JPG/JPEG、ARW、CR2、CR3、NEF、RAF、RW2、ORF 和 DNG。只有 RAW 文件时，咔咔选会尝试使用其中的内嵌预览。

元数据导出会把 Lightroom 兼容评分写入合适的元数据目标，不会编辑 Lightroom 目录。复制导出会把入选源文件及其关联文件放入单独的目标目录。

## 隐私与安全

- 本地 HTTP 服务只绑定 IPv4 loopback，并校验 Host、Origin 和每个进程的 token。
- 公开 API 响应、界面和导出报告不会透露照片绝对路径。
- Electron 渲染器启用 sandbox 和 context isolation，并关闭 Node integration。
- 会话数据保存在 `~/Library/Application Support/BurstPick/`；缩略图缓存在 `~/Library/Caches/BurstPick/`。这些内部历史名称为兼容已有数据而保留。

完整边界请参阅[系统架构](docs/architecture.md)和[安全策略](SECURITY.md)。请通过 GitHub 私密漏洞报告功能报告安全问题，不要公开发布利用细节。

## 构建与贡献

从源码构建需要 macOS 13+、Node.js 20.3+ 和 pnpm 11.7.0。

```bash
pnpm install
pnpm dev
```

运行 `pnpm desktop:pack` 或 `pnpm desktop:dist` 可创建独立 App 或 DMG。打包构建内含 Electron、Node.js、Sharp 和 ExifTool。

欢迎提交问题、专注的修复、测试和文档改进。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)；完整文档索引见 [docs/README.md](docs/README.md)。

## 当前限制

咔咔选仍是预发布软件。公开构建目前只支持 Apple Silicon 和 macOS 13+，采用 ad-hoc 签名且未公证。咔咔选不提供云同步、多人协作、照片编辑、RAW 显影或自动完成最终审美选择。

## 许可证

[MIT](LICENSE) © 2026 KakaPick contributors
