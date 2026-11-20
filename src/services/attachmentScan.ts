// 附件病毒扫描适配层（2026-11-20）
// 原则：不在业务代码里伪造“已扫描”。配置了 ASSET_AV_CMD 才真正执行；未配置明确返回 unscanned。
// 约定命令为 clamscan/clamdscan 兼容 CLI：文件参数在最后，发现病毒时 stdout 含 FOUND。
// ASSET_AV_REQUIRED=true 时，未扫描/扫描失败/发现病毒一律拒绝入库（fail-closed）。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type AttachmentScanStatus = 'clean' | 'infected' | 'error' | 'unscanned';

export interface AttachmentScanResult {
  status: AttachmentScanStatus;
  engine: string | null;
  detail: string;
}

export async function scanUploadFile(filePath: string): Promise<AttachmentScanResult> {
  const cmd = (process.env.ASSET_AV_CMD ?? '').trim();
  if (!cmd) {
    return { status: 'unscanned', engine: null, detail: 'ASSET_AV_CMD not configured' };
  }
  try {
    const { stdout, stderr } = await execFileAsync(cmd, ['--no-summary', filePath], {
      timeout: 20000,
      maxBuffer: 1024 * 1024,
    });
    const text = `${stdout}\n${stderr}`.trim();
    if (/FOUND/i.test(text)) {
      return { status: 'infected', engine: cmd, detail: text.slice(0, 500) };
    }
    return { status: 'clean', engine: cmd, detail: text.slice(0, 500) };
  } catch (e: unknown) {
    const err = e as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    const text = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.trim();
    // clamscan/clamdscan 约定：exit 1 + FOUND 表示检出病毒；其它非 0 视为扫描失败。
    if (err.code === 1 && /FOUND/i.test(text)) {
      return { status: 'infected', engine: cmd, detail: text.slice(0, 500) };
    }
    return {
      status: 'error',
      engine: cmd,
      detail: (text || err.message || 'scan failed').slice(0, 500),
    };
  }
}
