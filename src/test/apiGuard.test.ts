// RV-001 修复回归：API 已知路径守卫（apiGuardMiddleware / isKnownApiPath）。
// 口径：未知路径 404 先于鉴权；已知前缀与已知首段放行；参数化首段路由必须不受影响。
import { describe, it, expect } from 'vitest';
import { isKnownApiPath, KNOWN_V1_SEGMENTS } from '../middleware/apiGuard.js';

describe('apiGuard isKnownApiPath（RV-001）', () => {
  it('已知首段（含深路径与尾斜杠）→ true', () => {
    expect(isKnownApiPath('/v1/stats')).toBe(true);
    expect(isKnownApiPath('/v1/stats/summary')).toBe(true);
    expect(isKnownApiPath('/v1/stats/')).toBe(true);
    expect(isKnownApiPath('/v1/work-orders')).toBe(false); // 反例：work-orders 不在清单（真实路径是 tickets/open 等）
  });

  it('显式挂载前缀 → true（含内部参数段）', () => {
    expect(isKnownApiPath('/v1/platform/entities')).toBe(true);
    expect(isKnownApiPath('/v1/inspection/tasks')).toBe(true);
    expect(isKnownApiPath('/v1/workflow-defs/repair')).toBe(true);   // :entityType 参数段
    expect(isKnownApiPath('/v1/flow/repair/xxx/transition')).toBe(true);
    expect(isKnownApiPath('/v1/wechat/jssdk-config')).toBe(true);
    expect(isKnownApiPath('/v1/open-api/tenants')).toBe(true);
  });

  it('未知路径 → false（探针口径 /nonexistent-path-xyz）', () => {
    expect(isKnownApiPath('/v1/nonexistent-path-xyz')).toBe(false);
    expect(isKnownApiPath('/v2/anything')).toBe(false);
    expect(isKnownApiPath('/foo')).toBe(false);
    expect(isKnownApiPath('/')).toBe(false);
  });

  it('裸 /v1 与 /v1/ → false（无路由挂载，应 404）', () => {
    expect(isKnownApiPath('/v1')).toBe(false);
    expect(isKnownApiPath('/v1/')).toBe(false);
  });

  it('公开面关键路径不受守卫误伤', () => {
    expect(isKnownApiPath('/v1/public/repair-report')).toBe(true);
    expect(isKnownApiPath('/v1/public/ai-chat')).toBe(true);
    expect(isKnownApiPath('/v1/auth/login')).toBe(true);
    expect(isKnownApiPath('/v1/meta/labels')).toBe(true); // #938 展示标签字典（公开端点）
  });

  it('白名单不含参数占位符（:entityType 等不作为段名）', () => {
    expect(KNOWN_V1_SEGMENTS.has(':entityType')).toBe(false);
    expect(KNOWN_V1_SEGMENTS.has(':id')).toBe(false);
    expect(KNOWN_V1_SEGMENTS.has(':tenant')).toBe(false);
  });
});
