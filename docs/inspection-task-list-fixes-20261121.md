# 巡检/任务列表/工作台统计修复 · 2026-11-21

## 1. 水印上传失败（缺少机构）

### 根因

`inspection.js` 从 `auth.getUser().tenant` 取机构，但登录返回的用户字段是 `tenant_id`；`DEFAULT_ORG` 又可能为空，最终 `/public/upload?org=` 为空，后端返回“缺少机构”。

### 修复

- 新增 `_syncOrg()`：`youfu_mp_org` 缓存 → `user.tenant_id` → `user.tenant` → `DEFAULT_ORG`；
- `onLoad` / `onShow` 都同步机构；
- `uploadMedia(org,...)` 增加空机构前置拒绝，避免请求到后端才报错；
- 水印上传前再次校验，提示“返回首页重新选择机构或重新登录”。

## 2. 巡检完成后还能改结果

### 根因

- 后端 `POST /inspection/tasks/:id/records` 只查任务存在与执行人，没有校验状态；
- 前端检查项卡片与“保存检查结果”按钮没有按 `done/exception` 隐藏。

### 修复

- 后端：状态不是 `pending/in_progress` 时返回 `409 TASK_CLOSED`，不写 `inspection_record`；
- 前端：`editable = status in (pending,in_progress)`；
- 检查项卡片、保存按钮、水印、异常、完成、更多菜单在终态均不可用；
- 新增后端负控制测试：完成后 POST records 必须 409 且不写记录；
- 新增巡检页测试：完成后不调用保存接口。

## 3. 已完成排序与类型混淆

### 修复

- `_split()` 对在办/已完成统一按 `completed_at || done_at || updated_at || created_at` 倒序；
- 已完成卡片显示完成时间；
- 类型徽标区分：维修 / 巡检 / 运送 / 能耗，分别使用不同颜色；
- 增加类型筛选：全部 / 维修 / 巡检 / 运送 / 能耗。

## 4. 日期与状态筛选

- 状态：保留“在办 / 已完成”Tab；
- 日期：新增 全部 / 今天 / 近 7 天 / 近 30 天 筛选；
- 类型：新增 全部 / 维修 / 巡检 / 运送 / 能耗；
- Tab 数量显示筛选前总数，列表显示筛选后结果。

## 5. 工作台“今日完成”统计

### 根因

- `done_count` 是累计完成，却被显示为“今日完成”；
- 没有按 `completed_at` 的本地日界计算今日完成。

### 修复

后端 `/open/me/summary` 新增：

```sql
COUNT(*) FILTER (
  WHERE status = ANY(doneSet)
    AND completed_at IS NOT NULL
    AND (completed_at AT TIME ZONE 'Asia/Shanghai')::date
      = (now() AT TIME ZONE 'Asia/Shanghai')::date
) AS today_done
```

- `today_new` 同样使用 `Asia/Shanghai` 本地日界；
- 小程序工作台“今日完成”改读 `stats.today_done`；
- “我的任务”副标题改为“累计完成”，不再与今日完成混淆；
- 工作台 `onShow` 仍然每次刷新，完成返回后统计会更新。

## 6. 验证

| 项 | 结果 |
| --- | --- |
| 后端全量 | **219 文件 / 2609 用例通过** |
| 后端专项 | inspection 37 / statusVocab 6 |
| 小程序 pilot | **39 / 39** + 绑定自检 |
| 小程序主站 | **38 / 38** + 绑定自检 |
| live 今日完成 | **PASS**：done=2、today_done=1（3 天前完成不计入今天） |
| pilot 版本 | **5.9.29** 已上传开发版本，预览码 `preview_qr_v5929.png` |

## 7. 发布状态

- 后端已部署主站/pilot，readiness 正常；
- pilot 小程序 5.9.29 已上传开发版本，需在微信后台点「设为体验版」；
- 主站小程序代码已同步修复并通过测试，但主站版本号未改、未上传生产；
- pilot 测试已修正为测试当前项目（此前部分测试硬编码主站目录）。
