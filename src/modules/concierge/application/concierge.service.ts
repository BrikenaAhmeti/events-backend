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
import { languageName, requestedLanguage } from './guest-chat-language';

const answerSchema = z.string().trim().min(1).max(4_000);

export type ConciergeStreamEvent =
  | { type: 'language'; language: string }
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
    const event = await this.loadEvent(actor.eventId, true);
    const guest = await this.prisma.guest.findFirst({
      where: { id: actor.guestId, eventId: actor.eventId },
    });
    if (!guest)
      throw new ApplicationError(403, 'GUEST_ACCESS_DENIED', 'Guest access is not valid.');
    const otherGuests = await this.prisma.guest.findMany({
      where: { eventId: actor.eventId, id: { not: guest.id } },
      select: { fullName: true, email: true },
    });
    const otherGuestIdentifiers = otherGuests.flatMap(({ fullName, email }) => [
      fullName, email,
      ...fullName.split(/\s+/).filter((part) => part.length >= 4),
    ]).filter((value) => value.trim().length > 0);
    if (this.asksAboutOtherGuests(question, otherGuestIdentifiers)) {
      return this.replyPrivately(
        event, guest.id, question,
        'I can help with your own arrangements and shared event details, but I cannot share another guest’s information.',
        onEvent,
      );
    }
    const privateContext = this.needsPrivateContext(question)
      ? [
          ['Your arrangements', this.encryption.decrypt(guest.notesEncrypted)],
          ['Accommodation', this.encryption.decrypt(guest.accommodationEncrypted)],
          ['Travel', this.encryption.decrypt(guest.travelEncrypted)],
          ['Dietary', this.encryption.decrypt(guest.dietaryEncrypted)],
          ['Accessibility', this.encryption.decrypt(guest.accessibilityEncrypted)],
        ]
          .filter(([, value]) => value && !this.mentionsOtherGuest(value, otherGuestIdentifiers))
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
      otherGuestIdentifiers,
      onEvent,
    });
  }

  async historyPlatform(actor: AuthenticatedActor, eventId: string) {
    const event = await this.loadEvent(eventId);
    this.authorization.assert(actor, event.clientId, Permission.EVENT_READ);
    const organizer = await this.history(eventId, 'ORGANIZER', actor.userId);
    const setup = await this.prisma.conversation.findFirst({
      where: { eventId, type: 'EVENT_SETUP', userId: actor.userId, state: 'COMPLETED' },
      orderBy: { createdAt: 'desc' },
      select: {
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 100,
          select: { id: true, role: true, content: true, status: true, createdAt: true },
        },
      },
    });
    return {
      ...organizer,
      messages: [...(setup?.messages ?? []), ...organizer.messages]
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime()),
    };
  }

  async historyGuest(actor: GuestActor) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { eventId: actor.eventId, type: 'GUEST', state: 'ACTIVE', userId: null, guestId: actor.guestId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        draft: true,
        messages: {
          orderBy: { createdAt: 'desc' }, take: 100,
          select: { id: true, role: true, content: true, status: true, createdAt: true },
        },
      },
    });
    if (!conversation) return { id: null, language: null, messages: [] };
    const draft = conversation.draft as { language?: string } | null;
    return {
      id: conversation.id,
      language: languageName(draft?.language) ? draft?.language : null,
      messages: [...conversation.messages].reverse(),
    };
  }

  async startGuestChat(actor: GuestActor, language: string) {
    if (!languageName(language))
      throw new ApplicationError(400, 'INVALID_CHAT_LANGUAGE', 'Choose a valid chat language.');
    const event = await this.loadEvent(actor.eventId, true);
    const guest = await this.prisma.guest.findFirst({
      where: { id: actor.guestId, eventId: event.id }, select: { id: true },
    });
    if (!guest)
      throw new ApplicationError(403, 'GUEST_ACCESS_DENIED', 'Guest access is not valid.');
    return this.prisma.$transaction(async (tx) => {
      await tx.conversation.updateMany({
        where: { eventId: event.id, type: 'GUEST', state: 'ACTIVE', userId: null, guestId: guest.id },
        data: { state: 'COMPLETED', completedAt: new Date() },
      });
      const conversation = await tx.conversation.create({
        data: { clientId: event.clientId, eventId: event.id, guestId: guest.id, type: 'GUEST', draft: { language } },
        select: { id: true },
      });
      return { id: conversation.id, language, messages: [] };
    });
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
    otherGuestIdentifiers?: string[];
    onEvent?: (event: ConciergeStreamEvent) => void;
  }) {
    const conversation = await this.conversation(
      input.event,
      input.type,
      input.userId,
      input.guestId,
    );
    const draft = conversation.draft as { language?: string } | null;
    let responseLanguage = input.type === 'GUEST' ? draft?.language ?? 'en' : undefined;
    if (input.type === 'GUEST') {
      const changedTo = requestedLanguage(input.question);
      if (changedTo && changedTo !== responseLanguage) {
        responseLanguage = changedTo;
        await this.prisma.conversation.update({
          where: { id: conversation.id }, data: { draft: { ...(draft ?? {}), language: changedTo } },
        });
        this.publish(input, { type: 'language', language: changedTo });
      }
    }
    const recentMessages = [...(conversation.messages ?? [])].reverse()
      .filter((message) => !this.mentionsOtherGuest(message.content, input.otherGuestIdentifiers))
      .map((message) => ({
        role: message.role === 'USER' ? 'user' as const : 'assistant' as const,
        content: message.content.slice(0, 2_000),
      }));
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
      const [embedding] = await this.ai.embed([input.question]);
      const semantic = embedding
        ? await this.knowledge.semanticSearch(input.event.id, embedding)
        : [];
      const context = {
          audience: input.audience,
          question: input.question,
          eventName: input.event.name,
          timezone: input.event.timezone ?? 'UTC',
          structuredContext: this.withoutOtherGuests(
            this.structuredContext(input.event, input.question), input.otherGuestIdentifiers,
            input.audience === 'GUEST',
            [input.event.organizerEmail, ...input.event.contacts.map(({ email }) => email)].filter((value): value is string => Boolean(value)),
          ),
          untrustedDocumentContext: semantic
            .map(({ content }) => content)
            .filter((content) => !this.mentionsOtherGuest(content, input.otherGuestIdentifiers) &&
              (input.audience !== 'GUEST' || !this.containsGuestRosterData(content)))
            .join('\n---\n')
            .slice(0, 20_000),
          privateGuestContext: input.privateContext,
          recentMessages,
          requestId: input.requestId,
          responseLanguage: languageName(responseLanguage) ?? undefined,
        };
      const response = input.audience === 'GUEST'
        ? await this.ai.answer(context)
        : await this.ai.answerStream(context, (delta) =>
            this.publish(input, { type: 'delta', messageId: responseMessageId, delta }),
          );
      const answer = answerSchema.safeParse(response.answer);
      const safeAnswer = answer.success &&
        !this.mentionsOtherGuest(answer.data, input.otherGuestIdentifiers)
        ? answer.data
        : input.audience === 'GUEST'
          ? 'I cannot share another guest’s information. Please ask the organizer if you need help.'
          : 'I do not have that information for this event yet.';
      if (input.audience === 'GUEST')
        this.publish(input, { type: 'delta', messageId: responseMessageId, delta: safeAnswer });
      const message = await this.prisma.conversationMessage.create({
        data: {
          id: responseMessageId,
          conversationId: conversation.id,
          role: 'CONCIERGE',
          content: safeAnswer,
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

  private async loadEvent(eventId: string, guest = false) {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      include: {
        schedule: { ...(guest ? { where: { visibility: 'SHARED' } } : {}), orderBy: { startAt: 'asc' }, take: 100 },
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
    const include = { messages: {
      where: { status: 'COMPLETE' as const },
      orderBy: { createdAt: 'desc' as const },
      take: 8,
      select: { role: true, content: true },
    } };
    const existing = await this.prisma.conversation.findFirst({
      where: {
        eventId: event.id,
        type,
        state: 'ACTIVE',
        userId: userId ?? null,
        guestId: guestId ?? null,
      },
      orderBy: { createdAt: 'desc' },
      include,
    });
    return (
      existing ??
      this.prisma.conversation.create({
        data: { clientId: event.clientId, eventId: event.id, type, userId, guestId },
        include,
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
      where: {
        eventId,
        type,
        state: 'ACTIVE',
        userId: userId ?? null,
        guestId: guestId ?? null,
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 100,
          select: { id: true, role: true, content: true, status: true, createdAt: true },
        },
      },
    });
    return conversation
      ? { ...conversation, messages: [...conversation.messages].reverse() }
      : { id: null, messages: [] };
  }

  private needsPrivateContext(question: string): boolean {
    return /\b(my|mine|i|room|flight|transfer|dietary|allerg|accessib|hotel|seat|table|arrangement|assignment|entry|door)\b/i.test(question);
  }

  private mentionsOtherGuest(value: string, identifiers: string[] | undefined): boolean {
    const normalized = value.toLocaleLowerCase();
    return Boolean(identifiers?.some((identifier) =>
      normalized.includes(identifier.toLocaleLowerCase()),
    ));
  }

  private withoutOtherGuests(
    value: string, identifiers: string[] | undefined, guestAudience: boolean,
    publicEmails: string[] = [],
  ): string {
    if (!guestAudience) return value;
    return value.split('\n')
      .filter((line) => !this.mentionsOtherGuest(line, identifiers) &&
        !this.containsGuestRosterData(publicEmails.reduce((text, email) => text.replaceAll(email, ''), line)))
      .join('\n');
  }

  private containsGuestRosterData(value: string): boolean {
    return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b((guest|attendee|participant|delegate)\s+(list|roster|names?|emails?|contacts?)|seating chart|seat assignment|assigned seating|table assignment|room allocation|rooming list|personal details)\b/i.test(value);
  }

  private asksAboutOtherGuests(question: string, identifiers: string[]): boolean {
    return this.mentionsOtherGuest(question, identifiers) ||
      /\b(other guests?|another guest|guest list|attendee list|who else|who is (coming|attending|sitting)|who'?s (coming|attending|sitting)|everyone else|someone else|their (seat|room|email|phone|details)|near me|next to me|beside me|my neighbou?r|my room ?mate|table ?mates?)\b|\b(all|other|another|list of|names of)\s+(the\s+)?(guests?|attendees?|participants?)\b|\b(guest|attendee|participant)\s+(names?|emails?|contacts?|seats?|rooms?)\b/i.test(question);
  }

  private async replyPrivately(
    event: Awaited<ReturnType<ConciergeService['loadEvent']>>,
    guestId: string,
    question: string,
    reply: string,
    onEvent?: (event: ConciergeStreamEvent) => void,
  ) {
    const conversation = await this.conversation(event, 'GUEST', undefined, guestId);
    const draft = conversation.draft as { language?: string } | null;
    const changedTo = requestedLanguage(question);
    const language = changedTo ?? draft?.language ?? 'en';
    if (changedTo && changedTo !== draft?.language) {
      await this.prisma.conversation.update({
        where: { id: conversation.id }, data: { draft: { ...(draft ?? {}), language: changedTo } },
      });
      onEvent?.({ type: 'language', language: changedTo });
    }
    let localizedReply = reply;
    if (language !== 'en') {
      try {
        const translated = await this.ai.answer({
          audience: 'GUEST',
          question: 'A guest asked for another attendee’s private details. Politely say that you can help with their own arrangements and shared event details, but cannot share another guest’s information. Do not mention any attendee by name.',
          eventName: event.name,
          timezone: event.timezone ?? 'UTC',
          structuredContext: `Event: ${event.name}`,
          untrustedDocumentContext: '',
          recentMessages: [],
          responseLanguage: languageName(language) ?? 'English',
          requestId: randomUUID(),
        });
        if (answerSchema.safeParse(translated.answer).success)
          localizedReply = translated.answer;
      } catch {
        // Keep the privacy refusal available even if translation is unavailable.
      }
    }
    await this.prisma.conversationMessage.create({
      data: { conversationId: conversation.id, role: 'USER', content: question, status: 'COMPLETE' },
    });
    const message = await this.prisma.conversationMessage.create({
      data: { conversationId: conversation.id, role: 'CONCIERGE', content: localizedReply, status: 'COMPLETE' },
    });
    onEvent?.({
      type: 'message',
      message: {
        id: message.id, role: 'CONCIERGE', content: message.content,
        status: 'COMPLETE', createdAt: message.createdAt,
      },
    });
    return { conversationId: conversation.id, message };
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
    const facts = [...event.facts].sort((left, right) =>
      Number(matches(right.key, right.value)) - Number(matches(left.key, left.value)),
    );
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
      `Organizer: ${event.organizerName ?? 'Not provided'}`,
      `Organizer email: ${event.organizerEmail ?? 'Not provided'}`,
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
