import type { NextRequest } from 'next/server';
import { handleRouteError } from '@/lib/errors';
import { jsonSuccess, jsonError } from '@/lib/utils/response';
import { getRequestAuthContext } from '@/lib/auth/context';
import {
  getBackupRecords,
  getBackupSettings,
  createBackup,
  loadBackupSecret,
  publicSettings,
} from '@/lib/backup';
import { getCapabilities } from '@/lib/backup/targets';
import { encryptAESGCM, decryptAESGCM, deriveMasterKey } from '@/lib/crypto';
import { getConfig } from '@/lib/repositories/configRepository';
import type { BackupTarget } from '@/lib/backup/types';

export const dynamic = 'force-dynamic';

/** GET /api/backups — 列出备份记录（不回传密文） */
export async function GET(request: NextRequest) {
  try {
    await getRequestAuthContext(request);
    const [records, settings, capabilities] = await Promise.all([
      getBackupRecords(),
      getBackupSettings(),
      Promise.resolve(getCapabilities()),
    ]);
    return jsonSuccess({ records, settings: publicSettings(settings), capabilities });
  } catch (err) {
    return handleRouteError(err);
  }
}

/**
 * POST /api/backups — 立即创建一次备份 / 校验两层凭据
 *
 * Body: {
 *   "passphrase": "外层备份密码",
 *   "adminPassword": "内层管理员密码",
 *   "targets": ["database"], "includeSecrets": true
 * }
 * 带 "id" 时为校验模式，两层都通过才会返回 verified。
 */
export async function POST(request: NextRequest) {
  try {
    const ctx = await getRequestAuthContext(request);
    const body = (await request.json().catch(() => ({}))) as {
      passphrase?: string;
      adminPassword?: string;
      targets?: BackupTarget[];
      includeSecrets?: boolean;
      id?: string;
    };

    // 校验模式：必须两层都提供
    if (body.id) {
      if (!body.passphrase || !body.adminPassword) {
        return jsonError(
          'BACKUP_CREDENTIALS_REQUIRED',
          '校验备份需要同时提供备份密码与管理员密码',
          undefined,
          400
        );
      }
      const records = await getBackupRecords();
      const record = records.find((r) => r.id === body.id);
      if (!record) return jsonError('BACKUP_NOT_FOUND', '备份不存在', undefined, 404);
      const secret = await loadBackupSecret(record, {
        passphrase: body.passphrase,
        adminPassword: body.adminPassword,
      });
      return jsonSuccess({ verified: true, owner: secret.adminUsername });
    }

    const passphrase = body.passphrase || process.env.BACKUP_PASSPHRASE;
    if (!passphrase) {
      return jsonError('BACKUP_PASSPHRASE_REQUIRED', '请提供备份密码', undefined, 400);
    }

    const adminPassword = body.adminPassword || process.env.BACKUP_ADMIN_PASSWORD;
    if (!adminPassword) {
      return jsonError(
        'BACKUP_ADMIN_PASSWORD_REQUIRED',
        '请提供管理员密码（内层认证）',
        undefined,
        400
      );
    }

    // 内层密钥由管理员密码派生，密码错了会产出永远打不开的备份，必须先拦
    const config = await getConfig();
    if (config) {
      const probe = await encryptAESGCM(ctx.masterKey, 'freebuff-admin-probe');
      const candidate = await deriveMasterKey(
        adminPassword,
        config.masterSalt,
        config.pbkdf2Iterations
      );
      let matched = false;
      try {
        matched =
          (await decryptAESGCM(candidate, probe.iv, probe.ciphertext, probe.tag)) ===
          'freebuff-admin-probe';
      } catch {
        matched = false;
      }
      if (!matched) {
        return jsonError('ADMIN_PASSWORD_INVALID', '管理员密码不正确', undefined, 400);
      }
    }

    const result = await createBackup({
      ownerId: ctx.ownerId,
      passphrase,
      adminPassword,
      targets: body.targets?.length ? body.targets : ['database'],
      reason: 'manual',
      includeSecrets: body.includeSecrets !== false,
    });

    return jsonSuccess({ record: result.record, partial: result.partial }, undefined, { status: 201 });
  } catch (err) {
    return handleRouteError(err);
  }
}