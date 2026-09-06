// 服务台代申告优先级预填单测（2026-09-06 任务⑥）
// 覆盖：跳闸描述 → urgent（rule 留痕）；普通描述 → normal（default）；
//       陪检类目 + 任意描述 → normal（priorityRules 排除清单生效，绝不误升）。
import { describe, it, expect } from 'vitest';
import { buildServiceDeskTicket } from '../services/serviceDeskTicket.js';

describe('buildServiceDeskTicket · 优先级预填（resolvePrefillPriority 接线）', () => {
  it('跳闸描述 → urgent，source=rule 且留痕 ruleId', () => {
    const dto = buildServiceDeskTicket({
      tenantId: 't1',
      deskId: 'd1',
      callerName: '张护士',
      catalog: '维修',
      description: '三楼配电箱跳闸了，整个病区没电',
    });
    expect(dto.priority).toBe('urgent');
    expect(dto.prioritySource).toBe('rule');
    expect((dto.ext as any).filled.priority_source).toBe('rule');
    expect((dto.ext as any).filled.rule_id).toBe('power_trip');
  });

  it('普通描述（椅子腿松）→ normal，source=default', () => {
    const dto = buildServiceDeskTicket({
      tenantId: 't1',
      deskId: 'd1',
      callerName: '李医生',
      catalog: '维修',
      description: '诊室椅子腿松了，请来看看',
    });
    expect(dto.priority).toBe('normal');
    expect(dto.prioritySource).toBe('default');
    expect((dto.ext as any).filled.priority_source).toBe('default');
  });

  it('陪检类目 + 危急描述 → 仍 normal（排除清单生效，不误升档）', () => {
    const dto = buildServiceDeskTicket({
      tenantId: 't1',
      deskId: 'd1',
      callerName: '王护士',
      catalog: '陪检',
      description: '病人情况危急，赶紧派人',
    });
    expect(dto.priority).toBe('normal');
    expect(dto.prioritySource).toBe('default');
  });

  it('保持原映射语义：catalog→businessType、幂等键、title、纯函数性质', () => {
    const dto = buildServiceDeskTicket({
      tenantId: 't1',
      deskId: 'd1',
      callerName: '赵工',
      catalog: '运送',
      description: '送标本到检验科',
      location: '门诊3楼',
      sessionId: 's-1',
    });
    expect(dto.businessType).toBe('运送');
    expect(dto.catalog).toBe('运送');
    expect(dto.idempotencyKey).toBe('svcdesk:d1:s-1');
    expect(dto.title).toContain('赵工');
    expect(dto.description).toBe('送标本到检验科');
    // 幂等键不变 → 同输入重复调用产出稳定键（priority 规则命中不改变幂等语义）
    const again = buildServiceDeskTicket({
      tenantId: 't1',
      deskId: 'd1',
      callerName: '赵工',
      catalog: '维修',
      description: '漏水了',
      sessionId: 's-1',
    });
    expect(again.idempotencyKey).toBe('svcdesk:d1:s-1');
    expect(again.priority).toBe('urgent');
  });
});
