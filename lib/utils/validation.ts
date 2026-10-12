import { z } from 'zod';
import type { PasswordEntryInput, PasswordEntryUpdate } from '@/lib/types';

export const passwordEntryInputSchema = z.object({
  site: z.string().min(1, 'Site name is required').max(255),
  url: z.string().url('Invalid URL format').optional().or(z.literal('')),
  username: z.string().max(255).optional(),
  password: z.string().min(1, 'Password is required'),
  notes: z.string().max(10000).optional(),
  tags: z.array(z.string().min(1).max(50)).max(50).optional(),
}) satisfies z.ZodType<PasswordEntryInput>;

export const passwordEntryUpdateSchema = z.object({
  site: z.string().min(1).max(255).optional(),
  url: z.string().url().optional().or(z.literal('')),
  username: z.string().max(255).optional(),
  password: z.string().min(1).optional(),
  notes: z.string().max(10000).optional(),
  tags: z.array(z.string().min(1).max(50)).max(50).optional(),
  version: z.number().int().min(1),
}) satisfies z.ZodType<PasswordEntryUpdate>;

export const tagInputSchema = z.object({
  name: z.string().min(1, 'Tag name is required').max(50),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Invalid hex color').optional(),
});

export const initSchema = z.object({
  adminUsername: z
    .string()
    .trim()
    .min(2, '管理员账号名称至少 2 个字符')
    .max(32, '管理员账号名称最多 32 个字符'),
  masterPassword: z.string().min(8, 'Master password must be at least 8 characters').max(256),
});

export const loginSchema = z.object({
  masterPassword: z.string().min(1, 'Master password is required'),
});

export const apiKeyCreateSchema = z.object({
  name: z.string().min(1, 'API Key name is required').max(100),
});

export const passwordGeneratorSchema = z.object({
  length: z.number().int().min(8).max(128).default(20),
  uppercase: z.boolean().default(true),
  lowercase: z.boolean().default(true),
  numbers: z.boolean().default(true),
  symbols: z.boolean().default(true),
});

export const evaluatePasswordSchema = z.object({
  password: z.string().min(1),
});

export const changeMasterPasswordSchema = z.object({
  oldPassword: z.string().min(1),
  newPassword: z.string().min(8).max(256),
});

export const importSchema = z.object({
  strategy: z.enum(['skip', 'overwrite', 'duplicate']).default('skip'),
  data: z.object({
    version: z.string(),
    /** 旧导出文件里的分类字段，导入时会被转成同名标签 */
    categories: z.array(z.any()).optional(),
    tags: z.array(z.any()).default([]),
    passwords: z.array(z.any()).default([]),
  }),
});

export interface ValidationErrorLike extends Error {
  isValidationError?: boolean;
  validationErrors?: Array<{ path: string; message: string }>;
}

export function validateInput<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const errors = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    const err = new Error('Validation failed') as ValidationErrorLike;
    err.validationErrors = errors;
    err.isValidationError = true;
    throw err;
  }
  return result.data;
}

export function extractValidationErrors(err: Error): Array<{ path: string; message: string }> | null {
  const validationErr = err as ValidationErrorLike;
  if (validationErr.isValidationError) {
    return validationErr.validationErrors ?? null;
  }
  return null;
}
