import {
  CommandHandler,
  type ICommandHandler,
  type IQueryHandler,
  QueryHandler,
} from '@nestjs/cqrs';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { ApplicationError } from '../../../common/errors/application.error';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { OutboxService } from '../../../infrastructure/jobs/outbox.service';
import { AuthorizationService } from '../../memberships/application/authorization.service';
import { Permission } from '../../memberships/domain/permission';
import { EventCompletenessService } from '../domain/event-completeness.service';
import { EventLifecycleService } from '../domain/event-lifecycle.service';
import { EventMutationPolicyService } from '../domain/event-mutation-policy.service';
import {
  AddScheduleItemCommand,
  CancelEventCommand,
  CreateEventDraftCommand,
  DeleteEventCommand,
  GetEventQuery,
  GetEventsQuery,
  PublishEventCommand,
  UpdateEventDetailsCommand,
} from './event.messages';

const eventInclude = {
  _count: { select: { guests: true, documents: true, invitations: true } },
  schedule: { orderBy: { startAt: 'asc' as const }, take: 50 },
  facts: { orderBy: { key: 'asc' as const }, take: 100 },
  client: { select: { id: true, name: true } },
  createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
};

const slugify = (value: string) =>
  `${value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}-${randomUUID().slice(0, 8)}`;

@CommandHandler(CreateEventDraftCommand)
export class CreateEventDraftHandler implements ICommandHandler<CreateEventDraftCommand> {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly completeness: EventCompletenessService,
  ) {}

  async execute({ actor, input, requestId }: CreateEventDraftCommand) {
    this.authorization.assert(actor, input.clientId, Permission.EVENT_CREATE);
    const { facts = [], schedule = [], ...eventInput } = input;
    const event = await this.prisma.$transaction(async (transaction) => {
      const created = await transaction.event.create({
        data: {
          ...eventInput,
          startAt: eventInput.startAt ? new Date(eventInput.startAt) : undefined,
          endAt: eventInput.endAt ? new Date(eventInput.endAt) : undefined,
          slug: slugify(eventInput.name),
          createdByUserId: actor.userId,
        },
      });
      if (facts.length > 0) {
        await transaction.eventFact.createMany({
          data: facts.map((fact) => ({
            eventId: created.id,
            key: fact.key,
            value: fact.value,
            sourceType: 'USER_INPUT',
            sourceUserId: actor.userId,
            confidence: fact.confidence,
            precedence: 300,
          })),
          skipDuplicates: true,
        });
      }
      if (schedule.length > 0) {
        await transaction.scheduleItem.createMany({
          data: schedule.map((item) => ({
            eventId: created.id,
            title: item.title,
            description: item.description,
            startAt: new Date(item.startAt),
            endAt: item.endAt ? new Date(item.endAt) : undefined,
            location: item.location,
            category: item.category,
          })),
        });
      }
      await transaction.auditLog.create({
        data: {
          actorUserId: actor.userId,
          clientId: input.clientId,
          eventId: created.id,
          action: 'EVENT_CREATED',
          entityType: 'Event',
          entityId: created.id,
          requestId,
          metadata: { extractedFacts: facts.length, extractedScheduleItems: schedule.length },
        },
      });
      return created;
    });
    return { ...event, completeness: this.completeness.evaluate(event) };
  }
}

@CommandHandler(UpdateEventDetailsCommand)
export class UpdateEventDetailsHandler implements ICommandHandler<UpdateEventDetailsCommand> {
  constructor(
    private readonly prisma: PrismaService,
    private readonly completeness: EventCompletenessService,
    private readonly policy: EventMutationPolicyService,
  ) {}

  async execute({ actor, eventId, input, requestId }: UpdateEventDetailsCommand) {
    const existing = await this.prisma.event.findUnique({ where: { id: eventId } });
    if (!existing) throw new ApplicationError(404, 'EVENT_NOT_FOUND', 'Event not found.');
    this.policy.assertMutable(actor, existing, Permission.EVENT_EDIT);
    const event = await this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.event.update({
        where: { id: eventId },
        data: {
          ...input,
          configuration: input.configuration as Prisma.InputJsonValue | undefined,
          startAt:
            input.startAt === null ? null : input.startAt ? new Date(input.startAt) : undefined,
          endAt: input.endAt === null ? null : input.endAt ? new Date(input.endAt) : undefined,
        },
      });
      const result = this.completeness.evaluate(updated);
      const status = ['PUBLISHED', 'CANCELLED', 'ARCHIVED'].includes(updated.status)
        ? updated.status
        : result.ready
          ? 'READY'
          : 'DRAFT';
      const finalized =
        status === updated.status
          ? updated
          : await transaction.event.update({ where: { id: eventId }, data: { status } });
      await transaction.auditLog.create({
        data: {
          actorUserId: actor.userId,
          clientId: existing.clientId,
          eventId,
          action: 'EVENT_UPDATED',
          entityType: 'Event',
          entityId: eventId,
          requestId,
          metadata: { fields: Object.keys(input) },
        },
      });
      return finalized;
    });
    return { ...event, completeness: this.completeness.evaluate(event) };
  }
}

