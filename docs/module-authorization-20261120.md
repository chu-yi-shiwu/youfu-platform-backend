# 模块授权（租户 / 部门）交付说明 · 2026-11-20

## 1. 目标与边界

模块授权是**管理面能力开关**，不是权限点：

- 租户模块：租户级硬上限，默认全开（无覆盖行 = 启用）。
- 部门模块：只能在租户已启用范围内继续收紧，不能扩展。
- PC 管理面：菜单、页面路由、管理写入受模块开关控制。
- 移动端个人任务执行：接单、巡检、巡更、运送、志愿报名/签到、工单领料、资产报障/现场照片**永不套用模块门禁**。
- 接口安全边界仍是 `role_permission`；模块关闭不能替代权限校验。

## 2. 数据模型

迁移 `127_module_authorization.sql`（主站 `youfu` / `pilot` 两库均已应用并登记 `_migrations`）：

| 表 | 用途 | 语义 |
| --- | --- | --- |
| `tenant_module` | 租户模块覆盖 | 无行 = 启用；存 `enabled=false` 即关闭 |
| `department_module` | 部门模块覆盖 | 无行 = 继承租户；只能收紧 |

两张表均启用 RLS（`tenant_id = app_tenant_id()`），`department_module` 对 `dept(tenant_id,id)` 建复合外键，部门删除级联清理覆盖。

## 3. 后端 API

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/api/v1/tenant/modules` | 租户管理员 |
| PUT | `/api/v1/tenant/modules` | 租户管理员 |
| GET | `/api/v1/departments/:id/modules` | 租户管理员 / 本部门管理员 |
| PUT | `/api/v1/departments/:id/modules` | 租户管理员 / 本部门管理员；不能启用租户已关模块 |
| GET | `/api/v1/departments/:id/members` | 租户管理员 / 本部门管理员；返回成员与可分配角色 |
| PUT | `/api/v1/departments/:id/members/:accountId/role` | 租户管理员 / 本部门管理员；只能分配已有角色 |

部门管理员判定：

1. 非 admin 必须持有 `dept.manage` 权限点（由租户管理员在角色权限矩阵中授予）。
2. 账号必须通过 `worker.account_id` 绑定到目标部门的 worker。

角色分配防提权：

- 不能分配 `admin`；
- 不能修改自己的角色；
- 不能操作层级高于自己的账号；
- 只能分配租户内已启用角色；
- 非 admin 的目标角色权限集合必须是操作人权限集合的子集；
- 角色变更递增 `token_version`，旧 token 立即失效。

`GET /auth/me` 新增：

- `modules: string[]`：当前用户可见模块（租户上限 ∩ 所属部门收紧；admin 忽略部门收紧）；
- `department_id`：当前用户所属部门（admin 为 null）。

## 4. 管理面门禁

纯管理 router 整体挂模块门禁：

- `settlement` → 结算
- `equipment` → 设备
- `analytics` → 过程挖掘
- `optimize` → 自动调参

混合 router 只拦管理写，执行路径显式豁免：

| 模块 | 拦截 | 豁免（个人任务执行） |
| --- | --- | --- |
| `asset` | 台账新增/编辑/处置/导入/盘点等 | 报障 `POST /assets/:id/fault`、现场照片 `POST /assets/:id/attachments`、扫码/查询 |
| `material` | 目录与仓库入库/出库/退库/阈值 | 工单领料 `POST /inventory/consume`、材料目录读取 |
| `inspection` | 点位/项目/计划/生成 | 任务签到/记录/完成/异常/认领/转单 |
| `patrol` | 点位/任务编排 | 签到/漏签 |
| `volunteer` | 活动/积分规则/黑名单/审核 | 报名/签到/签退/取消/我的记录 |
| `monitor` | 设备配置 | 告警查看/处理/转单 |
| `emergency` | 预案知识库写入 | 预警查看/处理/关联/转单 |
| `transport` | 运送任务创建 | 轨迹/状态流转/认领 |

`work_order`、`analytics`、`configuration`、`foundation`、`system`、`feedback` 的接口与移动端/共用读取高度重叠，当前只做 PC 管理面菜单/路由控制；接口仍由权限点保护。该边界已在此文档显式声明，避免“菜单隐藏 = 安全边界”的误解。

> dev 模式（`AUTH_MODE=dev`）与权限点同口径，跳过模块表查询；生产（prod）执行真实门禁。

## 5. 前端

- `src/api/modules.ts`：菜单/路由 → 模块映射（最长前缀匹配）。
- `MainLayout`：`/auth/me.modules` 驱动菜单过滤；直输 URL 命中关闭模块时跳回工作台；`/module-auth` 故意不挂模块，作为恢复入口。
- `ModuleAuthPage`：租户模块、部门模块、部门成员角色三个页签；部门管理员只看到本部门。
- 菜单权限：`/module-auth` 挂 `dept.manage`（admin 拥有全部权限点）。

## 6. 验证证据

- 后端全量：**219 文件 / 2596 用例通过**。
- 前端全量：**36 文件 / 269 用例通过**。
- 模块专项契约：**16 / 16 通过**（租户/部门开关、越权、角色子集、执行豁免）。
- 隔离租户 live 验收：**12 / 12 PASS**
  - 租户关闭资产 → 部门不可再开；
  - A 部关闭耗材 → A 部成员模块缺失，B 部成员仍保留；
  - admin 忽略部门收紧但仍受租户上限；
  - 部门管理员分配低权角色成功，分配 admin / 跨部门失败；
  - 耗材关闭时个人领料到业务校验（400），仓库入库被 `403 MODULE_DISABLED`。
- 双环境资产 live 审计：**38 / 38 PASS**（主站 + pilot）。
- 公网 readiness：主站 / pilot 均 `{"ok":true,"status":"ready","db":"up"}`。
- `uat-module-*` 验收租户清理核查：两库均为 **0** 残留。

## 7. 残余与后续

- `work_order` 等共用接口未做模块级后端拦截（见 §4 边界说明），后续如需强隔离，应拆分管理面专用端点，而不是在共享执行端点上硬加门禁。
- 部门管理员分配角色采用“权限子集”收敛；租户如需要固定“部门可分配角色清单”，可在 `role_def` 增加 `dept_assignable` 标记后替换当前策略。
- P0-2 已完成真实 commit + CI artifact + 双仓库发布基线，证据见 `docs/release-baseline-20261120.md`。
- P0-5 微信模板/openid 仍未关闭（与本次模块授权无关）。
- P0-4 已完成非侵入式恢复演练，证据见 `docs/pilot-restore-drill-20261120.md`。
