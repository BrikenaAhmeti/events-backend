import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PLATFORM_ACCESS_COOKIE } from '../../../common/security/cookie.constants';
import type { RequestContext } from '../../../common/types/request.types';
import type { PrismaService } from '../../../infrastructure/database/prisma.service';
import type { SupabaseAuthProvider } from '../infrastructure/supabase-auth.provider';
import { PlatformAuthGuard } from './platform-auth.guard';

function setup() {
  const user = {
    id: 'user-a',
    supabaseUserId: 'identity-a',
    email: 'operator@example.test',
    firstName: 'Event',
    lastName: 'Operator',
    platformRole: null,
    status: 'ACTIVE',
    memberships: [
      {
        clientId: 'client-a',
        role: 'CLIENT_STAFF',
        status: 'ACTIVE',
        client: { status: 'ACTIVE' },
        permissions: [{ permission: 'EVENT_READ' }],
      },
      {
        clientId: 'inactive-client',
        role: 'CLIENT_ADMIN',
        status: 'ACTIVE',
        client: { status: 'INACTIVE' },
        permissions: [],
      },
    ],
  };
  const request = {
    cookies: { [PLATFORM_ACCESS_COOKIE]: 'access-token' },
  } as unknown as RequestContext;
  const context = {
    getHandler: () => setup,
    getClass: () => PlatformAuthGuard,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  const findUnique = vi.fn().mockResolvedValue(user);
  const verify = vi.fn().mockResolvedValue({ id: user.supabaseUserId });
  const guard = new PlatformAuthGuard(
    new Reflector(),
    { verify } as unknown as SupabaseAuthProvider,
    { user: { findUnique } } as unknown as PrismaService,
  );
  return { guard, context, request, user, findUnique, verify };
}

describe('PlatformAuthGuard', () => {
  it('loads current permissions and excludes inactive clients', async () => {
    const { guard, context, request, user, findUnique } = setup();

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.actor?.memberships).toEqual([
      {
        clientId: 'client-a',
        role: 'CLIENT_STAFF',
        status: 'ACTIVE',
        permissions: ['EVENT_READ'],
      },
    ]);

    findUnique.mockResolvedValue({
      ...user,
      memberships: [{ ...user.memberships[0], permissions: [] }],
    });
    await guard.canActivate(context);
    expect(request.actor?.memberships[0]?.permissions).toEqual([]);
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('rejects an account disabled between requests', async () => {
    const { guard, context, user, findUnique } = setup();
    await guard.canActivate(context);
    findUnique.mockResolvedValue({ ...user, status: 'DISABLED' });
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      code: 'ACCOUNT_NOT_ACTIVE',
    });
  });

  it('rejects invalid tokens before reading application data', async () => {
    const { guard, context, findUnique, verify } = setup();
    verify.mockRejectedValue(new Error('Invalid token'));
    await expect(guard.canActivate(context)).rejects.toThrow('Invalid token');
    expect(findUnique).not.toHaveBeenCalled();
  });
});
