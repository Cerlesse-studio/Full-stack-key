'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import {
  Check,
  Folder,
  Pencil,
  Plus,
  Tag as TagIcon,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils/cn';

export interface ExplorerItem {
  id: string;
  name: string;
  /** 双击 / 回车时打开的地址 */
  href: string;
  /** 被该分类 / 标签引用的密码条数 */
  count: number;
  /** 标签专用：色值 */
  color?: string;
}

export interface ExplorerGridProps {
  items: ExplorerItem[];
  kind: 'folder' | 'tag';
  /** 「新建分类」/「新建标签」按钮文案 */
  createLabel: string;
  /** 状态栏与提示里的名词 */
  itemNoun: string;
  emptyState: ReactNode;
  /** 进入重命名时全选名称（模拟资源管理器新建文件夹后选中名称） */
  selectNameOnRename?: boolean;

  renamingId: string | null;
  renameDraft: string;
  onRenameStart: (id: string) => void;
  onRenameDraftChange: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  /** 标签重命名时额外渲染颜色选择器 */
  renderRenameExtra?: () => ReactNode;

  onCreateRequest: () => void;
  onDeleteRequest: (ids: string[]) => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  /** 为空数组表示在空白处右键 */
  targetIds: string[];
}

interface MenuEntry {
  key: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  danger?: boolean;
  separatorBefore?: boolean;
  shortcut?: string;
}

const TYPE_AHEAD_RESET_MS = 700;
/** 判定「同一行 / 同一列」时允许的像素误差 */
const NAV_TOLERANCE = 6;
const MENU_WIDTH = 212;
const MENU_ROW_HEIGHT = 34;

/**
 * 在网格布局中按方向查找相邻项：左右在同一行内查找，上下在同一列内查找。
 * 直接读取 DOM 位置，因此不依赖固定列数（响应式布局下列数会变化）。
 */
function findNeighbor(
  container: HTMLElement,
  current: HTMLElement | null,
  direction: 'left' | 'right' | 'up' | 'down'
): HTMLElement | null {
  const cards = Array.from(container.querySelectorAll<HTMLElement>('[data-explorer-item]'));
  if (!current) return cards[0] ?? null;

  const fromLeft = current.offsetLeft;
  const fromTop = current.offsetTop;
  const sameRow = (el: HTMLElement) => Math.abs(el.offsetTop - fromTop) <= NAV_TOLERANCE;
  const sameCol = (el: HTMLElement) => Math.abs(el.offsetLeft - fromLeft) <= NAV_TOLERANCE;

  let candidates: HTMLElement[];
  let distance: (el: HTMLElement) => number;

  switch (direction) {
    case 'right':
      candidates = cards.filter((el) => el !== current && sameRow(el) && el.offsetLeft > fromLeft);
      distance = (el) => el.offsetLeft;
      break;
    case 'left':
      candidates = cards.filter((el) => el !== current && sameRow(el) && el.offsetLeft < fromLeft);
      distance = (el) => -el.offsetLeft;
      break;
    case 'down':
      candidates = cards.filter((el) => el !== current && sameCol(el) && el.offsetTop > fromTop);
      distance = (el) => el.offsetTop;
      break;
    default:
      candidates = cards.filter((el) => el !== current && sameCol(el) && el.offsetTop < fromTop);
      distance = (el) => -el.offsetTop;
      break;
  }

  candidates.sort((a, b) => distance(a) - distance(b));
  return candidates[0] ?? null;
}

