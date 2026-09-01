// L3 对话管家会话底座（R36 · R34 设计稿 §3）
// 两表读写仓储：ai_conversation / ai_conversation_turn（066 迁移，RLS 租户隔离）。
// 约定：所有查询走 withTenantClient（app.tenant_id 已注入），SQL 仍显式带 tenant_id 双保险。
import crypto from 'node:crypto';
import type { PoolClient } from 'pg';

export interface ConversationRow {
  id: string;
  tenant_id: string;
  work_order_id: string | null;
  reporter_anon: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface TurnRow {
  id: number;
  conversation_id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_name: string | null;
  tool_calls: Record<string, unknown>;
  created_at: string;
}

export async function createConversation(
  client: PoolClient,
  tenantId: string,
  opts: { reporterAnon?: string; workOrderId?: string | null },
): Promise<ConversationRow> {
  const id = crypto.randomUUID();
  const r = await client.query<ConversationRow>(
    `INSERT INTO ai_conversation (id, tenant_id, work_order_id, reporter_anon)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [id, tenantId, opts.workOrderId ?? null, opts.reporterAnon ?? ''],
  );
  return r.rows[0];
}

export async function getConversation(
  client: PoolClient,
  tenantId: string,
  id: string,
): Promise<ConversationRow | null> {
  const r = await client.query<ConversationRow>(
    `SELECT * FROM ai_conversation WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
    [tenantId, id],
  );
  return r.rows[0] ?? null;
}

export async function closeConversation(client: PoolClient, tenantId: string, id: string): Promise<void> {
  await client.query(
    `UPDATE ai_conversation SET status = 'closed', updated_at = now() WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
}

export async function appendTurn(
  client: PoolClient,
  tenantId: string,
  conversationId: string,
  turn: { role: 'user' | 'assistant' | 'tool'; content: string; toolName?: string; toolCalls?: Record<string, unknown> },
): Promise<TurnRow> {
  const r = await client.query<TurnRow>(
    `INSERT INTO ai_conversation_turn (tenant_id, conversation_id, role, content, tool_name, tool_calls)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [tenantId, conversationId, turn.role, turn.content, turn.toolName ?? null, JSON.stringify(turn.toolCalls ?? {})],
  );
  await client.query(
    `UPDATE ai_conversation SET updated_at = now() WHERE tenant_id = $1 AND id = $2`,
    [tenantId, conversationId],
  );
  return r.rows[0];
}

export async function listTurns(
  client: PoolClient,
  tenantId: string,
  conversationId: string,
  limit = 60,
): Promise<TurnRow[]> {
  const r = await client.query<TurnRow>(
    `SELECT * FROM ai_conversation_turn WHERE tenant_id = $1 AND conversation_id = $2
     ORDER BY id ASC LIMIT $3`,
    [tenantId, conversationId, limit],
  );
  return r.rows;
}
