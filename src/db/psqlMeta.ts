/**
 * psql 元命令剥离器 —— 让"给人看 + 给 psql 跑"的迁移文件也能被 pg 协议直接执行。
 *
 * 【为什么需要它】
 *   迁移文件的部署契约是 `psql -f NNN_x.sql`（085 起带 `\echo` 分节提示，便于部署窗口
 *   人工核对输出）。但仓库里有两个执行入口走的是 **pg 协议**（node-postgres），把文件
 *   原文整段丢给 PostgreSQL 服务端：
 *     - `scripts/init-db.ts`  全新库初始化
 *     - `src/db/migrate.ts`   常规迁移入口
 *   psql 元命令（\echo / \c / \set …）**不是 SQL**，服务端解析器遇到 `\` 直接报
 *   `syntax error at or near "\"`。084 及之前一个元命令都没有，085 是第一个引入者 ——
 *   所以全新库初始化必然卡在 084 之后。
 *
 * 【为什么不在迁移文件里删掉 \echo】
 *   ① 085-089 已在 ECS 应用（"已应用迁移不可回改"纪律）；
 *   ② `\echo` 是部署契约的一部分，运维在部署窗口要读它；
 *   ③ 通道适配本就是消费方的责任：谁用纯 SQL 协议，谁负责翻译。
 *
 * 【安全边界】
 *   - 只剥离**行首**（允许前导空白）以 `\` + 字母开头的行，这是 psql 元命令的唯一形态；
 *     字符串内的 `\'` `\\` 等转义一律不动；
 *   - **先跟踪美元引用**（`$$` / `$tag$`），块体内一律不判定 —— 否则 DO 块里的正文会被误伤；
 *   - 剥离行替换为空行而非删除，**行号保持不变**，报错可精确定位到原始行；
 *   - 返回被剥离的原始行，调用方打日志，不做静默丢弃。
 */

export interface StripResult {
  /** 清洗后的纯 SQL（行数与输入一致，被剥离行置空行） */
  sql: string;
  /** 被剥离的元命令原文（已 trim），供调用方审计/告警 */
  stripped: string[];
}

/** psql 元命令形态：行首 \ + 字母（\echo \c \set \d \dt \gset ...） */
const META_LINE_RE = /^\s*\\[a-zA-Z]/;
/** 美元引用定界符：`$$` 或 `$tag$`；pg 参数占位符 $1 不含收尾 $，不会误匹配 */
const DOLLAR_RE = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/g;

export function stripPsqlMeta(sql: string): StripResult {
  const lines = sql.split(/\r?\n/);
  const out: string[] = new Array(lines.length);
  const stripped: string[] = [];

  let inDollar = false;
  let openTag: string | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // ① 元命令判定：仅在美元引用块之外生效
    if (!inDollar && META_LINE_RE.test(line)) {
      stripped.push(line.trim());
      out[i] = ''; // 保行号：置空行而非删除
      continue; // 元命令不进服务端，不参与美元引用跟踪
    }

    // ② 美元引用状态跟踪（决定后续行是否处于块体内）
    DOLLAR_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = DOLLAR_RE.exec(line)) !== null) {
      const tag = m[1] ?? '';
      if (!inDollar) {
        inDollar = true;
        openTag = tag;
      } else if (tag === (openTag ?? '')) {
        inDollar = false;
        openTag = null;
      }
    }

    out[i] = line;
  }

  return { sql: out.join('\n'), stripped };
}
