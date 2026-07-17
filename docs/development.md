# 开发指南

## 环境

- macOS 13+
- Node.js 20.3+
- pnpm 11.7.0

安装依赖：

```bash
pnpm install
```

开发启动：

```bash
pnpm dev
```

服务默认绑定 `127.0.0.1:43110`，并输出带进程 token 的本地地址。不要将服务改为监听 `0.0.0.0`。

## 目录约定

```text
src/shared/   跨端领域类型和 API 合同
src/server/   文件系统、扫描、会话、导出和 HTTP 服务
src/client/   React 界面、状态和交互
src/electron/ macOS 窗口、原生选择器和进程生命周期
tests/        端到端与集成测试
docs/         当前关键文档
```

新模块应保持单一职责。共享层不得引入浏览器、React 或 Node 文件系统依赖；客户端不得直接接触真实文件路径；文件操作必须通过服务端验证边界。

## 常用命令

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm test:e2e
pnpm test:metadata-smoke
pnpm desktop:pack
pnpm desktop:dist
```

`desktop:pack` 生成可直接运行的 `release/mac-arm64/KakaPick.app`；`desktop:dist` 生成 Apple Silicon DMG。桌面构建使用 `build/AppIcon.png`，并通过 `scripts/adhoc-sign.cjs` 进行本地 ad-hoc 签名。公开分发前若要避免 Gatekeeper 警告，还需另行配置 Developer ID 与 Apple 公证。

修改行为时先添加能正确失败的测试，再实现最小改动。涉及文件安全、会话持久化或导出事务时，除了单元测试，还要运行对应集成测试和完整验证。

## 修改边界

- 保留 API 严格校验和安全错误映射。
- 不将绝对路径加入公开响应、前端持久化或下载报告。
- 不直接修改专有 RAW 文件。
- 不无提示覆盖目标文件或现有 XMP 内容。
- 品牌变更不得顺带迁移 `burstpick` 内部 key 与 `BurstPick` 应用数据目录。
- UI 新颜色、圆角和状态优先使用现有设计 Token。

## 测试数据隔离

测试必须使用 `mkdtemp` 创建的临时应用数据目录，不得读取或写入用户真实的：

`~/Library/Application Support/BurstPick/`

启动集成测试和 E2E 服务时，应显式注入测试数据根目录，并在结束后停止 watcher 和本地服务。测试不得把临时目录写入用户的最近相册注册表。

## 文档维护

- 产品定位或范围变化：更新 `docs/product.md`。
- 模块、数据流或安全边界变化：更新 `docs/architecture.md`。
- 名称、文案、Logo 或颜色变化：更新 `docs/brand.md`。
- 组件、Token 或交互规范变化：更新 `docs/design-system.md`。
- 命令和发布验证变化：更新 `docs/development.md` 与 `docs/verification.md`。
- 面向用户或贡献者的重要版本变化加入 `docs/history.md`。
