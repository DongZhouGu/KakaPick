# 咔咔选 KakaPick

![KakaPick mark](src/client/assets/kakapick-mark.svg)

**拍得多，也能选得快。**

[产品宣传页](https://DongZhouGu.github.io/KakaPick/) · [下载 macOS App](https://github.com/DongZhouGu/KakaPick/releases/latest) · [GitHub 源码](https://github.com/DongZhouGu/KakaPick)

咔咔选是一款面向摄影师和摄影爱好者的本地选片工具。它把连续拍摄和相似照片自动成组，支持并排比较、高清放大、键盘评分与安全导出。照片、缩略图、评分和导出始终留在本机。

> 当前状态：早期公开版本，优先支持 Apple Silicon Mac（macOS 13+）。欢迎试用、报告问题和贡献改进。

## 为什么做 KakaPick

每次连拍按爽了，回家选片就开始后悔：同一个动作几十张、表情只差一点点，来回切图、放大、缩小，最后眼睛都看麻了。KakaPick 专门处理大量相似照片的机械整理，让摄影师把时间留给真正的判断。

它不会替你决定哪张最有感觉，也不把自动检测包装成万能 AI；它只把重复工作先整理好，让你更快看清差异、更顺手完成交付。

## 一次完整的选片工作流

1. **打开文件夹**：选择照片目录，RAW、JPEG 和 XMP 会按规范化同名关系组成一个照片单元。
2. **自动成组**：根据拍摄时间、相机信息与画面特征整理连拍和相似画面。
3. **并排看清**：在沉浸式工作台中同步放大、拖拽平移，比较清晰度、表情和瞬间。
4. **连续完成**：使用 `X` 保留、`Z` 淘汰/恢复或 `1–5` 星评分，评分后自动前进。
5. **安心交付**：将评分交给 Lightroom，或把入选的 RAW、JPEG 和 XMP 复制到精选文件夹。

适合活动、人像、婚礼、旅行和任何连拍量比较大的场景。

## 功能

- **连拍成组**：结合拍摄时间、相机信息与感知哈希整理相似照片。
- **快速比较**：1–5 张自适应并排、同步放大、胶片栏和全组总览。
- **高效评分**：键盘评分、保留、淘汰、自动前进、拆分、合并与撤销。
- **本地画质提示**：用本机图像指标提示模糊、过曝和欠曝，不调用云端 AI。
- **安全导出**：写入 Lightroom 兼容评分，或复制入选的 RAW、JPEG 和 XMP。
- **快速恢复**：缓存缩略图与分析结果，重新打开未变化相册时跳过重复工作。

宣传页中也提供了一个不依赖云服务的产品概览：[dongzhougu.github.io/KakaPick](https://DongZhouGu.github.io/KakaPick/)。

## 安装 Mac App

发布构建会生成：

- `KakaPick.app`
- `KakaPick-<version>-arm64.dmg`

打开 DMG 后将 KakaPick 拖入“应用程序”。当前本地构建使用 ad-hoc 签名，没有 Apple 公证；从互联网获取的构建可能需要在 Finder 中右键应用并选择“打开”。只安装你信任来源的构建。

公开构建可在 [GitHub Releases](https://github.com/DongZhouGu/KakaPick/releases) 获取；当前版本面向 Apple Silicon，首次打开时的 Gatekeeper 提示属于未公证构建的预期行为。

## 从源码运行

需要 macOS 13+、Node.js 20.3+ 和 pnpm 11.7.0。

先在 GitHub 页面克隆或下载本仓库，然后在仓库目录中运行：

```bash
pnpm install
pnpm dev
```

开发服务只监听 `127.0.0.1`，启动后会在终端输出带一次性进程 token 的本地地址。

构建独立桌面应用：

```bash
pnpm desktop:pack  # release/mac-arm64/KakaPick.app
pnpm desktop:dist  # release/KakaPick-1.0.0-arm64.dmg
```

打包后的 App 内含 Electron、Node.js、Sharp 和 ExifTool，不依赖源码目录、pnpm 或系统 Node.js。

## 使用

1. 选择照片文件夹，或从最近相册继续。
2. 在并排舞台中比较连拍，使用 `X` 保留、`Z` 淘汰/恢复或 `1`–`5` 评分。
3. 用 `[` / `]` 切换组，`S` 拆分，`M` 与下一组合并，`⌘Z` 撤销。
4. 完成后将评分写入 Lightroom 兼容元数据，或复制入选照片到相册旁的“精选”文件夹。

按住 `Space` 可临时放大；点击、拖拽和 `Ctrl` + 滚轮可同步检查细节。快捷键和每屏照片数可在设置中调整。

## 支持格式

JPEG/JPG，以及 ARW、CR2、CR3、NEF、RAF、RW2、ORF、DNG。相同目录下规范化同名的 RAW、JPEG 和 XMP 会作为一个照片单元显示；仅有 RAW 时会尝试提取内嵌预览。

## 隐私与安全

- 不上传照片，不提供账号或云同步。
- HTTP 服务仅绑定 IPv4 loopback，并校验 Host、Origin 和进程 token。
- 不修改专有 RAW 字节；元数据和复制导出采用预检、临时文件、校验和原子发布。
- 公开 API、界面和导出报告不返回照片的绝对路径。
- 会话保存在 `~/Library/Application Support/BurstPick/`，缩略图位于 `~/Library/Caches/BurstPick/`。内部目录保留历史名称以兼容已有数据。

Electron 渲染器启用 sandbox 与 context isolation，并关闭 Node integration。详细边界见[系统架构](docs/architecture.md)和[安全策略](SECURITY.md)。

## 开发与测试

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm test:e2e
pnpm test:metadata-smoke
```

完整项目文档见 [docs/README.md](docs/README.md)，贡献约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE) © 2026 KakaPick contributors
