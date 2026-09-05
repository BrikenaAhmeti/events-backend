import type { AuthenticatedActor } from '../../../common/types/request.types';
import type { PrismaService } from '../../../infrastructure/database/prisma.service';
import { AuthorizationService } from '../../memberships/application/authorization.service';
import { Permission } from '../../memberships/domain/permission';
import type { FieldEncryptionService } from '../../../common/security/field-encryption.service';
import { GuestsService } from './guests.service';

const actor: AuthenticatedActor = {
  userId: 'user-a',
  supabaseUserId: 'identity-a',
  email: 'operator@example.test',
  firstName: 'Event',
  lastName: 'Operator',
  platformRole: null,
  memberships: [
    {
      clientId: 'client-a',
      role: 'CLIENT_STAFF',
      status: 'ACTIVE',
      permissions: [Permission.GUEST_MANAGE],
    },
  ],
};

describe('GuestsService', () => {
  it('scopes a guest update to the exact event relationship', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = {
      event: { findUnique: vi.fn().mockResolvedValue({ id: 'event-a', clientId: 'client-a' }) },
      guest: { findFirst },
    } as unknown as PrismaService;
    const service = new GuestsService(prisma, new AuthorizationService(), {
      encrypt: vi.fn(),
    } as unknown as FieldEncryptionService);

    await expect(
      service.update(actor, 'request-a', 'event-a', 'guest-b', { fullName: 'Updated Guest' }),
    ).rejects.toMatchObject({ code: 'GUEST_NOT_FOUND' });
    expect(findFirst).toHaveBeenCalledWith({ where: { id: 'guest-b', eventId: 'event-a' } });
  });
});
