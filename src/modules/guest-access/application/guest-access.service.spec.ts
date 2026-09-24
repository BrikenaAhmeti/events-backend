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
  it('allows a personal link to be confirmed again until the event closes and stores only hashed session tokens', async () => {
    const token = new TokenService().issue();
    const event = {
      id: 'event-a', slug: 'event-a', status: 'PUBLISHED',
      startAt: new Date(Date.now() - 3_600_000), endAt: new Date(Date.now() + 3_600_000),
    };
    const invitation = {
      id: 'invitation-a', tokenHash: token.hash, tokenEncrypted: null,
      guestId: 'guest-a', status: 'SENT', revokedAt: null,
      expiresAt: new Date(event.endAt.getTime() + 4 * 3_600_000),
      guest: { id: 'guest-a', fullName: 'Avery Stone', normalizedEmail: 'avery@example.test' },
      event,
    };
    const create = vi.fn();
    const cookie = vi.fn();
    const update = vi.fn(({ data }: { data: Record<string, unknown> }) => {
      Object.assign(invitation, data);
      return Promise.resolve(invitation);
    });
    const prisma = {
      invitation: { findUnique: vi.fn(({ where }: { where: { tokenHash: string } }) =>
        Promise.resolve(where.tokenHash === invitation.tokenHash ? invitation : null)), update },
      guestSession: { create },
    } as unknown as PrismaService;
    const service = new GuestAccessService(prisma, new TokenService(), new RateLimitService(), {
      get: (key: string) => key === 'NODE_ENV' ? 'production' : key === 'COOKIE_SAME_SITE' ? 'lax' : '',
    } as unknown as ConfigService<Environment, true>, new GuestAccessWindowService());
    const identity = { token: token.raw, fullName: 'Avery Stone', email: 'AVERY@example.test' };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(service.exchange(identity, '127.0.0.1', { cookie } as unknown as Response))
        .resolves.toEqual({ eventId: event.id, eventSlug: event.slug });
    }
    expect(invitation.tokenHash).toBe(token.hash);
    expect(invitation.status).toBe('ACCEPTED');
    expect(create).toHaveBeenCalledTimes(2);
    const rawSession = cookie.mock.calls[0]?.[1] as string;
    expect(create).toHaveBeenCalledWith({ data: {
      guestId: invitation.guestId, eventId: event.id,
      tokenHash: new TokenService().hash(rawSession), expiresAt: invitation.expiresAt,
    } });
    expect(cookie).toHaveBeenCalledWith(expect.any(String), rawSession,
      expect.objectContaining({ httpOnly: true, secure: true, expires: invitation.expiresAt }));
  });

  it.each(['NOT_STARTED', 'ENDED', 'CANCELLED'] as const)('denies both access paths when the event is %s', async (state) => {
    const event = {
      id: 'event-a', slug: 'event-a', status: state === 'CANCELLED' ? 'CANCELLED' : 'PUBLISHED',
      startAt: new Date(Date.now() + (state === 'NOT_STARTED' ? 3_600_000 : -10 * 3_600_000)),
      endAt: new Date(Date.now() + (state === 'ENDED' ? -5 * 3_600_000 : 3_600_000)),
    };
    const guest = { id: 'guest-a', fullName: 'Avery Stone', normalizedEmail: 'avery@example.test' };
    const create = vi.fn();
    const service = new GuestAccessService({
      event: { findFirst: vi.fn().mockResolvedValue(event) },
      guest: { findUnique: vi.fn().mockResolvedValue(guest) },
      invitation: { findUnique: vi.fn().mockResolvedValue({
        guestId: guest.id, guest, event, status: 'SENT', revokedAt: null,
        expiresAt: new Date(Date.now() + 24 * 3_600_000),
      }) },
      guestSession: { create },
    } as unknown as PrismaService, new TokenService(), new RateLimitService(),
    {} as ConfigService<Environment, true>, new GuestAccessWindowService());
    const identity = { fullName: guest.fullName, email: guest.normalizedEmail };
    await expect(service.identify(event.slug, identity, '127.0.0.1', {} as Response))
      .rejects.toMatchObject({ code: `EVENT_${state}` });
    await expect(service.exchange({ ...identity, token: 'a'.repeat(43) }, '127.0.0.1', {} as Response))
      .rejects.toMatchObject({ code: `EVENT_${state}` });
    expect(create).not.toHaveBeenCalled();
  });
  it('returns only minimal event identity before a guest confirms access', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: 'event-a',
      slug: 'leadership-forum',
      name: 'Leadership Forum',
      category: 'CONFERENCE',
      description: 'A leadership event.',
      destination: 'Lisbon',
      venue: 'Riverside Hall',
      startAt: new Date(Date.now() - 60 * 60 * 1000),
      endAt: new Date(Date.now() + 60 * 60 * 1000),
      timezone: 'Europe/Lisbon',
      status: 'PUBLISHED',
    });
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

    await expect(service.publicEvent('leadership-forum')).resolves.toMatchObject({
      id: 'event-a',
      accessState: 'ACTIVE',
    });
    const query = findFirst.mock.calls[0]?.[0] as { select: Record<string, boolean> };
    expect(query.select).not.toHaveProperty('venueAddress');
    expect(query.select).not.toHaveProperty('venueDetails');
    expect(query.select).not.toHaveProperty('restroomInformation');
    expect(query.select).not.toHaveProperty('accessibilityInformation');
    expect(query.select).not.toHaveProperty('parkingInformation');
    expect(query.select).not.toHaveProperty('wifiInformation');
    expect(query.select).not.toHaveProperty('organizerName');
  });

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
