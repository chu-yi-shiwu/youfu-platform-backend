// 工单 ID 是 text（陪检单存在 escort-* 非 UUID）；asset.linked_order_ids 是 uuid[]。
// 详情接口查关联资产时必须按 text 比较，否则非 UUID 工单会被 Postgres ::uuid 强转打成 400。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const ROOT = process.cwd();
const source = readFileSync(join(ROOT, 'src', 'routes', 'workOrder.ts'), 'utf8');

describe('工单详情：非 UUID 工单 ID 的资产关联查询', () => {
  it('源码使用 text 比较，不再把工单 ID 强转 uuid', () => {
    expect(source).toContain('$2::text = ANY(linked_order_ids::text[])');
    expect(source).not.toContain('$2::uuid = ANY(linked_order_ids)');
  });

  it('负控制：escort-* 按 uuid 强转会报错，按 text 比较安全返回空', async () => {
    const db = new PGlite();
    await db.exec(`
      CREATE TABLE asset (
        id uuid PRIMARY KEY,
        tenant_id text NOT NULL,
        linked_order_ids uuid[]
      );
      INSERT INTO asset (id, tenant_id, linked_order_ids)
      VALUES ('11111111-1111-4111-8111-111111111111', 't-1', ARRAY[]::uuid[]);
    `);

    const ok = await db.query(
      'SELECT id FROM asset WHERE tenant_id=$1 AND $2::text = ANY(linked_order_ids::text[])',
      ['t-1', 'escort-mwp7t1tm-o6gun4'],
    );
    expect(ok.rows).toHaveLength(0);

    await expect(
      db.query('SELECT id FROM asset WHERE tenant_id=$1 AND $2::uuid = ANY(linked_order_ids)', [
        't-1',
        'escort-mwp7t1tm-o6gun4',
      ]),
    ).rejects.toThrow();
    await db.close();
  });
});
