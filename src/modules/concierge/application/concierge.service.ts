import { Injectable } from '@nestjs/common';
import type { ConversationType } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApplicationError } from '../../../common/errors/application.error';
import { FieldEncryptionService } from '../../../common/security/field-encryption.service';
import type { AuthenticatedActor, GuestActor } from '../../../common/types/request.types';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { AiProvider } from '../../../infrastructure/openai/ai.provider';
import { EventKnowledgeRepository } from '../../knowledge/infrastructure/event-knowledge.repository';
import { AuthorizationService } from '../../memberships/application/authorization.service';
import { Permission } from '../../memberships/domain/permission';

const answerSchema = z.string().trim().min(1).max(4_000);

export type ConciergeStreamEvent =
  | { type: 'status'; messageId: string; status: 'PROCESSING' }
  | { type: 'delta'; messageId: string; delta: string }
  | {
      type: 'message';
      message: {
        id: string;
        role: 'CONCIERGE';
        content: string;
        status: 'COMPLETE';
        createdAt: Date;
      };
    }
  | { type: 'error'; messageId: string; message: string };

@Injectable()
export class ConciergeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiProvider,
    private readonly knowledge: EventKnowledgeRepository,
    private readonly authorization: AuthorizationService,
    private readonly encryption: FieldEncryptionService,
  ) {}

  async askPlatform(
    actor: AuthenticatedActor,
    eventId: string,
    question: string,
    requestId: string,
    onEvent?: (event: ConciergeStreamEvent) => void,
  ) {
    const event = await this.loadEvent(eventId);
    this.authorization.assert(actor, event.clientId, Permission.EVENT_READ);
    return this.answer({
      event,
      question,
      requestId,
      type: 'ORGANIZER',
      audience: this.platformAudience(actor, event.clientId),
      userId: actor.userId,
      onEvent,
    });
  }

  async askGuest(
    actor: GuestActor,
    question: string,
    requestId: string,
    onEvent?: (event: ConciergeStreamEvent) => void,
  ) {
    const event = await this.loadEvent(actor.eventId);
    const guest = await this.prisma.guest.findFirst({
      where: { id: actor.guestId, eventId: actor.eventId },
    });
    if (!guest)
      throw new ApplicationError(403, 'GUEST_ACCESS_DENIED', 'Guest access is not valid.');
    const privateContext = this.needsPrivateContext(question)
      ? [
          ['Accommodation', this.encryption.decrypt(guest.accommodationEncrypted)],
          ['Travel', this.encryption.decrypt(guest.travelEncrypted)],
          ['Dietary', this.encryption.decrypt(guest.dietaryEncrypted)],
          ['Accessibility', this.encryption.decrypt(guest.accessibilityEncrypted)],
        ]
          .filter(([, value]) => value)
          .map(([label, value]) => `${label}: ${value}`)
          .join('\n')
      : undefined;
    return this.answer({
      event,
      question,
      requestId,
      type: 'GUEST',
      audience: 'GUEST',
      guestId: guest.id,
      privateContext,
      onEvent,
    });
  }

  async historyPlatform(actor: AuthenticatedActor, eventId: string) {
    const event = await this.loadEvent(eventId);
    this.authorization.assert(actor, event.clientId, Permission.EVENT_READ);
    return this.history(eventId, 'ORGANIZER', actor.userId);
  }

  async historyGuest(actor: GuestActor) {
    return this.history(actor.eventId, 'GUEST', undefined, actor.guestId);
  }

  private async answer(input: {
    event: Awaited<ReturnType<ConciergeService['loadEvent']>>;
    question: string;
    requestId: string;
    type: ConversationType;
    audience: 'SUPER_ADMIN' | 'CLIENT_ADMIN' | 'CLIENT_STAFF' | 'GUEST';
    userId?: string;
    guestId?: string;
    privateContext?: string;
    onEvent?: (event: ConciergeStreamEvent) => void;
  }) {
    const conversation = await this.conversation(
      input.event,
      input.type,
      input.userId,
      input.guestId,
    );
    await this.prisma.conversationMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'USER',
        content: input.question,
        status: 'COMPLETE',
      },
    });
    const responseMessageId = randomUUID();
    this.publish(input, {
      type: 'status',
      messageId: responseMessageId,
      status: 'PROCESSING',
    });
    try {
      let semantic: Array<{ content: string }> = [];
      if (this.needsSemanticContext(input.question)) {
        const [embedding] = await this.ai.embed([input.question]);
        semantic = embedding ? await this.knowledge.semanticSearch(input.event.id, embedding) : [];
      }
      const response = await this.ai.answerStream(
        {
          audience: input.audience,
          question: input.question,
          eventName: input.event.name,
          timezone: input.event.timezone ?? 'UTC',
          structuredContext: this.structuredContext(input.event, input.question),
          untrustedDocumentContext: semantic
            .map(({ content }) => content)
            .join('\n---\n')
            .slice(0, 20_000),
          privateGuestContext: input.privateContext,
          requestId: input.requestId,
        },
        (delta) =>
          this.publish(input, {
            type: 'delta',
            messageId: responseMessageId,
            delta,
          }),
      );
      const answer = answerSchema.safeParse(response.answer);
      const message = await this.prisma.conversationMessage.create({
        data: {
          id: responseMessageId,
          conversationId: conversation.id,
          role: 'CONCIERGE',
          content: answer.success
            ? answer.data
            : 'I do not have that information for this event yet.',
          status: 'COMPLETE',
          metadata: response.usage ?? {},
        },
      });
      this.publish(input, {
        type: 'message',
        message: {
          id: message.id,
          role: 'CONCIERGE',
          content: message.content,
          status: 'COMPLETE',
          createdAt: message.createdAt,
        },
      });
      return { conversationId: conversation.id, message };
    } catch (error) {
      const failed = await this.prisma.conversationMessage.create({
        data: {
          id: responseMessageId,
          conversationId: conversation.id,
          role: 'CONCIERGE',
          content: 'Concierge is temporarily unavailable. Please try again shortly.',
          status: 'FAILED',
        },
      });
      this.publish(input, {
        type: 'error',
        messageId: failed.id,
        message: failed.content,
      });
      throw error;
    }
  }

  private publish(
    input: { onEvent?: (event: ConciergeStreamEvent) => void },
    event: ConciergeStreamEvent,
  ): void {
    input.onEvent?.(event);
  }

  private async loadEvent(eventId: string) {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      include: {
        schedule: { orderBy: { startAt: 'asc' }, take: 100 },
        facts: { take: 200 },
        contacts: { take: 50 },
        locations: { take: 50 },
      },
    });
    if (!event) throw new ApplicationError(404, 'EVENT_NOT_FOUND', 'Event not found.');
    return event;
  }

  private async conversation(
    event: { id: string; clientId: string },
    type: ConversationType,
    userId?: string,
    guestId?: string,
  ) {
    const existing = await this.prisma.conversation.findFirst({
      where: { eventId: event.id, type, userId: userId ?? null, guestId: guestId ?? null },
      orderBy: { createdAt: 'desc' },
    });
    return (
      existing ??
      this.prisma.conversation.create({
        data: { clientId: event.clientId, eventId: event.id, type, userId, guestId },
      })
    );
  }

  private async history(
    eventId: string,
    type: ConversationType,
    userId?: string,
    guestId?: string,
  ) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { eventId, type, userId: userId ?? null, guestId: guestId ?? null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        messages: {
          orderBy: { createdAt: 'asc' },
          take: 100,
          select: { id: true, role: true, content: true, status: true, createdAt: true },
        },
      },
    });
    return conversation ?? { id: null, messages: [] };
  }

  private needsPrivateContext(question: string): boolean {
    return /\b(my|mine|i|room|flight|transfer|dietary|allerg|accessib|hotel)\b/i.test(question);
  }

  private platformAudience(
    actor: AuthenticatedActor,
    clientId: string,
  ): 'SUPER_ADMIN' | 'CLIENT_ADMIN' | 'CLIENT_STAFF' {
    if (actor.platformRole === 'SUPER_ADMIN') return 'SUPER_ADMIN';
    return actor.memberships.find(
      (membership) => membership.clientId === clientId && membership.status === 'ACTIVE',
    )?.role === 'CLIENT_ADMIN'
      ? 'CLIENT_ADMIN'
      : 'CLIENT_STAFF';
  }

  private needsSemanticContext(question: string): boolean {
    return !/\b(when|time|today|tonight|tomorrow|contact|phone|email|schedule|next)\b/i.test(
      question,
    );
  }

  private structuredContext(
    event: Awaited<ReturnType<ConciergeService['loadEvent']>>,
    question: string,
  ): string {
    const terms = question
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length > 2);
    const matches = (...values: Array<string | null>) =>
      terms.some((term) => values.some((value) => value?.toLowerCase().includes(term)));
    const scheduleIntent =
      /\b(when|time|today|tonight|tomorrow|where|schedule|agenda|next|room|meet|registration|speaker|dinner|lunch|breakfast|session)\b/i.test(
        question,
      );
    const contactIntent = /\b(contact|phone|email|emergency|organizer|help)\b/i.test(question);
    const locationIntent = /\b(where|address|location|venue|room|meet|hotel)\b/i.test(question);
    const schedule = event.schedule
      .filter(
        (item) =>
          scheduleIntent || matches(item.title, item.description, item.location, item.category),
      )
      .slice(0, 30);
    const facts = event.facts.filter((fact) => matches(fact.key, fact.value)).slice(0, 30);
    const contacts = event.contacts
      .filter(
        (contact) =>
          contactIntent || matches(contact.name, contact.role, contact.email, contact.phone),
      )
      .slice(0, 10);
    const locations = event.locations
      .filter(
        (location) => locationIntent || matches(location.name, location.address, location.notes),
      )
      .slice(0, 15);
    const localNow = new Intl.DateTimeFormat('en', {
      dateStyle: 'full',
      timeStyle: 'long',
      timeZone: event.timezone ?? 'UTC',
    }).format(new Date());
    return [
      `Event: ${event.name}`,
      `Description: ${event.description ?? 'Not provided'}`,
      `Destination: ${event.destination ?? 'Not provided'}`,
      `Venue: ${event.venue ?? 'Not provided'}`,
      `Venue address: ${event.venueAddress ?? 'Not provided'}`,
      `Venue details and wayfinding: ${event.venueDetails ?? 'Not provided'}`,
      `Restrooms: ${event.restroomInformation ?? 'Not provided'}`,
      `Accessibility: ${event.accessibilityInformation ?? 'Not provided'}`,
      `Parking: ${event.parkingInformation ?? 'Not provided'}`,
      `Wi-Fi: ${event.wifiInformation ?? 'Not provided'}`,
      `Starts: ${event.startAt?.toISOString() ?? 'Not provided'}`,
      `Ends: ${event.endAt?.toISOString() ?? 'Not provided'}`,
      `Current event-local time: ${localNow}`,
      ...schedule.map(
        (item) =>
          `Schedule: ${item.title} | ${item.startAt.toISOString()} | ${item.endAt?.toISOString() ?? ''} | ${item.location ?? ''}`,
      ),
      ...facts.map((fact) => `${fact.key}: ${fact.value}`),
      ...contacts.map(
        (contact) =>
          `Contact: ${contact.name} | ${contact.role ?? ''} | ${contact.email ?? ''} | ${contact.phone ?? ''}`,
      ),
      ...locations.map((location) => `Location: ${location.name} | ${location.address ?? ''}`),
    ]
      .join('\n')
      .slice(0, 30_000);
  }
}
