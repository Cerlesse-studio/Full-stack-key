'use client';

import Link from 'next/link';
import { Suspense, useEffect, useState, useRef } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import {
  Copy,
  Check,
  KeyRound,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Search,
  Tag as TagIcon,
  Trash2,
  X,
  ExternalLink,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  listPasswordsAction,
  deletePasswordAction,
  restorePasswordAction,
  listTagsAction,
} from '@/app/actions/auth';
import type { PasswordEntryDecrypted, Tag } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { cn } from '@/lib/utils/cn';

function DashboardInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialSearch = searchParams.get('search') || '';
  const initialTag = searchParams.get('tag') || '';
  const initialTrashed = searchParams.get('trashed') === 'true';

  const [passwords, setPasswords] = useState<PasswordEntryDecrypted[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [search, setSearch] = useState(initialSearch);
  const [selectedTag, setSelectedTag] = useState(initialTag);
  const [showTrashed, setShowTrashed] = useState(initialTrashed);

  // 分页与排序
  const [sortBy, setSortBy] = useState<
    'updatedAt_desc' | 'updatedAt_asc' | 'site_asc' | 'site_desc' | 'createdAt_desc'
  >('updatedAt_desc');
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(24);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; permanent: boolean } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const searchInputRef = useRef<HTMLInputElement>(null);

  // 快捷键支持：Ctrl/Cmd + N 新建密码，/ 聚焦搜索框
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        router.push('/dashboard/passwords/new');
      } else if (e.key === '/' && document.activeElement !== searchInputRef.current) {
        const tagName = (document.activeElement?.tagName || '').toLowerCase();
        if (tagName !== 'input' && tagName !== 'textarea') {
          e.preventDefault();
          searchInputRef.current?.focus();
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [router]);

  // 数据加载（含搜索/过滤防抖）
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const [result, tgs] = await Promise.all([
          listPasswordsAction({
            search,
            tag: selectedTag || undefined,
            trashed: showTrashed,
            sortBy,
            page,
            perPage,
          }),
          listTagsAction(),
        ]);
        if (!cancelled) {
          setPasswords(result.items || []);
          setTotal(result.total ?? (result.items || []).length);
          setTotalPages(result.totalPages ?? 1);
          setTags(tgs);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [search, selectedTag, showTrashed, sortBy, page, perPage, reloadKey]);

  async function handleCopy(id: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(id);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      toast.error('复制失败');
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    try {
      await deletePasswordAction(pendingDelete.id, pendingDelete.permanent);
      toast.success(pendingDelete.permanent ? '已永久删除' : '已移入回收站');
      setReloadKey((k) => k + 1);
    } catch {
      toast.error('删除失败');
    } finally {
      setPendingDelete(null);
    }
  }

  async function handleRestore(id: string) {
    try {
      await restorePasswordAction(id);
      toast.success('已恢复');
      setReloadKey((k) => k + 1);
    } catch {
      toast.error('恢复失败');
    }
  }

  function getTagById(id: string) {
    return tags.find((t) => t.id === id);
  }

  return (
    <div className="space-y-6">
      {/* 页头 */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {showTrashed ? '回收站' : '全部密码'}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">共 {total} 条记录</p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* 回收站切换 Segmented Control */}
          <div className="flex rounded-lg border bg-muted/60 p-0.5 text-xs">
            <button
              type="button"
              onClick={() => {
                setShowTrashed(false);
                setPage(1);
              }}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition-colors',
                !showTrashed
                  ? 'bg-background text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              全部密码
            </button>
            <button
              type="button"
              onClick={() => {
                setShowTrashed(true);
                setPage(1);
              }}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition-colors',
                showTrashed
                  ? 'bg-background text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Trash2 className="size-3.5" />
              回收站
            </button>
          </div>

          {/* 新建密码入口按钮 */}
          <Button asChild className="gap-1.5 shadow-sm">
            <Link href="/dashboard/passwords/new">
              <Plus className="size-4" />
              <span>新建密码</span>
            </Link>
          </Button>
        </div>
      </div>

      {/* 搜索与过滤栏 */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        {/* 搜索框 */}
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchInputRef}
            type="text"
            placeholder="按网站、网址或用户名搜索... (按 / 聚焦，Ctrl+N 新建)"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="pl-9 pr-9"
          />
          {search && (
            <button
              type="button"
              onClick={() => {
                setSearch('');
                setPage(1);
              }}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground rounded-full"
              title="清空搜索"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        {/* 标签下拉 */}
        <Select
          value={selectedTag || 'all'}
          onValueChange={(v) => {
            setSelectedTag(v === 'all' ? '' : v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-full md:w-36">
            <SelectValue placeholder="全部标签" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部标签</SelectItem>
            {tags.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                #{t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* 排序下拉 */}
        <Select
          value={sortBy}
          onValueChange={(v: any) => {
            setSortBy(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-full md:w-36">
            <div className="flex items-center gap-1.5 truncate">
              <ArrowUpDown className="size-3.5 text-muted-foreground shrink-0" />
              <SelectValue placeholder="排序方式" />
            </div>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="updatedAt_desc">最近更新</SelectItem>
            <SelectItem value="site_asc">名称 (A-Z)</SelectItem>
            <SelectItem value="site_desc">名称 (Z-A)</SelectItem>
            <SelectItem value="createdAt_desc">最新创建</SelectItem>
            <SelectItem value="updatedAt_asc">最早更新</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* 列表 */}
      {loading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="space-y-3 rounded-xl border bg-card p-5">
              <div className="flex items-center gap-3">
                <Skeleton className="size-10 rounded-lg" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-3 w-40" />
                </div>
              </div>
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          ))}
        </div>
      ) : passwords.length === 0 ? (
        <div className="rounded-xl border border-dashed py-20 text-center">
          <div className="mb-4 inline-flex size-16 items-center justify-center rounded-2xl bg-muted">
            <KeyRound className="size-8 text-muted-foreground" />
          </div>
          <h3 className="mb-2 text-lg font-semibold">{showTrashed ? '回收站为空' : '还没有保存任何密码'}</h3>
          <p className="text-sm text-muted-foreground max-w-sm mx-auto">
            {showTrashed
              ? '已删除的密码会显示在这里，可随时恢复或永久删除。'
              : '可通过浏览器扩展自动保存密码，或在设置中导入已有密码。'}
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {passwords.map((entry) => (
              <div
                key={entry.id}
                className="group relative rounded-xl border bg-card p-5 shadow-xs transition-all hover:border-ring/40 hover:shadow-md"
              >
                <div className="mb-3 flex items-start justify-between gap-3">
                  <Link
                    href={`/dashboard/passwords/${entry.id}`}
                    className="flex min-w-0 flex-1 items-center gap-3 group-hover:text-primary transition-colors text-left"
                  >
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 font-bold text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                      {entry.site.charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <h3 className="truncate font-semibold">{entry.site}</h3>
                      {entry.url ? (
                        <p className="truncate text-xs text-muted-foreground flex items-center gap-1">
                          <span>{entry.url.replace(/^https?:\/\//, '')}</span>
                        </p>
                      ) : (
                        <p className="text-xs text-muted-foreground">未关联网址</p>
                      )}
                    </div>
                  </Link>

                  <div className="flex items-center gap-1">
                    {entry.url && (
                      <a
                        href={entry.url.startsWith('http') ? entry.url : `https://${entry.url}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground opacity-60 group-hover:opacity-100 transition-opacity"
                        title="打开网站"
                      >
                        <ExternalLink className="size-3.5" />
                      </a>
                    )}

                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="size-8">
                          <MoreHorizontal className="size-4" />
                          <span className="sr-only">操作</span>
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem asChild>
                          <Link href={`/dashboard/passwords/${entry.id}`}>查看详情与编辑</Link>
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        {showTrashed ? (
                          <>
                            <DropdownMenuItem onClick={() => handleRestore(entry.id)}>
                              <RotateCcw className="mr-2 size-4" />
                              恢复密码
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() => setPendingDelete({ id: entry.id, permanent: true })}
                            >
                              <Trash2 className="mr-2 size-4" />
                              永久删除
                            </DropdownMenuItem>
                          </>
                        ) : (
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => setPendingDelete({ id: entry.id, permanent: false })}
                          >
                            <Trash2 className="mr-2 size-4" />
                            移入回收站
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>

                {/* 账号与密码字段 */}
                <div className="space-y-2 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="w-12 shrink-0 text-xs text-muted-foreground">用户名</span>
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {entry.username || <span className="text-muted-foreground/60">未填写</span>}
                    </span>
                    {entry.username && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        onClick={() => handleCopy(entry.id + '-u', entry.username)}
                        title="复制用户名"
                      >
                        {copied === entry.id + '-u' ? (
                          <Check className="size-3.5 text-emerald-500" />
                        ) : (
                          <Copy className="size-3.5 text-muted-foreground" />
                        )}
                      </Button>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="w-12 shrink-0 text-xs text-muted-foreground">密码</span>
                    <span className="min-w-0 flex-1 truncate font-mono tracking-wider text-xs">
                      {'•'.repeat(Math.min(entry.password.length, 14))}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={() => handleCopy(entry.id + '-p', entry.password)}
                      title="复制密码"
                    >
                      {copied === entry.id + '-p' ? (
                        <Check className="size-3.5 text-emerald-500" />
                      ) : (
                        <Copy className="size-3.5 text-muted-foreground" />
                      )}
                    </Button>
                  </div>
                </div>

                {/* 标签展示 */}
                <div className="mt-4 flex flex-wrap items-center gap-1.5">
                  {entry.tags
                    .map((tid) => {
                      const tag = getTagById(tid);
                      if (!tag) return null;
                      return (
                        <Badge
                          key={tid}
                          variant="outline"
                          className="gap-1 text-[11px]"
                          style={tag.color ? { borderColor: tag.color, color: tag.color } : undefined}
                        >
                          <TagIcon className="size-3" />
                          {tag.name}
                        </Badge>
                      );
                    })
                    .filter(Boolean)}
                </div>
              </div>
            ))}
          </div>

          {/* 分页控制栏 */}
          {totalPages > 1 && (
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-4 border-t">
              <div className="text-xs text-muted-foreground">
                显示第 <span className="font-medium text-foreground">{(page - 1) * perPage + 1}</span> -{' '}
                <span className="font-medium text-foreground">{Math.min(page * perPage, total)}</span> 条，共{' '}
                <span className="font-medium text-foreground">{total}</span> 条
              </div>

              <div className="flex items-center gap-2">
                <Select
                  value={String(perPage)}
                  onValueChange={(v) => {
                    setPerPage(Number(v));
                    setPage(1);
                  }}
                >
                  <SelectTrigger className="h-8 w-24 text-xs">
                    <SelectValue placeholder="每页条数" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="12">12 条/页</SelectItem>
                    <SelectItem value="24">24 条/页</SelectItem>
                    <SelectItem value="48">48 条/页</SelectItem>
                  </SelectContent>
                </Select>

                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 px-2.5 text-xs gap-1"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    <ChevronLeft className="size-3.5" />
                    上一页
                  </Button>
                  <span className="text-xs px-2 text-muted-foreground">
                    {page} / {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 px-2.5 text-xs gap-1"
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  >
                    下一页
                    <ChevronRight className="size-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 删除确认 */}
      <AlertDialog open={!!pendingDelete} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingDelete?.permanent ? '永久删除该密码？' : '移入回收站？'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.permanent
                ? '此操作无法撤销，该密码条目将从数据库中被永久删除。'
                : '密码条目将移入回收站，之后您可以随时恢复或永久清除。'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className={pendingDelete?.permanent ? 'bg-destructive text-white hover:bg-destructive/90' : ''}
              onClick={(e) => {
                e.preventDefault();
                confirmDelete();
              }}
            >
              {pendingDelete?.permanent ? '永久删除' : '移入回收站'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export const dynamic = 'force-dynamic';

export default function DashboardPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-2xl space-y-4 py-20">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      }
    >
      <DashboardInner />
    </Suspense>
  );
}
