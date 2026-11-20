import { defineConfig } from 'vitest/config';

// 2026-09-11 五轮测试 R1 发现：默认 include 会吸收 dist/**/*.test.js（tsc -p
// tsconfig.build.json 会把 src/test 一并编译进 dist），导致全量测试总数随 dist
// 重编漂移（1009→1011→1014 三连跳）。收口：只认 src 下 TS 测试，排除 dist。
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // PGlite / 真库穿透用例在 CI 共享 runner 上明显慢于本地；默认 5s 会把
    // “机器慢”误报成“断言失败”。放宽超时只影响等待上限，不改变任何断言。
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
