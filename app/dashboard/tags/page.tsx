'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search, Tags, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  listTagsAction,
  createTagAction,
  updateTagAction,
  deleteTagAction,
  getTagCountsAction,
} from '@/app/actions/auth';
import type { Tag } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ExplorerGrid, type ExplorerItem } from '@/components/explorer-grid';
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

const COLOR_OPTIONS = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308',
  '#84cc16', '#22c55e', '#10b981', '#14b8a6',
  '#06b6d4', '#0ea5e9', '#3b82f6', '#6366f1',
  '#8b5cf6', '#a855f7', '#d946ef', '#ec4899',
  '#f43f5e', '#64748b',
];

function ColorSwatches({
  value,
  onChange,
  size = 'md',
}: {
  value: string;
  onChange: (c: string) => void;
  size?: 'sm' | 'md';
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {COLOR_OPTIONS.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(value === c ? '' : c)}
          aria-label={`选择颜色 ${c}`}
          className={`rounded-full border-2 transition-transform ${
            size === 'sm' ? 'size-4' : 'size-5'
          } ${value === c ? 'scale-110 border-foreground shadow-sm' : 'border-transparent hover:scale-105'}`}
          style={{ backgroundColor: c }}
        />
      ))}
    </div>
  );
}

/** 生成不与现有项重名的临时名称，模拟资源管理器「新建文件夹(2)」 */
function uniqueTempName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}(${n})`)) n++;
  return `${base}(${n})`;
}

function SearchBox({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="relative">
      <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="搜索标签名称..."
        className="h-9 pl-9 pr-8 text-xs"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="清空搜索"
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

function NoMatch({ keyword, onClear }: { keyword: string; onClear: () => void }) {
  return (
    <div className="rounded-xl border border-dashed py-10 text-center text-sm text-muted-foreground">
      未找到与「{keyword}」匹配的标签
      <Button variant="link" size="sm" onClick={onClear} className="ml-1 text-xs">
        清空搜索
      </Button>
    </div>
  );
}

function TagsContent() {
  const router = useRouter();

  const [tags, setTags] = useState<Tag[]>([]);
  const [tagCounts, setTagCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [editingTagId, setEditingTagId] = useState<string | null>(null);
  const [editTagName, setEditTagName] = useState('');
  const [editTagColor, setEditTagColor] = useState('');
  const [pendingDeleteTags, setPendingDeleteTags] = useState<string[]>([]);
  const [tagSearch, setTagSearch] = useState('');

  async function loadAll() {
    const [tgs, tagCnt] = await Promise.all([listTagsAction(), getTagCountsAction()]);
    setTags(tgs);
    setTagCounts(tagCnt);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadAll();
      } catch (err) {
        if (!cancelled) {
          toast.error(err instanceof Error ? err.message : '加载标签失败');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const tagItems = useMemo<ExplorerItem[]>(
    () =>
      tags.map((t) => ({
        id: t.id,
        name: t.name,
        href: `/dashboard?tag=${t.id}`,
        count: tagCounts[t.id] ?? 0,
        color: t.color,
      })),
    [tags, tagCounts]
  );

  const visibleTags = useMemo(() => {
    const q = tagSearch.trim().toLowerCase();
    return q ? tagItems.filter((i) => i.name.toLowerCase().includes(q)) : tagItems;
  }, [tagItems, tagSearch]);

  async function handleCreateTag() {
    const name = uniqueTempName('新建标签', tags.map((t) => t.name));
    const fd = new FormData();
    fd.set('name', name);
    try {
      const res = await createTagAction(fd);
      if (!res.ok) {
        toast.error(res.error || '创建标签失败');
        return;
      }
      await loadAll();
      setEditTagName(name);
      setEditTagColor('');
      setEditingTagId(res.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建标签失败');
    }
  }

  function startEditTag(id: string) {
    const target = tags.find((t) => t.id === id);
    if (!target) return;
    setEditTagName(target.name);
    setEditTagColor(target.color || '');
    setEditingTagId(id);
  }

  async function commitEditTag() {
    const id = editingTagId;
    if (!id) return;
    const trimmed = editTagName.trim();
    setEditingTagId(null);
    if (!trimmed) return;
    const original = tags.find((t) => t.id === id);
    if (original && original.name === trimmed && (original.color || '') === editTagColor) return;

    const fd = new FormData();
    fd.set('name', trimmed);
    fd.set('color', editTagColor);
    const res = await updateTagAction(id, fd);
    if (!res.ok) {
      toast.error(res.error || '更新标签失败');
      return;
    }
    toast.success('标签已更新');
    await loadAll();
  }

  async function handleDeleteTags() {
    const ids = pendingDeleteTags;
    if (ids.length === 0) return;
    setPendingDeleteTags([]);
    let failed = 0;
    for (const id of ids) {
      try {
        await deleteTagAction(id);
      } catch {
        failed++;
      }
    }
    if (failed > 0) {
      toast.error(`${ids.length - failed} 个已删除，${failed} 个删除失败`);
    } else {
      toast.success(`已删除 ${ids.length} 个标签`);
    }
    await loadAll();
    router.refresh();
  }

  const tagEmpty = (
    <div className="rounded-xl border border-dashed py-16 text-center">
      <div className="mb-4 inline-flex size-14 items-center justify-center rounded-xl bg-muted">
        <Tags className="size-7 text-muted-foreground" />
      </div>
      <h3 className="mb-1 font-semibold">还没有标签</h3>
      <p className="mb-4 text-sm text-muted-foreground">创建标签来为密码打上彩色标记，支持多选</p>
      <Button variant="outline" size="sm" onClick={handleCreateTag} className="gap-1.5">
        新建标签
      </Button>
    </div>
  );

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2.5 text-2xl font-bold tracking-tight">
          <Tags className="size-6 text-primary" />
          标签管理
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          用彩色标签整理密码：一条密码可同时属于多个标签，例如「工作」「重要」「邮箱」
        </p>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {[...Array(6)].map((_, i) => (
            <Skeleton key={i} className="h-[4.5rem] w-full rounded-xl" />
          ))}
        </div>
      ) : (
        <>
          {tagItems.length > 0 && (
            <SearchBox value={tagSearch} onChange={setTagSearch} />
          )}
          {tagSearch.trim() && visibleTags.length === 0 ? (
            <NoMatch keyword={tagSearch.trim()} onClear={() => setTagSearch('')} />
          ) : (
            <ExplorerGrid
              items={visibleTags}
              kind="tag"
              createLabel="新建标签"
              itemNoun="标签"
              emptyState={tagEmpty}
              renamingId={editingTagId}
              renameDraft={editTagName}
              onRenameStart={startEditTag}
              onRenameDraftChange={setEditTagName}
              onRenameCommit={commitEditTag}
              onRenameCancel={() => setEditingTagId(null)}
              renderRenameExtra={() => (
                <ColorSwatches value={editTagColor} onChange={setEditTagColor} size="sm" />
              )}
              onCreateRequest={handleCreateTag}
              onDeleteRequest={setPendingDeleteTags}
            />
          )}
        </>
      )}

      <AlertDialog
        open={pendingDeleteTags.length > 0}
        onOpenChange={(open) => !open && setPendingDeleteTags([])}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingDeleteTags.length > 1 ? `删除所选 ${pendingDeleteTags.length} 个标签？` : '删除该标签？'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              标签将被从所有包含它的密码记录中移除，密码本身不会被删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                void handleDeleteTags();
              }}
            >
              删除标签
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default function TagsPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-3xl space-y-6">
          <Skeleton className="h-10 w-48" />
          <Skeleton className="h-10 w-64" />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className="h-[4.5rem] w-full rounded-xl" />
            ))}
          </div>
        </div>
      }
    >
      <TagsContent />
    </Suspense>
  );
}