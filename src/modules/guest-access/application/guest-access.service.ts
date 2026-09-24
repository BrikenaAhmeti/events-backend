import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Response } from 'express';
import { z } from 'zod';
import type { Environment } from '../../../common/config/environment';
import { ApplicationError } from '../../../common/errors/application.error';
import { GUEST_SESSION_COOKIE } from '../../../common/security/cookie.constants';
import { RateLimitService } from '../../../common/security/rate-limit.service';
import { TokenService } from '../../../common/security/token.service';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { GuestAccessWindowService } from './guest-access-window.service';

export const identifyGuestSchema = z.object({
  fullName: z.string().trim().min(2).max(200),
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
});

export const invitationTokenSchema = z.object({ token: z.string().min(32).max(200) });

@Injectable()
export class GuestAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly rateLimits: RateLimitService,
    private readonly config: ConfigService<Environment, true>,
    private readonly accessWindow: GuestAccessWindowService,
  ) {}

  async publicEvent(slug: string) {
    const event = await this.prisma.event.findFirst({
      where: { slug, status: { in: ['PUBLISHED', 'CANCELLED'] } },
      select: {
        id: true,
        slug: true,
        name: true,
        category: true,
        description: true,
        destination: true,
        venue: true,
        startAt: true,
        endAt: true,
        timezone: true,
        status: true,
      },
    });
    if (!event) throw new ApplicationError(404, 'EVENT_NOT_FOUND', 'This event is not available.');
    return { ...event, accessState: this.accessWindow.state(event) };
  }

  async publicEventLink(eventId: string) {
    const event = await this.prisma.event.findFirst({
      where: { id: eventId, status: { in: ['PUBLISHED', 'CANCELLED'] } },
      select: { slug: true },
    });
    if (!event) throw new ApplicationError(404, 'EVENT_NOT_FOUND', 'This event is not available.');
    return { slug: event.slug };
  }

  async identify(slug: string, body: unknown, ip: string | undefined, response: Response) {
    this.rateLimits.assert(`guest-identify:${ip ?? 'unknown'}:${slug}`, 8, 15 * 60 * 1000);
    const input = identifyGuestSchema.parse(body);
    const event = await this.prisma.event.findFirst({
      where: { slug, status: { in: ['PUBLISHED', 'CANCELLED'] } },
      select: { id: true, slug: true, status: true, startAt: true, endAt: true },
    });
    if (!event) throw this.notOnList();
    this.accessWindow.assertActive(event);
    const guest = await this.prisma.guest.findUnique({
      where: { eventId_normalizedEmail: { eventId: event.id, normalizedEmail: input.email } },
    });
    if (!guest || !this.namesMatch(input.fullName, guest.fullName)) throw this.notOnList();
    await this.createSession(guest.id, event, response);
    return { eventId: event.id, eventSlug: event.slug };
  }

  async invitationPreview(body: unknown, ip: string | undefined) {
    this.rateLimits.assert(`invitation-preview:${ip ?? 'unknown'}`, 30, 15 * 60 * 1000);
    const { token } = invitationTokenSchema.parse(body);
    const invitation = await this.invitationForToken(token, true);
    if (!invitation) throw this.invalidInvitation();
    return {
      event: {
        id: invitation.event.id,
        name: invitation.event.name,
        category: invitation.event.category,
        description: invitation.event.description,
        destination: invitation.event.destination,
        venue: invitation.event.venue,
        startAt: invitation.event.startAt,
        endAt: invitation.event.endAt,
        timezone: invitation.event.timezone,
        accessState: this.accessWindow.state(invitation.event),
      },
      requiresConfirmation: false,
    };
  }

  async exchange(body: unknown, ip: string | undefined, response: Response) {
    this.rateLimits.assert(`invitation-exchange:${ip ?? 'unknown'}`, 15, 15 * 60 * 1000);
    const { token } = invitationTokenSchema.parse(body);
    const invitation = await this.invitationForToken(token);
    if (!invitation?.guestId || !invitation.guest || invitation.guest.id !== invitation.guestId)
      throw this.invalidInvitation();
    this.accessWindow.assertActive(invitation.event);
    await this.createSession(invitation.guestId, invitation.event, response);
    await this.prisma.invitation.update({
      where: { id: invitation.id },
      data: {
        status: 'ACCEPTED',
        acceptedAt: new Date(),
        tokenEncrypted: null,
      },
    });
    return { eventId: invitation.event.id, eventSlug: invitation.event.slug };
  }

  async guestEvent(eventId: string, guestId: string) {
    const event = await this.prisma.event.findFirst({
      where: { id: eventId, guests: { some: { id: guestId } } },
      select: {
        id: true,
        name: true,
        category: true,
        description: true,
        destination: true,
        venue: true,
        venueAddress: true,
        venueDetails: true,
        restroomInformation: true,
        accessibilityInformation: true,
        parkingInformation: true,
        wifiInformation: true,
        startAt: true,
        endAt: true,
        timezone: true,
        organizerName: true,
        status: true,
        schedule: {
          where: { visibility: 'SHARED' },
          orderBy: { startAt: 'asc' },
          take: 50,
          select: {
            id: true,
            title: true,
            description: true,
            startAt: true,
            endAt: true,
            location: true,
            category: true,
          },
        },
      },
    });
    if (!event)
      throw new ApplicationError(403, 'GUEST_ACCESS_DENIED', 'Guest access is not valid.');
    this.accessWindow.assertActive(event);
    return { ...event, accessClosesAt: this.accessWindow.closesAt(event) };
  }

  private async createSession(
    guestId: string,
    event: { id: string; endAt: Date | null },
    response: Response,
  ): Promise<void> {
    const token = this.tokens.issue();
    const expiresAt = this.accessWindow.closesAt(event);
    await this.prisma.guestSession.create({
      data: { guestId, eventId: event.id, tokenHash: token.hash, expiresAt },
    });
    response.cookie(GUEST_SESSION_COOKIE, token.raw, {
      ...this.cookieOptions(),
      expires: expiresAt,
    });
  }

  private cookieOptions(): CookieOptions {
    const production = this.config.get('NODE_ENV', { infer: true }) === 'production';
    const domain = this.config.get('COOKIE_DOMAIN', { infer: true });
    const sameSite = this.config.get('COOKIE_SAME_SITE', { infer: true });
    return {
      httpOnly: true,
      secure: production,
      sameSite,
      path: '/',
      ...(domain ? { domain } : {}),
    };
  }

  private namesMatch(supplied: string, expected: string): boolean {
    const normalize = (value: string) =>
      value
        .toLowerCase()
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .replace(/[^\p{L}\p{N}\s]/gu, '')
        .split(/\s+/)
        .filter(Boolean)
        .sort()
        .join(' ');
    const suppliedName = normalize(supplied);
    return Boolean(suppliedName) && suppliedName === normalize(expected);
  }

  private notOnList(): ApplicationError {
    return new ApplicationError(
      403,
      'GUEST_NOT_RECOGNIZED',
      'We could not confirm access with those details.',
    );
  }

  private invalidInvitation(): ApplicationError {
    return new ApplicationError(
      410,
      'INVITATION_INVALID',
      'This invitation is invalid, expired, or could not be confirmed.',
    );
  }

  private async invitationForToken(token: string, preview = false) {
    const invitation = await this.prisma.invitation.findUnique({
      where: { tokenHash: this.tokens.hash(token) },
      include: {
        guest: { select: { id: true } },
        event: {
          select: {
            id: true,
            slug: true,
            name: true,
            category: true,
            description: true,
            destination: true,
            venue: true,
            startAt: true,
            endAt: true,
            timezone: true,
            status: true,
          },
        },
      },
    });
    if (!invitation?.guestId || !invitation.expiresAt ||
      !['SENT', 'ACCEPTED'].includes(invitation.status)) return null;
    if (preview) {
      if (invitation.status === 'REVOKED' || invitation.revokedAt) return null;
      if (
        invitation.expiresAt <= new Date() &&
        this.accessWindow.state(invitation.event) !== 'ENDED'
      )
        return null;
    } else if (
      invitation.status === 'REVOKED' ||
      invitation.revokedAt ||
      invitation.expiresAt <= new Date()
    ) {
      return null;
    }
    return invitation;
  }
}
