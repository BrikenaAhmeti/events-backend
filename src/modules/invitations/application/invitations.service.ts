import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { Environment } from '../../../common/config/environment';
import { ApplicationError } from '../../../common/errors/application.error';
import type { AuthenticatedActor } from '../../../common/types/request.types';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { OutboxService } from '../../../infrastructure/jobs/outbox.service';
import { AuthorizationService } from '../../memberships/application/authorization.service';
import { Permission } from '../../memberships/domain/permission';
import { QrCodeService } from './qr-code.service';
import { GuestAccessWindowService } from '../../guest-access/application/guest-access-window.service';

@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly outbox: OutboxService,
    private readonly qr: QrCodeService,
    private readonly config: ConfigService<Environment, true>,
    private readonly accessWindow: GuestAccessWindowService,
  ) {}

  async list(actor: AuthenticatedActor, eventId: string) {
    const event = await this.authorize(actor, eventId, Permission.INVITATION_READ);
    const items = await this.prisma.invitation.findMany({
      where: { eventId: event.id },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        status: true,
        type: true,
        expiresAt: true,
        sentAt: true,
        acceptedAt: true,
        revokedAt: true,
        failureCode: true,
        guest: { select: { id: true, fullName: true, email: true } },
      },
    });
    return {
      items,
      summary: Object.fromEntries(
        ['PENDING', 'QUEUED', 'SENT', 'FAILED', 'REVOKED', 'ACCEPTED'].map((status) => [
          status,
          items.filter((item) => item.status === status).length,
        ]),
      ),
    };
  }

  async generalAccess(actor: AuthenticatedActor, eventId: string) {
    const event = await this.authorize(actor, eventId, Permission.INVITATION_READ);
    if (event.status !== 'PUBLISHED')
      throw new ApplicationError(
        400,
        'EVENT_NOT_PUBLISHED',
        'Publish the event before sharing guest access.',
      );
    const url = `${this.config.get('PUBLIC_APP_URL', { infer: true })}/e/${event.slug}`;
    return { url, qrSvg: await this.qr.toSvg(url) };
  }

  async send(actor: AuthenticatedActor, requestId: string, eventId: string) {
    const event = await this.authorize(actor, eventId, Permission.INVITATION_SEND);
    if (event.status !== 'PUBLISHED')
      throw new ApplicationError(
        400,
        'EVENT_NOT_PUBLISHED',
        'Publish the event before sending invitations.',
      );
    const queued = await this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${eventId}))`);
      const guests = await transaction.guest.findMany({
        where: {
          eventId,
          invitations: { none: { status: { in: ['QUEUED', 'SENT', 'ACCEPTED'] } } },
        },
        select: { id: true },
      });
      const guestCount = await transaction.guest.count({ where: { eventId } });
      if (guestCount === 0)
        throw new ApplicationError(
          400,
          'GUEST_LIST_EMPTY',
          'Add guests before sending invitations.',
        );
      if (guests.length === 0) return 0;
      for (const guest of guests) {
        const invitation = await transaction.invitation.create({
          data: {
            eventId,
            guestId: guest.id,
            status: 'QUEUED',
            expiresAt: this.accessWindow.closesAt(event),
          },
        });
        await this.outbox.create(transaction, {
          type: 'INVITATION_SEND',
          aggregateId: invitation.id,
          clientId: event.clientId,
          eventId,
          payload: { invitationId: invitation.id },
        });
      }
      await transaction.auditLog.create({
        data: {
          actorUserId: actor.userId,
          clientId: event.clientId,
          eventId,
          action: 'INVITATIONS_REQUESTED',
          entityType: 'Event',
          entityId: eventId,
          requestId,
          metadata: { count: guests.length },
        },
      });
      return guests.length;
    });
    return { queued };
  }

  async revoke(
    actor: AuthenticatedActor,
    requestId: string,
    eventId: string,
    invitationId: string,
  ) {
    const event = await this.authorize(actor, eventId, Permission.INVITATION_REVOKE);
    const invitation = await this.prisma.invitation.findFirst({
      where: { id: invitationId, eventId },
    });
    if (!invitation)
      throw new ApplicationError(404, 'INVITATION_NOT_FOUND', 'Invitation not found.');
    const revoked = await this.prisma.invitation.update({
      where: { id: invitationId },
      data: { status: 'REVOKED', revokedAt: new Date(), tokenHash: null, tokenEncrypted: null },
    });
    await this.prisma.guestSession.updateMany({
      where: { eventId, guestId: invitation.guestId ?? undefined, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.prisma.auditLog.create({
      data: {
        actorUserId: actor.userId,
        clientId: event.clientId,
        eventId,
        action: 'INVITATION_REVOKED',
        entityType: 'Invitation',
        entityId: invitationId,
        requestId,
      },
    });
    return { id: revoked.id, status: revoked.status };
  }

  private async authorize(actor: AuthenticatedActor, eventId: string, permission: Permission) {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { id: true, clientId: true, slug: true, status: true, endAt: true },
    });
    if (!event) throw new ApplicationError(404, 'EVENT_NOT_FOUND', 'Event not found.');
    this.authorization.assert(actor, event.clientId, permission);
    return event;
  }
}
