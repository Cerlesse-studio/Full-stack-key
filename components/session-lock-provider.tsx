'use client';

import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { Lock, Unlock, LogOut, Eye, EyeOff, ShieldCheck } from 'lucide-react';
import { verifyMasterPasswordAction, logoutAction } from '@/app/actions/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface SessionLockContextType {
  isLocked: boolean;
  lockNow: () => void;
  unlock: (password: string) => Promise<boolean>;
  idleTimeoutMinutes: number;
  setIdleTimeoutMinutes: (minutes: number) => void;
}

const SessionLockContext = createContext<SessionLockContextType | null>(null);

export function useSessionLock() {
  const ctx = useContext(SessionLockContext);
  if (!ctx) {
    throw new Error('useSessionLock must be used within a SessionLockProvider');
  }
  return ctx;
}

export function SessionLockProvider({ children }: { children: React.ReactNode }) {
  const [isLocked, setIsLocked] = useState(false);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idleTimeoutMinutes, setIdleTimeoutMinutesState] = useState<number>(15);

  const lastActivityRef = useRef<number>(Date.now());
  const inputRef = useRef<HTMLInputElement>(null);

  // Initialize idle timeout setting and lock state from storage
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const savedTimeout = localStorage.getItem('keyvault_idle_minutes');
    if (savedTimeout !== null) {
      const parsed = parseInt(savedTimeout, 10);
      if (!isNaN(parsed) && parsed >= 0) {
        setIdleTimeoutMinutesState(parsed);
      }
    }
    const savedLock = sessionStorage.getItem('keyvault_is_locked');
    if (savedLock === 'true') {
      setIsLocked(true);
    }
  }, []);

  const setIdleTimeoutMinutes = useCallback((minutes: number) => {
    setIdleTimeoutMinutesState(minutes);
    if (typeof window !== 'undefined') {
      localStorage.setItem('keyvault_idle_minutes', String(minutes));
    }
  }, []);

  const lockNow = useCallback(() => {
    setIsLocked(true);
    setPassword('');
    setError(null);
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('keyvault_is_locked', 'true');
    }
  }, []);

  const handleUnlock = useCallback(async (pwd: string): Promise<boolean> => {
    if (!pwd.trim()) {
      setError('请输入主密码');
      return false;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await verifyMasterPasswordAction(pwd);
      if (res.ok) {
        setIsLocked(false);
        setPassword('');
        setError(null);
        lastActivityRef.current = Date.now();
        if (typeof window !== 'undefined') {
          sessionStorage.removeItem('keyvault_is_locked');
        }
        return true;
      } else {
        setError(res.error || '主密码不正确');
        return false;
      }
    } catch {
      setError('验证失败，请重试');
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  // Listen to user activities to update last activity timestamp
  useEffect(() => {
    if (isLocked) return;

    let throttleTimer: NodeJS.Timeout | null = null;
    const handleActivity = () => {
      if (!throttleTimer) {
        lastActivityRef.current = Date.now();
        throttleTimer = setTimeout(() => {
          throttleTimer = null;
        }, 1000);
      }
    };

    const events = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'];
    events.forEach((ev) => window.addEventListener(ev, handleActivity, { passive: true }));

    // Listen to manual lock events if triggered anywhere
    const handleManualLock = () => lockNow();
    window.addEventListener('keyvault-lock-screen', handleManualLock);

    // Periodic check
    const interval = setInterval(() => {
      if (idleTimeoutMinutes <= 0) return; // 0 means disabled
      const idleTime = Date.now() - lastActivityRef.current;
      if (idleTime >= idleTimeoutMinutes * 60 * 1000) {
        lockNow();
      }
    }, 5000);

    return () => {
      events.forEach((ev) => window.removeEventListener(ev, handleActivity));
      window.removeEventListener('keyvault-lock-screen', handleManualLock);
      clearInterval(interval);
      if (throttleTimer) clearTimeout(throttleTimer);
    };
  }, [isLocked, idleTimeoutMinutes, lockNow]);

  // Focus password input when locked
  useEffect(() => {
    if (isLocked) {
      const timer = setTimeout(() => {
        inputRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [isLocked]);

  return (
    <SessionLockContext.Provider
      value={{
        isLocked,
        lockNow,
        unlock: handleUnlock,
        idleTimeoutMinutes,
        setIdleTimeoutMinutes,
      }}
    >
      {children}

      {/* Lock Screen Overlay */}
      {isLocked && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-xl p-4 animate-in fade-in duration-300">
          <div className="relative w-full max-w-md rounded-2xl border bg-card/95 p-8 shadow-2xl backdrop-blur-md">
            <div className="mx-auto mb-6 flex size-16 items-center justify-center rounded-2xl bg-primary/10 text-primary shadow-inner">
              <Lock className="size-8 animate-pulse text-primary" />
            </div>

            <div className="text-center">
              <h2 className="text-xl font-bold tracking-tight">保险库已锁定</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                检测到长时间无操作或已手动锁定。请输入主密码恢复会话。
              </p>
            </div>

            <form
              onSubmit={async (e) => {
                e.preventDefault();
                await handleUnlock(password);
              }}
              className="mt-6 space-y-4"
            >
              <div className="space-y-1.5">
                <div className="relative">
                  <Input
                    ref={inputRef}
                    type={showPassword ? 'text' : 'password'}
                    placeholder="请输入主密码..."
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      if (error) setError(null);
                    }}
                    disabled={loading}
                    className="h-11 pr-10 text-base"
                    autoComplete="current-password"
                  />
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
                {error && <p className="text-xs font-medium text-destructive">{error}</p>}
              </div>

              <div className="space-y-2">
                <Button type="submit" className="w-full h-11" disabled={loading || !password}>
                  {loading ? (
                    <span className="flex items-center gap-2">
                      <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                      正在验证...
                    </span>
                  ) : (
                    <span className="flex items-center gap-2">
                      <Unlock className="size-4" />
                      解锁保险库
                    </span>
                  )}
                </Button>

                <Button
                  type="button"
                  variant="ghost"
                  className="w-full text-muted-foreground hover:text-foreground"
                  onClick={() => logoutAction()}
                >
                  <LogOut className="mr-2 size-4" />
                  退出登录
                </Button>
              </div>
            </form>

            <div className="mt-6 flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <ShieldCheck className="size-3.5 text-emerald-500" />
              <span>零知识加密保护中</span>
            </div>
          </div>
        </div>
      )}
    </SessionLockContext.Provider>
  );
}
