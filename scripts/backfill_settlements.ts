// scripts/backfill_settlements.ts —— E-9 存量补建（BUG-004 欠账清理，一次性脚本）。
//
// 【为什么需要它】
//   自动结算（workOrder transition → evaluated 分支）只对**发版之后**的评价动作生效。
//   发版前已经评价但从未建过结算单的工单是"永久欠账"——本脚本把存量补齐，跑完即清账。
//
// 【设计契约（对齐《优服家_E9_自动结算与耗材二级库存设计》§2.2）】
//   - **不走迁移**（DDL/数据分离纪律）：迁移只做结构，数据补建由本脚本人工触发；
//   - **幂等**：候选集 = 「状态可入账 且 未被任何结算单占用」；逐单仍走 createSettlementDraft
//     （其内部有 UNIQUE(tenant_id, work_order_id, source) + settledSet 预检 + FOR UPDATE），
//     故重复执行恒为「跳过」而非重复建单；
//   - **可 dry-run**：`--dry-run` 只统计不写库（先看量再决定跑不跑）；
//   - **出报告**：逐租户一行 + 末尾汇总（候选/新建/跳过/失败），失败逐单打印订单号与原因，不中断后续；
//   - **单笔事务**：每张工单一个独立事务（withTenantClient）——单笔失败不牵连整批，也不留半成品；
//   - 建单创建人留痕 `backfill:e9`（与自动 'auto:evaluated'、人工 username 三方可区分，便于事后审计）。
//
// 【运行方式】
//   cd youfu_backend_dev_v2
//   npx tsx scripts/backfill_settlements.ts --dry-run            # 先看量（推荐第一步）
//   npx tsx scripts/backfill_settlements.ts                      # 真正补建（默认只补 evaluated 存量）
//   npx tsx scripts/backfill_settlements.ts --tenant=t-xxx       # 只处理某租户
//   npx tsx scripts/backfill_settlements.ts --status=evaluated,closed,completed  # 放宽入账口径
//   npx tsx scripts/backfill_settlements.ts --limit=50           # 试跑前 50 单
//
// 【运行身份】候选租户枚举需要「能看见全部租户的行」——RLS 对 youfu_app 生效，故不带 --tenant 时
//   请以 **postgres（表属主，RLS 不强制）** 身份运行；或显式 `--tenant=<id>`（此时 youfu_app 亦可）。
import { Pool } from 'pg';
import 'dotenv/config';
import { withTenantClient } from '../src/db/pool.js';
import { createSettlementDraft, SETTLEMENT_ELIGIBLE_STATUSES } from '../src/repo/settlement.js';

/** 补建留痕（与 'auto:evaluated' / 人工 username 三方可区分）。 */
export const BACKFILL_OPERATOR = 'backfill:e9';

/** 默认补建口径：只补「已评价」的存量欠账（自动结算触发态即 evaluated）。 */
const DEFAULT_STATUSES = ['evaluated'];

interface Args {
  dryRun: boolean;
  tenant: string | null;
  statuses: string[];
  limit: number | null;
}

