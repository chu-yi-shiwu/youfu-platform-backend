# 日期格式问题根因修复（2026-11-14）

## 现象

工单管理列表「创建时间」仍显示：

```text
2026-11-11T14:16:30.190Z
```

## 根因

不是 `fmtDateTime` 没写，而是工单列表的「显示设置」动态列重建丢失了 `render`：

```text
buildAllColumns() 里 created_at 有 render: fmtDateTime
→ 按 visibleKeys 重建列时，兜底分支只复制了 title/dataIndex/key
→ render 被丢掉
→ antd 直接渲染原始 created_at 字符串
```

所以上一轮只改基础列定义时，页面看起来仍然没修。

## 修复

`TicketList.tsx` 动态列兜底改为保留整列定义：

```ts
return {
  ...c,
  title: c.title,
  dataIndex: (c.dataIndex as string) || c.key,
  key: c.key,
} as any;
```

这样 `render`、`getExport`、`exportable` 等都不会再被动态列重建吞掉。

## 回归测试

1. 单元测试：`TicketList.test.tsx`
   - 断言创建时间渲染为 `2026/1/1` 本地化格式；
   - 断言页面不出现 `2026-01-01T10:00:00Z`。
2. 线上 Playwright：`e2e/ticket-list-date.spec.ts`
   - 真实 admin 登录 → 工单列表；
   - 断言表格正文不含任何 `YYYY-MM-DDTHH:mm:ss` ISO 裸串；
   - 断言存在 `2026/..` 或 `2026-..` 本地日期。
3. 全模块页面冒烟：`pilot-modules-pages.spec.ts`
   - 13 个模块页面逐个断言不出现 ISO 裸时间。

## 验证结果

```text
前端 tsc / build        PASS
前端单元                30 文件 / 242 用例 PASS
PC Playwright           10/10 PASS
后端全量                204 文件 / 2457 用例 PASS
PC 部署                 assets/index-BtCo3iMI.js
pilot 服务              active，/health/ready 200
数据                    4 工单 / 14 通知 / 3 账号 / 16 师傅
临时租户/师傅           0
```

线上工单列表现在显示形如：

```text
2026/11/11 22:16:30
```

## 其他日期检查

本轮同时复核：

- 资产列表/详情、维保日期：`fmtDate`；
- 设备列表购置日期：`fmtDate`；
- 巡检/巡更/运送/志愿者/反馈/结算/基础数据：本地化时间；
- CSV 导出：日期 `YYYY-MM-DD`，时间 `YYYY-MM-DD HH:mm:ss`；
- 13 个模块页面冒烟：无 ISO 裸时间。
