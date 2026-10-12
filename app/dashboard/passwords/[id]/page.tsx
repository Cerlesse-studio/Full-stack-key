'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  Copy,
  Check,
  Eye,
  EyeOff,
  Pencil,
  RotateCcw,
  Trash2,
  Wand2,
  ExternalLink,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  getPasswordDetailAction,
  updatePasswordAction,
  deletePasswordAction,
  restorePasswordAction,
  listTagsAction,
  generatePasswordAction,
} from '@/app/actions/auth';
import { TagPicker } from '@/components/tag-picker';
import { evaluatePasswordStrength } from '@/lib/crypto';
import type { PasswordEntryDecrypted, Tag } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import {
} from '@/components/ui/select';
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
import { PasswordStrength } from '@/components/password-strength';

export const dynamic = 'force-dynamic';

export default function PasswordDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  const [resolvedId, setResolvedId] = useState<string | null>(null);
  const [entry, setEntry] = useState<PasswordEntryDecrypted | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);

  // Controlled form states
  const [site, setSite] = useState('');
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [notes, setNotes] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  // UI states
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [showPassword, setShowPassword] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirmPermanent, setConfirmPermanent] = useState(false);

  useEffect(() => {
    params.then((p) => setResolvedId(p.id));
  }, [params]);

  useEffect(() => {
    if (!resolvedId) return;
    (async () => {
      try {
        const [e, tgs] = await Promise.all([
          getPasswordDetailAction(resolvedId),
          listTagsAction(),
        ]);
        setEntry(e);
        setSite(e.site);
        setUrl(e.url || '');
        setUsername(e.username || '');
        setPassword(e.password);
        setNotes(e.notes || '');
        setSelectedTags(e.tags || []);
        setTags(tgs);
      } catch {
        toast.error('加载密码详情失败');
      } finally {
        setLoading(false);
      }
    })();
  }, [resolvedId]);

  function cancelEdit() {
    if (entry) {
      setSite(entry.site);
      setUrl(entry.url || '');
      setUsername(entry.username || '');
      setPassword(entry.password);
      setNotes(entry.notes || '');
      setSelectedTags(entry.tags || []);
    }
    setMode('view');
    setError('');
  }

  async function handleCopy(field: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(field);
      setTimeout(() => setCopied(null), 1500);
      toast.success('已复制到剪贴板');
    } catch {
      toast.error('复制失败');
    }
  }

  async function handleGenerate(e: React.MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    try {
      const res = await generatePasswordAction({ length: 18 });
      setPassword(res.password);
      toast.success('已生成新强密码');
    } catch {
      toast.error('生成密码失败');
    }
  }

  async function handleSave(e: React.FormEvent<HTMLFormElement>) {
    if (!resolvedId || !entry) return;
    e.preventDefault();
    if (!site.trim()) {
      setError('网站 / 应用名称不能为空');
      return;
    }
    if (!password) {
      setError('密码不能为空');
      return;
    }

    setError('');
    setSaving(true);
    try {
      const formData = new FormData();
      formData.set('site', site.trim());
      formData.set('url', url.trim());
      formData.set('username', username.trim());
      formData.set('password', password);
      formData.set('notes', notes.trim());
      formData.set('tags', selectedTags.join(','));
      formData.set('version', String(entry.version));

      const res = await updatePasswordAction(resolvedId, formData);
      if (!res.ok) {
        setError(res.error || '更新失败');
      } else {
        toast.success('密码已成功更新');
        const updated = await getPasswordDetailAction(resolvedId);
        setEntry(updated);
        setSite(updated.site);
        setUrl(updated.url || '');
        setUsername(updated.username || '');
        setPassword(updated.password);
        setNotes(updated.notes || '');
        setSelectedTags(updated.tags || []);
        setMode('view');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新失败');
    } finally {
      setSaving(false);
    }
  }

  function askDelete(permanent: boolean) {
    if (permanent) {
      setConfirmPermanent(true);
    } else {
      doDelete(false);
    }
  }

  async function doDelete(permanent: boolean) {
    if (!resolvedId) return;
    try {
      await deletePasswordAction(resolvedId, permanent);
      toast.success(permanent ? '已永久删除' : '已移入回收站');
      router.push('/dashboard');
    } catch {
      toast.error('删除失败');
    }
  }

  async function handleRestore() {
    if (!resolvedId) return;
    try {
      await restorePasswordAction(resolvedId);
      toast.success('已恢复密码');
      router.push('/dashboard');
    } catch {
      toast.error('恢复失败');
    }
  }

  // Unified password strength evaluation
  const strengthInfo = evaluatePasswordStrength(password);

  if (loading || !entry) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 py-10">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl pb-12">
      {/* 头部导航与操作 */}
      <div className="mb-6 flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/dashboard" aria-label="返回保险库">
            <ArrowLeft className="size-4" />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-bold tracking-tight">{entry.site}</h1>
          {entry.url && (
            <p className="truncate text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
              <span>{entry.url}</span>
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {entry.trashed ? (
            <Button onClick={handleRestore} className="gap-1.5">
              <RotateCcw className="size-4" />
              恢复
            </Button>
          ) : (
            <Button
              variant={mode === 'view' ? 'default' : 'outline'}
              onClick={() => {
                if (mode === 'edit') {
                  cancelEdit();
                } else {
                  setMode('edit');
                }
              }}
              className="gap-1.5"
            >
              <Pencil className="size-3.5" />
              {mode === 'view' ? '编辑' : '取消'}
            </Button>
          )}
          <Button
            variant="destructive"
            size="icon"
            onClick={() => askDelete(entry.trashed)}
            title={entry.trashed ? '永久删除' : '移入回收站'}
          >
            <Trash2 className="size-4" />
            <span className="sr-only">{entry.trashed ? '永久删除' : '移入回收站'}</span>
          </Button>
        </div>
      </div>

      {error && mode === 'edit' && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <form onSubmit={handleSave} className="space-y-5 rounded-xl border bg-card p-6 shadow-sm md:p-8">
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          {/* 网站名称 */}
          <div className="space-y-2 md:col-span-2">
            <Label className="text-xs font-medium">网站 / 应用名称</Label>
            {mode === 'view' ? (
              <div className="rounded-lg border bg-muted/40 px-3.5 py-2.5 text-sm font-medium">
                {entry.site}
              </div>
            ) : (
              <Input
                name="site"
                required
                value={site}
                onChange={(e) => setSite(e.target.value)}
                placeholder="例如：GitHub"
              />
            )}
          </div>

          {/* 网址 URL */}
          <div className="space-y-2 md:col-span-2">
            <Label className="text-xs font-medium">网址 (URL)</Label>
            {mode === 'view' ? (
              entry.url ? (
                <div className="flex items-center justify-between rounded-lg border bg-muted/40 px-3.5 py-2 text-sm">
                  <span className="truncate text-primary">{entry.url}</span>
                  <a
                    href={entry.url.startsWith('http') ? entry.url : 'https://' + entry.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground ml-2 shrink-0"
                  >
                    <span>访问</span>
                    <ExternalLink className="size-3.5" />
                  </a>
                </div>
              ) : (
                <div className="rounded-lg border bg-muted/40 px-3.5 py-2.5 text-sm text-muted-foreground italic">
                  未关联网址
                </div>
              )
            ) : (
              <Input
                name="url"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://..."
              />
            )}
          </div>

          {/* 用户名 */}
          <div className="space-y-2">
            <Label className="text-xs font-medium">用户名 / 账号</Label>
            {mode === 'view' ? (
              <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-sm">
                  {entry.username || <span className="text-muted-foreground italic font-normal">(未设置用户名)</span>}
                </span>
                {entry.username && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    onClick={() => handleCopy('user', entry.username)}
                    title="复制用户名"
                  >
                    {copied === 'user' ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
                  </Button>
                )}
              </div>
            ) : (
              <Input
                name="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="用户名或邮箱"
                autoComplete="off"
              />
            )}
          </div>

          {/* 密码 */}
          <div className="space-y-2 md:col-span-2">
            <Label className="text-xs font-medium">密码</Label>
            {mode === 'view' ? (
              <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
                <code className="min-w-0 flex-1 break-all font-mono text-sm tracking-wide">
                  {showPassword ? entry.password : '•'.repeat(Math.min(entry.password.length, 24))}
                </code>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowPassword(!showPassword)}
                  title={showPassword ? '隐藏密码' : '显示密码'}
                >
                  {showPassword ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground hover:text-foreground"
                  onClick={() => handleCopy('pwd', entry.password)}
                  title="复制密码"
                >
                  {copied === 'pwd' ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="relative">
                  <Input
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="off"
                    className="pr-24 font-mono text-sm"
                  />
                  <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="h-7 px-2 text-xs gap-1"
                      onClick={handleGenerate}
                    >
                      <Wand2 className="size-3" />
                      生成
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7 text-muted-foreground hover:text-foreground"
                      onClick={() => setShowPassword(!showPassword)}
                    >
                      {showPassword ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                      <span className="sr-only">{showPassword ? '隐藏密码' : '显示密码'}</span>
                    </Button>
                  </div>
                </div>

                {/* 密码强度指示 */}
                <div className="space-y-1 pt-1">
                  <PasswordStrength score={strengthInfo.score} />
                  {strengthInfo.suggestions.length > 0 && (
                    <p className="text-[11px] text-muted-foreground">
                      提示: {strengthInfo.suggestions.join('，')}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* 备注 */}
          <div className="space-y-2 md:col-span-2">
            <Label className="text-xs font-medium">私密备注</Label>
            {mode === 'view' ? (
              <div className="min-h-16 whitespace-pre-wrap rounded-lg border bg-muted/40 px-3.5 py-2.5 text-sm">
                {entry.notes || <span className="italic text-muted-foreground">暂无备注</span>}
              </div>
            ) : (
              <Textarea
                name="notes"
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="备用码、PIN、提示问题等..."
                className="resize-none"
              />
            )}
          </div>

          {/* 标签 */}
          <div className="space-y-2 md:col-span-2">
            <Label className="text-xs font-medium">标签</Label>
            <TagPicker
              tags={tags}
              value={selectedTags}
              onChange={setSelectedTags}
              readOnly={mode === 'view'}
            />
          </div>
        </div>

        {/* 元数据时间 */}
        <div className="space-y-1 border-t pt-4 text-xs text-muted-foreground">
          <div>创建于：{new Date(entry.createdAt).toLocaleString()}</div>
          <div>
            更新于：{new Date(entry.updatedAt).toLocaleString()} · 版本 {entry.version}
          </div>
          {entry.trashedAt && <div>删除于：{new Date(entry.trashedAt).toLocaleString()}</div>}
        </div>

        {mode === 'edit' && (
          <div className="flex items-center justify-end gap-3 pt-2">
            <Button type="button" variant="outline" onClick={cancelEdit} disabled={saving}>
              取消
            </Button>
            <Button type="submit" disabled={saving} className="min-w-28">
              {saving ? '保存中...' : '保存修改'}
            </Button>
          </div>
        )}
      </form>

      {/* 永久删除确认弹窗 */}
      <AlertDialog open={confirmPermanent} onOpenChange={setConfirmPermanent}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>永久删除该密码？</AlertDialogTitle>
            <AlertDialogDescription>此操作无法撤销，密码条目将被永久删除。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                setConfirmPermanent(false);
                doDelete(true);
              }}
            >
              永久删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
