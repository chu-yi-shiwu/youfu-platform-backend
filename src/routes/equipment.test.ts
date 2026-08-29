// 设备模块回归测试：锁定 F1/F2 修复——仅插入「已提供且非空」的列，
// 让 DB 的 NOT NULL DEFAULT（如 equipment.status 默认 'in_use'）生效，
// 避免对 status 等 NOT NULL 列强行写 NULL 触发 23502。
// 不依赖真实数据库（仅测纯函数 resolveInsertColumns，确定性）。
import { describe, it, expect } from 'vitest';
import { resolveInsertColumns } from './equipment.js';

// 与 equipment.ts 中 equipment 类型对齐的最小 TypeDef（仅校验列计算逻辑）
const equipmentDef = {
  table: 'equipment',
  columns: ['id', 'tenant_id', 'name', 'code', 'type_id', 'status', 'remark'],
  insertCols: ['name', 'code', 'type_id', 'status', 'remark'],
  fields: [],
  schema: {} as any,
} as const;

describe('resolveInsertColumns (F1/F2 修复回归)', () => {
  it('CSV 省略 status 时应排除 status 列（让 DB NOT NULL DEFAULT 生效，不再 23502）', () => {
    // 模拟 CSV 导入：status 列未出现在表头 → obj 中无 status
    const cols = resolveInsertColumns(equipmentDef as any, { name: '3F 中央空调', code: 'AC-01' });
    expect(cols).toContain('name');
    expect(cols).toContain('code');
    expect(cols).not.toContain('status'); // 关键：不能把 status 写成 NULL
  });

  it('POST 显式提供 status 时应保留 status 列', () => {
    const cols = resolveInsertColumns(equipmentDef as any, {
      name: '3F 中央空调',
      status: 'in_use',
    });
    expect(cols).toContain('status');
  });

  it('CSV 空字符串状态应被排除（避免写入非法空值）', () => {
    const cols = resolveInsertColumns(equipmentDef as any, {
      name: '风机',
      status: '',
      remark: '',
    });
    expect(cols).toContain('name');
    expect(cols).not.toContain('status');
    expect(cols).not.toContain('remark');
  });

  it('所有列都提供时全部保留', () => {
    const cols = resolveInsertColumns(equipmentDef as any, {
      name: '风机',
      code: 'F-01',
      type_id: 't1',
      status: 'in_use',
      remark: '备注',
    });
    expect(cols.sort()).toEqual(['code', 'name', 'remark', 'status', 'type_id'].sort());
  });
});
