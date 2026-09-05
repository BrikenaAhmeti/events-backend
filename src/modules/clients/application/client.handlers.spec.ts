import type { AuthenticatedActor } from '../../../common/types/request.types';
import type { PrismaService } from '../../../infrastructure/database/prisma.service';
import { AuthorizationService } from '../../memberships/application/authorization.service';
import { UpdateClientHandler } from './client.handlers';
import { UpdateClientCommand } from './client.commands';

const clientAdmin: AuthenticatedActor = {
  userId: 'user-a',
  supabaseUserId: 'identity-a',
  email: 'admin@example.test',
  firstName: 'Client',
  lastName: 'Admin',
  platformRole: null,
  memberships: [{ clientId: 'client-a', role: 'CLIENT_ADMIN', status: 'ACTIVE', permissions: [] }],
};

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
