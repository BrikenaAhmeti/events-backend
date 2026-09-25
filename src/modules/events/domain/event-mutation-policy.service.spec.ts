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
      permissions: [
        Permission.EVENT_READ,
        Permission.EVENT_EDIT,
        Permission.EVENT_DELETE,
        Permission.EVENT_PUBLISH,
        Permission.GUEST_MANAGE,
        Permission.INVITATION_SEND,
        Permission.DOCUMENT_UPLOAD,
      ],
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

  it.each(['SUPER_ADMIN', 'CLIENT_ADMIN', 'CLIENT_STAFF'] as const)('enforces the start-time boundary for %s', (role) => {
    const scopedActor: AuthenticatedActor = {
      ...staff,
      platformRole: role === 'SUPER_ADMIN' ? role : null,
      memberships: role === 'SUPER_ADMIN' ? [] : [{ ...staff.memberships[0], role }],
    };
    for (const permission of [Permission.EVENT_EDIT, Permission.EVENT_DELETE]) {
      expect(service.canMutate(scopedActor, upcoming, permission)).toBe(true);
      expect(() => service.assertMutable(scopedActor, { ...upcoming, startAt: new Date(Date.now() - 1) }, permission))
        .toThrow('Only upcoming events can be changed.');
    }
  });

  it('allows a client administrator to change another creator’s upcoming event but denies a different client', () => {
    const administrator: AuthenticatedActor = {
      ...staff, userId: 'admin-a',
      memberships: [{ ...staff.memberships[0], role: 'CLIENT_ADMIN', permissions: [] }],
    };
    expect(service.canMutate(administrator, { ...upcoming, createdByUserId: 'staff-b' }, Permission.EVENT_EDIT)).toBe(true);
    expect(service.canMutate(administrator, { ...upcoming, clientId: 'client-b' }, Permission.EVENT_EDIT)).toBe(false);
  });

  it('allows staff to change their own upcoming events', () => {
    expect(service.canMutate(staff, upcoming, Permission.EVENT_EDIT)).toBe(true);
  });

  it('lets event creators with only create permission publish, manage guests, and send invitations', () => {
    const creator: AuthenticatedActor = {
      ...staff,
      memberships: [{ ...staff.memberships[0], permissions: [Permission.EVENT_CREATE] }],
    };
    for (const permission of [
      Permission.EVENT_EDIT,
      Permission.EVENT_PUBLISH,
      Permission.GUEST_MANAGE,
      Permission.GUEST_IMPORT,
      Permission.INVITATION_SEND,
    ]) {
      expect(service.canMutate(creator, upcoming, permission)).toBe(true);
      expect(() => service.assertMutable(creator, upcoming, permission)).not.toThrow();
      expect(service.canMutate(creator, { ...upcoming, createdByUserId: 'staff-b' }, permission)).toBe(false);
      expect(() => service.assertMutable(creator, { ...upcoming, createdByUserId: 'staff-b' }, permission))
        .toThrow('You do not have permission to perform this action.');
    }
    expect(service.canMutate(creator, upcoming, Permission.INVITATION_REVOKE)).toBe(false);
  });

  it('denies staff changes to another creator event', () => {
    const anotherCreatorEvent = { ...upcoming, createdByUserId: 'staff-b' };
    for (const permission of [
      Permission.EVENT_EDIT,
      Permission.EVENT_DELETE,
      Permission.EVENT_PUBLISH,
      Permission.GUEST_MANAGE,
      Permission.INVITATION_SEND,
      Permission.DOCUMENT_UPLOAD,
    ]) {
      expect(service.canMutate(staff, anotherCreatorEvent, permission)).toBe(false);
      expect(() => service.assertMutable(staff, anotherCreatorEvent, permission))
        .toThrow('Staff can change only events they created.');
    }
  });

  it('locks ongoing events for staff', () => {
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
    ).toBe(false);
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

  it('locks past events for client administrators', () => {
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
    ).toBe(false);
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
