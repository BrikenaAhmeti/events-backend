import { validateEnvironment } from './environment';

describe('environment validation', () => {
  it('keeps credential-free local test execution available', () => {
    expect(validateEnvironment({ NODE_ENV: 'test' })).toMatchObject({
      NODE_ENV: 'test',
      PORT: 3000,
    });
  });

  it('fails closed when production providers and secrets are absent', () => {
    expect(() => validateEnvironment({ NODE_ENV: 'production' })).toThrow();
  });

  it('parses provider-neutral SMTP settings without treating false as true', () => {
    expect(
      validateEnvironment({
        NODE_ENV: 'test',
        EMAIL_PROVIDER: 'smtp',
        SMTP_SECURE: 'false',
      }),
    ).toMatchObject({
      EMAIL_PROVIDER: 'smtp',
      SMTP_PORT: 587,
      SMTP_SECURE: false,
      COOKIE_SAME_SITE: 'lax',
    });
  });

  it('accepts SMTP instead of a Resend key when every production provider is configured', () => {
    expect(
      validateEnvironment({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://database.example/app',
        DIRECT_DATABASE_URL: 'postgresql://database.example/app',
        SUPABASE_URL: 'https://project.supabase.co',
        SUPABASE_PUBLISHABLE_KEY: 'publishable-key',
        SUPABASE_SECRET_KEY: 'secret-key',
        SUPABASE_STORAGE_BUCKET: 'event-documents',
        OPENAI_API_KEY: 'openai-key',
        EMAIL_PROVIDER: 'smtp',
        EMAIL_FROM: 'Feliam <concierge@example.com>',
        SMTP_HOST: 'smtp.example.com',
        SMTP_USER: 'smtp-user',
        SMTP_PASSWORD: 'smtp-password',
        COOKIE_SECRET: 'a-production-cookie-secret-with-more-than-32-characters',
        COOKIE_SAME_SITE: 'none',
        DATA_ENCRYPTION_KEY: 'a-production-data-encryption-key',
      }),
    ).toMatchObject({
      EMAIL_PROVIDER: 'smtp',
      RESEND_API_KEY: '',
      SMTP_PORT: 587,
      COOKIE_SAME_SITE: 'none',
    });
  });
});
