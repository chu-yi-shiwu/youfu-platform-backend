// labelDictTenant.ts —— 展示标签「租户覆盖层」写入侧（098 label_dict_tenant）。
//
// 【为什么需要它】
//   073 的 label_dict 是平台级（无租户维度），而流程状态名是租户可自定义的（workflow_def.states）。
//   两者正面冲突 ⇒ 租户自定义状态在界面上显示裸 key。本模块在流程**生效**时把该 def 的
//   状态名落进覆盖表，管理员随后可在字典界面改成中文名（读侧见 routes/meta.ts /meta/labels/me）。
//
// 【关键取舍①：DO NOTHING，不是 DO UPDATE】
//   保存流程时若用 DO UPDATE，管理员改好的中文名会在下次保存流程时被悄悄冲回裸 key
//   ——用户看到的是"改了又变回去"，且无从归因。所以：只补缺失行，绝不覆盖既有译名。
//
// 【关键取舍②：只落"平台字典里没有的"状态（自定义状态），平台已有的一个都不落】
//   读侧 /meta/labels/me 是「平台字典 ∪ 租户覆盖，**覆盖优先**」。若把 draft/assigned 这些
//   标准状态也落成 label='draft'，租户保存一次流程后，界面上「草稿」就变成了 draft ——
//   本改动是为了消灭裸 key，写成全覆盖反而给所有标准状态制造裸 key。
//   落行的目的从来只是"给自定义状态一条可改的记录"，平台已有中文名的状态不需要我们操心。
//
// 【关键取舍③：scope 按**业务文档**分域，巡检独立成 insp_status（默认仍是 wo_status）】
//   scope 此前硬编码成工单域 'wo_status'，于是保存巡检流程时 pending / in_progress /
//   done / exception 这些**巡检状态**被落成 label_dict_tenant 里 (tenant, 'wo_status', key) 的行：
//     · 读侧 /meta/labels/me 按 scope 合并下发 ⇒ 巡检与工单共用一张状态表，脏数据落在**别人的域**里；
//     · 同名 key（如 done）一旦在工单侧也出现，两边共享唯一键 (tenant_id, scope, key)，
//       谁先落谁占位，巡检改好的中文名会被工单流程的保存连坐（反之亦然）。
//   两套枚举本来就不相交（073 的 wo_status 域只有工单那 19 条），分域才是对事实的诚实表达。
//   scope 做成**可选第 5 参、默认 'wo_status'**：既有调用点零改动、行为逐字不变。
import type { PoolClient } from 'pg';

/** 最小客户端契约：既能接真实 PoolClient，也能接 PGlite（测试用真库跑）。 */
export interface LabelDictClient {
  query(sql: string, params?: unknown[]): Promise<{ rowCount?: number | null; affectedRows?: number | null }>;
}

/**
 * 把流程里的**自定义状态**补进租户覆盖表（幂等，只补不覆盖）。
 *
 * T0：新增落变更人（updated_by）。本函数的写入虽是"补缺失行"，但同样是**改动了租户可见配置**，
 *   不留变更人 ⇒ 管理员看到一条来历不明的字典行，无从归因。
 * @param actor 变更人（一般是触发保存流程的操作人）；不传 = 未知（落 NULL，不编造 'system' 掩盖未知）
 * @param scope 字典域（**业务文档维度**）。默认 'wo_status'（工单域，向后兼容既有调用点）；
 *              巡检流程传 'insp_status' —— 巡检与工单是两套状态枚举，混域会互相污染译名
 *              （详见文件头「关键取舍③」）。
 * @returns 本次**真正新增**的行数（已存在的不计）
 */
export async function ensureTenantStateLabels(
  client: LabelDictClient | PoolClient,
  tenantId: string,
  states: string[],
  actor?: string,
  scope: string = 'wo_status',
): Promise<number> {
  // 脏数据不静默写入：非字符串 / 空串 / 空白串一律剔除（def.states 来自用户 JSON，形状不可信）。
  const keys = [...new Set((states ?? []).filter((s) => typeof s === 'string' && s.trim() !== ''))];
  if (keys.length === 0) return 0;
  // 单条语句落全部：循环 INSERT 在 20 个状态的 def 下是 20 次往返，且仍需逐条判重。
  // version 不显式写：走列默认 1（101 迁移给的 NOT NULL DEFAULT 1），与 workflow_def 初始版本同口径。
  // scope 由调用方按业务文档给（默认工单域）：巡检必须走 insp_status，见文件头「关键取舍③」。
  const r = await (
    client as unknown as LabelDictClient
  ).query(
    `INSERT INTO label_dict_tenant (tenant_id, scope, key, label, sort, updated_by)
     SELECT $1, $4, t.k, t.k, 0, $3
       FROM unnest($2::text[]) AS t(k)
      WHERE NOT EXISTS (
        SELECT 1 FROM label_dict WHERE scope = $4 AND key = t.k
      )
     ON CONFLICT (tenant_id, scope, key) DO NOTHING`,
    [tenantId, keys, actor ?? null, scope],
  );
  return Number(r?.rowCount ?? r?.affectedRows ?? 0) || 0;
}
