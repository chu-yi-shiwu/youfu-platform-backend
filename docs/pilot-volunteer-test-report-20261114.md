# 志愿者活动模块全面测试报告（2026-11-14）

## 一、结论

```text
API 全功能 / 负向 / 边界 / 权限 / 并发：NO_GAPS
后端全量：204 文件 / 2462 用例 PASS
前端单元：30 文件 / 242 用例 PASS
PC Playwright：10/10 PASS
隔离租户：已清理为 0
真机：11/14 下午待执行
```

本轮未发现新的 P0/P1/P2；所有方案用例通过。

## 二、API 实测结果

### 活动

```text
创建/详情/编辑/删除/关闭/重开        PASS
缺标题 422 / 起止非法 422 / 截止晚于结束 422 PASS
名额小于已报名 409                   PASS
删除有报名 409 / 删除无报名 200       PASS
过期活动 effective_status=ended       PASS
签到码租户内唯一                     PASS
```

### 报名 / 取消

```text
报名 201 / 重复 409 / 满员 409        PASS
取消本人 200 / 管理员 200             PASS
非本人 403 / 已签到 409 / 过截止 409  PASS
取消后重新报名 201                    PASS
黑名单报名 403 BLACKLISTED            PASS
10 并发抢最后 1 名额：恰好 1 成功      PASS
```

### 签到 / 签退 / 核销

```text
开始前 3h 签到 409 / 前 1h 200        PASS
结束后 2 天补签 200（late=true）      PASS
结束后 5 天签到 409                   PASS
扫码签到 200                          PASS
未签到签退 409 / 未签退核销 409        PASS
签退→核销→重复核销                    PASS
积分规则 2 分/小时 → 2h=4 分          PASS
积分规则 0 → 0 分 / 非法 -1 → 422     PASS
```

### 导出 / 通知 / 统计

```text
导出中文表头 + 姓名/状态/签到时间/补签 PASS
活动变更通知：DB 1 条、列表可见        PASS
无变化/仅状态变更不发送通知            PASS
统计 / 人员档案 200                   PASS
```

### 权限

```text
worker 建活动 403 / worker 读黑名单 403 PASS
admin 全功能 PASS
```

## 三、PC / 小程序

```text
PC 志愿者页：列表/详情/创建/编辑/删除/结束/重开/记录操作/二维码/导出/积分规则/黑名单
PC Playwright：10/10 PASS
小程序 v5.9.23：列表/详情/报名/取消/签到/签退/扫码签到
真机 iPad/HarmonyOS：11/14 下午待执行
```

## 四、数据与迁移

```text
116_volunteer_enhancements.sql 已应用：
- volunteer_activity.checkin_code
- volunteer_activity.cancel_deadline
- volunteer_blacklist + RLS
```

清理：

```text
UAT 租户/活动/记录/黑名单：0
pilot 数据：4 工单 / 14 通知 / 3 账号 / 16 师傅
```

## 五、残余

1. 真机 iPad/HarmonyOS 扫码签到与布局需下午现场确认；
2. 微信订阅消息未纳入（本轮变更通知仅站内信）；
3. 活动变更通知只发给能映射到 worker 档案的报名人，外部姓名会跳过。

## 六、小程序/PC 调整（2026-11-14 第二轮）

### 6.1 调整项与实现

| # | 要求 | 实现 |
| --- | --- | --- |
| 1 | 小程序「我的报名」单独一栏 | `volunteer.js` 由 `my-records` 拆分 `myItems` / `otherItems`；wxml 分「我的报名」「可报名活动」两个分区，空态各自独立 |
| 2 | 取消后不再显示「已报名」 | 取消成功即 `volunteerLocal.unmark(activityId)` 再刷新；详情页取消同样 unmark |
| 3 | 取消后可重新报名并出现在列表 | 重新报名成功 `volunteerLocal.mark(id)`；详情页以 `my-records` 服务端事实为准做 mark/unmark（接口失败时不清本地标记，断网仍显示已报名） |
| 4 | PC/小程序增加统计 | PC 新增 `/volunteer/stats` 统计页（总览四卡 + 活动明细表，入口「服务统计」）；小程序列表新增「我的志愿服务」统计卡并进入独立统计页（个人报名/认定/时长/积分 + 服务记录） |

### 6.2 新增接口

```text
GET /volunteer/stats/overview  （volunteer.view）
→ { stats:{registered_count,served_count,total_duration_min,total_points},
    activities:[{id,title,status,slots,start_at,end_at,signup_count,
                 checked_in_count,checked_out_count,approved_count,
                 total_duration_min,total_points}] }
```

- 两条 SQL 均带 `tenant_id`，跨租户零泄漏；
- 服务人次口径 `checked_in + checked_out + approved`，与 `GET /volunteer/stats` 同源；
- worker 访问 403（个人统计走 `GET /volunteer/my-records`，不需要 `volunteer.view`）。

### 6.3 负控制

