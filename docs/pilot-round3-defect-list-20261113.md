# Round 3 缺陷清单（2026-11-13）

## D-R3-01 通知单条已读在真实 UUID 上 500

- 级别：P2（功能不可用，有“全部已读”绕过）
- 状态：已修复
- 层级：契约（API 入参类型）+ 共享数据访问（SQL 类型）
- 现象：`POST /open/notifications/read {"ids":["<真实通知id>"]}` 返回 500。
- 根因：`notification.id` 是 `uuid`，SQL 写成 `id = ANY($2::text[])`，
  PostgreSQL 报 `operator does not exist: uuid = text`。
- 为什么之前没拦住：
  - 单测 mock 使用 `n-1` 这类非 UUID，且断言的是 `::text[]`；
  - 之前只测了“全部已读”（ids 缺省），没有用真实 UUID 走单条路径。
- 修复：
  - zod 入参改为 `z.array(z.string().uuid())`；
  - SQL 改为 `id = ANY($2::uuid[])`；
  - 负控制：非法 UUID 必须 422，不能 500；
  - 更新 F8-2 用例使用真实 UUID 并断言 `::uuid[]`。
- 删除修复后变红的测试：
  - `reviewFixesF8F9F15.test.ts` F8-2；
  - `pilot-round3-edge-e2e.mjs` 非法 UUID 负控制；
  - `pilot-round3-chains-c9-c16.mjs` C15 单条已读。
- 线上证据：修复后 C15 PASS；非法 UUID 返回 422。

## D-R3-02 并发编辑资产无乐观锁，最后写入生效

- 级别：P3（数据覆盖风险，低并发场景）
- 状态：记录，未修复
- 现象：两个管理员并发 PUT 同一资产，两次都 200，最终值为后提交者。
- 层级：契约/共享逻辑（缺少版本号或 `updated_at` 乐观锁）
- 影响：PC 双人同时编辑可能静默覆盖。
- 建议：资产/耗材/设备等管理表单增加 `version` 或 `updated_at` 条件更新，
  冲突返回 409。pilot 单管理员场景风险低，本轮不阻塞。

## 非缺陷确认

### 流程配置租户侧 403

`PUT /workflow-defs/work_order/draft` 返回
`403 WORKFLOW_CONFIG_PLATFORM_ONLY`。这是 097 归属闸门的设计行为：
pilot 的流程配置归平台运维。本轮通过“直接发布新版本 + 历史快照”验证了
在途单锁旧版、新单新版的引擎行为。

### 运送单创建后 claim 返回 409

运送单创建时可能已自动派给唯一在岗师傅，随后 claim 返回
`transport order already claimed`。这是自动派单与认领的正常竞态，
本轮链改为“已有承运人则直接接单”，不视为缺陷。

### 账号删除后旧 token

使用生产格式 token（含 `tv`）时，删除账号后立即 401/403；
测试脚本早期直接签发的 token 未带 `tv`，属于测试构造问题，不是产品缺陷。

## 承接上一轮的 P2（仍按书面豁免）

```text
通知 outbox（内存队列丢消息）
模板 ID 双源无自动门禁
AI embedding 资源未隔离
```
