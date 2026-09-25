import type { AuthenticatedActor } from '../../../common/types/request.types';
import type { PrismaService } from '../../../infrastructure/database/prisma.service';
import { AuthorizationService } from '../../memberships/application/authorization.service';
import { Permission } from '../../memberships/domain/permission';
import type { FieldEncryptionService } from '../../../common/security/field-encryption.service';
import { GuestsService } from './guests.service';
import { EventMutationPolicyService } from '../../events/domain/event-mutation-policy.service';
import { EventLifecycleService } from '../../events/domain/event-lifecycle.service';

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
  it('allows active event readers to list guests without a separate guest-read grant', async () => {
    const reader: AuthenticatedActor = {
      ...actor,
      memberships: [{ ...actor.memberships[0], permissions: [Permission.EVENT_READ] }],
    };
    const event = { id: 'event-a', clientId: 'client-a', createdByUserId: 'staff-b', status: 'PUBLISHED', startAt: new Date(Date.now() - 86_400_000), endAt: new Date(Date.now() + 86_400_000) };
    const authorization = new AuthorizationService();
    const assert = vi.spyOn(authorization, 'assert');
    const prisma = {
      event: { findUnique: vi.fn().mockResolvedValue(event) },
      guest: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const service = new GuestsService(prisma, authorization, {} as FieldEncryptionService,
      new EventMutationPolicyService(authorization, new EventLifecycleService()));

    await expect(service.list(reader, event.id)).resolves.toMatchObject({ items: [] });
    expect(assert).toHaveBeenCalledWith(reader, event.clientId, Permission.EVENT_READ);
  });

  it.each([
    { createdByUserId: 'staff-b', startAt: new Date(Date.now() + 86_400_000), code: 'EVENT_OWNERSHIP_REQUIRED' },
    { createdByUserId: actor.userId, startAt: new Date(Date.now() - 1), code: 'EVENT_CHANGES_CLOSED' },
  ])('rejects guest mutations when the event policy denies access: $code', async ({ createdByUserId, startAt, code }) => {
    const create = vi.fn();
    const prisma = {
      event: { findUnique: vi.fn().mockResolvedValue({ id: 'event-a', clientId: 'client-a', status: 'PUBLISHED', createdByUserId, startAt, endAt: new Date(Date.now() + 86_400_000) }) },
      guest: { create },
    } as unknown as PrismaService;
    const service = new GuestsService(prisma, new AuthorizationService(), {} as FieldEncryptionService,
      new EventMutationPolicyService(new AuthorizationService(), new EventLifecycleService()));
    await expect(service.add(actor, 'request-a', 'event-a', { fullName: 'Test Guest', email: 'guest@example.test' }))
      .rejects.toMatchObject({ code });
    expect(create).not.toHaveBeenCalled();
  });
  it('scopes a guest update to the exact event relationship', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = {
      event: { findUnique: vi.fn().mockResolvedValue({ id: 'event-a', clientId: 'client-a', createdByUserId: actor.userId, status: 'READY', startAt: null, endAt: null }) },
      guest: { findFirst },
    } as unknown as PrismaService;
    const service = new GuestsService(prisma, new AuthorizationService(), {
      encrypt: vi.fn(),
    } as unknown as FieldEncryptionService, new EventMutationPolicyService(new AuthorizationService(), new EventLifecycleService()));

    await expect(
      service.update(actor, 'request-a', 'event-a', 'guest-b', { fullName: 'Updated Guest' }),
    ).rejects.toMatchObject({ code: 'GUEST_NOT_FOUND' });
    expect(findFirst).toHaveBeenCalledWith({ where: { id: 'guest-b', eventId: 'event-a' } });
  });
});
