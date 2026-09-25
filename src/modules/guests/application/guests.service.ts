import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ApplicationError } from '../../../common/errors/application.error';
import { FieldEncryptionService } from '../../../common/security/field-encryption.service';
import type { AuthenticatedActor } from '../../../common/types/request.types';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { AuthorizationService } from '../../memberships/application/authorization.service';
import { Permission } from '../../memberships/domain/permission';
import type { GuestInput, UpdateGuestInput } from './guest.contracts';
import { EventMutationPolicyService } from '../../events/domain/event-mutation-policy.service';

@Injectable()
export class GuestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly encryption: FieldEncryptionService,
    private readonly policy: EventMutationPolicyService,
  ) {}

  async list(actor: AuthenticatedActor, eventId: string, cursor?: string) {
    const event = await this.authorizeEvent(actor, eventId, Permission.GUEST_READ);
    const records = await this.prisma.guest.findMany({
      where: { eventId: event.id },
      take: 51,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      select: {
        id: true,
        fullName: true,
        firstName: true,
        lastName: true,
        email: true,
        company: true,
        jobTitle: true,
        phone: true,
        guestGroup: true,
        metadata: true,
        invitations: {
          orderBy: { createdAt: 'desc' }, take: 1,
          select: { id: true, status: true, sentAt: true },
        },
        createdAt: true,
      },
    });
    const items = records.slice(0, 50).map(({ invitations, ...guest }) => ({
      ...guest, latestInvitation: invitations?.[0] ?? null,
    }));
    return {
      items,
      pageInfo: {
        hasNextPage: records.length > 50,
        endCursor: records.length > 50 ? items.at(-1)?.id : null,
      },
    };
  }

  async add(actor: AuthenticatedActor, requestId: string, eventId: string, input: GuestInput) {
    const event = await this.authorizeEvent(actor, eventId, Permission.GUEST_MANAGE);
    try {
      const guest = await this.prisma.guest.create({ data: this.toCreateData(eventId, input) });
      await this.prisma.auditLog.create({
        data: {
          actorUserId: actor.userId,
          clientId: event.clientId,
          eventId,
          action: 'GUEST_ADDED',
          entityType: 'Guest',
          entityId: guest.id,
          requestId,
        },
      });
      return this.toSafeGuest(guest);
    } catch (error) {
      if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002')
        throw new ApplicationError(
          409,
          'GUEST_ALREADY_EXISTS',
          'A guest with this email already exists for the event.',
        );
      throw error;
    }
  }

  async import(actor: AuthenticatedActor, requestId: string, eventId: string, rows: GuestInput[]) {
    const event = await this.authorizeEvent(actor, eventId, Permission.GUEST_IMPORT);
    const existing = new Set(
      (
        await this.prisma.guest.findMany({
          where: { eventId, normalizedEmail: { in: rows.map(({ email }) => email.toLowerCase()) } },
          select: { normalizedEmail: true },
        })
      ).map(({ normalizedEmail }) => normalizedEmail),
    );
    const accepted: GuestInput[] = [];
    for (const row of rows) {
      const normalizedEmail = row.email.toLowerCase();
      if (existing.has(normalizedEmail)) continue;
      existing.add(normalizedEmail);
      accepted.push(row);
    }
    const guestIds = await this.prisma.$transaction(async (transaction) => {
      const ids: string[] = [];
      for (const row of accepted) {
        const guest = await transaction.guest.create({ data: this.toCreateData(eventId, row) });
        ids.push(guest.id);
      }
      await transaction.auditLog.create({
        data: {
          actorUserId: actor.userId,
          clientId: event.clientId,
          eventId,
          action: 'GUESTS_IMPORTED',
          entityType: 'Guest',
          entityId: eventId,
          requestId,
          metadata: { accepted: accepted.length, duplicates: rows.length - accepted.length },
        },
      });
      return ids;
    });
    return { accepted: accepted.length, duplicates: rows.length - accepted.length, rejected: 0, guestIds };
  }

  async update(
    actor: AuthenticatedActor,
    requestId: string,
    eventId: string,
    guestId: string,
    input: UpdateGuestInput,
  ) {
    const event = await this.authorizeEvent(actor, eventId, Permission.GUEST_MANAGE);
    const existing = await this.prisma.guest.findFirst({ where: { id: guestId, eventId } });
    if (!existing) throw new ApplicationError(404, 'GUEST_NOT_FOUND', 'Guest not found.');
    try {
      const guest = await this.prisma.$transaction(async (transaction) => {
        const updated = await transaction.guest.update({
          where: { id: guestId },
          data: this.toUpdateData(input),
        });
        await transaction.auditLog.create({
          data: {
            actorUserId: actor.userId,
            clientId: event.clientId,
            eventId,
            action: 'GUEST_UPDATED',
            entityType: 'Guest',
            entityId: guestId,
            requestId,
            metadata: { fields: Object.keys(input) },
          },
        });
        return updated;
      });
      return this.toSafeGuest(guest);
    } catch (error) {
      if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002')
        throw new ApplicationError(
          409,
          'GUEST_ALREADY_EXISTS',
          'A guest with this email already exists for the event.',
        );
      throw error;
    }
  }

  async assertImportAccess(actor: AuthenticatedActor, eventId: string): Promise<void> {
    await this.authorizeEvent(actor, eventId, Permission.GUEST_IMPORT);
  }

  private async authorizeEvent(actor: AuthenticatedActor, eventId: string, permission: Permission) {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { id: true, clientId: true, createdByUserId: true, status: true, startAt: true, endAt: true },
    });
    if (!event) throw new ApplicationError(404, 'EVENT_NOT_FOUND', 'Event not found.');
    if (permission === Permission.GUEST_READ) this.authorization.assert(actor, event.clientId, Permission.EVENT_READ);
    else this.policy.assertMutable(actor, event, permission);
    return event;
  }

  private toCreateData(eventId: string, input: GuestInput): Prisma.GuestUncheckedCreateInput {
    return {
      eventId,
      fullName: input.fullName,
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      normalizedEmail: input.email.toLowerCase(),
      company: input.company,
      jobTitle: input.jobTitle,
      phone: input.phone,
      guestGroup: input.guestGroup,
      notesEncrypted: this.encryption.encrypt(input.notes),
      dietaryEncrypted: this.encryption.encrypt(input.dietaryInformation),
      accessibilityEncrypted: this.encryption.encrypt(input.accessibilityInformation),
      accommodationEncrypted: this.encryption.encrypt(input.accommodation),
      travelEncrypted: this.encryption.encrypt(input.travelInformation),
      metadata: input.metadata ?? {},
    };
  }

  private toUpdateData(input: UpdateGuestInput): Prisma.GuestUncheckedUpdateInput {
    return {
      fullName: input.fullName,
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      normalizedEmail: input.email?.toLowerCase(),
      company: input.company,
      jobTitle: input.jobTitle,
      phone: input.phone,
      guestGroup: input.guestGroup,
      notesEncrypted: input.notes === undefined ? undefined : this.encryption.encrypt(input.notes),
      dietaryEncrypted:
        input.dietaryInformation === undefined
          ? undefined
          : this.encryption.encrypt(input.dietaryInformation),
      accessibilityEncrypted:
        input.accessibilityInformation === undefined
          ? undefined
          : this.encryption.encrypt(input.accessibilityInformation),
      accommodationEncrypted:
        input.accommodation === undefined
          ? undefined
          : this.encryption.encrypt(input.accommodation),
      travelEncrypted:
        input.travelInformation === undefined
          ? undefined
          : this.encryption.encrypt(input.travelInformation),
      metadata: input.metadata,
    };
  }

  private toSafeGuest(guest: {
    id: string;
    eventId: string;
    fullName: string;
    email: string;
    company: string | null;
    guestGroup: string | null;
    createdAt: Date;
  }) {
    return {
      id: guest.id,
      eventId: guest.eventId,
      fullName: guest.fullName,
      email: guest.email,
      company: guest.company,
      guestGroup: guest.guestGroup,
      createdAt: guest.createdAt,
    };
  }
}
