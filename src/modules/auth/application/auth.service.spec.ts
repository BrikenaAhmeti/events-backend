import type { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import type { Environment } from '../../../common/config/environment';
import type { CsrfService } from '../../../common/security/csrf.service';
import type { AuthenticatedActor } from '../../../common/types/request.types';
import type { PrismaService } from '../../../infrastructure/database/prisma.service';
import type { AuditService } from '../../audit/application/audit.service';
import type { SupabaseAuthProvider } from '../infrastructure/supabase-auth.provider';
import { AuthService } from './auth.service';
import {
  PLATFORM_SESSION_TTL_MS,
  PlatformSessionCookieService,
} from './platform-session-cookie.service';

const actor: AuthenticatedActor = {
  userId: 'user-a',
  supabaseUserId: 'identity-a',
  email: 'person@example.test',
  firstName: 'Old',
  lastName: 'Name',
  platformRole: null,
  memberships: [
    {
      clientId: 'client-a',
      role: 'CLIENT_STAFF',
      status: 'ACTIVE',
      permissions: ['EVENT_READ'],
    },
  ],
};

function createService() {
  const transaction = {
    user: { update: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  const prisma = {
    $transaction: vi.fn(async (operation: (client: typeof transaction) => Promise<void>) =>
      operation(transaction),
    ),
    user: {
      findUnique: vi.fn().mockResolvedValue({
        id: actor.userId,
        supabaseUserId: actor.supabaseUserId,
        email: actor.email,
        firstName: 'New',
        lastName: 'Name',
        platformRole: null,
        status: 'ACTIVE',
        memberships: [
          {
            id: 'membership-a',
            clientId: 'client-a',
            role: 'CLIENT_STAFF',
            status: 'ACTIVE',
            client: { status: 'ACTIVE' },
            permissions: [{ permission: 'EVENT_READ' }],
          },
        ],
      }),
    },
  };
  const provider = {
    login: vi.fn().mockResolvedValue({
      access_token: 'access-token-a',
      refresh_token: 'refresh-token-a',
      expires_in: 60 * 60,
    }),
    refresh: vi.fn().mockResolvedValue({
      access_token: 'access-token-b',
      refresh_token: 'refresh-token-b',
      expires_in: 60 * 60,
    }),
    verify: vi.fn().mockResolvedValue({ id: actor.supabaseUserId }),
    changePassword: vi.fn(),
    createPasswordResetToken: vi.fn().mockResolvedValue('recovery-token-hash'),
  };
  const audit = { record: vi.fn() };
  const email = { send: vi.fn() };
  const config = {
    get: vi.fn((key: string) => {
      if (key === 'PUBLIC_APP_URL') return 'https://feliam.example';
      if (key === 'PRODUCT_NAME') return 'Feliam';
      if (key === 'COOKIE_SECRET') return 'test-cookie-secret-with-at-least-32-characters';
      if (key === 'NODE_ENV') return 'test';
      if (key === 'COOKIE_SAME_SITE') return 'lax';
      return '';
    }),
  };
  const sessionCookies = new PlatformSessionCookieService(
    config as unknown as ConfigService<Environment, true>,
  );
  const service = new AuthService(
    provider as unknown as SupabaseAuthProvider,
    prisma as unknown as PrismaService,
    {} as CsrfService,
    config as unknown as ConfigService<Environment, true>,
    audit as unknown as AuditService,
    email,
    sessionCookies,
  );
  return { service, provider, prisma, transaction, audit, email };
}

function createResponse() {
  const cookie = vi.fn();
  const clearCookie = vi.fn();
  return { response: { cookie, clearCookie } as unknown as Response, cookie, clearCookie };
}

describe('AuthService account settings', () => {
  it('updates the signed-in user profile and records the exact actor', async () => {
    const { service, transaction } = createService();
    const result = await service.updateProfile(
      actor,
      { firstName: 'New', lastName: 'Name' },
      'request-a',
    );

    expect(transaction.user.update).toHaveBeenCalledWith({
      where: { id: actor.userId },
      data: { firstName: 'New', lastName: 'Name' },
    });
    expect(transaction.auditLog.create).toHaveBeenCalledWith({
      data: {
        actorUserId: actor.userId,
        clientId: 'client-a',
        action: 'USER_PROFILE_UPDATED',
        entityType: 'User',
        entityId: actor.userId,
        requestId: 'request-a',
        metadata: {},
      },
    });
    expect(result).toMatchObject({ firstName: 'New', lastName: 'Name' });
  });

  it('verifies and changes the password through Supabase before auditing', async () => {
    const { service, provider, audit } = createService();
    await service.changePassword(actor, 'current-password', 'new-secure-password', 'request-b');

    expect(provider.changePassword).toHaveBeenCalledWith(
      actor.email,
      'current-password',
      'new-secure-password',
    );
    expect(audit.record).toHaveBeenCalledWith({
      actorUserId: actor.userId,
      clientId: 'client-a',
      action: 'USER_PASSWORD_CHANGED',
      entityType: 'User',
      entityId: actor.userId,
      requestId: 'request-b',
    });
  });

  it('delivers a Supabase recovery token through the selected email provider', async () => {
    const { service, provider, email } = createService();
    await service.requestPasswordReset(actor.email);

    expect(provider.createPasswordResetToken).toHaveBeenCalledWith(
      actor.email,
      'https://feliam.example/reset-password',
    );
    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: actor.email,
        subject: 'Reset your Feliam password',
        html: expect.stringContaining(
          'href="https://feliam.example/reset-password?token_hash=recovery-token-hash"',
        ) as string,
        text: expect.stringContaining(
          'https://feliam.example/reset-password?token_hash=recovery-token-hash',
        ) as string,
        attachments: [
          expect.objectContaining({
            contentId: 'feliam-logo',
            contentType: 'image/png',
          }),
        ],
        idempotencyKey: 'password-reset-recovery-token-hash',
      }),
    );
  });
});

