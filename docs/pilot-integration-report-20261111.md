# 全业务流程集成测试报告（2026-11-11）

## 1. 方式

使用**独立 UAT 租户**，不碰真实 `zixing-hospital` 数据：

```text
租户：uat-full-<run>
部门：UAT后勤（默认）
师傅：UAT-W-<run>（唯一技能，避免命中真实师傅）
分类：UAT全流程-<run>
流程：从真实租户复制 workflow_def(work_order)
```

测试结束删除整个 UAT 租户、账号、人员、分类、流程定义、工单、通知、上传目录。

## 2. 跑通链路

```text
公开报修（带照片）
→ 自动归属 UAT后勤 / 自动派单 UAT 师傅
→ 我的报修 token 查询 / 公开状态查询
→ 师傅读单
→ 到场 → 开始处理
→ 上传现场照片 + 录音 + 保存现场备注
→ 公开 token 读取照片/录音
→ 挂起（无原因 422）→ 挂起（带原因 200）→ 恢复
→ 提交复核
→ worker 复核通过 403 / worker 取消 403
→ admin 驳回
→ 师傅再次提交复核
→ admin 复核通过
→ 完成 → 关闭 → 评价 5 分
→ 最终状态/满意度/部门/照片/录音/备注/事件/通知核对
→ 公开“我的报修”显示 evaluated
```

## 3. 实测结果

```text
[full] public report WO_20261111_3566468590 → UAT-W-fmwc723s739d7
[full] final WO_20261111_3566468590 status=evaluated score=5 events=14 notifications=1
[full] PASS tenant=uat-full-fmwc723s739d7 order=WO_20261111_3566468590
```

断言通过：

- 公开报修 201，自动派给 UAT 师傅；
- 公开查询 / 公开状态 200；
- 师傅列表/详情可见；
- 到场、开始、挂起、恢复、提交复核全部 200；
- 挂起无原因 422；
- worker 复核/取消 403；
- admin 驳回/通过/完成/关闭/评价 200；
- 最终 `evaluated`，满意度 5；
- `ext.attachments`、`ext.photos`、`ext.voice`、`feedback_note` 均落库；
- 照片/录音 token 读取 200；
- 事件时间线 14 条；
- 通知记录 1 条；
- 公开“我的报修”最终显示 `evaluated`。

## 4. 清理结果

```text
UAT 租户：0
UAT 工单：0
UAT 账号：0
UAT 人员：0
UAT 上传目录：已删除
真实 pilot 工单：4（3 张真实 + 1 张 24h soak 临时单，未改动）
```

## 5. 运行

```bash
cd /opt/youfu/pilot/backend
PGDATABASE=youfu_pilot ENV_FILE=.env \
  /opt/node16/bin/node scripts/pilot-full-business-e2e.mjs
```

默认走公网 `https://youfu.banerz.cn/pilot/api/v1`；本机调试可设：

```bash
PILOT_API_BASE=http://127.0.0.1:4101/api/v1
```

## 6. 结论

主流程已从公开报修一路跑到评价闭环，且隔离租户清理干净。  
剩余未覆盖的是**真实微信通知到达**和**真机 UI**，由 UAT 清单覆盖。
