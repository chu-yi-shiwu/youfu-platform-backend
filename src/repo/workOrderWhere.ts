// 工单列表/统计共用的 WHERE 构造器。
// 安全边界不在这里：行可见性由 work_orders RLS 兜底；本文件只拼业务筛选。
export interface WorkOrderFilter {
  status?: string;
  assignee?: string | string[];
  departmentId?: string;
  departmentUnassigned?: boolean;
  priority?: string;
  source?: string;
  businessType?: string;
  autoFlow?: boolean;
  todayOnly?: boolean;
  createdSince?: string | Date;
  unsettledOnly?: boolean;
}

/**
 * 部门口径的唯一 SQL 拼接实现：工单列表、工作台、超时、负载、过程挖掘都必须走这里，
 * 禁止各端点各写一套 `department_id` 条件导致"看板按部门、列表不按部门"的漂移。
 * params 由调用方持有，函数只追加，占位符编号与 params.length 对齐。
 */
export function appendDepartmentScope(
  conds: string[],
  params: unknown[],
  filter: { departmentId?: string; departmentUnassigned?: boolean },
  alias: string,
): void {
  if (filter.departmentId) {
    params.push(filter.departmentId);
    conds.push(`${alias}.department_id = $${params.length}`);
  }
  if (filter.departmentUnassigned) {
    conds.push(`${alias}.department_id IS NULL`);
  }
}

export function buildWorkOrderWhere(
  tenantId: string,
  filter: WorkOrderFilter,
): { conds: string[]; params: unknown[] } {
  const conds = ['wo.tenant_id = $1'];
  const params: unknown[] = [tenantId];

  if (filter.status) {
    const statuses = filter.status.split(',').map((s) => s.trim()).filter(Boolean);
    params.push(statuses);
    conds.push(`wo.status = ANY($${params.length}::text[])`);
  }
  if (filter.assignee) {
    if (Array.isArray(filter.assignee)) {
      params.push(filter.assignee);
      conds.push(`wo.assignee_id = ANY($${params.length}::text[])`);
    } else {
      params.push(filter.assignee);
      conds.push(`wo.assignee_id = $${params.length}`);
    }
  }
  appendDepartmentScope(conds, params, filter, 'wo');
  if (filter.priority) {
    params.push(filter.priority);
    conds.push(`wo.priority = $${params.length}`);
  }
  if (filter.source) {
    params.push(filter.source);
    conds.push(`wo.source = $${params.length}`);
  }
  if (filter.businessType) {
    params.push(filter.businessType);
    conds.push(`wo.business_type = $${params.length}`);
  }
  if (filter.unsettledOnly) {
    conds.push('NOT EXISTS (SELECT 1 FROM settlement_item si WHERE si.work_order_id = wo.id)');
  }
  if (filter.createdSince) {
    params.push(filter.createdSince);
    conds.push(`wo.created_at >= $${params.length}`);
  }
  if (filter.autoFlow) {
    conds.push('wo.auto_flow = true');
  }
  if (filter.todayOnly) {
    conds.push('wo.created_at::date = CURRENT_DATE');
  }
  return { conds, params };
}