```text
FE VolunteerStatsPage：403 → 无权限文案，不渲染统计数字
FE VolunteerStatsPage：接口失败 → 明确「统计加载失败」，不静默空表
FE VolunteerStatsPage：无活动 → 空态文案
BE 统计总览：served 口径不含 serving，且 SQL 带 tenant_id
BE 权限矩阵：仅 volunteer.audit → stats/overview 403；仅 volunteer.view → 200
BE 取消后重报：DELETE record → 再次 signup 201
```

### 6.4 复测结果

```text
后端全量        204 文件 / 2465 用例 PASS
前端单元        31 文件 / 246 用例 PASS
PC Playwright   10/10 PASS（含新增 volunteer/stats 路由冒烟）
志愿者 API 审计 NO_GAPS（新增「统计总览」「统计总览 worker 403」两项 PASS）
PC 资源         assets/index-B3NeEtM4.js（pilot base，构建脚本 build:pilot）
小程序          v5.9.24 预览码已生成
数据            4 工单 / 14 通知 / 3 账号 / 16 师傅；临时租户/活动 0
```

> 部署口径修正：pilot 必须使用 `npm run build:pilot`（`--base=/pilot/`），
> 普通 `npm run build` 产出根路径资源会导致 `/pilot/` 下 404。已按正确脚本重建并验证登录页可渲染。

## 七、签到二维码下载打印 + 直接签到漏洞（2026-11-14 第三轮）

### 7.1 问题 1：二维码只能看不能打印

**根因（展示层）**：签到二维码只在活动详情弹窗内以 120px 屏幕尺寸渲染（antd `QRCode`），
没有任何导出/打印通道；现场无法张贴，志愿者到岗后无码可扫，只能让管理员代签。

**修复**：
- 新增 `src/utils/volunteerQrPoster.ts`：把弹窗内二维码 canvas 合成为 900×1240 PNG 海报
  （活动标题 / 时间 / 地点 / 二维码 / 签到码 / 操作提示 / 张贴说明）；
- 详情弹窗新增「下载签到二维码」「打印」：下载为 PNG（可直接打印），打印走隐藏 iframe（不被弹窗拦截）；
- 发布活动成功后自动打开详情弹窗，二维码与下载/打印入口立即出现，不必再找「详情」。
- 失败不静默：二维码 canvas 未就绪 / 浏览器不支持 2d 画布 → 明确报错，不下载空图。

**实测（线上真实浏览器）**：

```text
下载文件  签到二维码_002_V68DB8553.png
大小      105,765 bytes
内容      标题 002 / 时间 / 地点 门诊 / 二维码 / 签到码 V68DB8553 / 小程序扫码提示
```

### 7.2 问题 2：报名后可直接点签到，绕过扫码

**根因（接口契约层）**：`POST /volunteer/records/:id/checkin` 对「报名本人」直接放行
（`assertVolunteerExec` 归属命中即 return），与 `POST /volunteer/checkin-by-code`（扫码）
构成两条自助签到路径。按钮路径没有任何「本人在现场」的证明，等于允许远程签到。

**修复（去掉双轨，而不是加一个判断）**：
- `POST /volunteer/records/:id/checkin` 收紧为仅 `volunteer.audit`（PC/小程序管理端现场代签）；
- worker 调用返回 `403 SCAN_REQUIRED`「请使用小程序扫描活动签到码签到」；
- worker 自助签到唯一通道 = `POST /volunteer/checkin-by-code`（必须持有活动签到码）；
- 小程序报名列表、活动详情移除「签到」按钮，改为「扫码签到」；
- 管理端（PC / 小程序管理页）保留「签到」操作，用于现场人工兜底。

**负控制**：

```text
worker 本人（归属命中）直接 checkin → 403 SCAN_REQUIRED，且无签到 UPDATE
worker 扫码 checkin-by-code         → 200（唯一合法自助通道不回退）
operator/admin 直接 checkin         → 200（现场代签保留）
仅 volunteer.view / audit 的权限矩阵回归不变
```

### 7.3 复测结果

```text
后端全量        204 文件 / 2467 用例 PASS
前端单元        32 文件 / 251 用例 PASS（新增海报导出 4 用例、详情二维码入口 1 用例）
PC Playwright   10/10 PASS
志愿者 API 审计 NO_GAPS（新增「worker 直接点签到 403 SCAN_REQUIRED」）
PC 资源         assets/index-B50zj8hU.js（build:pilot）
小程序          v5.9.25 预览码已生成
数据            4 工单 / 14 通知 / 3 账号 / 16 师傅；临时租户/活动 0
```

### 7.4 残余风险

1. 扫码签到证明「持有签到码」，无法证明「人在现场」——截图转发他人仍可代扫；
   如后续需要更强约束，应上地理围栏/蓝牙信标，而不是再开一条按钮通道；
2. 管理端「签到」是人工兜底，属于授权行为，需按现场管理规范使用。