export function ExplorerGrid({
  items,
  kind,
  createLabel,
  itemNoun,
  emptyState,
  selectNameOnRename = false,
  renamingId,
  renameDraft,
  onRenameStart,
  onRenameDraftChange,
  onRenameCommit,
  onRenameCancel,
  renderRenameExtra,
  onCreateRequest,
  onDeleteRequest,
}: ExplorerGridProps) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const typeAheadRef = useRef<{ buffer: string; timer: ReturnType<typeof setTimeout> | null }>({
    buffer: '',
    timer: null,
  });

  const [selected, setSelected] = useState<string[]>([]);
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const isRenaming = renamingId !== null;
  const itemIds = useMemo(() => new Set(items.map((i) => i.id)), [items]);
  // 数据刷新后自动忽略已不存在的选中项（渲染期派生，避免在 effect 里 setState）
  const activeSelected = useMemo(
    () => selected.filter((id) => itemIds.has(id)),
    [selected, itemIds]
  );
  const selectedCount = activeSelected.length;

  // 进入重命名：聚焦输入框，并按需全选名称
  useEffect(() => {
    if (!renamingId) return;
    const input = renameInputRef.current;
    if (!input) return;
    input.focus();
    if (selectNameOnRename) input.select();
  }, [renamingId, selectNameOnRename]);

  // 右键菜单：点击空白 / 窗口失焦 / 滚动 / 缩放时关闭
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    window.addEventListener('wheel', close, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('wheel', close);
    };
  }, [contextMenu]);

  // 卸载时清理输入跳转定时器
  useEffect(() => {
    const timer = typeAheadRef.current;
    return () => {
      if (timer.timer) clearTimeout(timer.timer);
    };
  }, []);

  const focusCard = useCallback((id: string | null) => {
    if (!id) return;
    containerRef.current
      ?.querySelector<HTMLElement>(`[data-explorer-item="${CSS.escape(id)}"]`)
      ?.focus();
  }, []);

  const selectOnly = useCallback((id: string) => {
    setSelected([id]);
    setAnchorId(id);
    focusCard(id);
  }, [focusCard]);

  const selectRange = useCallback((fromId: string, toId: string) => {
    const from = items.findIndex((i) => i.id === fromId);
    const to = items.findIndex((i) => i.id === toId);
    if (from === -1 || to === -1) {
      selectOnly(toId);
      return;
    }
    const [start, end] = from <= to ? [from, to] : [to, from];
    setSelected(items.slice(start, end + 1).map((i) => i.id));
    setAnchorId(fromId);
    focusCard(toId);
  }, [items, focusCard, selectOnly]);

  const toggleSelected = useCallback((id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));
    setAnchorId(id);
    focusCard(id);
  }, [focusCard]);

  const clearSelection = useCallback(() => {
    setSelected([]);
    setAnchorId(null);
  }, []);

  const openItem = useCallback((id: string) => {
    const item = items.find((i) => i.id === id);
    if (item) router.push(item.href);
  }, [items, router]);

  const startRename = useCallback((id: string) => {
    setContextMenu(null);
    const item = items.find((i) => i.id === id);
    if (!item) return;
    setSelected([id]);
    setAnchorId(id);
    onRenameStart(id);
  }, [items, onRenameStart]);

  /** 输入跳转：连续键入字符快速定位；连按同一字母时在同首字母的项之间循环 */
  const handleTypeAhead = useCallback((char: string) => {
    const state = typeAheadRef.current;
    const buffer = state.timer ? state.buffer + char : char;
    state.buffer = buffer;

    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.buffer = '';
      state.timer = null;
    }, TYPE_AHEAD_RESET_MS);

    const cycling = buffer.length > 1 && new Set(buffer).size === 1;
    const query = (cycling ? char : buffer).toLowerCase();
    const matches = items.filter((i) => i.name.toLowerCase().startsWith(query));
    if (matches.length === 0) return;

    const target = cycling
      ? matches[selected.filter((s) => matches.some((m) => m.id === s)).length % matches.length]
      : matches[0];
    if (target) {
      setSelected([target.id]);
      setAnchorId(target.id);
      focusCard(target.id);
    }
  }, [items, selected, focusCard]);

  const moveSelection = useCallback((direction: 'left' | 'right' | 'up' | 'down') => {
    const container = containerRef.current;
    if (!container) return;
    const currentId = activeSelected[activeSelected.length - 1] ?? null;
    const currentEl = currentId
      ? container.querySelector<HTMLElement>(`[data-explorer-item="${CSS.escape(currentId)}"]`)
      : null;
    const next = findNeighbor(container, currentEl, direction);
    const id = next?.dataset.explorerItem;
    if (!next || !id) return;
    setSelected([id]);
    setAnchorId(id);
    next.focus();
  }, [activeSelected]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (isRenaming) return;
    const hasModifier = e.ctrlKey || e.metaKey || e.altKey;

    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        if (hasModifier) return;
        e.preventDefault();
        moveSelection(
          e.key === 'ArrowLeft' ? 'left'
            : e.key === 'ArrowRight' ? 'right'
              : e.key === 'ArrowUp' ? 'up' : 'down'
        );
        return;
      }
      case 'Home':
      case 'End': {
        e.preventDefault();
        const target = e.key === 'Home' ? items[0] : items[items.length - 1];
        if (target) selectOnly(target.id);
        return;
      }
      case 'Escape': {
        e.preventDefault();
        if (contextMenu) {
          setContextMenu(null);
          return;
        }
        clearSelection();
        return;
      }
      case 'Enter': {
        e.preventDefault();
        if (activeSelected.length === 1) openItem(activeSelected[0]);
        return;
      }
      case 'F2': {
        e.preventDefault();
        if (activeSelected.length === 1) startRename(activeSelected[0]);
        return;
      }
      case 'Delete':
      case 'Backspace': {
        e.preventDefault();
        if (activeSelected.length === 0) return;
        setContextMenu(null);
        onDeleteRequest([...activeSelected]);
        return;
      }
      default:
        break;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      setSelected(items.map((i) => i.id));
      setAnchorId(items[0]?.id ?? null);
      return;
    }

    // 输入跳转：仅处理不带修饰键的可打印字符
    if (!hasModifier && e.key.length === 1) {
      e.preventDefault();
      handleTypeAhead(e.key);
    }
  }, [
    isRenaming,
    items,
    activeSelected,
    contextMenu,
    moveSelection,
    selectOnly,
    clearSelection,
    openItem,
    startRename,
    onDeleteRequest,
    handleTypeAhead,
  ]);

  const handleCardClick = useCallback((e: React.MouseEvent, id: string) => {
    if (isRenaming) return;
    if (e.shiftKey && anchorId) {
      selectRange(anchorId, id);
    } else if (e.ctrlKey || e.metaKey) {
      toggleSelected(id);
    } else {
      selectOnly(id);
    }
  }, [anchorId, isRenaming, selectRange, toggleSelected, selectOnly]);

  const handleContextMenu = useCallback((e: React.MouseEvent, id: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    containerRef.current?.focus({ preventScroll: true });
    if (!id) {
      clearSelection();
      setContextMenu({ x: e.clientX, y: e.clientY, targetIds: [] });
      return;
    }
    // 在已选中的项上右键：保持当前多选
    const keepMulti = (e.ctrlKey || e.metaKey || e.shiftKey) && activeSelected.includes(id);
    const targetIds = keepMulti ? [...activeSelected] : [id];
    setSelected(targetIds);
    setAnchorId(id);
    setContextMenu({ x: e.clientX, y: e.clientY, targetIds });
  }, [activeSelected, clearSelection]);

  const closeMenuThen = useCallback((fn: () => void) => () => {
    setContextMenu(null);
    fn();
  }, []);

  const menuEntries: MenuEntry[] = [];
  if (contextMenu) {
    if (contextMenu.targetIds.length === 0) {
      menuEntries.push({
        key: 'create',
        label: createLabel,
        icon: Plus,
        onSelect: closeMenuThen(onCreateRequest),
      });
    } else {
      if (contextMenu.targetIds.length === 1) {
        menuEntries.push(
          {
            key: 'open',
            label: '打开',
            icon: Folder,
            shortcut: 'Enter',
            onSelect: closeMenuThen(() => openItem(contextMenu.targetIds[0])),
          },
          {
            key: 'rename',
            label: '重命名',
            icon: Pencil,
            shortcut: 'F2',
            onSelect: closeMenuThen(() => startRename(contextMenu.targetIds[0])),
          }
        );
      }
      menuEntries.push({
        key: 'delete',
        label: contextMenu.targetIds.length > 1
          ? `删除 ${contextMenu.targetIds.length} 个${itemNoun}`
          : '删除',
        icon: Trash2,
        danger: true,
        onSelect: closeMenuThen(() => onDeleteRequest([...contextMenu.targetIds])),
      });
      menuEntries.push({
        key: 'create',
        label: createLabel,
        icon: Plus,
        separatorBefore: true,
        onSelect: closeMenuThen(onCreateRequest),
      });
    }
  }

  const renderMenu = () => {
    if (!contextMenu) return null;
    const estimatedHeight = menuEntries.length * MENU_ROW_HEIGHT + 12;
    const left = Math.min(contextMenu.x, window.innerWidth - MENU_WIDTH - 8);
    const top = Math.min(contextMenu.y, window.innerHeight - estimatedHeight - 8);

    return (
      <div
        role="menu"
        className="fixed z-50 min-w-[13rem] select-none rounded-md border bg-popover p-1 text-popover-foreground shadow-lg"
        style={{ left: Math.max(8, left), top: Math.max(8, top) }}
        onPointerDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {menuEntries.map((entry) => {
          const Icon = entry.icon;
          return (
            <div key={entry.key}>
              {entry.separatorBefore && <div className="my-1 h-px bg-border" role="separator" />}
              <button
                type="button"
                role="menuitem"
                onClick={entry.onSelect}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left text-sm transition-colors',
                  'hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus:outline-none',
                  entry.danger &&
                    'text-destructive hover:bg-destructive/10 hover:text-destructive focus:bg-destructive/10 focus:text-destructive'
                )}
              >
                <Icon className="size-4 shrink-0" />
                <span className="flex-1 truncate">{entry.label}</span>
                {entry.shortcut && (
                  <span className="text-xs tracking-widest text-muted-foreground">{entry.shortcut}</span>
                )}
              </button>
            </div>
          );
        })}
      </div>
    );
  };

  if (items.length === 0) {
    return <>{emptyState}</>;
  }

  return (
    <div className="space-y-2" onContextMenu={(e) => e.preventDefault()}>
      {/* 选中后才出现的操作条，模拟资源管理器的上下文工具栏 */}
      <div className="flex min-h-9 flex-wrap items-center gap-1.5">
        <Button variant="outline" size="sm" className="gap-1.5" onClick={onCreateRequest}>
          <Plus className="size-3.5" />
          {createLabel}
        </Button>
        {selectedCount > 0 && (
          <>
            <span className="text-xs text-muted-foreground">
              已选择 {selectedCount} 个{itemNoun}
            </span>
            {selectedCount === 1 && (
              <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => startRename(activeSelected[0])}>
                <Pencil className="size-3.5" />
                重命名
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => onDeleteRequest([...activeSelected])}
            >
              <Trash2 className="size-3.5" />
              删除
            </Button>
          </>
        )}
      </div>

      <div
        ref={containerRef}
        tabIndex={0}
        role="listbox"
        aria-multiselectable="true"
        aria-label={itemNoun}
        onKeyDown={handleKeyDown}
        onClick={(e) => {
          // 点击卡片之间的空白区域：取消选中并把焦点交回列表
          if (e.target === e.currentTarget) {
            clearSelection();
            containerRef.current?.focus({ preventScroll: true });
          }
        }}
        onContextMenu={(e) => handleContextMenu(e, null)}
        className="grid grid-cols-1 gap-3 rounded-xl outline-none sm:grid-cols-2"
      >
        {items.map((item) => {
          const isSelected = activeSelected.includes(item.id);
          const isItemRenaming = renamingId === item.id;
          const Icon = kind === 'folder' ? Folder : TagIcon;

          return (
            <div
              key={item.id}
              data-explorer-item={item.id}
              role="option"
              aria-selected={isSelected}
              tabIndex={-1}
              onMouseDown={(e) => {
                if (isItemRenaming) return;
                // 阻止默认行为：避免拖拽选中文字
                e.preventDefault();
              }}
              onClick={(e) => handleCardClick(e, item.id)}
              onDoubleClick={() => {
                if (!isItemRenaming) openItem(item.id);
              }}
              onContextMenu={(e) => handleContextMenu(e, item.id)}
              className={cn(
                'flex items-center gap-3 rounded-xl border bg-card p-4 shadow-sm transition-colors',
                isSelected
                  ? 'border-primary/70 bg-primary/5 ring-2 ring-primary/60'
                  : 'hover:border-ring/50'
              )}
            >
              <div
                className="flex size-9 shrink-0 items-center justify-center rounded-lg"
                style={
                  kind === 'tag'
                    ? item.color
                      ? { backgroundColor: `${item.color}20`, color: item.color }
                      : { backgroundColor: 'var(--muted)', color: 'var(--muted-foreground)' }
                    : {
                        backgroundColor: 'color-mix(in oklab, var(--primary) 10%, transparent)',
                        color: 'var(--primary)',
                      }
                }
              >
                <Icon className="size-4" />
              </div>

              {isItemRenaming ? (
                <div
                  className="min-w-0 flex-1 space-y-2"
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center gap-1.5">
                    <Input
                      ref={renameInputRef}
                      value={renameDraft}
                      onChange={(e) => onRenameDraftChange(e.target.value)}
                      onBlur={onRenameCommit}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') onRenameCommit();
                        if (e.key === 'Escape') onRenameCancel();
                      }}
                      className="h-8"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0 text-green-600 hover:text-green-700"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={onRenameCommit}
                    >
                      <Check className="size-4" />
                      <span className="sr-only">保存</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0 text-muted-foreground"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={onRenameCancel}
                    >
                      <X className="size-4" />
                      <span className="sr-only">取消</span>
                    </Button>
                  </div>
                  {renderRenameExtra?.()}
                </div>
              ) : (
                <>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">
                      {kind === 'tag' ? `#${item.name}` : item.name}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {item.count > 0 ? `${item.count} 条密码` : '未使用'}
                    </div>
                  </div>
                  {/* 仅选中时显示操作按钮，未选中时保持卡片干净 */}
                  {isSelected && (
                    <div className="flex shrink-0 gap-1" onClick={(e) => e.stopPropagation()}>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 text-muted-foreground"
                        onClick={() => startRename(item.id)}
                      >
                        <Pencil className="size-4" />
                        <span className="sr-only">重命名</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 text-muted-foreground hover:text-destructive"
                        onClick={() => onDeleteRequest([item.id])}
                      >
                        <Trash2 className="size-4" />
                        <span className="sr-only">删除</span>
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* 底部状态栏 */}
      <div className="flex items-center justify-between gap-3 border-t px-1 pt-2 text-xs text-muted-foreground">
        <span>
          {items.length} 个{itemNoun}
          {selectedCount > 0 && ` · 已选择 ${selectedCount} 个`}
        </span>
        <span className="hidden sm:inline">
          单击选中 · 双击打开 · F2 重命名 · Delete 删除 · 右键更多
        </span>
      </div>

      {renderMenu()}
    </div>
  );
}
