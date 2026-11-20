# pilot 发布记录 · 服务台退场 / 部门模型 / 工作台统一（2026-11-08）

环境：现有 ECS `8.136.107.153`，隔离试点库 `youfu_pilot`，服务 `youfu-pilot`（4101），
PC 静态目录 `/opt/youfu/pilot/frontend-dist`。

## 1. 备份

发布前已备份到 `/opt/youfu/pilot/backup/pre-112-<时间戳>/`：

- `youfu_pilot.sql.gz`（pg_dump）
- `backend-dist.tar.gz`（旧 `dist`）
- `frontend-dist.tar.gz`（旧 PC 静态包）

## 2. 数据库迁移（以 postgres 执行）

按顺序应用：

1. `110_principal_rls.sql` —— 请求级 RLS；
2. `111_department_model.sql` —— 默认部门、部门路由规则、`department_id` 回填；
3. `115_account_token_version.sql` —— 账号 token_version（新后端登录会读取该列）；
4. 部署新后端并重启 `youfu-pilot`（新代码不再读写服务台）；
5. `112_drop_service_desk.sql` —— 删除服务台列/表/开关/权限覆盖，`department_id` NOT NULL；
6. `113_evaluated_score_check.sql` —— 评价态必须有满意度分数；
7. `114_drop_service_desk_agent.sql` —— 删除遗留的 `service_desk_agent` 空表。

已补齐 `_migrations` 记录（110~115）。当前 pilot 迁移到 115。

## 3. 应用部署

- 后端：新 `dist` 覆盖 `/opt/youfu/pilot/backend/dist`，`systemctl restart youfu-pilot`；
- 前端：新 `dist` 覆盖 `/opt/youfu/pilot/frontend-dist`，`nginx -t && nginx -s reload`；
- 小程序：`youfu_mp_pilot` v5.9.16 已通过 `miniprogram-ci` 上传开发版本
  （体验版需在公众平台手动“设为体验版”）。

## 4. 数据状态（pilot · `zixing-hospital`）

- 部门：`总务科`（`ZW`，`is_default=true`）；
- 人员：`W0001` 已归属 `总务科`；
- 账号：`admin` / `operator` / `w001`；
- 工单：发布时已清零；2026-11-09 已生成 100 条试点演示数据（`docs/pilot-demo-data-20261109.md`），
  真实试点启动前执行 `seed-pilot-demo.mjs --clean` 清掉演示数据与 `demo_*` 账号。

## 5. 冒烟结果

- `youfu-pilot` active，`/health` 返回 `{"ok":true,"status":"up"}`；
- `admin` 登录成功；`/auth/me` 返回权限；
- `GET /stats/workbench` 返回 buckets / timeout / today_new / rates / data_quality；
- `GET /open/work_orders?limit=2&offset=0` 正常；
- `GET /basic-data/dept` 返回默认部门；
- 建单自动归属：不带 `department_id` 建单 → 自动派给 `W0001`，`department_id=总务科`、
  `department_source=assignee`、`department_name=总务科`（冒烟单已删除，工单仍为 0）；
- 改部门链路：处理人属于原部门时改到其他部门 → 409；解除处理人后改部门 → 200，
  事件 `change_department` 落库（冒烟数据已清理）；
- PC UI 走查：登录、工作台、工单列表、工单详情、建单页、基础数据、系统管理均无控制台错误；
  列表/详情显示“责任部门”，无“服务台”；“改部门”入口存在；
- 全流程 UAT：建单 → 自动派 `W0001` → 工人开始/完成 → admin 关闭 → 评价 5 分 →
  自动生成结算草稿 `ST202611080001` → 工作台显示今日新增 1、满意度 5.00、已评价 1；
  走查数据已清理，pilot 工单/结算/load 恢复为 0；
- `GET /service-desks` → 404；
- `GET /config/ticket-require-service-desk` → 404；
- pilot 前端 `index.html` 与 `assets/index-*.js` 200；
- `https://youfu.banerz.cn/pilot/api/v1/auth/login` 外网可达（错误账密返回 401）。

## 6. PC 管理端访问（2026-11-08 追加）

`pilot.banerz.cn` 仍无公网 A 记录，为避免试点被 DNS 卡住，已增加主域子路径入口：

