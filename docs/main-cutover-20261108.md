# 主站切换记录（2026-11-08）

## 1. 结果

主站 `youfu.banerz.cn` 已从 10-30 旧后端/旧前端切换为当前代码：

- 新后端：`/opt/youfu/backend/dist`，`youfu-backend` active，4001 `/health` 正常；
- 主站库：`youfu` 已应用 `110/111/115 → 新后端 → 112/113/114`；
- 新 PC 前端：`/opt/youfu/frontend-dist`；
- `/pilot/` PC 管理端静态入口保留，主前端重新部署后已重建软链。

## 2. 数据结果

- `youfu` 全库工单：65；
- `t-verification`：52（切换前后一致，无丢单）；
- buckets：pending 8 / active 4 / done 24 / cancelled 16；
- timeout 12；
- 4 条无分数 evaluated 按 113 还原为 completed；
- `data_quality.evaluated_missing_score`：4 → 0；
- `work_orders.service_desk` / `department` 列与 `service_desk*` 表已删除。

## 3. 冒烟结果

- 主站登录、工作台、工单列表、详情正常；
- 工作台 52 单、部门名正常；
- `/service-desks` → 404；
- `/pilot/` 登录与 API 正常；
- 主站与 `/pilot/` 同时登录时，localStorage 已按 base 命名空间隔离：
  - 主站：`youfu_token` / `youfu_user`
  - pilot：`pilot_youfu_token` / `pilot_youfu_user`

## 4. 切换中补齐的问题

1. **同源会话串扰**
   - 主站 `/` 与 pilot `/pilot/` 同源，原先共用 `youfu_token/youfu_user`，登录/401 会互相清掉。
   - 已按 `import.meta.env.BASE_URL` 给 localStorage key 加 `pilot_` 前缀；根部署保持原 key，兼容存量会话。
2. **HTML 缓存导致旧 bundle**
   - 切换后浏览器仍可能用缓存 index.html，加载旧 JS。
   - Nginx 已对主站 `/` 与 `/pilot/` 的 HTML 响应加 `Cache-Control: no-cache`；JS/CSS 仍走静态缓存。
3. **旧 JWT 强制失效**
   - 主站切换前签发的 token 没有 `tv`，仅靠 token_version 无法拦旧 token。
   - 切换完成后已轮换主站 `JWT_SECRET`（pilot 使用独立 `JWT_SECRET`，不受影响），
     所有主站旧 token 立即失效，用户重新登录后拿到带 `tv` 的新 token。

## 5. 回滚素材

切换前备份在 `/opt/youfu/backup/pre-cutover-<时间戳>/`：

- `youfu.sql.gz`
- `backend-dist.tar.gz`
- `frontend-dist.tar.gz`
- `backend.env`

如需回滚：

1. 停 `youfu-backend`；
2. 恢复库与旧 `dist` / `frontend-dist`；
3. 重建 `/opt/youfu/frontend-dist/pilot` 软链（若恢复的是加软链之前的包）；
4. 启动服务并 `nginx -t && nginx -s reload`。

## 6. 账号迁移

主站 `t-verification` 的 8 个 `w_*` operator 演示账号已改为 `worker`：

- w_electric / w_elevator / w_hvac / w_lighting / w_network / w_plumbing / w_security / w_water
- 触发器将 `token_version` 自增到 1，旧 JWT 立即失效；
- 这些账号今后只能走小程序（PC 登录返回 `CHANNEL_FORBIDDEN`）。

## 7. 仍未做

- 主站真实人员 UAT 尚未执行；
- `pilot.banerz.cn` 仍无公网 DNS（PC 走 `/pilot/` 已可用）。
