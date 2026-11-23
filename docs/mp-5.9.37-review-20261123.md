# 主站小程序 5.9.37 审核提交单（2026-11-23）

## 1. 当前状态

| 项 | 值 |
| --- | --- |
| AppID | `wxb99197ac59cfa519` |
| 版本 | `5.9.37` |
| 小程序代码 commit | `8ca056db0e94b34c76c110f19162a4daeb9636f2` |
| manifest digest | `553ac0eb5cc1d6e9f0eb64da26d596c91925b931dea0372ab27c5a3fdf107331` |
| manifest 文件数 | 230 |
| manifest 字节数 | 1,188,434 |
| 小程序测试 | 42 / 42 PASS |
| 开发版上传 | 2026-11-23 12:15，已进「开发版本」 |
| 预览二维码 | `preview_qr_v5937.png` |
| `wx.getLocation` | 2026-11-23 显示“已开通” |
| `wx.chooseLocation` | `requiredPrivateInfos` 已声明；接口权限待微信后台申请（弹窗：接口无权限） |
| 审核提交 | **待 `wx.chooseLocation` 权限通过后提交 5.9.37** |
| 生产发布 | 审核通过后发布 |

> 5.9.36 不再提交。5.9.36 的 `app.json` 只声明了 `getLocation`，但通用表单地点字段实际调用 `wx.chooseLocation`，审核弹窗会提示“接口未正确配置：wx.chooseLocation（暂无权限）”。5.9.37 已修复该根因。

## 2. 本次修复

- 代码调用面：`components/field-renderer/field-renderer.js` 的 `onLocation` 使用 `wx.chooseLocation`；
- 修复前：`app.json` 的 `requiredPrivateInfos` 只有 `["getLocation"]`；
- 修复后：`requiredPrivateInfos: ["getLocation", "chooseLocation"]`；
- 版本门禁新增两条断言：代码存在 `wx.chooseLocation` 调用面、`app.json` 必须声明 `chooseLocation`；
- 位置用途不变：巡检签到、运送轨迹上报、现场地点选择，均用于工单履约留痕。

## 2.1 第二次审核阻塞：`wx.chooseLocation` 接口权限

5.9.37 已正确声明 `requiredPrivateInfos`，但提交审核时微信仍弹出：

```text
接口无权限
app.json文件中部分接口暂无权限，请删除接口，或前往
「微信公众平台 > 开发管理 > 接口设置」申请相关权限。
暂无权限接口：wx.chooseLocation
```

处理路径：

1. 点弹窗里的「去申请」；
2. 或进入「开发管理 → 接口设置」；
3. 找到地理位置相关接口中的 `wx.chooseLocation`；
4. 提交申请理由（可直接用下面文案）；
5. 权限通过后回到「版本管理 → 开发版本 → 5.9.37 → 提交审核」。

申请理由建议：

```text
用于现场人员在通用业务表单中选择服务地点、设备位置或客户地址，
便于工单履约、到达证明和后续统计。仅在用户主动点击地点字段时打开地图选择，
不进行后台持续定位，不采集与业务无关的位置。
```

注意：不要为过审删除 `wx.chooseLocation` 或 `wx.getLocation` 调用；地点选择是通用表单的真实生产能力。

## 3. 为什么必须在后台页面提交

普通小程序（非第三方平台代开发）不能直接调用审核提交接口：

```text
wxa/get_auditstatus      -> 86000 should be called only from third party
wxa/get_latest_auditstatus -> 86000 should be called only from third party
wxa/get_page             -> 86000 should be called only from third party
```

`wxa/get_category` 可读，当前后台返回的类目包括：

- 商业服务 / 软件/建站/技术开发（first_id=402，second_id=1273）
- 工具 / 设备管理（first_id=287，second_id=1255）

提交时以微信后台当前已配置类目为准，不在代码里硬编码。

## 4. 提交路径

1. 打开 `https://mp.weixin.qq.com/`，用管理员微信扫码登录；
2. 进入对应小程序；
3. 左侧「管理」→「版本管理」；
4. 在「开发版本」找到 `5.9.37`（上传时间 2026-11-23 12:15）；
5. 点「提交审核」；
6. 如果仍弹出 `wx.chooseLocation` 接口无权限，点「去申请」并开通 `wx.chooseLocation`，通过后再提交；不要删除接口绕过；
7. 按后台表单确认类目、标签、页面路径、截图/视频和审核说明；
8. 提交后记录审核编号、提交时间和当前状态。

## 5. 审核说明建议

```text
本次更新优化工单处理流程：管理端统一工单派发、催办、统计和部门筛选；
师傅端保留接单、到场、处理、完成等现场执行能力；修复统计口径和消息提醒。
位置权限仅用于巡检点签到、运送任务轨迹上报、现场地点选择和到达证明；
用户主动签到时获取一次位置，不做后台持续定位；位置数据仅用于工单履约留痕。
```

## 6. 审核关注点

- `app.json` 已声明 `requiredPrivateInfos: ["getLocation", "chooseLocation"]` 与 `scope.userLocation`；
- 不允许为过审删除巡检签到/运送轨迹/地点选择依赖的位置接口；
- 审核员如需测试账号，使用体验版已验证账号，账号密码不写入仓库；
- 5.9.37 与 pilot 包共用 AppID，体验版/正式版互斥；当前不再回到 pilot 包；
- 审核通过后先发布正式版，再复核 `/pilot/api`、登录、工单列表、通知回执。

## 7. 提交后记录模板

```text
提交时间：
审核编号：
审核状态：
审核结果/驳回原因：
发布时间：
发布后复核：
  - 主站登录：
  - 工单列表：
  - 师傅执行面：
  - 微信通知：
  - 主 API 5xx：
```
