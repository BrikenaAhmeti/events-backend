import type { ExecutionContext } from '@nestjs/common';
import { GUEST_SESSION_COOKIE } from '../../../common/security/cookie.constants';
import { TokenService } from '../../../common/security/token.service';
import type { PrismaService } from '../../../infrastructure/database/prisma.service';
import { GuestAccessWindowService } from '../application/guest-access-window.service';
import { GuestSessionGuard } from './guest-session.guard';

describe('GuestSessionGuard', () => {
  it('allows the invited guest to chat before the event begins', async () => {
    const now = new Date();
    const update = vi.fn();
    const guard = new GuestSessionGuard({ guestSession: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'session-a', eventId: 'event-a', guestId: 'guest-a', revokedAt: null,
        expiresAt: new Date(now.getTime() + 8 * 3_600_000),
        event: { status: 'PUBLISHED', startAt: new Date(now.getTime() + 2 * 3_600_000), endAt: new Date(now.getTime() + 4 * 3_600_000) },
      }), update,
    } } as unknown as PrismaService, new TokenService(), new GuestAccessWindowService());
    const request = { cookies: { [GUEST_SESSION_COOKIE]: 'opaque-session' }, params: { eventId: 'event-a' } };
    const context = { switchToHttp: () => ({ getRequest: () => request }) } as ExecutionContext;
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(update).toHaveBeenCalledOnce();
    expect(request).toHaveProperty('guestActor', { sessionId: 'session-a', guestId: 'guest-a', eventId: 'event-a' });
  });

  it('returns an ended state at the cutoff even when the session expires at the same instant', async () => {
    const now = new Date();
    const findFirst = vi.fn().mockResolvedValue({
      id: 'session-a', eventId: 'event-a', guestId: 'guest-a', revokedAt: null, expiresAt: now,
      event: { status: 'PUBLISHED', startAt: new Date(now.getTime() - 10 * 3_600_000), endAt: new Date(now.getTime() - 4 * 3_600_000) },
    });
    const update = vi.fn();
    const tokens = new TokenService();
    const guard = new GuestSessionGuard({ guestSession: { findFirst, update } } as unknown as PrismaService,
      tokens, new GuestAccessWindowService());
    const request = { cookies: { [GUEST_SESSION_COOKIE]: 'opaque-session' }, params: { eventId: 'event-a' } };
    const context = { switchToHttp: () => ({ getRequest: () => request }) } as ExecutionContext;
    await expect(guard.canActivate(context)).rejects.toMatchObject({ code: 'EVENT_ENDED' });
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { eventId: 'event-a', tokenHash: tokens.hash('opaque-session') },
    }));
    expect(update).not.toHaveBeenCalled();
  });
});
