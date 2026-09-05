import type { AuthenticatedActor } from '../../../common/types/request.types';
import { Permission } from '../domain/permission';
import { AuthorizationService } from './authorization.service';

const actor = (overrides: Partial<AuthenticatedActor> = {}): AuthenticatedActor => ({
  userId: '00000000-0000-4000-8000-000000000001',
  supabaseUserId: '00000000-0000-4000-8000-000000000002',
  email: 'operator@example.test',
  firstName: 'Event',
  lastName: 'Operator',
  platformRole: null,
  memberships: [],
  ...overrides,
});

describe('AuthorizationService', () => {
  const service = new AuthorizationService();

  it('allows a super administrator inside a selected client context', () => {
    expect(
      service.can(actor({ platformRole: 'SUPER_ADMIN' }), 'client-b', Permission.EVENT_EDIT),
    ).toBe(true);
  });

  it('allows active client administrators only in their client', () => {
    const clientAdmin = actor({
      memberships: [
        { clientId: 'client-a', role: 'CLIENT_ADMIN', status: 'ACTIVE', permissions: [] },
      ],
    });
    expect(service.can(clientAdmin, 'client-a', Permission.EVENT_PUBLISH)).toBe(true);
    expect(service.can(clientAdmin, 'client-b', Permission.EVENT_READ)).toBe(false);
  });

  it('enforces explicit permissions and active status for client staff', () => {
    const staff = actor({
      memberships: [
        {
          clientId: 'client-a',
          role: 'CLIENT_STAFF',
          status: 'ACTIVE',
          permissions: [Permission.EVENT_READ],
        },
      ],
    });
    const disabled = actor({
      memberships: [
        {
          clientId: 'client-a',
          role: 'CLIENT_STAFF',
          status: 'DISABLED',
          permissions: [Permission.EVENT_READ],
        },
      ],
    });
    expect(service.can(staff, 'client-a', Permission.EVENT_READ)).toBe(true);
    expect(service.can(staff, 'client-a', Permission.GUEST_MANAGE)).toBe(false);
    expect(service.can(disabled, 'client-a', Permission.EVENT_READ)).toBe(false);
  });
});