@CommandHandler(AddScheduleItemCommand)
export class AddScheduleItemHandler implements ICommandHandler<AddScheduleItemCommand> {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: EventMutationPolicyService,
  ) {}

  async execute({ actor, eventId, input, requestId }: AddScheduleItemCommand) {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { clientId: true, createdByUserId: true, status: true, startAt: true, endAt: true },
    });
    if (!event) throw new ApplicationError(404, 'EVENT_NOT_FOUND', 'Event not found.');
    this.policy.assertMutable(actor, event, Permission.EVENT_EDIT);
    const item = await this.prisma.scheduleItem.create({
      data: {
        ...input,
        eventId,
        startAt: new Date(input.startAt),
        endAt: input.endAt ? new Date(input.endAt) : undefined,
      },
    });
    await this.prisma.auditLog.create({
      data: {
        actorUserId: actor.userId,
        clientId: event.clientId,
        eventId,
        action: 'SCHEDULE_ITEM_ADDED',
        entityType: 'ScheduleItem',
        entityId: item.id,
        requestId,
      },
    });
    return item;
  }
}

@CommandHandler(PublishEventCommand)
export class PublishEventHandler implements ICommandHandler<PublishEventCommand> {
  constructor(
    private readonly prisma: PrismaService,
    private readonly completeness: EventCompletenessService,
    private readonly outbox: OutboxService,
    private readonly policy: EventMutationPolicyService,
  ) {}

  async execute({ actor, eventId, requestId }: PublishEventCommand) {
    const event = await this.prisma.event.findUnique({ where: { id: eventId } });
    if (!event) throw new ApplicationError(404, 'EVENT_NOT_FOUND', 'Event not found.');
    this.policy.assertMutable(actor, event, Permission.EVENT_PUBLISH);
    const completeness = this.completeness.evaluate(event);
    if (!completeness.ready) {
      throw new ApplicationError(
        400,
        'EVENT_VALIDATION_FAILED',
        'Event information is incomplete.',
        completeness,
      );
    }
    return this.prisma.$transaction(async (transaction) => {
      const published = await transaction.event.update({
        where: { id: eventId },
        data: { status: 'PUBLISHED' },
      });
      await this.outbox.create(transaction, {
        type: 'EVENT_PUBLISHED',
        aggregateId: eventId,
        clientId: event.clientId,
        eventId,
        payload: { eventId },
      });
      await transaction.auditLog.create({
        data: {
          actorUserId: actor.userId,
          clientId: event.clientId,
          eventId,
          action: 'EVENT_PUBLISHED',
          entityType: 'Event',
          entityId: eventId,
          requestId,
        },
      });
      return { ...published, completeness };
    });
  }
}

