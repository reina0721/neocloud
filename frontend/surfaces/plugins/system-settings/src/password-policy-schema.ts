import { z } from 'zod';

const length = z
  .string()
  .regex(/^\d+$/)
  .refine((value) => Number(value) >= 1 && Number(value) <= 128);

export const passwordPolicyFormSchema = z
  .object({ minLength: length, maxLength: length, requireComplexity: z.boolean() })
  .refine(({ minLength, maxLength }) => Number(minLength) <= Number(maxLength), {
    path: ['maxLength'],
  });
