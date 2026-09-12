# 志愿者模块收尾批次（V1）上线 Checklist

| 项 | 内容 |
|---|---|
| 文档版本 | v1.0（2026-09-11） |
| 依据 | 《志愿者模块收尾批次（V1）增量架构设计》§3.4 数据卫生 + T04 任务卡；《增量 PRD》F2 数据卫生 |
| 执行人 | ________（执行后逐栏填记留痕） |
| 关联提交 | BE `8fb2e15` · FE `89fc98b` · mp `45359a3`（本地 commit，部署/回灌由主理人负责） |

> 本批次**零 DDL、零新增 npm 依赖**；serving 移除是纯代码/注释级改动。上线顺序：**数据卫生核查 → BE → FE → mp → 回归**。

---

## 一、上线步骤（按序执行）

### 1. 数据卫生核查（BE 部署前，连生产库）

```sql
-- 1.1 核查 serving 死状态存量（预期 0——全系统无任何 API 可置入该状态）
-- ⚠️ 必须以表 owner / 超户(postgres)连接执行：volunteer_record 启用 RLS，
--    若以 youfu_app 连接且未 SET app.tenant_id，本查询恒返回 0 → 假"干净"结论。
SELECT count(*) FROM volunteer_record WHERE status = 'serving';
```

- 结果 = **0** → 无需清洗，在下方"数据卫生执行记录"填 `0`，跳到第 2 步。
- 结果 ≠ **0** → 先导出留痕，再清洗：

```sql
-- 1.2 留痕：导出全部 serving 行（结果整段贴工单/回贴本文件执行记录栏）
SELECT id, tenant_id, activity_id, user_name, status, check_in_at, check_out_at,
       duration_min, points, created_at
FROM volunteer_record WHERE status = 'serving';

-- 1.3 清洗：serving 语义并入 checked_in（已到场服务；时长/积分只依赖 check_in_at，不受影响）
UPDATE volunteer_record SET status = 'checked_in' WHERE status = 'serving';

-- 1.4 复核：再次执行 1.1，确认结果 = 0
SELECT count(*) FROM volunteer_record WHERE status = 'serving';
```

### 2. 部署 BE（youfu_backend_dev_v2 @ 8fb2e15）

1. 确认 `git log -1` 为 `8fb2e15`（志愿者V1批次T01）；**无需执行任何迁移文件**（012 仅为注释级改动，已应用库重放安全）。
2. 部署后探针（按仓库既有探针纪律）：
   - `GET /api/v1/volunteer/activities`（登录态）→ 200 且 items[] 含 `signup_count` 字段；
   - 未登录访问 `POST /api/v1/volunteer/activities` → 401；
   - worker 角色调 `POST /api/v1/volunteer/activities` → 403 `permission denied: volunteer.manage`。
3. 同一活动同一 user_name 二次 `POST /activities/:id/signup` → 第二次 409 `DUPLICATE`。

### 3. 部署 FE（youfu_frontend_dev @ 89fc98b）

1. 部署后以 admin 刷新后台：菜单「志愿者活动」可见、「发布活动」按钮出现（有 <1s 权限加载延迟，属设计 D3 预期）。
2. 无 `volunteer.manage` 权限的角色（如 worker）登录：菜单不可见；直连 URL 进页面无管理按钮。

### 4. 发布 mp（youfu_mp @ 45359a3，走既有提审/发布流程）

提审前自查（本仓 precommit_gate 已全绿）：`pages/worker/volunteer` 四件套已注册 app.json；工作台宫格与个人中心两入口在位；报名页全程无姓名输入框（合规审查重点：零文本采集超出既有身份字段）。

---

## 二、数据卫生执行记录（可填栏）

| 检查项 | 命令 | 预期 | 实测 | 执行时间 | 执行人 |
|---|---|---|---|---|---|
| serving 存量核查（清洗前） | `SELECT count(*) FROM volunteer_record WHERE status='serving'` | 0 | ____ | ____ | ____ |
| serving 行导出留痕（仅非 0 时） | §一 1.2 SQL，结果贴工单 | — | ☐ 已贴 | ____ | ____ |
| 清洗 UPDATE（仅非 0 时） | `UPDATE volunteer_record SET status='checked_in' WHERE status='serving'` | 影响行数=留痕数 | ____ | ____ | ____ |
| serving 存量核查（清洗后复核） | 同 1.1 | 0 | ____ | ____ | ____ |

---

## 三、三端回归清单

### BE（自动化已覆盖，上线后抽查）

