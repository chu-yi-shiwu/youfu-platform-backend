// 模块目录（单一事实源）：模块 = 管理面能力开关，不是权限点。
// 角色权限仍由 role_permission 控制接口安全；模块只控制 PC 管理端菜单/页面与对应管理写入。
// 移动端个人任务执行（接单/巡检/巡更/运送/志愿报名签到）永不套用模块门禁。
export interface ModuleDef {
  key: string;
  label: string;
  description: string;
}

export const MODULE_DEFS: readonly ModuleDef[] = [
  { key: 'work_order', label: '工单管理', description: '工单列表、详情、派单与流转管理（不影响移动端接单执行）' },
  { key: 'settlement', label: '结算管理', description: '结算单、验收与导出' },
  { key: 'inspection', label: '巡检管理', description: '巡检点位、项目、计划与统计（移动端巡检任务不受限）' },
  { key: 'patrol', label: '巡更管理', description: '巡更点位与任务编排（移动端巡更执行不受限）' },
  { key: 'volunteer', label: '志愿者活动', description: '志愿活动、积分与黑名单管理（移动端报名/签到不受限）' },
  { key: 'monitor', label: '网管监控', description: '监控设备与告警配置' },
  { key: 'transport', label: '运送管理', description: '运送任务创建与调度（移动端运送执行不受限）' },
  { key: 'asset', label: '资产管理', description: '资产台账、处置、盘点与导入导出（扫码查询不受限）' },
  { key: 'material', label: '耗材管理', description: '耗材目录、库存与出入库（工单领料不受限）' },
  { key: 'equipment', label: '设备管理', description: '设备档案、维保与厂商主数据' },
  { key: 'emergency', label: '应急预案', description: '应急预案知识库与预警配置（移动端预警处置不受限）' },
  { key: 'analytics', label: '数据分析', description: '数据大屏与统计分析' },
  { key: 'optimize', label: '自适应优化', description: '流程优化建议、影子回放与自动调参' },
  { key: 'configuration', label: '业务规则配置', description: '业务流程、派单规则、术语与系统配置' },
  { key: 'foundation', label: '基础数据', description: '部门、区域、供应商、字典等主数据' },
  { key: 'system', label: '系统管理', description: '账号、角色与平台管理入口' },
  { key: 'feedback', label: '需求反馈', description: '需求反馈处理与导出' },
] as const;

export const MODULE_KEYS: readonly string[] = MODULE_DEFS.map((m) => m.key);

const MODULE_KEY_SET = new Set<string>(MODULE_KEYS);

export function isModuleKey(key: string): boolean {
  return MODULE_KEY_SET.has(key);
}

export function moduleLabel(key: string): string {
  return MODULE_DEFS.find((m) => m.key === key)?.label ?? key;
}
