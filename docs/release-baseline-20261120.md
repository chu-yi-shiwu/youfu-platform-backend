# 发布基线（P0-2）· 2026-11-20

## 1. 结论

P0-2 已闭环：后端/前端都有真实 commit、tag、干净工作树、可复现发布清单，并由 GitHub Actions 生成成功 artifact。

| 项 | 值 |
| --- | --- |
| 后端 release commit | `3dbcf119fb781ff122b28a27e58efcfbde8c004a` |
| 后端 tag | `release-20261120-module-auth` |
| 前端 release commit | `9e3e728a30d4e8d6c909aebcf5563bf62de5d3c3` |
| 前端 tag | `release-20261120-module-auth` |
| 发布清单 | `release-manifest.json` |
| 双仓库基线 | `release-baseline.json` |
| 发布 ID | `20261120T142638-3dbcf119fb78` |
| 服务器发布目录 | `/opt/youfu/releases/20261120T142638-3dbcf119fb78` |
| `current` 软链 | `/opt/youfu/releases/current` |

## 2. CI 与 artifact

- 工作流：GitHub Actions `CI`
- 成功运行：<https://github.com/chu-yi-shiwu/youfu-platform-backend/actions/runs/44752715741>
- 结论：`success`
- artifact：`youfu-release-3dbcf119fb781ff122b28a27e58efcfbde8c004a`
- 大小：634,656 bytes
- 保留：30 天
- artifact 内容：`dist/` + `release-manifest.json`

CI 步骤全部通过：Install、Typecheck、Build、Release manifest、Upload artifact、C3 发布闸门（全量 vitest + SQL 注入扫描 + 迁移幂等 + RLS 策略 + SQL 列契约）。

## 3. 发布清单关键字段

`release-manifest.json`：

- `commit = 3dbcf119fb781ff122b28a27e58efcfbde8c004a`
- `cleanTree = true`
- `migrations = 134`
- `distFileCount = 152`
- `distSha256 = f891e94f0ef1...`（完整值见文件）

`release-baseline.json`：

- backend commit `3dbcf11...`，clean `true`
- frontend commit `9e3e728...`，clean `true`
- backend dist sha256 `25e1bbcb8268...`
- frontend dist sha256 `5be4407fbf91...`
- frontend pilot dist sha256 `1b9bd1db9593...`
- OpenAPI sha256 `b7248ebca499...`

## 4. 本次修复的发布阻断

### 4.1 CI 缺失 seed

`src/test/migrationManifest.test.ts` 读取 `seeds/a1_dispatch_rules.sql`，但 `.gitignore` 的 `a1_dispatch_rules.sql` 模式把整个仓库内同名文件都忽略了，CI 检出后文件不存在。

修复：忽略规则收窄为根目录 `/a1_dispatch_rules.sql`，并把 `seeds/a1_dispatch_rules.sql` 纳入版本库。

### 4.2 CI 慢 runner 超时

`vitest.config.ts` 使用默认 5s 测试超时，PGlite/真库穿透用例在 CI 共享 runner 上会因机器慢被误判为断言失败。调整为 `testTimeout/hookTimeout = 30s`，不改变断言。

### 4.3 迁移账本漂移

两库 `_migrations` 修复：

- `127_module_authorization.sql` 登记名误带前后空格 → `btrim` 修正；
- `116_volunteer_enhancements.sql`、`117_pilot_closure_gaps.sql`、`118_patrol_point_qr.sql` 结构已存在但未登记 → 补登记。

修复后两库 `_migrations` 均无前后空格脏登记；试点库 134 条与仓库 134 个迁移文件对齐。

### 4.4 真实院方 PII 不入库

`docs/pilot-master-hospital-real-20261110/` 含 58 个联系人手机号、15 个员工手机号。已加入 `.gitignore`，不进入 commit/artifact；保留脱敏模板目录。

## 5. 复现命令

```bash
# 后端（Node 22 + git 在 PATH）
npm ci
npm run typecheck
npm run build
npm run manifest
npx tsx scripts/releaseGate.ts --force-vitest

# 双仓库基线
node scripts/release-baseline.mjs --frontend ../youfu_frontend_dev
```

Windows 本地无 PATH git 时：

```powershell
$env:GIT_BIN = "C:\Users\Administrator\AppData\Local\Programs\WorkBuddyAI\resources\vendor\PortableGit\cmd\git.exe"
node scripts/release-baseline.mjs --frontend ..\youfu_frontend_dev
```

## 6. 约束

- `release-manifest.json` / `release-baseline.json` 是可复现发布 artifact，不进入源码库；
- `release-baseline.mjs` 默认 fail-closed：commit 缺失或工作树不干净直接退出 1；
- 发布目录保留 manifest、baseline、CI 元数据，`/opt/youfu/releases/current` 指向当前发布。
