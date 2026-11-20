// migrationManifest.test.ts —— P0-1 迁移清单/命名护栏。
//
// 背景（真实事故根因）：
//   - 053b_review_fixes.sql / 053c_ugc_contribution.sql 因文件名在数字后带字母，
//     永远不匹配迁移正则，代码却已经在读它们新增的列；
//   - 105_drop_service_desk_agent.sql 一旦留在仓根，下一次自动迁移就会 DROP TABLE；
//   - a1_dispatch_rules.sql 是演示租户种子，不应进入生产迁移通道。
// 本测试把「哪些文件会被自动执行」钉死为单一事实源，并锚定上述文件的正确位置。
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  MIGRATION_FILE_RE,
  listMigrationFiles,
  listUnrecognizedSqlFiles,
} from '../db/migrationFiles.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('P0-1 迁移文件命名（严格口径）', () => {
  it('接受规范的 3~6 位数字前缀迁移', () => {
    for (const name of ['001_init.sql', '053_platform_template.sql', '105_drop_service_desk_agent.sql', '106_review_fixes_additive.sql', '107_ugc_contribution.sql']) {
      expect(MIGRATION_FILE_RE.test(name), name).toBe(true);
    }
  });

  it('拒绝数字后带字母/无数字前缀/非 .sql 的文件', () => {
    for (const name of ['053b_review_fixes.sql', '053c_ugc_contribution.sql', 'a1_dispatch_rules.sql', '105_drop.sql.bak', 'readme.txt']) {
      expect(MIGRATION_FILE_RE.test(name), name).toBe(false);
    }
  });

  it('仓根不存在会被静默忽略的 .sql 文件', () => {
    expect(listUnrecognizedSqlFiles(ROOT)).toEqual([]);
  });

  it('自动迁移清单包含 106/107，且不包含 053b/053c/a1/105', () => {
    const files = listMigrationFiles(ROOT);
    expect(files).toContain('106_review_fixes_additive.sql');
    expect(files).toContain('107_ugc_contribution.sql');
    expect(files).not.toContain('053b_review_fixes.sql');
    expect(files).not.toContain('053c_ugc_contribution.sql');
    expect(files).not.toContain('a1_dispatch_rules.sql');
    expect(files).not.toContain('105_drop_service_desk_agent.sql');
  });
});

describe('P0-1 破坏性迁移与种子被移出自动通道', () => {
  it('105 删表迁移在 pending-migrations/，仓根不存在', () => {
    expect(existsSync(join(ROOT, '105_drop_service_desk_agent.sql'))).toBe(false);
    const pending = read('pending-migrations/105_drop_service_desk_agent.sql');
    expect(pending).toContain('DROP TABLE public.service_desk_agent');
  });

  it('053b/053c 旧文件归档，加法内容由 106/107 接管', () => {
    expect(existsSync(join(ROOT, '053b_review_fixes.sql'))).toBe(false);
    expect(existsSync(join(ROOT, '053c_ugc_contribution.sql'))).toBe(false);
    expect(read('106_review_fixes_additive.sql')).toContain('ADD COLUMN IF NOT EXISTS refreshed_at');
    expect(read('107_ugc_contribution.sql')).toContain("ADD COLUMN IF NOT EXISTS source");
    expect(read('107_ugc_contribution.sql')).toContain('ADD COLUMN IF NOT EXISTS contributor_tenant');
  });

  it('053b 的删列部分在 pending-migrations/108，不随部署自动执行', () => {
    const sql = read('pending-migrations/108_drop_open_api_app_secret.sql');
    expect(sql).toContain('DROP COLUMN IF EXISTS app_secret');
    expect(listMigrationFiles(ROOT)).not.toContain('108_drop_open_api_app_secret.sql');
  });

  it('a1 演示派单规则在 seeds/，不在自动迁移通道', () => {
    expect(existsSync(join(ROOT, 'a1_dispatch_rules.sql'))).toBe(false);
    expect(read('seeds/a1_dispatch_rules.sql')).toContain("'t-verification'");
    expect(listMigrationFiles(ROOT)).not.toContain('a1_dispatch_rules.sql');
  });
});

describe('P0-1 迁移入口全部使用同一套严格清单', () => {
  it('migrate.ts / init-db.ts 使用 migrationFiles 且做 fail-closed', () => {
    for (const rel of ['src/db/migrate.ts', 'scripts/init-db.ts']) {
      const src = read(rel);
      expect(src, rel).toContain('listMigrationFiles');
      expect(src, rel).toContain('assertNoUnrecognizedSqlFiles');
    }
  });

  it('releaseGate.ts 对非规范 SQL 直接失败', () => {
    const src = read('scripts/releaseGate.ts');
    expect(src).toContain('listUnrecognizedSqlFiles');
    expect(src).toMatch(/unrecognizedSql\.length === 0/);
  });

  it('migrate-as-owner.sh 也做严格命名与 fail-closed', () => {
    const sh = read('scripts/migrate-as-owner.sh');
    expect(sh).toContain('MIGRATION_RE');
    expect(sh).toContain('UNRECOGNIZED');
    expect(sh).toContain('exit 1');
  });
});
