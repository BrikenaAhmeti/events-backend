import type { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import type { Environment } from '../../../common/config/environment';
import { RateLimitService } from '../../../common/security/rate-limit.service';
import { TokenService } from '../../../common/security/token.service';
import type { PrismaService } from '../../../infrastructure/database/prisma.service';
import { GuestAccessService } from './guest-access.service';
import { GuestAccessWindowService } from './guest-access-window.service';

const createService = (invitation: unknown) => {
  const prisma = {
    invitation: { findUnique: vi.fn().mockResolvedValue(invitation) },
  } as unknown as PrismaService;
  const config = {
    get: (key: string) => (key === 'NODE_ENV' ? 'test' : ''),
  } as unknown as ConfigService<Environment, true>;
  return new GuestAccessService(
    prisma,
    new TokenService(),
    new RateLimitService(),
    config,
    new GuestAccessWindowService(),
  );
};

describe('GuestAccessService invitation security', () => {
  it('denies expired invitations', async () => {
    const service = createService({
      guestId: 'guest-a',
      status: 'SENT',
      revokedAt: null,
      expiresAt: new Date(Date.now() - 1000),
      event: { id: 'event-a', slug: 'event-a', status: 'PUBLISHED' },
    });
    await expect(
      service.exchange(
        { token: 'a'.repeat(40), fullName: 'Avery Stone', email: 'avery@example.test' },
        '127.0.0.1',
        {} as Response,
      ),
    ).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
  });

  it('denies revoked invitations', async () => {
    const service = createService({
      guestId: 'guest-a',
      status: 'REVOKED',
      revokedAt: new Date(),
      expiresAt: new Date(Date.now() + 1000),
      event: { id: 'event-a', slug: 'event-a', status: 'PUBLISHED' },
    });
    await expect(
      service.exchange(
        { token: 'b'.repeat(40), fullName: 'Avery Stone', email: 'avery@example.test' },
        '127.0.0.2',
        {} as Response,
      ),
    ).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
  });

  it('does not preview a revoked invitation for a cancelled event', async () => {
    const service = createService({
      guestId: 'guest-a',
      status: 'REVOKED',
      revokedAt: new Date(),
      expiresAt: new Date(Date.now() + 1000),
      event: { id: 'event-a', slug: 'event-a', status: 'CANCELLED' },
    });
    await expect(
      service.invitationPreview({ token: 'd'.repeat(40) }, '127.0.0.4'),
    ).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
  });

  it('enforces the exact guest and event relationship for guest views', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = { event: { findFirst } } as unknown as PrismaService;
    const config = {
      get: (key: string) => (key === 'NODE_ENV' ? 'test' : ''),
    } as unknown as ConfigService<Environment, true>;
    const service = new GuestAccessService(
      prisma,
      new TokenService(),
      new RateLimitService(),
      config,
      new GuestAccessWindowService(),
    );

    await expect(service.guestEvent('event-b', 'guest-a')).rejects.toMatchObject({
      code: 'GUEST_ACCESS_DENIED',
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'event-b', guests: { some: { id: 'guest-a' } } },
      }),
    );
  });

  it('requires the complete guest name as well as the exact email', async () => {
    const service = createService({
      guestId: 'guest-a',
      status: 'SENT',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      guest: {
        id: 'guest-a',
        fullName: 'Avery Stone',
        normalizedEmail: 'avery@example.test',
      },
      event: {
        id: 'event-a',
        slug: 'event-a',
        status: 'PUBLISHED',
        startAt: new Date(Date.now() - 60 * 60 * 1000),
        endAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    await expect(
      service.exchange(
        { token: 'c'.repeat(40), fullName: 'Avery Other', email: 'avery@example.test' },
        '127.0.0.3',
        {} as Response,
      ),
    ).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
  });
});
