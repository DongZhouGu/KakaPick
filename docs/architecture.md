# 系统架构

## 架构概览

咔咔选是单仓库 TypeScript 桌面应用，由 Electron 壳、React 客户端和只监听本机回环地址的 Node.js 服务组成。Electron 管理原生窗口、文件夹选择和进程生命周期；React 负责交互；服务负责文件系统、元数据、缩略图、会话和导出。生产环境由本地服务托管构建后的客户端，开发环境使用 Vite。

```text
照片目录
  ↓
scanner / metadata / image adapters
  ↓
配对、感知哈希与自动分组
  ↓
session service + atomic session store
  ↓
本地 HTTP API / SSE
  ↓
React 选片工作台
  ↓
元数据导出 或 安全复制

Electron 主进程 ── 启停本地服务 / 原生窗口 / 文件夹选择
```

## 模块边界

### `src/shared`

存放客户端与服务端共享的可序列化领域类型、Zod 合同和 API 数据结构。该层不依赖 React、浏览器 API 或 Node 文件系统。

### `src/server`

负责本地资源与持久化：

- `scanner.ts`：递归扫描、配对与扫描警告；
- `adapters/metadata.ts`：ExifTool 元数据边界；
- `adapters/image.ts`：预览提取、缩略图和基础画面指标；
- `grouping.ts`、`perceptual-hash.ts`：自动分组与相似度；
- `session-service.ts`、`session-store.ts`：命令、撤销和原子持久化；
- `recent-albums-store.ts`：最近相册注册表；
- `export/`：Lightroom 元数据与复制导出；
- `app.ts`：HTTP API、安全校验与错误映射；
- `index.ts`、`dev.ts`：生产与开发启动。

### `src/client`

负责 React 界面、相册状态、偏好与键盘交互：

- `use-album.ts`：打开、扫描、恢复、评分和分组命令的客户端控制器；
- `CullingWorkspace.tsx`：沉浸式工作台编排；
- `PhotoStage.tsx`、`Filmstrip.tsx`：照片比较与导航；
- `CullingSettings.tsx`、`ExportPanel.tsx`：设置与导出流程；
- `Welcome.tsx`：相册入口与最近相册；
- `styles.css`：当前全局视觉 Token 与组件样式。

### `src/electron`

负责 macOS 桌面边界：

- `main.ts`：单实例、原生窗口、文件夹选择、服务启动与退出清理；
- `security.ts`：应用同源导航和外部 HTTP(S) URL 白名单。

渲染器开启 sandbox 与 context isolation，关闭 Node integration，不暴露 preload API。客户端仍只通过既有 HTTP 合同访问本地能力。

## 数据模型与持久化

一个 `PhotoUnit` 代表同目录、规范化同名的 RAW/JPEG/XMP 组合。`BurstGroup` 保存有序照片 ID；`AlbumSession` 保存照片、分组、评分、淘汰、边界覆盖、历史和分组灵敏度。

会话按规范化源目录路径的 SHA-256 保存到：

`~/Library/Application Support/BurstPick/sessions/<path-hash>/session-v1.json`

这里继续使用历史内部目录名 `BurstPick`，品牌升级不迁移数据路径，以免用户已有会话和偏好失效。会话写入采用临时文件、同步和原子重命名；损坏文件会隔离而不是覆盖。

最近相册注册表位于同一应用数据根目录的 `recent-albums-v1.json`。公开 API 只返回不含绝对路径的摘要和不透明 ID。

## 扫描、配对与分组

扫描器递归查找支持文件，忽略隐藏目录和内部临时目录。同目录中大小写折叠后同名的 RAW 与 JPEG 组成一个照片单元；重复候选、缺失配对和元数据回退会形成可见警告。

自动分组优先使用拍摄时间、相机 ID、连拍 ID 和序列号；在时间间隔模糊时使用 64 位感知哈希作为边界提示。相似度只用于组织照片，不代表审美评分。用户手动拆分或合并会以稳定照片 ID 保存并在恢复时重放。

## 客户端数据流

1. `useAlbum` 调用 `/api/v1/albums/open` 开始或恢复相册。
2. 扫描阶段通过 SSE 接收清点、元数据、哈希和分组进度。
3. 准备完成后，客户端持有脱敏的 `PublicAlbumSession`。
4. 评分和分组操作调用精确 API；服务端保存成功后返回最新状态。
5. 客户端显示保存中、已保存或错误状态，并保留撤销入口。

## 导出架构

### Lightroom 元数据

只修改 `xmp:Rating`。专有 RAW 使用同名 XMP sidecar；JPEG 和 DNG 使用经过准备、验证和原子发布的嵌入式 XMP。提交前必须预览并确认 Lightroom 状态；最近一次导出支持审计和回滚。

### 复制入选照片

复制达到星级阈值的 RAW、JPEG 和 XMP，并保持相对目录结构。目标文件已存在时，只有内容相同才跳过；内容不同则报告冲突，不覆盖。文件先写临时名、验证大小与哈希，再原子发布。

## 安全边界

- 服务只绑定 `127.0.0.1`，不监听局域网。
- 启动时生成高强度进程 token，所有修改请求必须携带 token。
- API 校验 Host、Origin 和严格 JSON 合同。
- 文件操作限制在已选择的源目录和目标目录。
- 公开响应、日志与报告不返回原始绝对路径或异常内部细节。
- 原始 RAW 字节不被修改，导出流程不静默覆盖冲突文件。

## 桌面生命周期

Electron 主进程启动时用随机可用端口创建 Express 服务，再把带进程 token 的 loopback URL 加载到原生窗口。文件夹选择由 Electron 原生 dialog 实现并继续经过服务端目录校验。关闭应用时主进程等待扫描、导出、ExifTool 和 HTTP 服务停止，避免残留后台进程。

生产包使用 ASAR 保存应用代码，并解包 Sharp 与 ExifTool 的原生/可执行资源。`com.burstpick.app`、`BurstPick` 应用数据目录和内部存储 key 暂时保留，以兼容已有会话。