/** 解析命令行参数（纯函数，便于单测）。未知参数直接抛错——防"打错参数静默按默认跑"。 */
export function parseArgs(argv: string[]): Args {
  const out: Args = { dryRun: false, tenant: null, statuses: [...DEFAULT_STATUSES], limit: null };
  for (const a of argv) {
    if (a === '--dry-run') {
      out.dryRun = true;
    } else if (a.startsWith('--tenant=')) {
      const v = a.slice('--tenant='.length).trim();
      if (!v) throw new Error('--tenant 不能为空');
      out.tenant = v;
    } else if (a.startsWith('--status=')) {
      const list = a
        .slice('--status='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (list.length === 0) throw new Error('--status 不能为空');
      out.statuses = list;
    } else if (a.startsWith('--limit=')) {
      const n = Number(a.slice('--limit='.length));
      if (!Number.isFinite(n) || n <= 0) throw new Error('--limit 必须为正整数');
      out.limit = Math.floor(n);
    } else {
      throw new Error(`未知参数：${a}（可用：--dry-run / --tenant=<id> / --status=a,b / --limit=N）`);
    }
  }
  return out;
}

/** 入账口径校验：只允许工单确实可能出现的状态，防止手打错字导致空跑却说"清账完成"。 */
export function assertStatuses(statuses: string[], allowed: readonly string[]): void {
  const bad = statuses.filter((s) => !allowed.includes(s));
  if (bad.length > 0) {
    throw new Error(`--status 含非法状态：${bad.join(',')}（允许：${allowed.join(',')}）`);
  }
}

interface TenantReport {
  tenantId: string;
  candidates: number;
  created: number;
  skipped: number;
  failed: number;
  failures: Array<{ orderNo: string | null; id: string; error: string }>;
}

/** 单租户补建（候选枚举 → 逐单独立事务建单）。导出便于单测注入假 client 行为。 */
export async function backfillTenant(
  tenantId: string,
  args: Pick<Args, 'dryRun' | 'statuses' | 'limit'>,
  opts?: { log?: (line: string) => void },
): Promise<TenantReport> {
  const log = opts?.log ?? ((line: string) => console.log(line));
  const report: TenantReport = { tenantId, candidates: 0, created: 0, skipped: 0, failed: 0, failures: [] };

  const candidates = await withTenantClient(tenantId, async (client) => {
    const r = await client.query(
      `SELECT wo.id, wo.order_no, wo.status FROM work_orders wo
       WHERE wo.tenant_id = $1
         AND wo.status = ANY($2::text[])
         AND NOT EXISTS (
           SELECT 1 FROM settlement_item si WHERE si.tenant_id = $1 AND si.work_order_id = wo.id
         )
       ORDER BY wo.created_at ASC, wo.id ASC`,
      [tenantId, args.statuses],
    );
    return r.rows as Array<{ id: string; order_no: string | null; status: string }>;
  });

  const picked = args.limit ? candidates.slice(0, args.limit) : candidates;
  report.candidates = picked.length;
  log(
    `[backfill] tenant=${tenantId} 候选=${picked.length}${args.limit && candidates.length > picked.length ? `（另有 ${candidates.length - picked.length} 单被 --limit 截断）` : ''} statuses=${args.statuses.join(',')} dryRun=${args.dryRun}`,
  );
  if (args.dryRun) return report;

  for (const wo of picked) {
    try {
      const r = await withTenantClient(tenantId, (client) =>
        createSettlementDraft(client, tenantId, [wo.id], BACKFILL_OPERATOR),
      );
      if (r.ok && r.settlement) {
        report.created += 1;
        log(`[backfill]   + ${wo.order_no ?? wo.id} → ${r.settlement.settlement_no}（total=${r.settlement.total}）`);
      } else {
        // 非致命：createSettlementDraft 的正常冲突语义（并发/状态变化）→ 记跳过，不算失败
        report.skipped += 1;
        log(`[backfill]   ~ ${wo.order_no ?? wo.id} 跳过（${(r.conflicts ?? []).map((c) => c.reason).join(',') || 'no_reason'}）`);
      }
    } catch (e) {
      report.failed += 1;
      const message = e instanceof Error ? e.message : String(e);
      report.failures.push({ orderNo: wo.order_no, id: wo.id, error: message });
      log(`[backfill]   ! ${wo.order_no ?? wo.id} 失败：${message}`);
    }
  }
  log(
    `[backfill] tenant=${tenantId} 完成：新建=${report.created} 跳过=${report.skipped} 失败=${report.failed}`,
  );
  return report;
}

async function listTenants(pool: Pool, statuses: string[]): Promise<string[]> {
  // 直连（不带租户上下文）枚举：以属主身份运行时 RLS 不强制，可看到全部租户
  const r = await pool.query(
    `SELECT DISTINCT tenant_id FROM work_orders WHERE status = ANY($1::text[]) ORDER BY tenant_id`,
    [statuses],
  );
  return r.rows.map((x: { tenant_id: string }) => x.tenant_id);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assertStatuses(args.statuses, SETTLEMENT_ELIGIBLE_STATUSES);

  const pool = new Pool({
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? 5432),
    database: process.env.PGDATABASE ?? 'youfu',
    user: process.env.PGUSER ?? 'youfu_app',
    password: process.env.PGPASSWORD ?? 'change_me',
    max: 4,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  });

  try {
    let tenants: string[];
    if (args.tenant) {
      tenants = [args.tenant];
    } else {
      tenants = await listTenants(pool, args.statuses);
      if (tenants.length === 0) {
        console.warn(
          '[backfill] 未枚举到任何租户。若确认库中确有存量工单，说明当前身份受 RLS 限制——' +
            '请以 postgres 身份运行，或显式指定 --tenant=<id>。',
        );
      }
    }
    console.log(
      `[backfill] 启动：tenants=${tenants.length} statuses=${args.statuses.join(',')} dryRun=${args.dryRun} limit=${args.limit ?? '∞'}`,
    );

    const reports: TenantReport[] = [];
    for (const t of tenants) {
      reports.push(await backfillTenant(t, args));
    }

    const sum = reports.reduce(
      (acc, r) => ({
        candidates: acc.candidates + r.candidates,
        created: acc.created + r.created,
        skipped: acc.skipped + r.skipped,
        failed: acc.failed + r.failed,
      }),
      { candidates: 0, created: 0, skipped: 0, failed: 0 },
    );
    console.log(
      `[backfill] 汇总：租户=${reports.length} 候选=${sum.candidates} 新建=${sum.created} 跳过=${sum.skipped} 失败=${sum.failed} dryRun=${args.dryRun}`,
    );
    if (args.dryRun) {
      console.log('[backfill] dry-run 结束：未写库。确认数量无误后去掉 --dry-run 正式执行。');
    }
    if (sum.failed > 0) {
      console.error('[backfill] 存在失败单，请按上面逐单原因排查后重跑（脚本幂等，重跑只处理仍缺结算单的工单）。');
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

// 仅在被直接执行时跑 main（被单测 import 时不自动跑）
const isDirectRun = process.argv[1] ? /backfill_settlements\.(ts|js)$/.test(process.argv[1]) : false;
if (isDirectRun) {
  main().catch((e) => {
    console.error('[backfill] 失败：', e);
    process.exit(1);
  });
}
