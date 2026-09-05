import type { ConfigService } from '@nestjs/config';
import type { Environment } from '../../../common/config/environment';
import type { CsrfService } from '../../../common/security/csrf.service';
import type { AuthenticatedActor } from '../../../common/types/request.types';
import type { PrismaService } from '../../../infrastructure/database/prisma.service';
import type { AuditService } from '../../audit/application/audit.service';
import type { SupabaseAuthProvider } from '../infrastructure/supabase-auth.provider';
import { AuthService } from './auth.service';

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
    changePassword: vi.fn(),
    createPasswordResetToken: vi.fn().mockResolvedValue('recovery-token-hash'),
  };
  const audit = { record: vi.fn() };
  const email = { send: vi.fn() };
  const config = {
    get: vi.fn((key: string) =>
      key === 'PUBLIC_APP_URL' ? 'https://feliam.example' : key === 'PRODUCT_NAME' ? 'Feliam' : '',
    ),
  };
  const service = new AuthService(
    provider as unknown as SupabaseAuthProvider,
    prisma as unknown as PrismaService,
    {} as CsrfService,
    config as unknown as ConfigService<Environment, true>,
    audit as unknown as AuditService,
    email,
  );
  return { service, provider, prisma, transaction, audit, email };
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
    expect(email.send).toHaveBeenCalledWith({
      to: actor.email,
      subject: 'Reset your Feliam password',
      html: '<p>We received a request to reset your Feliam password.</p><p><a href="https://feliam.example/reset-password?token_hash=recovery-token-hash">Reset password</a></p><p>If you did not request this, you can ignore this email.</p>',
      idempotencyKey: 'password-reset-recovery-token-hash',
    });
  });
});
