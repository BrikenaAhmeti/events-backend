import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { OutboxService } from '../../../infrastructure/jobs/outbox.service';

export async function queueGuestInvitations(
  transaction: Prisma.TransactionClient,
  event: { id: string; clientId: string },
  expiresAt: Date,
  outbox: OutboxService,
  guestIds?: string[],
): Promise<number> {
  await transaction.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${event.id}))`);
  const guests = await transaction.guest.findMany({
    where: {
      eventId: event.id,
      ...(guestIds ? { id: { in: guestIds } } : {}),
      invitations: { none: { status: { in: ['QUEUED', 'SENT', 'ACCEPTED'] } } },
    },
    select: { id: true },
  });
  for (let offset = 0; offset < guests.length; offset += 1_000) {
    const invitations = guests.slice(offset, offset + 1_000).map((guest) => ({
      id: randomUUID(), eventId: event.id, guestId: guest.id, status: 'QUEUED' as const, expiresAt,
    }));
    await transaction.invitation.createMany({
      data: invitations,
    });
    await outbox.createMany(transaction, invitations.map((invitation) => ({
      type: 'INVITATION_SEND', aggregateId: invitation.id,
      clientId: event.clientId, eventId: event.id,
      payload: { invitationId: invitation.id },
    })));
  }
  return guests.length;
}
