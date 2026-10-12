'use client';

import Link from 'next/link';
import Image from 'next/image';
import { useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import {
  Archive,
  Database,
  KeyRound,
  Lock,
  LogOut,
  Menu,
  Settings2,
  ShieldCheck,
  Tags,
} from 'lucide-react';
import { logoutAction } from '@/app/actions/auth';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { ThemeToggle } from '@/components/theme-toggle';
import { SessionLockProvider } from '@/components/session-lock-provider';
import { cn } from '@/lib/utils/cn';
import type { Tag } from '@/lib/types';

const navItems = [
  { href: '/dashboard', label: '全部密码', icon: KeyRound },
  { href: '/dashboard/tags', label: '标签管理', icon: Tags },
  { href: '/dashboard/database', label: '数据库监控', icon: Database },
  { href: '/dashboard/backups', label: '备份管理', icon: Archive },
  { href: '/dashboard/settings', label: '设置', icon: Settings2 },
];

function VaultLogo() {
  return (
    <Link href="/dashboard" className="flex items-center gap-3 px-2">
      {/* logo 原图底部为深靛蓝，放白底板上才能在深色主题下保持清晰 */}
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white shadow-sm ring-1 ring-black/5 dark:ring-white/10">
        <Image
          src="/logo.png"
          alt="Full-stack-key"
          width={28}
          height={28}
          priority
          className="size-7"
        />
      </div>
      <div>
        <div className="font-semibold tracking-tight">密码保险库</div>
        <div className="text-xs text-muted-foreground">私密 · 安全 · 同步</div>
      </div>
    </Link>
  );
}

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav className="space-y-1">
      {navItems.map(({ href, label, icon: Icon }) => {
        const active =
          href === '/dashboard'
            ? pathname === '/dashboard'
            : href === '/dashboard/tags'
              ? pathname.startsWith('/dashboard/tags') || pathname.startsWith('/dashboard/categories')
              : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            className={cn(
              'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
              active
                ? 'bg-accent font-medium text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
            )}
          >
            <Icon className="size-4" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

function SidebarTagsSection({
  tags,
  onNavigate,
}: {
  tags: Tag[];
  onNavigate?: () => void;
}) {
  return (
    <>
      {tags.length > 0 && (
        <div className="mt-6">
          <div className="mb-2 flex items-center justify-between px-3 text-xs font-medium text-muted-foreground">
            <span>常用标签</span>
            <Link
              href="/dashboard/tags"
              onClick={onNavigate}
              className="text-[11px] text-muted-foreground/80 hover:text-foreground transition-colors"
            >
              管理
            </Link>
          </div>
          <div className="flex flex-wrap gap-1.5 px-2">
            {tags.slice(0, 12).map((tag) => (
              <Link
                key={tag.id}
                href={`/dashboard?tag=${tag.id}`}
                onClick={onNavigate}
                className="rounded-md border px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
                style={tag.color ? { borderColor: tag.color, color: tag.color } : undefined}
              >
                #{tag.name}
              </Link>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function SidebarFooter() {
  return (
    <div className="mt-auto border-t pt-4">
      <div className="mb-3 rounded-lg bg-muted p-3">
        <div className="flex items-center gap-2 text-xs font-medium">
          <span className="size-2 rounded-full bg-emerald-500" />
          端到端加密已启用
        </div>
        <p className="mt-1 pl-4 text-[11px] leading-relaxed text-muted-foreground">
          只有你可以解密保险库中的内容
        </p>
      </div>
      <form action={logoutAction}>
        <button
          type="submit"
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        >
          <LogOut className="size-4" />
          退出登录
        </button>
      </form>
    </div>
  );
}

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const [meta, setMeta] = useState<{ tags: Tag[] }>({
    tags: [],
  });
  const [adminUsername, setAdminUsername] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { listTagsAction, getAdminProfileAction } = await import('@/app/actions/auth');
      const [tags, profile] = await Promise.all([
        listTagsAction().catch(() => []),
        getAdminProfileAction().catch(() => null),
      ]);
      if (cancelled) return;
      setMeta({ tags });
      if (profile) setAdminUsername(profile.adminUsername);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <SessionLockProvider>
      <div className="flex min-h-screen flex-1 flex-col bg-background text-foreground lg:grid lg:grid-cols-[260px_minmax(0,1fr)]">
        {/* 桌面侧边栏 */}
        <aside className="hidden flex-col border-r bg-card px-4 py-5 lg:flex lg:min-h-screen">
          <VaultLogo />
          <div className="mb-2 mt-8 px-3 text-xs font-medium text-muted-foreground">工作区</div>
          <SidebarNav />
          <SidebarTagsSection {...meta} />
          <SidebarFooter />
        </aside>

        <main className="min-w-0 flex-1">
          <header className="sticky top-0 z-10 flex h-14 items-center justify-between gap-3 border-b bg-background/80 px-4 backdrop-blur md:px-8">
            <div className="flex items-center gap-2">
              {/* 移动端抽屉导航 */}
              <Sheet open={open} onOpenChange={setOpen}>
                <SheetTrigger asChild>
                  <Button variant="ghost" size="icon" className="lg:hidden" aria-label="打开菜单">
                    <Menu className="size-5" />
                  </Button>
                </SheetTrigger>
                <SheetContent side="left" className="w-72 gap-0 overflow-y-auto px-4 py-5">
                  <SheetTitle className="sr-only">导航菜单</SheetTitle>
                  <VaultLogo />
                  <div className="mt-8" />
                  <SidebarNav onNavigate={() => setOpen(false)} />
                  <SidebarTagsSection {...meta} onNavigate={() => setOpen(false)} />
                  <div className="mt-6">
                    <SidebarFooter />
                  </div>
                </SheetContent>
              </Sheet>
              <div className="hidden text-sm text-muted-foreground md:block">
                {adminUsername ?? '个人工作区'}{' '}
                <span className="mx-2 text-muted-foreground/50">/</span>
                <span className="text-foreground">保险库</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => window.dispatchEvent(new CustomEvent('keyvault-lock-screen'))}
                title="锁定当前会话"
              >
                <Lock className="size-3.5" />
                <span className="hidden sm:inline">锁定</span>
              </Button>
              <div className="hidden items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-xs text-muted-foreground sm:flex">
                <ShieldCheck className="size-3.5" />
                安全连接
              </div>
              <ThemeToggle />
            </div>
          </header>
          <div className="mx-auto w-full max-w-7xl p-4 md:p-8">{children}</div>
        </main>
      </div>
    </SessionLockProvider>
  );
}
