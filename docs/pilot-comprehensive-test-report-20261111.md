# 真实 pilot 全面测试报告（2026-11-11）

## 1. 测试范围

- 真实租户 `zixing-hospital`；
- 真实师傅账号 `17773639019`（HQ016）；
- PC、公开报修 API、小程序预览码、真实微信通知记录；
- 功能、集成、权限、媒体、安全、性能、备份恢复、数据完整性；
- 排除：H5、结算、巡检、运送、资产、志愿者、AI 功能。

## 2. 备份与回滚

```text
DB：/opt/youfu/backup/pilot-pre-fulltest-20261111-224058.dump（2.1MB）
上传目录：/opt/youfu/backup/pilot-uploads-pre-fulltest-20261111-224058.tar.gz（420KB）
```

## 3. 测试结果总览

| 项目 | 结果 |
| --- | --- |
| 后端单元/集成 | 203 文件 / 2449 用例 PASS（最终回归） |
| 前端单元 | 30 文件 / 238 用例 PASS |
| PC Playwright | 9 用例 PASS |
| 角色 × 动作 E2E | PASS |
| 媒体回环 E2E | PASS |
| 安全 E2E | PASS |
| 真实账号全流程 | PASS（站内通知；微信 43101） |
| 性能验收（关闭 AI embedding） | PASS |
| 1000 条列表 | PASS |
| 5MB 并发上传 | PASS |
| 备份恢复演练 | PASS |
| 数据完整性 | 孤儿事件/通知 0 |

## 4. 真实账号全流程

测试单：`WO_20261111_1142940505`（已清理）。

```text
建单 → 派给 HQ016 → 到场 → 开始
→ 照片/录音/备注 → 提交复核
→ worker 越权复核/取消 403
→ admin 驳回 → 再提交 → admin 通过
→ 完成 → 关闭 → 评价 5
```

结果：

```text
[real] PASS order=WO_20261111_1142940505 status=evaluated score=5
notifications:
  in_app worker delivered=true  ×2
  wechat worker delivered=false ×2
```

微信未送达原因：`43101 user refuse to accept the msg`（一次性订阅未授权）。

### 小程序「开启通知」入口修复

原工作台只在 `!wxBound || showSubscribeGuide` 时显示授权提示；绑定过或之前弹过授权后，入口会隐藏。已在工作台底部工具栏新增常驻「开启通知」入口，点击后重新发起一次性订阅授权并自检。

## 5. 性能结果

### 关键发现：AI embedding 是建单性能瓶颈

在 AI embedding 开启时：

- 20 单/10 并发，建单 p95 约 **6~7s**；
- 出现数据库连接池超时，`POST /open/work_order` 返回 **500**；
- 日志：`timeout exceeded when trying to connect`。

AI 功能本轮已排除。临时关闭 `EMBEDDING_API_KEY` 后，同一环境：

| 场景 | 并发 | 成功率 | p50 | p95 | p99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 建单 20 单 | 10 | 100% | 107.9ms | **153.5ms** | 171.1ms |
| 建单 50 单 | 50 | 100% | 466.5ms | **657.9ms** | 666.3ms |
| 列表 limit=100 | 20 轮 | 100% | 6.9ms | 8.4ms | 15.0ms |
| 详情 | 20 轮 | 100% | 4.7ms | 6.4ms | 8.5ms |
| 工作台 | 10 轮 | 100% | 10.5ms | 14.1ms | 14.1ms |
| 1MB 上传 | 5 | 100% | 8.8ms | 19.4ms | 19.4ms |

50 并发派单分布：5 个临时师傅分别 20/9/9/6/6，未出现单行锁死。

测试结束后已恢复原 `EMBEDDING_API_KEY`，生产配置未变。

**结论**：核心报修流程本身满足 SLO；AI embedding 与请求共用连接池/资源，开启时会拖垮建单并产生 500。建议 pilot 关闭 embedding，或将 AI 任务移到独立队列/连接池。

### 1000 条列表

| 场景 | p50 | p95 |
| --- | ---: | ---: |
| 首页 limit=100 | 20.4ms | 28.3ms |
| 深分页 offset=900 | 19.5ms | 23.0ms |
| offset=800 limit=200 | 22.7ms | 24.9ms |
| 工作台 | 21.7ms | 34.6ms |

### 5MB 上传

```text
本机 5 并发 4.9MB：p95 319.2ms
5MB+1：413 TOO_LARGE
公网单张 4.9MB：约 8.5s（ECS 公网带宽瓶颈）
```

## 6. 备份恢复

```text
恢复耗时：约 2 秒
行数比对：dept/location_dict/fault_category/worker/contact/work_orders/
          account_user/role_permission/ticket_event/notification 全部一致
RLS 策略：84 = 84
抽查：默认部门 1、联系人 178、工单 4
临时库已删除，未触碰 pilot
```

## 7. 数据完整性

```text
默认部门 1
人员/工单引用悬空 0
重复工单号 0
重复 public_view_token 0
非法状态 0
孤儿 ticket_event 0
孤儿 notification 0
联系人空电话/重复 0
活跃工单缺 SLA 0
```

## 8. 当前数据状态

```text
真实工单：3 完成 + 1 取消 = 4
24h soak 临时单：1（运行中，带 perf_run 标记）
账号：admin / operator / 17773639019
临时测试账号/人员/上传文件：已清理
```

24h soak：

```text
PID：20268
日志：/opt/youfu/pilot/logs/soak-24h-final-20261111-230509.log
模式：1 单 + 1 rps 列表读，24h
```

## 9. 功能模块开放

pilot 已开放主站除「网管监控」「运送管理」外的全部菜单模块：

```text
结算 / 巡检 / 巡检计划 / 巡更 / 志愿者 / 资产 / 耗材 / 设备
应急预案 / 数据大屏 / 统计分析 / 自适应优化 / 体验用户 / 移动入口
```

验证：菜单可见性、直接访问 `/monitor` `/transport` 重定向、各模块页面冒烟均通过。  
详见 `docs/pilot-module-expansion-20261111.md`。

## 10. 待处理事项

1. **微信真实送达**：需要师傅在 pilot 小程序工作台点一次「开启通知」，然后重新跑真实派单通知；当前 43101。
2. **AI/embedding 生产配置**：建议 pilot 关闭或隔离 embedding；当前已恢复原配置。
3. **真机 UAT**：iPad / HarmonyOS 微信按 `docs/pilot-uat-checklist-20261111.md` 走查；预览码需现场重新生成。
4. **联系人手机号脱敏**：本轮测试证据未输出手机号；生产联系人数据未修改。若要求界面脱敏，需确认规则。
