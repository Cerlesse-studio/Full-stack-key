'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Archive,
  CheckCircle2,
  Database,
  Download,
  Folder,
  GitBranch,
  Loader2,
  Play,
  RotateCcw,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  getBackupOverviewAction,
  createBackupAction,
  deleteBackupAction,
  restoreBackupAction,
  getBackupFileAction,
  importBackupFileAction,
  testBackupTargetAction,
  saveBackupSettingsAction,
  checkAutoBackupAction,
  forceAutoBackupAction,
  type BackupOverview,
} from '@/app/actions/backup';
import { BACKUP_TARGET_LABELS, type BackupRecord, type BackupTarget } from '@/lib/backup/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

export const dynamic = 'force-dynamic';

const ALL_TARGETS: BackupTarget[] = ['database', 'local', 'git'];

const TARGET_ICONS: Record<BackupTarget, typeof Database> = {
  database: Database,
  local: Folder,
  git: GitBranch,
};

const REASON_LABELS: Record<BackupRecord['reason'], string> = {
  manual: '手动',
  auto: '自动',
  'pre-reset': '重置前',
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString('zh-CN')} ${d.toLocaleTimeString('zh-CN', { hour12: false })}`;
}

export default function BackupsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<BackupOverview | null>(null);

  // 立即备份
  const [passphrase, setPassphrase] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [rememberPassphrase, setRememberPassphrase] = useState(false);
  const [targets, setTargets] = useState<BackupTarget[]>(['database']);
  const [includeSecrets, setIncludeSecrets] = useState(true);
  const [creating, setCreating] = useState(false);

  // 自动备份
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [intervalHours, setIntervalHours] = useState(24);
  const [retention, setRetention] = useState(7);
  const [autoTargets, setAutoTargets] = useState<BackupTarget[]>(['database']);
  const [autoPassphrase, setAutoPassphrase] = useState('');
  const [savingSettings, setSavingSettings] = useState(false);
  const [runningAuto, setRunningAuto] = useState(false);
  const [testingTarget, setTestingTarget] = useState<BackupTarget | null>(null);

  // 恢复 / 删除
  const [restoreId, setRestoreId] = useState<string | null>(null);
  const [restorePassphrase, setRestorePassphrase] = useState('');
  const [restoreAdminPassword, setRestoreAdminPassword] = useState('');
  const [restoreStrategy, setRestoreStrategy] = useState<'skip' | 'overwrite' | 'duplicate'>('skip');
  const [restoreConfig, setRestoreConfig] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const overview = await getBackupOverviewAction();
      setData(overview);
      setAutoEnabled(overview.settings.enabled);
      setIntervalHours(overview.settings.intervalHours);
      setRetention(overview.settings.retention);
      setAutoTargets(overview.settings.targets);
      setIncludeSecrets(overview.settings.includeSecrets);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加载备份信息失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 延后一拍再拉数据：避免在 effect 体内同步写 state 造成级联渲染
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  // 页面停留期间定期检查自动备份（尊重间隔，未到期时为空操作）
  useEffect(() => {
    const timer = setInterval(() => {
      void checkAutoBackupAction()
        .then((res) => {
          if (res.ran) {
            toast.success('自动备份已完成');
            void load();
          }
        })
        .catch(() => {});
    }, 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, [load]);

  const capabilities = data?.capabilities;
  const records = useMemo(() => data?.records ?? [], [data]);

  function targetUsable(target: BackupTarget): boolean {
    if (!capabilities) return false;
    switch (target) {
      case 'database':
        return true;
      case 'local':
        return capabilities.local;
      case 'git':
        return capabilities.gitConfigured;
      default:
        return false;
    }
  }

  function toggle(list: BackupTarget[], target: BackupTarget, current: BackupTarget[]) {
    void list;
    return current.includes(target)
      ? current.filter((t) => t !== target)
      : [...current, target];
  }

  async function handleCreate() {
    if (targets.length === 0) {
      toast.error('请至少选择一个备份目标');
      return;
    }
    // 提交前先本地校验，避免把「没填」发到服务端才报出让人误解的长度错误
    if (!adminPassword.trim()) {
      toast.error('请在「第 2 层 · 管理员密码」中填写保险库主密码，它是备份的内层认证');
      return;
    }
    if (adminPassword.trim().length < 8) {
      toast.error(`管理员密码至少 8 个字符（当前 ${adminPassword.trim().length} 个）`);
      return;
    }
    setCreating(true);
    try {
      const res = await createBackupAction({
        passphrase: passphrase.trim() || undefined,
        adminPassword: adminPassword.trim(),
        rememberPassphrase,
        targets,
        includeSecrets,
      });
      if (res.partial) {
        toast.warning('备份已创建，但部分目标写入失败，详见列表中的状态');
      } else {
        toast.success('备份完成');
      }
      setPassphrase('');
      setAdminPassword('');
      setRememberPassphrase(false);
      await load();
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '备份失败');
    } finally {
      setCreating(false);
    }
  }

  async function handleTest(target: BackupTarget) {
    setTestingTarget(target);
    try {
      const res = await testBackupTargetAction(target);
      if (res.ok) toast.success(`${BACKUP_TARGET_LABELS[target]}：${res.detail}`);
      else toast.error(`${BACKUP_TARGET_LABELS[target]}：${res.detail}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '测试失败');
    } finally {
      setTestingTarget(null);
    }
  }

  async function handleSaveSettings() {
    setSavingSettings(true);
    try {
      await saveBackupSettingsAction({
        enabled: autoEnabled,
        intervalHours,
        targets: autoTargets,
        retention,
        includeSecrets,
        passphrase: autoPassphrase.trim() || undefined,
      });
      toast.success('自动备份设置已保存');
      setAutoPassphrase('');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleForceAuto() {
    setRunningAuto(true);
    try {
      const res = await forceAutoBackupAction();
      if (res.ran) {
        toast.success('自动备份已执行');
        await load();
      } else {
        toast.warning(`未执行：${res.reason}${res.error ? `（${res.error}）` : ''}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '执行失败');
    } finally {
      setRunningAuto(false);
    }
  }

  async function handleRestore() {
    if (!restoreId) return;
    if (!restorePassphrase.trim() || !restoreAdminPassword.trim()) {
      toast.error('恢复需要同时输入「第 1 层 备份密码」与「第 2 层 管理员密码」');
      return;
    }
    if (restorePassphrase.trim().length < 8) {
      toast.error(`备份密码至少 8 个字符（当前 ${restorePassphrase.trim().length} 个）`);
      return;
    }
    if (restoreAdminPassword.trim().length < 8) {
      toast.error(`管理员密码至少 8 个字符（当前 ${restoreAdminPassword.trim().length} 个）`);
      return;
    }
    setRestoring(true);
    try {
      const res = await restoreBackupAction({
        id: restoreId,
        passphrase: restorePassphrase.trim(),
        adminPassword: restoreAdminPassword.trim(),
        strategy: restoreStrategy,
        restoreConfig,
      });
      const { passwords, tagsCreated } = res.result;
      toast.success(
        `恢复完成：导入 ${passwords.imported} 条密码、新建 ${tagsCreated} 个标签`
      );
      for (const w of res.result.warnings) toast.warning(w);
      setRestoreId(null);
      setRestorePassphrase('');
      setRestoreAdminPassword('');
      setRestoreConfig(false);
      await load();
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '恢复失败');
    } finally {
      setRestoring(false);
    }
  }

  async function handleDownload(record: BackupRecord) {
    const outer = window.prompt('第 1 层 · 请输入备份密码');
    if (outer === null) return;
    const inner = window.prompt('第 2 层 · 请输入管理员密码');
    if (inner === null) return;
    setDownloadingId(record.id);
    try {
      const file = await getBackupFileAction(record.id, outer, inner);
      const blob = new Blob([file.content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '下载失败');
    } finally {
      setDownloadingId(null);
    }
  }

  async function handleDelete() {
    if (!deleteId) return;
    setDeleting(true);
    try {
      await deleteBackupAction(deleteId);
      toast.success('备份已删除');
      setDeleteId(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败');
    } finally {
      setDeleting(false);
    }
  }

  async function handleImportFile(file: File) {
    setImporting(true);
    try {
      const content = await file.text();
      const outer = window.prompt('第 1 层 · 该备份的备份密码（留空则跳过校验）', '');
      if (outer === null) {
        setImporting(false);
        return;
      }
      const inner = window.prompt('第 2 层 · 创建该备份时的管理员密码（留空则跳过校验）', '');
      if (inner === null) {
        setImporting(false);
        return;
      }
      const res = await importBackupFileAction({
        filename: file.name,
        content,
        passphrase: outer.trim() || undefined,
        adminPassword: inner.trim() || undefined,
      });
      toast.success(`已导入备份：${res.record.summary.passwords} 条密码`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '导入失败');
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2.5 text-2xl font-bold tracking-tight">
          <Archive className="size-6 text-primary" />
          备份管理
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          备份为单个 <code className="rounded bg-muted px-1 py-0.5 text-xs">.fbk</code>{' '}
          文件，内含两层独立加密：外层用「备份密码」（AES-256-GCM），
          内层用「管理员密码 + 账号名」（AES-256-CBC + HMAC-SHA256）。
          缺少任意一层都无法读取明文。
        </p>
      </div>

      {capabilities && !capabilities.local && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-amber-700 dark:text-amber-400">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>当前运行在 Cloudflare 环境，无法写入本地文件；请使用 git 仓库或数据库快照。</span>
        </div>
      )}

      {/* 立即备份 */}
      <section className="space-y-4 rounded-xl border bg-card p-6 shadow-sm">
        <div>
          <h2 className="font-semibold">立即备份</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            手动创建一份快照，可同时写入多个目标
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="backupPassphrase">
              第 1 层 · 备份密码
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">AES-256-GCM</span>
            </Label>
            <Input
              id="backupPassphrase"
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="至少 8 位；留空则用已保存的"
              autoComplete="new-password"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="adminPassword">
              第 2 层 · 管理员密码
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">AES-CBC+HMAC</span>
            </Label>
            <Input
              id="adminPassword"
              type="password"
              value={adminPassword}
              onChange={(e) => setAdminPassword(e.target.value)}
              placeholder="即当前保险库的主密码"
              autoComplete="current-password"
            />
          </div>
        </div>
          <label className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={rememberPassphrase}
              onChange={(e) => setRememberPassphrase(e.target.checked)}
              className="size-3.5"
            />
            记住该密码（用主密钥加密保存，供自动备份使用）
          </label>

        <div className="space-y-2">
          <Label>备份目标</Label>
          <div className="grid gap-2 sm:grid-cols-2">
            {ALL_TARGETS.map((t) => {
              const Icon = TARGET_ICONS[t];
              const usable = targetUsable(t);
              return (
                <div
                  key={t}
                  className={`flex items-center justify-between gap-2 rounded-lg border p-3 text-sm ${
                    usable ? '' : 'opacity-50'
                  }`}
                >
                  <label className="flex min-w-0 items-center gap-2">
                    <input
                      type="checkbox"
                      disabled={!usable}
                      checked={targets.includes(t)}
                      onChange={() => setTargets((prev) => toggle(ALL_TARGETS, t, prev))}
                      className="size-4"
                    />
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{BACKUP_TARGET_LABELS[t]}</span>
                  </label>
                  {t !== 'database' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 shrink-0 px-2 text-xs"
                      disabled={!usable || testingTarget === t}
                      onClick={() => void handleTest(t)}
                    >
                      {testingTarget === t ? <Loader2 className="size-3 animate-spin" /> : '测试'}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={includeSecrets}
            onChange={(e) => setIncludeSecrets(e.target.checked)}
            className="size-4"
          />
          包含主密码与 API 密钥（已加密，可在空库中完整恢复）
        </label>

        <Button onClick={() => void handleCreate()} disabled={creating || targets.length === 0}>
          {creating ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
          {creating ? '正在备份...' : '创建备份'}
        </Button>
      </section>

      {/* 自动备份 */}
      <section className="space-y-4 rounded-xl border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold">自动备份</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              登录访问时按间隔自动执行，无需保持页面打开
            </p>
          </div>
          <Switch checked={autoEnabled} onCheckedChange={setAutoEnabled} aria-label="启用自动备份" />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="interval">间隔（小时）</Label>
            <Input
              id="interval"
              type="number"
              min={1}
              max={720}
              value={intervalHours}
              onChange={(e) => setIntervalHours(Number(e.target.value) || 24)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="retention">保留份数（每个目标）</Label>
            <Input
              id="retention"
              type="number"
              min={1}
              max={100}
              value={retention}
              onChange={(e) => setRetention(Number(e.target.value) || 7)}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="autoPass">备份密码（留空表示不修改）</Label>
          <Input
            id="autoPass"
            type="password"
            value={autoPassphrase}
            onChange={(e) => setAutoPassphrase(e.target.value)}
            placeholder="自动备份需要它来加密；也可配置环境变量 BACKUP_PASSPHRASE"
            autoComplete="new-password"
          />
        </div>

        <div className="space-y-2">
          <Label>自动备份目标</Label>
          <div className="flex flex-wrap gap-2">
            {ALL_TARGETS.map((t) => {
              const usable = targetUsable(t);
              return (
                <label
                  key={t}
                  className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm ${
                    usable ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'
                  }`}
                >
                  <input
                    type="checkbox"
                    disabled={!usable}
                    checked={autoTargets.includes(t)}
                    onChange={() => setAutoTargets((prev) => toggle(ALL_TARGETS, t, prev))}
                    className="size-3.5"
                  />
                  {BACKUP_TARGET_LABELS[t]}
                </label>
              );
            })}
          </div>
        </div>

        {data?.settings.lastRunAt && (
          <p className="text-xs text-muted-foreground">
            上次运行：{formatTime(data.settings.lastRunAt)}
            {data.settings.lastResult ? ` · ${data.settings.lastResult}` : ''}
          </p>
        )}

        <Separator />

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void handleSaveSettings()} disabled={savingSettings}>
            {savingSettings && <Loader2 className="size-4 animate-spin" />}
            保存自动备份设置
          </Button>
          <Button
            variant="outline"
            onClick={() => void handleForceAuto()}
            disabled={runningAuto || !autoEnabled}
          >
            {runningAuto ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            立即执行一次
          </Button>
        </div>
      </section>

      {/* 备份列表 */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">备份记录（{records.length}）</h2>
          <div className="flex gap-1">
            <input
              ref={fileInputRef}
              type="file"
              accept=".fbk,text/plain"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleImportFile(f);
              }}
            />
            <Button
              variant="ghost"
              size="sm"
              disabled={importing}
              onClick={() => fileInputRef.current?.click()}
            >
              {importing ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
              导入文件
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void load()}>
              刷新
            </Button>
          </div>
        </div>

        {records.length === 0 ? (
          <div className="rounded-xl border border-dashed py-12 text-center text-sm text-muted-foreground">
            还没有任何备份，建议先创建一份。
          </div>
        ) : (
          <div className="space-y-2">
            {records.map((record) => {
              const failed = record.deliveries.filter((d) => !d.ok);
              const hasSecrets = record.summary.includesSecrets;
              return (
                <div key={record.id} className="rounded-xl border bg-card p-4 shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{formatTime(record.createdAt)}</span>
                        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                          {REASON_LABELS[record.reason]}
                        </span>
                        {hasSecrets && (
                          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                            含配置
                          </span>
                        )}
                        {failed.length === 0 ? (
                          <span className="flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-xs text-green-600 dark:text-green-400">
                            <CheckCircle2 className="size-3" /> 全部成功
                          </span>
                        ) : (
                          <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive">
                            {failed.length} 个目标失败
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {record.summary.passwords} 条密码 · {record.summary.tags} 个标签 ·{' '}
                        {formatSize(record.size)}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {record.deliveries.map((d) => {
                          const Icon = TARGET_ICONS[d.target];
                          return (
                            <span
                              key={d.target}
                              title={d.ok ? d.location : d.error}
                              className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${
                                d.ok
                                  ? 'border-border text-muted-foreground'
                                  : 'border-destructive/40 text-destructive'
                              }`}
                            >
                              <Icon className="size-3" />
                              {BACKUP_TARGET_LABELS[d.target]}
                            </span>
                          );
                        })}
                      </div>
                    </div>

                    <div className="flex shrink-0 gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1"
                        onClick={() => {
                          setRestoreId(record.id);
                          setRestorePassphrase('');
                          setRestoreConfig(false);
                        }}
                      >
                        <RotateCcw className="size-3.5" />
                        恢复
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1"
                        disabled={downloadingId === record.id}
                        onClick={() => void handleDownload(record)}
                      >
                        {downloadingId === record.id ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Download className="size-3.5" />
                        )}
                        下载
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => setDeleteId(record.id)}
                      >
                        <Trash2 className="size-3.5" />
                        删除
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* 恢复对话框 */}
      <Dialog open={!!restoreId} onOpenChange={(open) => !open && setRestoreId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>从备份恢复</DialogTitle>
            <DialogDescription>
              恢复会把备份中的密码、分类与标签导入当前保险库。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="restorePass">第 1 层 · 备份密码</Label>
              <Input
                id="restorePass"
                type="password"
                value={restorePassphrase}
                onChange={(e) => setRestorePassphrase(e.target.value)}
                placeholder="创建该备份时使用的备份密码"
                autoComplete="current-password"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="restoreAdminPass">第 2 层 · 管理员密码</Label>
              <Input
                id="restoreAdminPass"
                type="password"
                value={restoreAdminPassword}
                onChange={(e) => setRestoreAdminPassword(e.target.value)}
                placeholder="创建该备份时的管理员密码"
                autoComplete="current-password"
              />
              <p className="text-xs text-muted-foreground">
                两层都正确才会恢复；主密码不会被覆盖，密码条目会用当前保险库密钥重新加密。
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>冲突策略</Label>
              <div className="flex gap-2">
                {(
                  [
                    { v: 'skip', l: '跳过' },
                    { v: 'overwrite', l: '覆盖' },
                    { v: 'duplicate', l: '保留两份' },
                  ] as const
                ).map((opt) => (
                  <label
                    key={opt.v}
                    className={`flex-1 cursor-pointer rounded-lg border px-3 py-2 text-center text-sm ${
                      restoreStrategy === opt.v ? 'border-primary bg-primary/5' : ''
                    }`}
                  >
                    <input
                      type="radio"
                      className="hidden"
                      checked={restoreStrategy === opt.v}
                      onChange={() => setRestoreStrategy(opt.v)}
                    />
                    {opt.l}
                  </label>
                ))}
              </div>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={restoreConfig}
                onChange={(e) => setRestoreConfig(e.target.checked)}
                className="mt-0.5 size-4"
              />
              <span>
                同时恢复 API 密钥
                <span className="block text-xs text-muted-foreground">
                  主密码永远不会被备份覆盖：两层认证已经证明你知道它，条目也会用当前密钥重新加密
                </span>
              </span>
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRestoreId(null)} disabled={restoring}>
              取消
            </Button>
            <Button onClick={() => void handleRestore()} disabled={restoring || !restorePassphrase}>
              {restoring && <Loader2 className="size-4 animate-spin" />}
              开始恢复
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <AlertDialog open={!!deleteId} onOpenChange={(open) => !open && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="size-5" />
              删除该备份？
            </AlertDialogTitle>
            <AlertDialogDescription>
              将同时删除各目标中的副本（本地文件 / git 仓库 / 库内快照），此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                void handleDelete();
              }}
            >
              {deleting ? '正在删除...' : '确认删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
