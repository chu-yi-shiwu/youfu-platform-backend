# 方向 B「现场真实性」实施记录（2026-11-14）

> 依据：用户选择方向 B，并确定巡更在场校验「只做扫码」。
> 目标：让现场记录能证明“人到了”，并让逾期可见；不引入定位依赖（巡更）。

## 1. 巡更扫码签到

### 1.1 根因

原 `POST /patrol/tasks/:id/checkin` 只接收 `point_id`，任务负责人可在任意地点逐点点完，记录没有任何到点证明；PC 也没有点位码可打印。

### 1.2 修复

- 迁移 `118_patrol_point_qr.sql`：
  - `patrol_point.checkin_code`（租户内唯一索引）；
  - 历史点位按 id 派生稳定码回填（pilot 2 个点位已回填）。
- 后端：
  - 新建点位自动生成 12 位签到码；
  - `POST /patrol/tasks/:id/checkin` 默认必须传 `code`，服务端只在该任务点位集合内按码定位；
  - 仅传 `point_id`：仅 `patrol.manage`（管理员/现场负责人）可手工补签，worker 返回 `403 SCAN_REQUIRED`；
  - 签到记录写入 `via: 'scan' | 'manual'`，用于事后审计。
- PC 巡更管理：
  - 点位表展示「签到码」；
  - 「二维码」弹窗 + 下载 PNG 海报 + 打印（复用签到海报生成器，文案改为巡更）。
- 小程序：
  - 任务详情移除逐点「签到」按钮，改为「扫码签到」；
  - 扫描点位码后调用新契约，成功刷新详情与列表。

### 1.3 契约

```text
POST /patrol/tasks/:id/checkin { code, note? }         # worker 唯一自助通道
POST /patrol/tasks/:id/checkin { point_id, note? }     # 仅 patrol.manage 手工补签
```

## 2. 巡检定位策略

- 新增租户级配置 `system_config.inspection_geo_policy`：
  - `off`（默认，保持历史行为）；
  - `warn`：必须上报经纬度，超过点位 500m 标记 `geo_suspect`；
  - `block`：必须上报经纬度，超过 500m 直接 422 `GEO_TOO_FAR`。
- 点位无坐标时不硬判距离（诚实口径：只校验“有定位”）。
- PC「系统配置」自动展示该策略行，用下拉选择，保存后立即生效。

## 3. 巡检逾期可见

- 不改状态机，按派生口径：`status IN ('pending','in_progress') AND scheduled_at < now()`。
- `GET /inspection/tasks` 返回 `overdue` 布尔；支持 `?overdue=1` 过滤。
- `GET /inspection/stats` 增加 `overdue` 计数。
- PC 巡检管理：状态列后新增「逾期」标签、统计卡「逾期」、右上「只看逾期」开关。

## 4. 验证

```text
后端全量        204 文件 / 2482 用例 PASS
前端全量        34 文件 / 260 用例 PASS
PC Playwright   10/10 PASS
线上隔离审计    10/10 PASS（uat-onsite-<run>，审计后清理）
```

线上审计 `scripts/pilot-onsite-audit-e2e.mjs`：

```text
巡更点位创建即生成签到码
worker 不扫码 → 403 SCAN_REQUIRED
错误签到码 → 404
扫码签到 200 + via=scan
管理端手工补签 200 + via=manual
巡检 overdue=1 命中逾期任务；统计 overdue 计数
warn 未带定位 → 422 GEO_REQUIRED；带近定位 → 200
block 超 500m → 422 GEO_TOO_FAR
```

PC 实测：巡更点位表已显示签到码与二维码入口；系统配置已显示定位策略；巡检管理已显示逾期筛选/统计。

## 5. 部署

```text
迁移 118 已应用 pilot（2 个历史点位回填签到码）
后端  active，/health/ready 200
PC    assets/index-CzyjUybQ.js
小程序 v5.9.26 预览码已生成
```

## 6. 残余风险

1. 点位二维码仍可能被拍照转发他人代扫；扫码只能证明“持有码”，不能证明“人在现场”。
   如后续需要更强约束，可叠加定位（本轮按选择未做）。
2. 管理端手工补签是授权行为，记录 `via=manual`，需按现场管理规范使用。
3. 巡检点位未维护坐标时，`warn/block` 只能校验“有没有定位”，无法判断距离。
4. 逾期为派生展示，不改变任务状态；长期未处理的任务仍会留在待处理列表。
