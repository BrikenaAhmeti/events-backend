import { EventStatus } from '@prisma/client';
import type { AuthenticatedActor } from '../../../common/types/request.types';
import { AuthorizationService } from '../../memberships/application/authorization.service';
import { Permission } from '../../memberships/domain/permission';
import { EventLifecycleService } from './event-lifecycle.service';
import { EventMutationPolicyService } from './event-mutation-policy.service';

const staff: AuthenticatedActor = {
  userId: 'staff-a',
  supabaseUserId: 'identity-a',
  email: 'staff@example.test',
  firstName: 'Morgan',
  lastName: 'Reed',
  platformRole: null,
  memberships: [
    {
      clientId: 'client-a',
      role: 'CLIENT_STAFF',
      status: 'ACTIVE',
      permissions: [Permission.EVENT_READ, Permission.EVENT_EDIT, Permission.EVENT_DELETE],
    },
  ],
};

describe('EventMutationPolicyService', () => {
  const service = new EventMutationPolicyService(
    new AuthorizationService(),
    new EventLifecycleService(),
  );
  const upcoming = {
    clientId: 'client-a',
    createdByUserId: 'staff-a',
    status: EventStatus.DRAFT,
    startAt: new Date(Date.now() + 86_400_000),
    endAt: new Date(Date.now() + 172_800_000),
  };

  it('allows staff to change their own upcoming events', () => {
    expect(service.canMutate(staff, upcoming, Permission.EVENT_EDIT)).toBe(true);
  });

  it('denies staff changes to another creator event', () => {
    expect(
      service.canMutate(staff, { ...upcoming, createdByUserId: 'staff-b' }, Permission.EVENT_EDIT),
    ).toBe(false);
  });

  it('allows staff to change their own ongoing events', () => {
    expect(
      service.canMutate(
        staff,
        {
          ...upcoming,
          startAt: new Date(Date.now() - 86_400_000),
          endAt: new Date(Date.now() + 86_400_000),
        },
        Permission.EVENT_EDIT,
      ),
    ).toBe(true);
  });

  it('locks past events for staff', () => {
    expect(
      service.canMutate(
        staff,
        {
          ...upcoming,
          startAt: new Date(Date.now() - 172_800_000),
          endAt: new Date(Date.now() - 86_400_000),
        },
        Permission.EVENT_EDIT,
      ),
    ).toBe(false);
  });

  it('allows a client administrator to manage past events from another creator', () => {
    const administrator: AuthenticatedActor = {
      ...staff,
      userId: 'admin-a',
      memberships: [{ ...staff.memberships[0], role: 'CLIENT_ADMIN', permissions: [] }],
    };
    expect(
      service.canMutate(
        administrator,
        {
          ...upcoming,
          createdByUserId: 'staff-b',
          startAt: new Date(Date.now() - 172_800_000),
          endAt: new Date(Date.now() - 86_400_000),
        },
        Permission.EVENT_DELETE,
      ),
    ).toBe(true);
  });

  it('keeps cancelled events closed for administrators', () => {
    const administrator: AuthenticatedActor = {
      ...staff,
      userId: 'admin-a',
      memberships: [{ ...staff.memberships[0], role: 'CLIENT_ADMIN', permissions: [] }],
    };
    expect(
      service.canMutate(
        administrator,
        {
          ...upcoming,
          createdByUserId: 'staff-b',
          status: EventStatus.CANCELLED,
        },
        Permission.EVENT_EDIT,
      ),
    ).toBe(false);
  });
});
