// src/test/migrationTxSafety.test.ts —— 迁移「不可半截」守卫测试。
// 背景（真风险，勿删）：migrate-as-owner.sh 用 `psql -f` 跑迁移，而 psql 默认 autocommit ——
//   每个 SQL 语句各自提交。093 有 203 行（多租户 jsonb 改写），一旦中途失败：
//     ① 已执行的语句**不会回滚** → 留下「部分租户改了、部分没改」的半截状态；
//     ② `_migrations` 的 INSERT 在整文件成功后才写 → 失败时**不记账**，下次重跑从头再来，
//        已改过的租户被再改一遍。
//   修法选的是「脚本层加事务（-1 / --single-transaction）」而不是「改 SQL 文件内容加 BEGIN/COMMIT」，
//   因为后者会让这些文件的内容发生变化，而 093/094 已由 PGlite 13 例验证过 —— 内容一动，
//   那份验证结论就得重新做。脚本层一个参数即可覆盖全部迁移（含未来的）。
// 本测试把「文件不得自带事务」这条前提钉死：若将来有人往迁移里塞了 BEGIN/COMMIT，
//   脚本的 -1 会与之冲突（COMMIT 提前提交、外层再 COMMIT 报警），这里会立刻红。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const TARGETS = [
  '090_role_def.sql',
  '091_workflow_approve_perms_backfill.sql',
  '092_accept_edge_worker_backfill.sql',
  '093_retired_roles_backfill.sql',
  '094_workflow_auto_rule.sql',
];

function read(name: string): string {
  return readFileSync(join(ROOT, name), 'utf8');
}

describe('迁移事务安全（防半截）', () => {
  it('① 090-094 不得自带 BEGIN/COMMIT —— 否则与脚本的 --single-transaction 冲突', () => {
    for (const f of TARGETS) {
      const sql = read(f);
      expect(/^\s*BEGIN\s*;/im.test(sql), `${f} 不得自带 BEGIN`).toBe(false);
      expect(/^\s*COMMIT\s*;/im.test(sql), `${f} 不得自带 COMMIT`).toBe(false);
    }
  });

  it('② 090-094 不得含事务内禁用的语句（CONCURRENTLY / VACUUM / ALTER TYPE ADD VALUE）', () => {
    for (const f of TARGETS) {
      const sql = read(f);
      expect(/CONCURRENTLY/i.test(sql), `${f} 不得含 CONCURRENTLY`).toBe(false);
      expect(/^\s*VACUUM/im.test(sql), `${f} 不得含 VACUUM`).toBe(false);
      expect(/ALTER\s+TYPE[\s\S]*ADD\s+VALUE/i.test(sql), `${f} 不得含 ALTER TYPE ADD VALUE`).toBe(false);
    }
  });

  it('③ 部署脚本必须以单事务方式应用迁移（-1 或 --single-transaction）', () => {
    // 只检查真实 psql 命令行，不检查注释 —— 注释里也会出现 --single-transaction，
    // 若按全文匹配，把参数删掉测试照样绿（假绿，本条最初就踩过）。
    const sh = readFileSync(join(ROOT, 'scripts', 'migrate-as-owner.sh'), 'utf8');
    const psqlLines = sh.split('\n').filter((l) => /psql\s+-d\s/.test(l) && !/^\s*#/.test(l));
    expect(psqlLines.length).toBeGreaterThan(0);
    const txLines = psqlLines.filter((l) => /(^|\s)(-1|--single-transaction)(\s|$)/.test(l));
    expect(txLines.length, '至少一条 psql 命令行带单事务参数').toBeGreaterThan(0);
  });

  it('④ 部署脚本必须开 ON_ERROR_STOP —— 否则失败不中断，半截会被当成成功', () => {
    const sh = readFileSync(join(ROOT, 'scripts', 'migrate-as-owner.sh'), 'utf8');
    expect(sh).toContain('ON_ERROR_STOP=1');
  });

  it('⑤ migrate.ts 通道同样包事务，且与 shell 通道同口径（防两通道行为分叉）', () => {
    const ts = readFileSync(join(ROOT, 'src', 'db', 'migrate.ts'), 'utf8');
    expect(ts).toContain("pool.query('BEGIN')");
    expect(ts).toContain("pool.query('COMMIT')");
    expect(ts).toContain("pool.query('ROLLBACK')");
    // 必须做自带事务探测，否则 059 这类文件会被双层包裹
    expect(ts).toMatch(/selfTx|BEGIN\\s*;/);
  });

  it('⑥ 部署脚本对自带事务的迁移（如 059）不得强行再套一层 —— 需有 BEGIN 探测', () => {
    const sh = readFileSync(join(ROOT, 'scripts', 'migrate-as-owner.sh'), 'utf8');
    // 059_idempotency_tenant_scoped.sql 实测自带 BEGIN/COMMIT，若对它再套 -1 会打出
    // "there is already a transaction in progress" 并让事务在文件内部提前提交。
    // 同样只认命令行：脚本里必须有「探测自带 BEGIN 再决定是否套事务」的分支（grep ... BEGIN）
    const branchLines = sh.split('\n').filter((l) => /grep\s+.*BEGIN/.test(l) && !/^\s*#/.test(l));
    expect(branchLines.length, '必须有 BEGIN 探测分支，否则 059 会被双层包裹').toBeGreaterThan(0);
    expect(readFileSync(join(ROOT, '059_idempotency_tenant_scoped.sql'), 'utf8')).toMatch(/^\s*BEGIN\s*;/im);
  });

  it('⑦ 调用 sudo -u postgres psql 前必须切到 postgres 可进入的目录（防 could not change directory）', () => {
    // 真事故（2026-10-17 02:31，ECS 真机）：在 /root 下执行 `sudo -u postgres pg_dump` →
    //   "could not change directory to /root: Permission denied"，命令直接失败。
    // 成因：sudo -u 不重置 CWD，postgres 用户对 /root（0700）无 x 权限。
    //   ssh 非交互式远程命令的 CWD 恰好就是 $HOME=/root ⇒ 用 ssh 包一层必踩。
    // 同类证据（本仓库早有，tools/wfdef_arrived_patch_20260906.mjs:115）：
    //   "sudo -u postgres psql 需要读该文件：mkdtemp 默认 0700（仅 root 可入），放开为 0755/0644"
    // 因此脚本不得依赖调用时的 CWD，必须显式切到全局可进入目录（/tmp，1777）。
    const sh = readFileSync(join(ROOT, 'scripts', 'migrate-as-owner.sh'), 'utf8');
    const lines = sh.split('\n').filter((l) => !/^\s*#/.test(l));
    const cdIdx = lines.findIndex((l) => /^\s*cd\s+("\$\{?RUN_DIR|'\/tmp'|\/tmp)/.test(l) || /^\s*cd\s+\/tmp\s*$/.test(l));
    const psqlIdx = lines.findIndex((l) => /sudo\s+-u\s+postgres\s+psql/.test(l));
    expect(cdIdx, '必须有一条非注释的 cd 到 /tmp（或 $RUN_DIR，默认 /tmp）').toBeGreaterThanOrEqual(0);
    expect(psqlIdx).toBeGreaterThan(cdIdx);
  });
});
