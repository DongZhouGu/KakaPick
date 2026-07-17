# 咔咔选验证与发布

本文档定义发布前需要运行的验证。历史某次运行结果不等于当前通过状态；发布者必须以当前提交上的新鲜输出为准。

本页把设计规范的 12 条验收标准逐项绑定到可重复证据。最终发布状态以本次提交报告中的新鲜命令输出为准；“手动观察”均由 `tests/e2e/demo.spec.ts` 在真实 Chromium 中自动执行。

| # | 验收标准 | 证明证据 |
| --- | --- | --- |
| 1 | 真实 RAW+JPEG 文件夹可扫描且不上传 | `src/server/scanner.test.ts` 的 “pairs, enriches, hashes, groups and reports progress” 以及 “scans and resumes a read-only source without creating source entries”（0555 源、应用数据会话、0600 文件、源目录零新增）；`src/server/app.test.ts` 的 loopback 监听测试；`pnpm test:metadata-smoke` 使用临时真实文件走 `scanAlbum`。网络外传没有独立抓包测试；架构证据是服务仅绑定 `127.0.0.1` 且代码无上传端点。 |
| 2 | 每对只显示一次并报告未配对/重复 | `src/server/pairing.test.ts` 的 same-directory pairing、duplicate preference/report tests；`ScanWarnings.test.tsx` 逐项覆盖重复 RAW/JPEG/XMP、未配对和适配器/文件时间警告；`tests/e2e/warning-fixture.ts` 生成真实无 EXIF JPEG 和多个无效 RAW 候选，`demo.spec.ts` 通过正常手动路径流程断言真实重复、未配对、mtime 回退和元数据处理警告且不泄漏绝对路径。干净 demo 明确断言没有警告。 |
| 3 | 自动分组确定，并结合时间、EXIF、相似度 | `src/server/grouping.test.ts` 覆盖 MAD 阈值、burst ID、sequence、camera boundary、ambiguous similarity 和稳定排序；`src/server/scanner.test.ts` 验证元数据/哈希/分组流水线。 |
| 4 | 手动分组在照片 ID 有效时跨重载保存 | `grouping.test.ts` 覆盖 split 的相邻边界语义、join 的持久共同分组语义、已满足 join 保留及非相邻组 fail-closed；`session-service.test.ts` 覆盖三个重叠相机流的连续 merge、逐次 undo 和 save/load；`scanner.test.ts` 覆盖 join ID 之间新增同相机成员、两个连续 join 及无关清单变化后的重放；`tests/e2e/demo.spec.ts` 留下 `[1,4,7,4]` 并 reload 后逐组断言完全相同。 |
| 5 | 沉浸式工作台支持鼠标和键盘给任意照片独立评分 | `culling-navigation.test.ts`、`PhotoStage.test.tsx`、`CullingWorkspace.test.tsx`、`CullingSettings.test.tsx` 和 `GroupOverview.test.tsx` 覆盖 1–4 张批次、独立评分、即时保存状态、设置 Sheet、所有组统计与跳转、自动前进与边界；E2E 先在总览中跨组跳转，再在两张并排状态分别评分并从设置切换到单张模式。 |
| 6 | 评分跨重载并可撤销 | `session-service.test.ts` 覆盖评分逆命令；`app.test.ts` 覆盖严格批量 API；`use-album.test.tsx` 覆盖乐观更新与回滚；E2E 验证偏好跨 reload，并通过服务端快照驱动持久评分。 |
| 7 | 元数据 dry run 在提交前列出目标和冲突 | `src/server/export/metadata-export.test.ts` 的 confirmation binding、expiry、conflict tests；E2E 断言 demo metadata preview 区域和 32 个目标，且 demo 不出现提交按钮。 |
| 8 | 只写 Rating，保留 Lightroom 元数据，不改专有 RAW，配对同分 | `pnpm test:metadata-smoke`：真实 ExifTool + Sharp，断言 RAW/.acr 字节与 mtime 不变、JPEG/DNG 像素尺寸稳定、protected metadata 相等、三个目标 Rating=4；`metadata-export.test.ts` 另覆盖 same-rating pair。 |
| 9 | 配对写失败恢复两个目标 | `src/server/export/metadata-export.test.ts` 的 “restores the RAW sidecar and JPEG when paired verification fails” 及安装/恢复失败注入测试；smoke 的显式 rollback 验证所有原始字节恢复。 |
| 10 | 复制包含 RAW/JPEG/XMP、校验且不覆盖冲突 | `src/server/export/copy-export.test.ts` 的 copies/verifies hashes、different-content conflict、generated XMP、cancel、install race；`src/server/app.test.ts` 覆盖 preview/job/cancel/report。 |
| 11 | 不用个人照片即可体验 demo | `src/server/scanner.test.ts` 的 demo SVG/三组测试；E2E 覆盖打开、独立评分、密度切换、按住查看、完成流程和 metadata/copy demo-safe preview。 |
| 12 | 自动验证、生产构建、浏览器 smoke 全通过 | 发布门：`pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm test:e2e`、`pnpm test:metadata-smoke`、独立 dev-startup 测试和 `git diff --check`；发布结论只依据当前提交的新鲜输出。 |

## 浏览器观察清单

`tests/e2e/demo.spec.ts` 在 1280×800 和 390×844 两个项目中检查：令牌安全处理；干净 demo；默认两张沉浸式舞台；所有组拼贴总览、统计、跨组跳转和返回；两张独立评分；iOS 风格设置 Sheet；切换单张；自动前进开关；连拍分组范围；按住 Space 临时 100% 查看并恢复；评分结果 Sheet；metadata 的 demo 禁止写入结果与 copy 的 demo-only 预览；偏好 reload 恢复。另一个用例通过正常手动路径打开真实警告相册，断言重复 RAW、未配对 JPEG、mtime 回退和元数据处理失败。所有用例要求无 console warning/error 或 page error、无横向溢出，且所有可见控件至少 44×44 px。

## 可重复命令

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm test:e2e
pnpm test:metadata-smoke
CI=true pnpm vitest run tests/integration/dev-startup.test.ts
git diff --check
```

## macOS 桌面发布门

```bash
pnpm desktop:dist
codesign --verify --deep --strict release/mac-arm64/KakaPick.app
codesign -dv --verbose=4 release/mac-arm64/KakaPick.app
hdiutil verify release/KakaPick-1.0.0-arm64.dmg
```

此外必须从仓库外的临时目录启动复制后的 App，确认首页与 `/api/v1/health` 可访问，退出后本地服务不再监听。检查 `app.asar.unpacked` 中只包含 Sharp、libvips 和 ExifTool 所需运行资源；发布包不得包含测试、源码映射、个人路径、虚拟环境、照片或应用数据。

Playwright 首次运行可能需要一次 `pnpm exec playwright install chromium` 下载与锁定版本匹配的 Chromium。测试服务固定监听 `127.0.0.1:43110`，使用 `0123456789abcdef` 重复四次形成的 64 位十六进制令牌。
