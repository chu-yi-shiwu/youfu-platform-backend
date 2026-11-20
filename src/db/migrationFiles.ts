// 迁移文件发现（单一事实源）。
//
// 背景（P0-1）：历史上迁移入口用宽松正则 /^\d+_.*\.sql$/ 扫描仓根，导致：
//   - 053b_*.sql / 053c_*.sql 永远不会被自动执行（文件名在数字后带字母）；
//   - a1_dispatch_rules.sql 这类种子/脚本也被静默忽略；
//   - 105_drop_service_desk_agent.sql 这类破坏性迁移一旦放错目录就会被自动应用。
// 现在统一为严格命名：<3~6 位数字>_<小写字母/数字开头>...sql。
// 不符合命名且位于仓根的 .sql 文件一律显式报错，不再静默跳过。
import { readdirSync } from 'node:fs';

/** 允许自动执行的迁移文件名（严格口径；不匹配的一律不会被迁移通道扫描）。 */
export const MIGRATION_FILE_RE = /^\d{3,6}_[a-z0-9][a-z0-9_]*\.sql$/i;

function prefixOf(name: string): number {
  const m = /^(\d+)_/.exec(name);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

/** 按数字前缀排序（同前缀再按文件名），避免未来出现 4 位前缀时字典序错乱。 */
export function listMigrationFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && MIGRATION_FILE_RE.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => {
      const d = prefixOf(a) - prefixOf(b);
      return d !== 0 ? d : a.localeCompare(b);
    });
}

/**
 * 仓根所有不匹配迁移命名的 .sql 文件。
 * 迁移入口必须对非空结果 fail-closed：这些文件不会被自动执行，
 * 静默留在根目录只会制造「以为跑了、其实没跑」的假象（053b/053c 事故根因）。
 */
export function listUnrecognizedSqlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.sql$/i.test(e.name) && !MIGRATION_FILE_RE.test(e.name))
    .map((e) => e.name)
    .sort();
}

/** 迁移入口共用的启动前校验。 */
export function assertNoUnrecognizedSqlFiles(dir: string): void {
  const bad = listUnrecognizedSqlFiles(dir);
  if (bad.length > 0) {
    throw new Error(
      `仓根存在不符合迁移命名的 .sql 文件：${bad.join(', ')}。` +
        '自动迁移只扫描 <数字>_<名称>.sql；请移入 pending-migrations/、seeds/ 或按规范重命名。',
    );
  }
}
