#!/usr/bin/env node
// E2 官方模板种子（V7 官方预置起步，解决冷启动）：预置 5 个行业运营包。
// 幂等：按 name 存在则跳过。直接连平台库（无 RLS 表），pool 用 youfu_app 即可（GRANT 已给）。
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'youfu',
  user: process.env.PGUSER || 'youfu_app',
  password: process.env.PGPASSWORD || 'change_me',
});

// 基础工作流 def（官方标准版；应用时覆盖为新版本，旧版进历史可回滚）
const WORK_ORDER_DEF = {
  initial: 'draft',
  states: ['draft', 'pending_dispatch', 'assigned', 'processing', 'pending_review', 'completed', 'cancelled'],
  transitions: [
    { from: 'draft', to: 'pending_dispatch', event: 'submit', allowedRoles: ['admin', 'operator', 'dispatcher'] },
    { from: 'pending_dispatch', to: 'assigned', event: 'assign', allowedRoles: ['admin', 'dispatcher'] },
    { from: 'assigned', to: 'processing', event: 'accept', allowedRoles: ['worker'] },
    { from: 'processing', to: 'pending_review', event: 'resolve', allowedRoles: ['worker'], requiredFields: ['remark'] },
    { from: 'pending_review', to: 'completed', event: 'close', allowedRoles: ['admin', 'operator'] },
    { from: 'draft', to: 'cancelled', event: 'cancel', allowedRoles: ['admin', 'operator'] },
  ],
  config: {
    name: '标准报修工单',
    fields: [
      { key: 'priority', label: '优先级', type: 'select', options: ['normal', 'urgent', 'emergency'] },
      { key: 'location', label: '位置', type: 'text', required: true },
    ],
  },
};
const INSPECTION_DEF = {
  initial: 'scheduled',
  states: ['scheduled', 'checked', 'missed', 'exception'],
  transitions: [
    { from: 'scheduled', to: 'checked', event: 'checkin', allowedRoles: ['worker'], requiredFields: ['result'] },
    { from: 'scheduled', to: 'exception', event: 'exception', allowedRoles: ['worker'] },
  ],
  config: { name: '标准巡检', fields: [{ key: 'result', label: '检查结果', type: 'select', options: ['pass', 'fail'] }] },
};
const TRANSPORT_DEF = {
  initial: 'pending',
  states: ['pending', 'transporting', 'done', 'exception'],
  transitions: [
    { from: 'pending', to: 'transporting', event: 'start', allowedRoles: ['worker'] },
    { from: 'transporting', to: 'done', event: 'complete', allowedRoles: ['worker'] },
  ],
  config: { name: '标准运送', fields: [{ key: 'destination', label: '目的地', type: 'text', required: true }] },
};
const EMERGENCY_DEF = {
  initial: 'activated',
  states: ['activated', 'processing', 'resolved', 'cancelled'],
  transitions: [
    { from: 'activated', to: 'processing', event: 'dispatch', allowedRoles: ['admin', 'dispatcher'] },
    { from: 'processing', to: 'resolved', event: 'resolve', allowedRoles: ['worker'] },
  ],
  config: { name: '标准应急', fields: [{ key: 'level', label: '等级', type: 'select', options: ['low', 'medium', 'high'] }] },
};

const TEMPLATES = [
  {
    name: '医院报修标准运营包',
    category: 'hospital',
    entity_type: 'work_order',
    description: '医院后勤报修标准流程：建单→派单→处理→复核→闭环；含优先级/位置字段与 SLA（响应2h/完成24h）。',
    playbook: {
      workflow_def: WORK_ORDER_DEF,
      default_fields: { priority: 'normal' },
      sla: { response_hours: 2, complete_hours: 24 },
      dispatch: { strategy: 'least_load' },
      terms: { '报修': '工单', '维修': '处理' },
      report: { kpis: ['close_rate', 'overdue_rate', 'satisfaction'] },
    },
  },
  {
    name: '学校巡检标准运营包',
    category: 'school',
    entity_type: 'inspection_task',
    description: '学校设施巡检：排期→打卡→合格/异常；支持检查项与结果记录。',
    playbook: {
      workflow_def: INSPECTION_DEF,
      default_fields: {},
      sla: { response_hours: 24, complete_hours: 72 },
      dispatch: { strategy: 'manual' },
      terms: { '巡查': '巡检' },
      report: { kpis: ['checked_rate', 'missed_count'] },
    },
  },
  {
    name: '物业运送标准运营包',
    category: 'property',
    entity_type: 'transport_task',
    description: '物业物资运送：接单→运送→送达；目的地必填。',
    playbook: {
      workflow_def: TRANSPORT_DEF,
      default_fields: {},
      sla: { response_hours: 1, complete_hours: 4 },
      dispatch: { strategy: 'least_load' },
      terms: { '搬': '运送' },
      report: { kpis: ['done_rate'] },
    },
  },
  {
    name: '市政应急标准运营包',
    category: 'municipal',
    entity_type: 'emergency_plan',
    description: '市政突发事件应急：启动→处置→结案；等级分级。',
    playbook: {
      workflow_def: EMERGENCY_DEF,
      default_fields: { level: 'medium' },
      sla: { response_hours: 1, complete_hours: 48 },
      dispatch: { strategy: 'manual' },
      terms: { '突发': '应急' },
      report: { kpis: ['resolve_hours'] },
    },
  },
  {
    name: '酒店客诉标准运营包',
    category: 'hotel',
    entity_type: 'work_order',
    description: '酒店宾客诉求闭环：登记→分派→处理→回访；满意度必评。',
    playbook: {
      workflow_def: WORK_ORDER_DEF,
      default_fields: { priority: 'normal' },
      sla: { response_hours: 0.5, complete_hours: 8 },
      dispatch: { strategy: 'least_load' },
      terms: { '投诉': '客诉' },
      report: { kpis: ['satisfaction', 'close_rate'] },
    },
  },
];

async function main() {
  let created = 0, skipped = 0;
  for (const t of TEMPLATES) {
    const ex = await pool.query(`SELECT id FROM platform_template WHERE name = $1`, [t.name]);
    if (ex.rowCount > 0) { skipped++; continue; }
    await pool.query(
      `INSERT INTO platform_template (name, category, entity_type, description, playbook, created_by)
       VALUES ($1,$2,$3,$4,$5,'seed')`,
      [t.name, t.category, t.entity_type, t.description, JSON.stringify(t.playbook)],
    );
    created++;
    console.log('created:', t.name);
  }
  console.log(`done: created=${created} skipped=${skipped}`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
