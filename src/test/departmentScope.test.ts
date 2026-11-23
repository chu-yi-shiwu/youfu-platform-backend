// 部门筛选参数契约：所有统计/过程挖掘端点共用同一解析器，避免某个端点静默忽略互斥参数。
import { describe, expect, it } from 'vitest';
import { parseDepartmentScope } from '../routes/departmentScope.js';

describe('parseDepartmentScope', () => {
  it('department_id 优先于旧别名 department', () => {
    expect(parseDepartmentScope({ department_id: 'a', department: 'b' })).toEqual({
      departmentId: 'a',
      departmentUnassigned: false,
    });
  });

  it('兼容旧别名 department', () => {
    expect(parseDepartmentScope({ department: 'b' })).toEqual({
      departmentId: 'b',
      departmentUnassigned: false,
    });
  });

  it('department_unassigned 支持 1/true，其他值不生效', () => {
    expect(parseDepartmentScope({ department_unassigned: '1' }).departmentUnassigned).toBe(true);
    expect(parseDepartmentScope({ department_unassigned: 'true' }).departmentUnassigned).toBe(true);
    expect(parseDepartmentScope({ department_unassigned: '0' }).departmentUnassigned).toBe(false);
    expect(parseDepartmentScope({ department_unassigned: 'yes' }).departmentUnassigned).toBe(false);
  });

  it('空字符串不视为有效部门', () => {
    expect(parseDepartmentScope({ department_id: '', department: '' })).toEqual({
      departmentId: undefined,
      departmentUnassigned: false,
    });
  });

  it('部门与未分配互斥：同时传必须 400，不能静默只取一个', () => {
    let caught: unknown;
    try {
      parseDepartmentScope({ department_id: 'a', department_unassigned: '1' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: string }).code).toBe('BAD_PARAM');
    expect((caught as { status?: number }).status).toBe(400);
  });
});