- 新增 PC 构建 `base=/pilot/`，部署到 `/opt/youfu/pilot/frontend-dist-path`；
- 主域静态根建立软链 `/opt/youfu/frontend-dist/pilot → /opt/youfu/pilot/frontend-dist-path`；
- 主域 Nginx 增加：
  - `location = /pilot { return 301 /pilot/; }`
  - `location ^~ /pilot/ { try_files $uri $uri/ /pilot/index.html; }`
- 前端 `client` / `platformClient` / `BrowserRouter` 改为从 `import.meta.env.BASE_URL` 派生基路径，
  同一份源码兼容根路径与 `/pilot/` 子路径。

访问地址：`https://youfu.banerz.cn/pilot/`（API 仍走 `/pilot/api/v1`）。

## 7. 发布后现场修复（2026-11-08）

实际打开 PC 页面后又修了三处：

1. **通知列表 500**
   - 根因：`notification.work_order_id` 是 text，`transport_order.id` 是 uuid，
     孤儿过滤直接 `t.id = n.work_order_id` 报 `operator does not exist: uuid = text`。
   - 修复：`t.id::text = n.work_order_id`，并把 PGlite 测试的 `transport_order.id` 改成 uuid 对齐生产。
2. **二次打开页面统计卡变「—」**
   - 根因：Express 默认 ETag 导致浏览器发 `If-None-Match` 收到 304，axios 默认只认 2xx。
   - 修复：API 统一 `Cache-Control: no-store`，并关闭全局 ETag。
3. **评价流转被 113 约束拒绝**
   - 根因：先 UPDATE status=evaluated，再单独 UPDATE satisfaction_score，CHECK 在第一步即失败。
   - 修复：评分并入 `transition()` 的同一条 UPDATE；路由层删除二次 UPDATE。
4. **渠道收口只有前端拦截**
   - `/auth/login`、`/auth/wx-login` 增加 `channel: pc | mp` 服务端强校验：
     worker + pc → 403，operator + mp → 403；缺省 channel 兼容老客户端。
   - PC 登录发送 `channel: pc`，小程序登录/静默登录发送 `channel: mp`。
5. **工单列表/抢单大厅部门列仍取旧字段**
   - 统一改为 `department_name`；抢单大厅 SQL 补 `LEFT JOIN dept`。
6. **部门路由规则没有管理入口**
   - 新增 `GET/POST/PUT/DELETE /department-route-rules`（`basicdata.edit`）；
   - PC「基础数据 → 部门路由规则」支持优先级、启停、目标部门与匹配条件；
   - pilot 实测：`description_contains=RULE-UAT` 规则把新单落到临时部门，来源 `rule:smoke rule`。
7. **小程序抢单大厅仍读旧 department 字段**
   - 改为 `department_name || department_id`，随 v5.9.16 上传。
8. **默认部门没有管理按钮**
   - 新增 `PUT /departments/:id/default`；PC「基础数据 → 部门」增加“设为默认”和默认标记。
9. **改角色后旧 JWT 仍有效**
   - `115_account_token_version.sql`：`account_user.token_version` + 角色/启用/密码变更触发器；
   - 新登录 JWT 带 `tv`，鉴权时回查比对，不一致返回 401 `AUTH_004`；
   - 旧 token 无 `tv` 时保持兼容（等 TTL 自然过期）。
   - pilot 实测：w001 改角色后旧 token /auth/me 401，重登后新 token 200。

## 8. 已知边界

- `pilot.banerz.cn` 仍无公网 A 记录；PC 管理端已可走 `https://youfu.banerz.cn/pilot/`，
  后续如需独立域名再加 DNS 即可。
- 主站 `youfu` 已于 2026-11-08 切换为当前后端/前端，记录见 `docs/main-cutover-20261108.md`。
- 主站 8 个 `w_*` operator 演示账号已改为 worker（`token_version` 已自增，旧 JWT 失效）。
- 主域重新部署前端时，需保留/重建 `/opt/youfu/frontend-dist/pilot` 软链，否则 `/pilot/` 静态入口会 404。
- `department_route_rule` 已有管理入口（基础数据 → 部门路由规则），但试点租户尚未配业务规则，当前仍由默认部门兜底。
- `dept.is_default` 已有“设为默认部门”入口（基础数据 → 部门），并有 DB 唯一默认约束。
