// 挂载冒烟测试（QA 修复🔴① · 防复发）：router import 了但忘 app.use 挂载 = 合法路径全 404
// （批次一 KNOWN_V1_SEGMENTS 教训重演）。不依赖真实 DB/HTTP：直接读 server.ts 源文本断言
// 「import 行 + app.use 挂载行」成对存在（4 断言），最诚实且零运行时依赖。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const serverSrc = readFileSync(
  path.resolve(fileURLToPath(import.meta.url), '../../server.ts'),
  'utf-8',
);

describe('server.ts 路由挂载冒烟（批次三 卡4）', () => {
  it('settlementRouter：import 与 app.use 挂载成对存在', () => {
    expect(serverSrc).toMatch(/import settlementRouter from '\.\/routes\/settlement\.js'/);
    expect(serverSrc).toMatch(/app\.use\('\/api\/v1', settlementRouter\)/);
  });

  it('acceptanceRouter：import 与 app.use 挂载成对存在', () => {
    expect(serverSrc).toMatch(/import acceptanceRouter from '\.\/routes\/acceptance\.js'/);
    expect(serverSrc).toMatch(/app\.use\('\/api\/v1', acceptanceRouter\)/);
  });
});
