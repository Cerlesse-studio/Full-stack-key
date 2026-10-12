import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * 分类已并入标签（见 lib/repositories/tagMigration.ts）。
 * 这里保留跳转，避免旧链接、书签与侧边栏缓存直接 404。
 */
export default function CategoriesPageRedirect() {
  redirect('/dashboard/tags');
}