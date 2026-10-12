'use client';

import { useMemo, useRef, useState } from 'react';
import { Plus, Tag as TagIcon, X } from 'lucide-react';
import type { Tag } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils/cn';

/**
 * 统一的标签选择控件，取代原先并排的「所属分类」下拉 + 「标签」多选。
 *
 * value 里既可以是标签 id，也可以是自由文本（新建的标签尚未落库）。
 * 服务端的 resolveTagRefs 会把自由文本自动注册为正式标签，因此这里
 * 不需要为了新建标签而额外发一次请求。
 */

export interface TagPickerProps {
  /** 保险库中已有的全部标签 */
  tags: Tag[];
  /** 选中的标签（id 或自由文本） */
  value: string[];
  onChange: (next: string[]) => void;
  /** 只读态：仅展示彩色徽章 */
  readOnly?: boolean;
  placeholder?: string;
  className?: string;
}

export function TagPicker({
  tags,
  value,
  onChange,
  readOnly = false,
  placeholder = '搜索或新建标签…',
  className,
}: TagPickerProps) {
  const [keyword, setKeyword] = useState('');
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const byId = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags]);

  /** 选中项的名称与颜色：自由文本没有颜色 */
  const selected = useMemo(
    () =>
      value.map((raw) => {
        const tag = byId.get(raw);
        return { raw, name: tag?.name ?? raw, color: tag?.color };
      }),
    [value, byId]
  );

  const normalized = keyword.trim().toLowerCase();
  const options = useMemo(() => {
    if (readOnly) return [];
    return tags
      .filter((t) => !value.includes(t.id))
      .filter((t) => (normalized ? t.name.toLowerCase().includes(normalized) : true))
      .slice(0, 8);
  }, [tags, value, normalized, readOnly]);

  const exactExists =
    !normalized || tags.some((t) => t.name.toLowerCase() === normalized) || value.some((v) => v.toLowerCase() === normalized);
  const canCreate = !readOnly && Boolean(normalized) && !exactExists;

  function toggle(id: string) {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  }

  function remove(raw: string) {
    onChange(value.filter((v) => v !== raw));
  }

  function commitKeyword() {
    const name = keyword.trim();
    if (!name || readOnly) return;
    if (!value.some((v) => v.toLowerCase() === name.toLowerCase())) {
      onChange([...value, name]);
    }
    setKeyword('');
  }

  if (readOnly) {
    if (selected.length === 0) {
      return <span className="text-sm italic text-muted-foreground">暂无标签</span>;
    }
    return (
      <div className={cn('flex flex-wrap items-center gap-2', className)}>
        {selected.map((item) => (
          <Badge
            key={item.raw}
            variant="outline"
            style={item.color ? { borderColor: item.color, color: item.color } : undefined}
            className="gap-1 text-xs"
          >
            <TagIcon className="size-3" />#{item.name}
          </Badge>
        ))}
      </div>
    );
  }

  return (
    <div className={cn('space-y-2', className)}>
      {/* 已选标签 */}
      <div className="flex min-h-12 flex-wrap items-center gap-2 rounded-lg border border-input bg-transparent p-2">
        {selected.map((item) => (
          <span
            key={item.raw}
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium"
            style={
              item.color
                ? { borderColor: item.color, color: item.color }
                : undefined
            }
          >
            <TagIcon className="size-3" />
            #{item.name}
            <button
              type="button"
              onClick={() => remove(item.raw)}
              aria-label={`移除标签 ${item.name}`}
              className="opacity-60 transition-opacity hover:opacity-100"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}

        <Input
          ref={inputRef}
          value={keyword}
          onChange={(e) => {
            setKeyword(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            // 延迟关闭，确保点击候选项时事件先完成
            window.setTimeout(() => setOpen(false), 120);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitKeyword();
            } else if (e.key === 'Backspace' && !keyword && value.length > 0) {
              onChange(value.slice(0, -1));
            }
          }}
          placeholder={selected.length === 0 ? placeholder : ''}
          className="h-7 min-w-32 flex-1 border-0 px-1 text-xs shadow-none focus-visible:ring-0"
        />
      </div>

      {/* 候选列表 */}
      {open && (options.length > 0 || canCreate) && (
        <div className="rounded-lg border bg-popover p-1 shadow-md">
          {options.map((t) => (
            <button
              key={t.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                toggle(t.id);
                setKeyword('');
                inputRef.current?.focus();
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
            >
              <span
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: t.color || 'var(--muted-foreground)' }}
              />
              <span className="truncate">{t.name}</span>
            </button>
          ))}
          {canCreate && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                commitKeyword();
                inputRef.current?.focus();
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-primary transition-colors hover:bg-accent"
            >
              <Plus className="size-3" />
              新建标签「{keyword.trim()}」
            </button>
          )}
        </div>
      )}

      {tags.length === 0 && (
        <p className="text-xs text-muted-foreground">
          还没有标签，直接输入名称即可新建
        </p>
      )}
    </div>
  );
}