@CommandHandler(CancelEventCommand)
export class CancelEventHandler implements ICommandHandler<CancelEventCommand> {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: EventMutationPolicyService,
  ) {}

  async execute({ actor, eventId, requestId }: CancelEventCommand) {
    const event = await this.prisma.event.findUnique({ where: { id: eventId } });
    if (!event) throw new ApplicationError(404, 'EVENT_NOT_FOUND', 'Event not found.');
    this.policy.assertMutable(actor, event, Permission.EVENT_DELETE);
    return this.prisma.$transaction(async (transaction) => {
      const cancelled = await transaction.event.update({
        where: { id: eventId },
        data: { status: 'CANCELLED' },
      });
      await transaction.invitation.updateMany({
        where: { eventId, status: { notIn: ['REVOKED', 'FAILED'] } },
        data: { status: 'REVOKED', revokedAt: new Date(), tokenEncrypted: null },
      });
      await transaction.guestSession.updateMany({
        where: { eventId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await transaction.auditLog.create({
        data: {
          actorUserId: actor.userId,
          clientId: event.clientId,
          eventId,
          action: 'EVENT_CANCELLED',
          entityType: 'Event',
          entityId: eventId,
          requestId,
        },
      });
      return cancelled;
    });
  }
}

@CommandHandler(DeleteEventCommand)
export class DeleteEventHandler implements ICommandHandler<DeleteEventCommand> {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: EventMutationPolicyService,
  ) {}

  async execute({ actor, eventId, requestId }: DeleteEventCommand): Promise<void> {
    const event = await this.prisma.event.findUnique({ where: { id: eventId } });
    if (!event) throw new ApplicationError(404, 'EVENT_NOT_FOUND', 'Event not found.');
    this.policy.assertMutable(actor, event, Permission.EVENT_DELETE);
    await this.prisma.$transaction(async (transaction) => {
      await transaction.auditLog.create({
        data: {
          actorUserId: actor.userId,
          clientId: event.clientId,
          eventId,
          action: 'EVENT_DELETED',
          entityType: 'Event',
          entityId: eventId,
          requestId,
          metadata: { name: event.name },
        },
      });
      await transaction.event.delete({ where: { id: eventId } });
    });
  }
}

@QueryHandler(GetEventsQuery)
export class GetEventsHandler implements IQueryHandler<GetEventsQuery> {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly completeness: EventCompletenessService,
    private readonly lifecycle: EventLifecycleService,
    private readonly policy: EventMutationPolicyService,
  ) {}

  async execute({ actor, input }: GetEventsQuery) {
    const resolvedClientId =
      input.clientId ?? actor.memberships.find(({ status }) => status === 'ACTIVE')?.clientId;
    if (!resolvedClientId && actor.platformRole !== 'SUPER_ADMIN')
      throw new ApplicationError(400, 'CLIENT_CONTEXT_REQUIRED', 'Select a client to view events.');
    if (resolvedClientId) this.authorization.assert(actor, resolvedClientId, Permission.EVENT_READ);
    const now = new Date();
    const and: Prisma.EventWhereInput[] = [];
    const lifecycleFilters = (input.lifecycle ?? []).map((lifecycle): Prisma.EventWhereInput => {
      if (lifecycle === 'UNSCHEDULED') return { startAt: null };
      if (lifecycle === 'UPCOMING')
        return { status: { not: 'CANCELLED' }, startAt: { gt: now } };
      if (lifecycle === 'ONGOING')
        return {
          status: { not: 'CANCELLED' },
          startAt: { lte: now },
          OR: [{ endAt: null }, { endAt: { gte: now } }],
        };
      if (lifecycle === 'PAST')
        return { status: { not: 'CANCELLED' }, endAt: { lt: now } };
      return { status: 'CANCELLED' };
    });
    if (lifecycleFilters.length) and.push({ OR: lifecycleFilters });
    if (input.date) {
      const start = new Date(`${input.date}T00:00:00.000Z`);
      const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
      and.push({ startAt: { lt: end }, endAt: { gte: start } });
    }
    if (input.from || input.to) {
      const start = input.from ? new Date(`${input.from}T00:00:00.000Z`) : undefined;
      const end = input.to
        ? new Date(new Date(`${input.to}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000)
        : undefined;
      if (end) and.push({ startAt: { lt: end } });
      if (start) and.push({ OR: [{ endAt: { gte: start } }, { endAt: null }] });
    }
    const where: Prisma.EventWhereInput = {
      ...(resolvedClientId ? { clientId: resolvedClientId } : {}),
      ...(input.status ? { status: { in: input.status } } : {}),
      ...(input.createdByUserId ? { createdByUserId: input.createdByUserId } : {}),
      ...(input.search ? { name: { contains: input.search, mode: 'insensitive' } } : {}),
      ...(and.length ? { AND: and } : {}),
    };
    const records = await this.prisma.event.findMany({
      where,
      take: input.limit + 1,
      ...(input.cursor ? { skip: 1, cursor: { id: input.cursor } } : {}),
      orderBy: [{ startAt: 'desc' }, { id: 'asc' }],
      include: {
        _count: { select: { guests: true, documents: true, invitations: true } },
        client: { select: { id: true, name: true } },
        createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });
    const items = records.slice(0, input.limit).map((event) => ({
      ...event,
      completeness: this.completeness.evaluate(event),
      operationalStatus: this.lifecycle.status(event, now),
      capabilities: {
        canEdit: this.policy.canMutate(actor, event, Permission.EVENT_EDIT),
        canDelete: this.policy.canMutate(actor, event, Permission.EVENT_DELETE),
        canCancel: this.policy.canMutate(actor, event, Permission.EVENT_DELETE),
      },
    }));
    return {
      items,
      pageInfo: {
        hasNextPage: records.length > input.limit,
        endCursor: records.length > input.limit ? items.at(-1)?.id : null,
      },
    };
  }
}

@QueryHandler(GetEventQuery)
export class GetEventHandler implements IQueryHandler<GetEventQuery> {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly completeness: EventCompletenessService,
    private readonly lifecycle: EventLifecycleService,
    private readonly policy: EventMutationPolicyService,
  ) {}

  async execute({ actor, eventId }: GetEventQuery) {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      include: eventInclude,
    });
    if (!event) throw new ApplicationError(404, 'EVENT_NOT_FOUND', 'Event not found.');
    this.authorization.assert(actor, event.clientId, Permission.EVENT_READ);
    return {
      ...event,
      completeness: this.completeness.evaluate(event),
      operationalStatus: this.lifecycle.status(event),
      capabilities: {
        canEdit: this.policy.canMutate(actor, event, Permission.EVENT_EDIT),
        canDelete: this.policy.canMutate(actor, event, Permission.EVENT_DELETE),
        canCancel: this.policy.canMutate(actor, event, Permission.EVENT_DELETE),
      },
    };
  }
}
