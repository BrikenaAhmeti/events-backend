import type { AuthenticatedActor } from '../../../common/types/request.types';
import type { PrismaService } from '../../../infrastructure/database/prisma.service';
import { AuthorizationService } from '../../memberships/application/authorization.service';
import { GetClientsHandler, UpdateClientHandler } from './client.handlers';
import { GetClientsQuery, UpdateClientCommand } from './client.commands';

const clientAdmin: AuthenticatedActor = {
  userId: 'user-a',
  supabaseUserId: 'identity-a',
  email: 'admin@example.test',
  firstName: 'Client',
  lastName: 'Admin',
  platformRole: null,
  memberships: [{ clientId: 'client-a', role: 'CLIENT_ADMIN', status: 'ACTIVE', permissions: [] }],
};

const superAdmin: AuthenticatedActor = {
  ...clientAdmin,
  platformRole: 'SUPER_ADMIN',
  memberships: [],
};

describe('GetClientsHandler', () => {
  it('counts client staff without counting client administrators', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const handler = new GetClientsHandler({
      client: { findMany },
    } as unknown as PrismaService);

    await handler.execute(new GetClientsQuery(superAdmin));

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: {
          _count: {
            select: {
              events: true,
              memberships: { where: { role: 'CLIENT_STAFF' } },
            },
          },
        },
      }),
    );
  });
});

describe('UpdateClientHandler', () => {
  it('reserves client lifecycle changes for platform administrators', async () => {
    const transaction = vi.fn();
    const handler = new UpdateClientHandler(
      { $transaction: transaction } as unknown as PrismaService,
      new AuthorizationService(),
    );

    await expect(
      handler.execute(
        new UpdateClientCommand(clientAdmin, 'request-a', 'client-a', { status: 'INACTIVE' }),
      ),
    ).rejects.toMatchObject({ code: 'CLIENT_STATUS_RESTRICTED' });
    expect(transaction).not.toHaveBeenCalled();
  });
});
