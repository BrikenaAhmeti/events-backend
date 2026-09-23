import { Injectable } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { z } from 'zod';
import type { AuthenticatedActor } from '../../../common/types/request.types';
import { ApplicationError } from '../../../common/errors/application.error';
import { AiProvider } from '../../../infrastructure/openai/ai.provider';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { scheduleItemSchema, updateEventSchema } from '../../events/application/event.contracts';
import { UpdateEventDetailsCommand } from '../../events/application/event.messages';
import { EventCompletenessService } from '../../events/domain/event-completeness.service';
import { EventMutationPolicyService } from '../../events/domain/event-mutation-policy.service';
import { Permission } from '../../memberships/domain/permission';
import { AuthorizationService } from '../../memberships/application/authorization.service';
import { validChatGuests } from '../../guests/application/guest.contracts';

@Injectable()
export class OrganizerExtractionService {
  constructor(
    private readonly ai: AiProvider,
    private readonly commands: CommandBus,
    private readonly prisma: PrismaService,
    private readonly policy: EventMutationPolicyService,
    private readonly completeness: EventCompletenessService,
    private readonly authorization: AuthorizationService,
  ) {}

  async extractAndApply(
    actor: AuthenticatedActor,
    eventId: string,
    text: string,
    requestId: string,
  ) {
    const existing = await this.prisma.event.findUnique({ where: { id: eventId } });
    if (!existing) throw new ApplicationError(404, 'EVENT_NOT_FOUND', 'Event not found.');
    this.policy.assertMutable(actor, existing, Permission.EVENT_EDIT);
    const conversation =
      (await this.prisma.conversation.findFirst({
        where: { eventId, type: 'ORGANIZER', userId: actor.userId },
        orderBy: { createdAt: 'desc' },
      })) ??
      (await this.prisma.conversation.create({
        data: {
          clientId: existing.clientId,
          eventId,
          userId: actor.userId,
          type: 'ORGANIZER',
        },
      }));
    await this.prisma.conversationMessage.create({
      data: { conversationId: conversation.id, role: 'USER', content: text, status: 'COMPLETE' },
    });
    try {
      const recent = await this.prisma.conversationMessage.findMany({
        where: { conversationId: conversation.id },
        orderBy: { createdAt: 'desc' },
        take: 12,
        select: { role: true, content: true },
      });
      const source = [
        `Current event details (context only): ${JSON.stringify({
          name: existing.name,
          category: existing.category,
          description: existing.description,
          destination: existing.destination,
          venue: existing.venue,
          startAt: existing.startAt,
          endAt: existing.endAt,
          timezone: existing.timezone,
          organizerName: existing.organizerName,
          organizerEmail: existing.organizerEmail,
        })}`,
        `Recent conversation (context only): ${recent.reverse().map((item) => `${item.role}: ${item.content}`).join('\n')}`,
        `Latest organizer message to apply: ${text}`,
      ].join('\n\n');
      const candidate = await this.ai.extractEventInformation(source, requestId);
      const normalized = Object.fromEntries(
        Object.entries(candidate.event ?? {}).filter(([, value]) => value != null),
      );
      const parsed = updateEventSchema.safeParse(normalized);
      if (!parsed.success) {
        const message = await this.prisma.conversationMessage.create({
          data: {
            conversationId: conversation.id,
            role: 'CONCIERGE',
            content: 'I found some details, but they need review before I can add them.',
            status: 'COMPLETE',
          },
        });
        return {
          applied: false,
          rejectedFields: z.flattenError(parsed.error).fieldErrors,
          candidate,
          message,
        };
      }
      const updated =
        Object.keys(parsed.data).length > 0
          ? await this.commands.execute<UpdateEventDetailsCommand, Record<string, unknown>>(
              new UpdateEventDetailsCommand(actor, requestId, eventId, parsed.data),
            )
          : null;
      const validSchedule = candidate.schedule.flatMap((item) => {
        const result = scheduleItemSchema.safeParse(item);
        return result.success ? [result.data] : [];
      });
      const parsedGuests = validChatGuests(candidate.guests ?? []);
      if (parsedGuests.guests.length)
        this.authorization.assert(actor, existing.clientId, Permission.GUEST_MANAGE);
      const addedGuests = await this.prisma.$transaction(async (transaction) => {
        for (const fact of candidate.facts) {
          await transaction.eventFact.upsert({
            where: { eventId_key: { eventId, key: fact.key } },
            create: {
              eventId,
              key: fact.key,
              value: fact.value,
              sourceType: 'CONCIERGE_UPDATE',
              sourceUserId: actor.userId,
              confidence: fact.confidence,
              precedence: 300,
            },
            update: {
              value: fact.value,
              sourceType: 'CONCIERGE_UPDATE',
              sourceDocumentId: null,
              sourceUserId: actor.userId,
              confidence: fact.confidence,
              precedence: 300,
            },
          });
        }
        const schedule = await transaction.scheduleItem.findMany({
          where: { eventId },
          select: { title: true, startAt: true },
        });
        for (const item of validSchedule) {
          const startAt = new Date(item.startAt);
          const duplicate = schedule.some(
            (current) =>
              current.title.toLowerCase() === item.title.toLowerCase() &&
              current.startAt.getTime() === startAt.getTime(),
          );
          if (!duplicate) {
            await transaction.scheduleItem.create({
              data: {
                eventId,
                title: item.title,
                startAt,
                endAt: item.endAt ? new Date(item.endAt) : undefined,
                location: item.location,
              },
            });
          }
        }
        if (!parsedGuests.guests.length) return 0;
        const result = await transaction.guest.createMany({
          data: parsedGuests.guests.map((guest) => ({
            eventId,
            fullName: guest.fullName,
            email: guest.email,
            normalizedEmail: guest.email.toLowerCase(),
            company: guest.company,
            guestGroup: guest.guestGroup,
          })),
          skipDuplicates: true,
        });
        if (result.count) await transaction.auditLog.create({
          data: {
            actorUserId: actor.userId,
            clientId: existing.clientId,
            eventId,
            action: 'GUESTS_IMPORTED',
            entityType: 'Guest',
            entityId: eventId,
            requestId,
            metadata: { accepted: result.count, source: 'CONCIERGE' },
          },
        });
        return result.count;
      });
      const finalEvent = await this.prisma.event.findUniqueOrThrow({ where: { id: eventId } });
      const eventCompleteness = this.completeness.evaluate(finalEvent);
      const guestSummary = addedGuests ? `Added ${addedGuests} guest${addedGuests === 1 ? '' : 's'}. ` : '';
      const missingEmailSummary = parsedGuests.missingEmails.length
        ? `I still need email addresses for: ${parsedGuests.missingEmails.join(', ')}. ` : '';
      const content = `${guestSummary}${missingEmailSummary}${eventCompleteness.ready
        ? 'All mandatory event details are complete. Continue to guest details or publishing.'
        : `Still needed: ${eventCompleteness.missing.join(', ')}.`}`;
      const message = await this.prisma.conversationMessage.create({
        data: {
          conversationId: conversation.id,
          role: 'CONCIERGE',
          content,
          status: 'COMPLETE',
        },
      });
      return {
        applied: Boolean(updated) || candidate.facts.length > 0 || validSchedule.length > 0 || addedGuests > 0,
        addedGuests,
        event: updated,
        candidate: { facts: candidate.facts, schedule: validSchedule },
        completeness: eventCompleteness,
        message,
      };
    } catch (error) {
      await this.prisma.conversationMessage.create({
        data: {
          conversationId: conversation.id,
          role: 'CONCIERGE',
          content: 'I could not review that information. Please try again.',
          status: 'FAILED',
        },
      });
      throw error;
    }
  }
}
