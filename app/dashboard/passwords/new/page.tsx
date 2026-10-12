'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  KeyRound,
  Globe,
  User,
  Tag as TagIcon,
  FileText,
  Wand2,
  Copy,
  Check,
  Eye,
  EyeOff,
  RefreshCw,
  Sliders,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  createPasswordAction,
  listTagsAction,
} from '@/app/actions/auth';
import { evaluatePasswordStrength, generatePassword } from '@/lib/crypto';
import type { Tag } from '@/lib/types';
import { TagPicker } from '@/components/tag-picker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
} from '@/components/ui/select';

export default function NewPasswordPage() {
  const router = useRouter();

  // Form states
  const [site, setSite] = useState('');
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [notes, setNotes] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  // Available metadata
  const [tags, setTags] = useState<Tag[]>([]);

  // UI states
  const [showPassword, setShowPassword] = useState(false);
  const [showGenerator, setShowGenerator] = useState(false);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  // Generator settings
  const [genLength, setGenLength] = useState(18);
  const [genUppercase, setGenUppercase] = useState(true);
  const [genLowercase, setGenLowercase] = useState(true);
  const [genNumbers, setGenNumbers] = useState(true);
  const [genSymbols, setGenSymbols] = useState(true);

  // Load tags
  useEffect(() => {
    (async () => {
      try {
        const tgs = await listTagsAction();
        setTags(tgs);
      } catch {
        // Ignore fallback
      }
    })();
  }, []);

  // Compute password strength using unified evaluation
  const strength = evaluatePasswordStrength(password);

  const strengthColors = [
    'bg-destructive',
    'bg-orange-500',
    'bg-amber-500',
    'bg-emerald-500',
    'bg-emerald-600',
  ];

  function handleGeneratePassword() {
    const generated = generatePassword({
      length: genLength,
      uppercase: genUppercase,
      lowercase: genLowercase,
      numbers: genNumbers,
      symbols: genSymbols,
    });
    setPassword(generated);
  }

  async function handleCopyPassword() {
    if (!password) return;
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast.success('密码已复制到剪贴板');
    } catch {
      toast.error('复制失败');
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!site.trim()) {
      toast.error('请输入网站或应用名称');
      return;
    }
    if (!password) {
      toast.error('请输入或生成密码');
      return;
    }

    setLoading(true);
    try {
      const formData = new FormData();
      formData.set('site', site.trim());
      if (url.trim()) formData.set('url', url.trim());
      if (username.trim()) formData.set('username', username.trim());
      formData.set('password', password);
      if (notes.trim()) formData.set('notes', notes.trim());
      if (selectedTags.length > 0) formData.set('tags', selectedTags.join(','));

      const res = await createPasswordAction(formData);
      if (res.ok) {
        toast.success('密码条目已创建');
        router.push('/dashboard');
      } else {
        toast.error(res.error || '创建失败');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-12">
      {/* 头部面包屑与标题 */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild className="size-9">
          <Link href="/dashboard" aria-label="返回保险库">
            <ArrowLeft className="size-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">新建密码</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            添加并使用端到端零知识加密保护您的账户凭据
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* 基本信息 */}
        <div className="rounded-xl border bg-card p-6 shadow-sm space-y-4">
          <div className="flex items-center gap-2 border-b pb-3 text-sm font-semibold">
            <KeyRound className="size-4 text-primary" />
            <span>账户凭据</span>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="site" className="text-xs font-medium">
                网站 / 应用名称 <span className="text-destructive">*</span>
              </Label>
              <Input
                id="site"
                placeholder="例如：GitHub、Google、ChatGPT"
                value={site}
                onChange={(e) => setSite(e.target.value)}
                required
                className="h-10"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="url" className="text-xs font-medium flex items-center gap-1.5">
                <Globe className="size-3.5 text-muted-foreground" />
                网址 (URL)
              </Label>
              <Input
                id="url"
                type="url"
                placeholder="https://example.com/login"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="h-10"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="username" className="text-xs font-medium flex items-center gap-1.5">
              <User className="size-3.5 text-muted-foreground" />
              用户名 / 邮箱 / 手机号
            </Label>
            <Input
              id="username"
              placeholder="请输入登录用户名或邮箱"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="h-10"
            />
          </div>

          {/* 密码输入与操作 */}
          <div className="space-y-2 pt-1">
            <div className="flex items-center justify-between">
              <Label htmlFor="password" className="text-xs font-medium">
                密码 <span className="text-destructive">*</span>
              </Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowGenerator(!showGenerator);
                  if (!password && !showGenerator) handleGeneratePassword();
                }}
                className="h-7 text-xs text-primary hover:text-primary/80 gap-1 px-2"
              >
                <Wand2 className="size-3.5" />
                {showGenerator ? '收起密码生成器' : '随机生成强密码'}
              </Button>
            </div>

            <div className="relative">
              <Input
                id="password"
                type={showPassword ? 'text' : 'password'}
                placeholder="输入密码或点击右侧生成"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="h-11 pr-24 font-mono text-sm"
              />
              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 text-muted-foreground">
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={handleCopyPassword}
                  className="p-1 hover:text-foreground transition-colors"
                  title="复制密码"
                >
                  {copied ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4" />}
                </button>
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowPassword(!showPassword)}
                  className="p-1 hover:text-foreground transition-colors"
                  title={showPassword ? '隐藏密码' : '显示密码'}
                >
                  {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </div>

            {/* 密码强度指示条 */}
            {password && (
              <div className="space-y-1.5 pt-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">密码强度：</span>
                  <span className="font-medium">{strength.label}</span>
                </div>
                <div className="grid grid-cols-5 gap-1.5 h-1.5 rounded-full overflow-hidden bg-muted">
                  {[0, 1, 2, 3, 4].map((level) => (
                    <div
                      key={level}
                      className={`h-full transition-all duration-300 ${
                        level <= strength.score ? strengthColors[strength.score] : 'bg-transparent'
                      }`}
                    />
                  ))}
                </div>
                {strength.suggestions.length > 0 && (
                  <p className="text-[11px] text-muted-foreground">
                    提示: {strength.suggestions.join('，')}
                  </p>
                )}
              </div>
            )}

            {/* 内嵌密码生成器配置面板 */}
            {showGenerator && (
              <div className="mt-3 rounded-lg border border-primary/20 bg-primary/5 p-4 space-y-4 animate-in fade-in slide-in-from-top-2 duration-200">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs font-semibold text-primary">
                    <Sliders className="size-3.5" />
                    <span>强密码生成选项</span>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs gap-1.5"
                    onClick={handleGeneratePassword}
                  >
                    <RefreshCw className="size-3" />
                    重新生成
                  </Button>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">长度：{genLength} 字符</span>
                  </div>
                  <input
                    type="range"
                    min={8}
                    max={64}
                    value={genLength}
                    onChange={(e) => {
                      setGenLength(Number(e.target.value));
                      const pwd = generatePassword({
                        length: Number(e.target.value),
                        uppercase: genUppercase,
                        lowercase: genLowercase,
                        numbers: genNumbers,
                        symbols: genSymbols,
                      });
                      setPassword(pwd);
                    }}
                    className="w-full accent-primary cursor-pointer"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={genUppercase}
                      onChange={(e) => {
                        setGenUppercase(e.target.checked);
                        const pwd = generatePassword({
                          length: genLength,
                          uppercase: e.target.checked,
                          lowercase: genLowercase,
                          numbers: genNumbers,
                          symbols: genSymbols,
                        });
                        setPassword(pwd);
                      }}
                      className="rounded accent-primary"
                    />
                    大写字母 (A-Z)
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={genLowercase}
                      onChange={(e) => {
                        setGenLowercase(e.target.checked);
                        const pwd = generatePassword({
                          length: genLength,
                          uppercase: genUppercase,
                          lowercase: e.target.checked,
                          numbers: genNumbers,
                          symbols: genSymbols,
                        });
                        setPassword(pwd);
                      }}
                      className="rounded accent-primary"
                    />
                    小写字母 (a-z)
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={genNumbers}
                      onChange={(e) => {
                        setGenNumbers(e.target.checked);
                        const pwd = generatePassword({
                          length: genLength,
                          uppercase: genUppercase,
                          lowercase: genLowercase,
                          numbers: e.target.checked,
                          symbols: genSymbols,
                        });
                        setPassword(pwd);
                      }}
                      className="rounded accent-primary"
                    />
                    数字 (0-9)
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={genSymbols}
                      onChange={(e) => {
                        setGenSymbols(e.target.checked);
                        const pwd = generatePassword({
                          length: genLength,
                          uppercase: genUppercase,
                          lowercase: genLowercase,
                          numbers: genNumbers,
                          symbols: e.target.checked,
                        });
                        setPassword(pwd);
                      }}
                      className="rounded accent-primary"
                    />
                    特殊符号 (!@#$)
                  </label>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 标签归类 */}
        <div className="rounded-xl border bg-card p-6 shadow-sm space-y-4">
          <div className="flex items-center gap-2 border-b pb-3 text-sm font-semibold">
            <TagIcon className="size-4 text-primary" />
            <span>标签</span>
          </div>

          <div className="space-y-2">
            <Label className="text-xs font-medium">为这条密码打标签</Label>
            <TagPicker
              tags={tags}
              value={selectedTags}
              onChange={setSelectedTags}
              placeholder="输入标签名并按回车新建…"
            />
            <p className="text-xs text-muted-foreground">
              一条密码可同时属于多个标签，例如「工作」「重要」「邮箱」
            </p>
          </div>
        </div>

        {/* 备忘与附加笔记 */}
        <div className="rounded-xl border bg-card p-6 shadow-sm space-y-4">
          <div className="flex items-center gap-2 border-b pb-3 text-sm font-semibold">
            <FileText className="size-4 text-primary" />
            <span>备注说明</span>
          </div>

          <div className="space-y-2">
            <Label htmlFor="notes" className="text-xs font-medium">
              私密备注 (加密存储)
            </Label>
            <Textarea
              id="notes"
              placeholder="可填写备用恢复代码、安全问题、PIN码等..."
              rows={4}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="resize-none"
            />
          </div>
        </div>

        {/* 底部按钮栏 */}
        <div className="flex items-center justify-end gap-3 pt-2">
          <Button type="button" variant="outline" asChild>
            <Link href="/dashboard">取消</Link>
          </Button>
          <Button type="submit" disabled={loading} className="min-w-28">
            {loading ? (
              <span className="flex items-center gap-2">
                <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                正在保存...
              </span>
            ) : (
              '保存密码'
            )}
          </Button>
        </div>
      </form>
    </div>
  );
}