describe('AuthService platform sessions', () => {
  afterEach(() => vi.useRealTimers());

  it('rotates Supabase tokens without extending the absolute 24-hour login', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T08:00:00.000Z'));
    const { service, provider } = createService();
    const loginResponse = createResponse();

    await service.login(actor.email, 'password123', loginResponse.response);

    const accessCookie = loginResponse.cookie.mock.calls.find(([name]) => name === 'event_access');
    const refreshCookie = loginResponse.cookie.mock.calls.find(([name]) => name === 'event_refresh');
    expect(accessCookie).toEqual([
      'event_access',
      'access-token-a',
      expect.objectContaining({ httpOnly: true, maxAge: 60 * 60 * 1000 }),
    ]);
    expect(refreshCookie?.[1]).not.toBe('refresh-token-a');
    expect(refreshCookie?.[2]).toEqual(
      expect.objectContaining({ httpOnly: true, maxAge: PLATFORM_SESSION_TTL_MS }),
    );

    vi.advanceTimersByTime(60 * 60 * 1000);
    const refreshResponse = createResponse();
    await service.refresh(String(refreshCookie?.[1]), refreshResponse.response);

    expect(provider.refresh).toHaveBeenCalledWith('refresh-token-a');
    expect(refreshResponse.cookie).toHaveBeenCalledWith(
      'event_refresh',
      expect.any(String),
      expect.objectContaining({ maxAge: 23 * 60 * 60 * 1000 }),
    );
  });

  it('rejects refresh after 24 hours and removes both authentication cookies', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T08:00:00.000Z'));
    const { service, provider } = createService();
    const loginResponse = createResponse();
    await service.login(actor.email, 'password123', loginResponse.response);
    const refreshCookie = loginResponse.cookie.mock.calls.find(([name]) => name === 'event_refresh');

    vi.advanceTimersByTime(PLATFORM_SESSION_TTL_MS + 1);
    const refreshResponse = createResponse();
    await expect(service.refresh(String(refreshCookie?.[1]), refreshResponse.response)).rejects.toMatchObject(
      { statusCode: 401, code: 'SESSION_EXPIRED' },
    );

    expect(provider.refresh).not.toHaveBeenCalled();
    expect(refreshResponse.clearCookie).toHaveBeenCalledTimes(2);
  });
});
