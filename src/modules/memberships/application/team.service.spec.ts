import type { AuthenticatedActor } from '../../../common/types/request.types';
import type { PrismaService } from '../../../infrastructure/database/prisma.service';
import type { SupabaseAuthProvider } from '../../auth/infrastructure/supabase-auth.provider';
import type { AuthorizationService } from './authorization.service';
import { TeamService } from './team.service';

const actor: AuthenticatedActor = {
  userId: 'admin-a',
  supabaseUserId: 'identity-admin-a',
  email: 'admin@example.test',
  firstName: 'Client',
  lastName: 'Admin',
  platformRole: null,
  memberships: [
    {
      clientId: 'client-a',
      role: 'CLIENT_ADMIN',
      status: 'ACTIVE',
      permissions: [],
    },
  ],
};

function setup() {
  const membership = {
    id: 'membership-a',
    userId: 'staff-a',
    clientId: 'client-a',
    role: 'CLIENT_STAFF',
    status: 'ACTIVE',
  };
  const transaction = {
    clientMembership: {
      update: vi.fn().mockResolvedValue(membership),
      delete: vi.fn().mockResolvedValue(membership),
      count: vi.fn().mockResolvedValue(0),
    },
    user: { update: vi.fn(), updateMany: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  const prisma = {
    user: { findUnique: vi.fn() },
    clientMembership: { findFirst: vi.fn().mockResolvedValue(membership) },
    $transaction: vi.fn(
      async (operation: (client: typeof transaction) => Promise<unknown>) => operation(transaction),
    ),
  };
  const authorization = { assert: vi.fn() };
  const auth = { provisionUser: vi.fn() };
  const service = new TeamService(
    prisma as unknown as PrismaService,
    authorization as unknown as AuthorizationService,
    auth as unknown as SupabaseAuthProvider,
  );
  return { service, prisma, transaction, authorization, auth };
}

describe('TeamService access lifecycle', () => {
  it('rejects inviting the signed-in account as staff', async () => {
    const { service, prisma, auth } = setup();

    await expect(
      service.invite(actor, 'request-a', 'client-a', {
        email: 'ADMIN@EXAMPLE.TEST',
        firstName: 'Client',
        lastName: 'Admin',
        permissions: [],
      }),
    ).rejects.toMatchObject({ code: 'SELF_INVITATION_NOT_ALLOWED' });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(auth.provisionUser).not.toHaveBeenCalled();
  });

  it('disables the application user when their last active membership is disabled', async () => {
    const { service, transaction } = setup();

    await service.update(actor, 'request-b', 'client-a', 'membership-a', {
      status: 'DISABLED',
    });

    expect(transaction.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'staff-a', platformRole: null },
      data: { status: 'DISABLED' },
    });
  });

  it('reactivates the application user without creating an invitation job', async () => {
    const { service, transaction } = setup();

    await service.update(actor, 'request-c', 'client-a', 'membership-a', {
      status: 'ACTIVE',
    });

    expect(transaction.user.update).toHaveBeenCalledWith({
      where: { id: 'staff-a' },
      data: { status: 'ACTIVE' },
    });
  });

  it('removes staff membership and disables an account with no remaining access', async () => {
    const { service, transaction } = setup();

    await service.remove(actor, 'request-d', 'client-a', 'membership-a');

    expect(transaction.clientMembership.delete).toHaveBeenCalledWith({
      where: { id: 'membership-a' },
    });
    expect(transaction.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'staff-a', platformRole: null },
      data: { status: 'DISABLED' },
    });
    expect(transaction.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'CLIENT_STAFF_REMOVED' }) as unknown,
    });
  });
});
