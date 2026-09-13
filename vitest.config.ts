import { defineConfig } from 'vitest/config';

// 2026-09-11 五轮测试 R1 发现：默认 include 会吸收 dist/**/*.test.js（tsc -p
// tsconfig.build.json 会把 src/test 一并编译进 dist），导致全量测试总数随 dist
// 重编漂移（1009→1011→1014 三连跳）。收口：只认 src 下 TS 测试，排除 dist。
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