| # | 场景 | 预期 | 结果 |
|---|---|---|---|
| B1 | signup 404（活动不存在） | 404 NOT_FOUND | ☐ |
| B2 | closed 活动 signup | 409 BAD_STATE「活动已关闭，无法报名」 | ☐ |
| B3 | 名额满 signup（含 slots=0） | 409 BAD_STATE「报名名额已满」 | ☐ |
| B4 | 同 (activity_id, user_name) 二次 signup | 409 DUPLICATE「您已报名过该活动，无需重复报名」 | ☐ |
| B5 | signup→checkin→checkout→approve 全链 | 全 200，状态机四态 | ☐ |
| B6 | GET /activities | 200，items 含 signup_count | ☐ |
| B7 | worker 调管理端点 | 403 | ☐ |
| B8 | 无覆盖行租户 operator 全通过 / worker 全 403 | 与升级前一致（零回归） | ☐ |

### FE（后台手工走查）

| # | 场景 | 预期 | 结果 |
|---|---|---|---|
| F1 | admin 打开志愿者页 | 统计卡 + 活动表含「已报 X / 名额 Y」列 | ☐ |
| F2 | 仅授 volunteer.view 角色 | 页面可见、无发布/关闭/重开按钮 | ☐ |
| F3 | 仅授 volunteer.audit 角色（如 service_desk） | 菜单不可见（无 volunteer.view） | ☐ |
| F4 | 收回 volunteer.manage 后刷新 | 按钮消失，与后端 403 一致 | ☐ |
| F5 | perms 加载瞬间（刷新首帧） | 管理按钮短暂隐藏后出现（D3 预期，非 bug） | ☐ |
| F6 | 历史脏数据 serving 行（若构造） | 状态显示「服务中」，页面不报错（只读兼容） | ☐ |

### mp（真机走查，对齐 PRD F1 验收标准）

| # | 场景 | 预期 | 结果 |
|---|---|---|---|
| M1 | worker 登录 → 工作台「志愿活动」 | 入口可见（五按钮布局正常换行） | ☐ |
| M2 | 进入报名页 | 列表含名额余量（已报 X/名额 Y），open 在前、closed 置灰 | ☐ |
| M3 | 点「确认报名」 | 弹窗「将以【张三】的身份报名」，全程无姓名输入框 | ☐ |
| M4 | 报名成功 | toast「报名成功，请按时到场签到」+ 卡片转「已报名」 | ☐ |
| M5 | 重复报名第二次 | toast「您已报名过该活动，无需重复报名」+ 卡片已报名；断网重进本地标记仍生效 | ☐ |
| M6 | slots=1 活动两人先后报 | 第二人收「报名名额已满，看看其他活动吧」 | ☐ |
| M7 | closed 活动报名 | 卡片置灰「已截止」，提示「该活动已截止报名」 | ☐ |
| M8 | 身份两源皆空 | 阻断弹窗「请先完善姓名后再报名」+ 跳个人中心按钮可用 | ☐ |
| M9 | operator（无 worker 档案）经个人中心进入 | 以 display_name 正常报名（summary 404 走兜底，不弹错误） | ☐ |
| M10 | 个人中心「志愿活动」入口行 | 全角色可见可进 | ☐ |

---

## 四、回滚说明

本批次**无数据回滚需求**（零 DDL；数据卫生 UPDATE 仅在存量非 0 时执行，且 checked_in 为合法终局前状态，无需回写）。

### 代码回滚（按端独立，无需同时）

1. **BE**：`git revert 8fb2e15`（或回滚至 `6f41c23`）。
   - 守卫还原为 `requireConfigRole`（admin/operator 同步放行），PERMS 移除 3 点；
   - `role_permission` 表中已自配的 `volunteer.*` 覆盖行**无需清理**（回滚后这些权限点不再被任何端点消费，属惰性数据，不产生副作用）；
   - signup 去重守卫随 revert 一并消失（回滚期间重复报名重新可能，属已知旧行为）。
2. **FE**：`git revert 89fc98b`（菜单映射回 basicdata.edit、VolunteerPage 回 role 判断）。
3. **mp**：撤回本次提审版本（本地 `git revert 45359a3` 后重新提审）。

### 回滚后兼容性

- 回滚 BE 但保留新 FE/mp：FE 菜单 `/volunteer` 看 `basicdata.edit`（回滚版映射），operator/admin 仍可见；mp 报名页仍可用（GET /activities、signup 端点回滚前后均为仅登录），仅失去去重与名额展示（signup_count 字段消失，mp 卡面显示"已报 0 / 名额 Y"降级，不报错）。
- 保留 BE 回滚 FE/mp：新权限点生效但 FE 菜单/按钮仍走旧映射，等效于升级前行为。

---

## 五、已知技术债（挂 V2，不阻塞上线）

1. 判重键 `user_name` 文本：同名同姓者互相收到"已报名"（V2 加 user_id 列，需 DDL+迁移）。
2. 「我的报名」查询端点（GET /volunteer/my）未做：mp 以本地标记 + 服务端 409 兜底。
3. mp 端 409 分流目前按 message 子串（两子串被 BE http 测试断言锁定）；utils/api.js 错误对象暴露 code 后可升级为 code 优先（api.js 零改动约束保持）。
