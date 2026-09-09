import { z } from 'zod';

const optionalUrl = z.string().url().or(z.literal('')).default('');

export const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PRODUCT_NAME: z.string().min(1).max(100).default('Feliam'),
    PORT: z.coerce.number().int().positive().default(3000),
    FRONTEND_URL: z.string().url().default('http://localhost:5173'),
    PUBLIC_APP_URL: z.string().url().default('http://localhost:5173'),
    DATABASE_URL: z.string().default(''),
    DIRECT_DATABASE_URL: z.string().default(''),
    SUPABASE_URL: optionalUrl,
    SUPABASE_PUBLISHABLE_KEY: z.string().default(''),
    SUPABASE_SECRET_KEY: z.string().default(''),
    SUPABASE_STORAGE_BUCKET: z.string().default('events-files'),
    OPENAI_API_KEY: z.string().default(''),
    OPENAI_MODEL: z.string().default('gpt-5.6'),
    OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
    EMAIL_PROVIDER: z.enum(['resend', 'smtp']).default('smtp'),
    RESEND_API_KEY: z.string().default(''),
    EMAIL_FROM: z.string().default(''),
    SMTP_HOST: z.string().default(''),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    SMTP_SECURE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    SMTP_USER: z.string().default(''),
    SMTP_PASSWORD: z.string().default(''),
    COOKIE_SECRET: z.string().min(32).default('development-only-secret-change-me-now'),
    COOKIE_DOMAIN: z.string().default(''),
    COOKIE_SAME_SITE: z.enum(['lax', 'none', 'strict']).default('lax'),
    DATA_ENCRYPTION_KEY: z.string().default(''),
  })
  .superRefine((environment, context) => {
    if (environment.NODE_ENV !== 'production') return;
    const required = [
      'DATABASE_URL',
      'DIRECT_DATABASE_URL',
      'SUPABASE_URL',
      'SUPABASE_PUBLISHABLE_KEY',
      'SUPABASE_SECRET_KEY',
      'SUPABASE_STORAGE_BUCKET',
      'OPENAI_API_KEY',
      'EMAIL_FROM',
      'DATA_ENCRYPTION_KEY',
    ] as const;
    for (const field of required) {
      if (!environment[field])
        context.addIssue({
          code: 'custom',
          path: [field],
          message: 'Required in production',
        });
    }
    if (environment.EMAIL_PROVIDER === 'resend' && !environment.RESEND_API_KEY)
      context.addIssue({
        code: 'custom',
        path: ['RESEND_API_KEY'],
        message: 'Required in production when EMAIL_PROVIDER=resend',
      });
    if (environment.EMAIL_PROVIDER === 'smtp') {
      for (const field of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD'] as const) {
        if (!environment[field])
          context.addIssue({
            code: 'custom',
            path: [field],
            message: 'Required in production when EMAIL_PROVIDER=smtp',
          });
      }
    }
    if (environment.COOKIE_SECRET === 'development-only-secret-change-me-now')
      context.addIssue({
        code: 'custom',
        path: ['COOKIE_SECRET'],
        message: 'Replace the development cookie secret in production',
      });
  });

export type Environment = z.infer<typeof environmentSchema>;

export const validateEnvironment = (value: Record<string, unknown>): Environment =>
  environmentSchema.parse(value);
