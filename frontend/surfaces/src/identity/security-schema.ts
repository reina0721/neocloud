import { z } from 'zod';
import { identifierSchema } from './model';
export const accountSessionSchema = z
  .object({
    id: identifierSchema,
    device: z.string().min(1).max(200),
    createdAt: z.string().datetime(),
    lastActiveAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    current: z.boolean(),
  })
  .strict();
export const accountSessionsSchema = z
  .object({
    items: z
      .array(accountSessionSchema)
      .refine(
        (items) =>
          new Set(items.map((item) => item.id)).size === items.length &&
          items.filter((item) => item.current).length === 1,
      ),
  })
  .strict();
const passwordInput = z
  .string()
  .min(1)
  .refine((value) => Array.from(value).length <= 128);
export const changePasswordSchema = z
  .object({ currentPassword: passwordInput, newPassword: passwordInput })
  .strict()
  .refine((input) => input.currentPassword !== input.newPassword, { path: ['newPassword'] });
