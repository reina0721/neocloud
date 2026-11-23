import { z } from 'zod';

export type SetupValues = { name: string; email: string; password: string; setupToken: string };

export type SetupPasswordPolicy = Readonly<{
  minLength: number;
  maxLength: number;
  requireComplexity: boolean;
}>;

export const setupPolicySchema = z
  .object({
    minLength: z.number().int().min(1),
    maxLength: z.number().int().max(128),
    requireComplexity: z.boolean(),
    initialized: z.boolean(),
  })
  .refine((policy) => policy.minLength <= policy.maxLength);

export function createSetupSchema(policy: SetupPasswordPolicy) {
  return z.object({
    name: z
      .string()
      .trim()
      .refine((value) => value.length > 0 && Array.from(value).length <= 128),
    email: z
      .string()
      .trim()
      .pipe(z.email())
      .refine((value) => new TextEncoder().encode(value).length <= 254),
    password: z.string().refine((value) => {
      // IAM 按 Unicode 码点计数，复杂度也使用 Unicode 字符类别。
      const size = Array.from(value).length;
      return (
        size >= policy.minLength &&
        size <= policy.maxLength &&
        (!policy.requireComplexity ||
          (/\p{Lu}/u.test(value) && /\p{Ll}/u.test(value) && /\p{Nd}/u.test(value)))
      );
    }),
    setupToken: z.string().min(1),
  });
}
