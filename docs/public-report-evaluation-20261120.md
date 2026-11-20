# 公共报修本人评价 · 2026-11-20

## 1. 问题

公共报修由未登录用户提交，`work_orders.created_by` 为空；原有评价强制 `work_order.created_by === 当前用户`，因此公共报修人无法评价。

## 2. 方案

复用建单时已下发的 `public_view_token` 作为本人凭证，不新增表、不伪造账号。

### 后端

新增公开端点：

`POST /api/v1/public/evaluate-report`

请求：

```json
{ "org": "tenant-id", "token": "public_view_token", "score": 5, "comment": "选填" }
```

校验链：

1. `org` 必须是 `tenant_registry.status='active'`；
2. token 必须命中 `work_orders.ext->>'public_view_token'`；
3. 工单必须是 `source='public_report'` 或 `ext.source_channel='public_report'`；
4. 按工单 `def_version` 读取锁定工作流（缺失 fail-closed）；
5. 当前状态必须存在 `event='satisfy'` 的合法边，否则 `422 NOT_EVALUABLE`；
6. 通过 `transition()` 走标准评价流转，写入 `satisfaction_score`；
7. 调用共享 `finalizeTransitionSideEffects()`：增量学习、评价自动结算、资产维修状态回写；
8. 可选评价备注写入 `ext.satisfaction_comment`；
9. 评价后状态离开可评价态，重复评价自然返回 `422 NOT_EVALUABLE`。

安全边界：

- token 为 24 字节随机数（48 hex），不可枚举；
- 限流 20 次/分钟；
- 只能评价公共报修单，内部工单即使有查看 token 也返回 404；
- 不返回其他租户/工单信息。

### 小程序

「我的报修」列表：

- `completed/closed` 显示「评价服务」；
- 点击后 action sheet 选 1–5 分，再弹可选备注；
- 提交调用 `POST /public/evaluate-report`；
- `evaluated` 显示「已评价 N 分」并隐藏评价入口。

`my-reports` 返回新增 `satisfaction_score`，用于已评价展示。

## 3. 复用与重构

将流转后的副作用从 `routes/workOrder.ts` 提取为：

`finalizeTransitionSideEffects(client, tenantId, workOrderId, to, from)`

通用流转端点与公共评价端点共用，避免两套学习/结算/资产回写口径漂移。

## 4. 验证

| 项 | 结果 |
| --- | --- |
| 后端全量 | **219 文件 / 2608 用例通过** |
| publicReport 专项 | **21 / 21 通过** |
| 小程序测试 | **38 / 38 通过** |
| 小程序绑定自检 | 10 页全部通过，38 页无孤儿 |
| 隔离租户 live 验收 | **5 / 5 PASS** |

live 覆盖：

- 公共报修建单拿到 `view_token`；
- 工单置 `closed`；
- token 评价 5 分成功；
- DB 落库 `status=evaluated / score=5 / comment`；
- 重复评价 422。

## 5. 上线注意

- 后端已部署；小程序代码已改，需要按既有微信开发者工具流程上传/发布后才能在前端看到评价入口。
- 生产租户已有 `workflow_def`；无定义的租户回退 DEFAULT 不含 `closed→evaluated`，评价会安全返回 `422 NOT_EVALUABLE`，不会写坏数据。
