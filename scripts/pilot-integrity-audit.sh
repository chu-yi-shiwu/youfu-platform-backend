#!/bin/bash
# pilot 数据完整性只读审计（不修改数据）
set -euo pipefail
DB=${PGDATABASE:-youfu_pilot}
T=${PILOT_TENANT:-zixing-hospital}
q() { sudo -u postgres psql -d "$DB" -c "$1"; }

echo '=== 1. 默认部门数量（应为 1）==='
q "SELECT count(*) AS default_depts FROM dept WHERE tenant_id='$T' AND is_default=true"

echo '=== 2. worker 引用悬空 ==='
q "SELECT count(*) AS worker_bad_dept FROM worker w LEFT JOIN dept d ON d.id=w.department_id AND d.tenant_id=w.tenant_id WHERE w.tenant_id='$T' AND w.department_id IS NOT NULL AND d.id IS NULL"
q "SELECT count(*) AS worker_bad_account FROM worker w LEFT JOIN account_user a ON a.id::text=w.account_id::text AND a.tenant_id=w.tenant_id WHERE w.tenant_id='$T' AND w.account_id IS NOT NULL AND a.id IS NULL"

echo '=== 3. 工单引用悬空 / 重复 ==='
q "SELECT count(*) AS wo_bad_dept FROM work_orders o LEFT JOIN dept d ON d.id=o.department_id AND d.tenant_id=o.tenant_id WHERE o.tenant_id='$T' AND d.id IS NULL"
q "SELECT count(*) AS wo_bad_assignee FROM work_orders o LEFT JOIN worker w ON w.id=o.assignee_id AND w.tenant_id=o.tenant_id WHERE o.tenant_id='$T' AND o.assignee_id IS NOT NULL AND w.id IS NULL"
q "SELECT order_no,count(*) FROM work_orders WHERE tenant_id='$T' GROUP BY order_no HAVING count(*)>1"
q "SELECT ext->>'public_view_token' tok,count(*) FROM work_orders WHERE tenant_id='$T' AND ext ? 'public_view_token' GROUP BY 1 HAVING count(*)>1"

echo '=== 4. 状态是否都在 workflow_def.states 中 ==='
q "SELECT o.status,count(*) FROM work_orders o JOIN workflow_def w ON w.tenant_id=o.tenant_id AND w.entity_type='work_order' WHERE o.tenant_id='$T' AND NOT (w.def->'states' ? o.status) GROUP BY o.status"

echo '=== 5. 事件/通知/结算孤儿 ==='
q "SELECT count(*) AS orphan_events FROM ticket_event e LEFT JOIN work_orders o ON o.id::text=e.work_order_id::text AND o.tenant_id=e.tenant_id WHERE e.tenant_id='$T' AND o.id IS NULL"
q "SELECT count(*) AS orphan_notifications FROM notification n LEFT JOIN work_orders o ON o.id::text=n.work_order_id::text AND o.tenant_id=n.tenant_id WHERE n.tenant_id='$T' AND n.work_order_id IS NOT NULL AND o.id IS NULL"
q "SELECT count(*) AS orphan_settlement_items FROM settlement_item s LEFT JOIN work_orders o ON o.id::text=s.work_order_id::text AND o.tenant_id=s.tenant_id WHERE s.tenant_id='$T' AND s.work_order_id IS NOT NULL AND o.id IS NULL"

echo '=== 6. 主数据重复/空值 ==='
q "SELECT count(*) AS contacts_no_phone FROM contact WHERE tenant_id='$T' AND (phone IS NULL OR phone='')"
q "SELECT name,phone,dept,count(*) FROM contact WHERE tenant_id='$T' GROUP BY 1,2,3 HAVING count(*)>1 ORDER BY 4 DESC LIMIT 10"
q "SELECT name,count(*) FROM location_dict WHERE tenant_id='$T' GROUP BY 1 HAVING count(*)>1"
q "SELECT name,count(*) FROM fault_category WHERE tenant_id='$T' GROUP BY 1 HAVING count(*)>1"
q "SELECT code,count(*) FROM fault_category WHERE tenant_id='$T' GROUP BY 1 HAVING count(*)>1"

echo '=== 7. 账号状态 ==='
q "SELECT role,active,count(*) FROM account_user WHERE tenant_id='$T' GROUP BY 1,2 ORDER BY 1,2"

echo '=== 8. 活跃工单/SLA ==='
q "SELECT status,count(*) FROM work_orders WHERE tenant_id='$T' GROUP BY status ORDER BY 2 DESC"
q "SELECT count(*) AS active_no_sla FROM work_orders WHERE tenant_id='$T' AND status NOT IN ('completed','closed','evaluated','cancelled') AND sla_due_at IS NULL"
