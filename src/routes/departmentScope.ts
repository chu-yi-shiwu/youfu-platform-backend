// 部门筛选查询参数的唯一解析实现。
//
// 为什么要单独一层：/stats/overdue、/stats/workbench、/stats/worker-load-drift、
// /process-mining 都接受 department_id / department_unassigned。历史上每个路由
// 各写一遍 qstr + 互斥校验，结果只有部分端点校验互斥，前端传错时一个接口按部门、
// 另一个接口静默忽略。这里把"参数名、互斥、空值"收口成一份契约。
import { AppError } from '../middleware/error.js';

export interface DepartmentScopeQuery {
  departmentId?: string;
  departmentUnassigned: boolean;
}

export function parseDepartmentScope(query: Record<string, unknown>): DepartmentScopeQuery {
  const read = (key: string): string | undefined => {
    const value = query[key];
    return typeof value === 'string' && value ? value : undefined;
  };
  // department 是兼容旧前端/脚本的别名；新代码统一用 department_id。
  const departmentId = read('department_id') ?? read('department');
  const departmentUnassigned =
    query.department_unassigned === '1' || query.department_unassigned === 'true';
  if (departmentId && departmentUnassigned) {
    throw new AppError('BAD_PARAM', 'department_id 与 department_unassigned 互斥，不能同时传', 400);
  }
  return { departmentId, departmentUnassigned };
}
