import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApplicationError } from '../../../common/errors/application.error';
import type { AuthenticatedActor } from '../../../common/types/request.types';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { AiProvider } from '../../../infrastructure/openai/ai.provider';
import { FileStorage } from '../../../infrastructure/storage/file-storage';
import { DocumentTextExtractorService } from '../../documents/application/document-text-extractor.service';
import { FileValidationService } from '../../documents/application/file-validation.service';
import {
  eventFactInputSchema,
  scheduleItemSchema,
  updateEventSchema,
} from '../../events/application/event.contracts';
import {
  type EventCompleteness,
  EventCompletenessService,
} from '../../events/domain/event-completeness.service';
import { AuthorizationService } from '../../memberships/application/authorization.service';
import { Permission } from '../../memberships/domain/permission';
import { chatGuestSchema, validChatGuests } from '../../guests/application/guest.contracts';

const setupSchema = z.object({
  clientId: z.uuid(),
  sessionId: z.uuid(),
  text: z.string().trim().max(80_000).optional(),
  startAt: z.iso.datetime().optional(),
  endAt: z.iso.datetime().optional(),
  timezone: z.string().trim().min(3).max(100).optional(),
  nameDecision: z.enum(['accept', 'reject']).optional(),
  eventName: z.string().trim().min(2).max(160).optional(),
});
const setupStartSchema = z.object({
  clientId: z.uuid(),
  restart: z.boolean().optional().default(false),
});
const setupDraftSchema = z.object({
  event: updateEventSchema.default({}),
  dateHints: z.object({ startDate: z.iso.date().or(z.literal('')), endDate: z.iso.date().or(z.literal('')) })
    .default({ startDate: '', endDate: '' }),
  facts: z.array(eventFactInputSchema).max(200).default([]),
  schedule: z.array(scheduleItemSchema).max(200).default([]),
  guests: z.array(chatGuestSchema).max(500).default([]),
  suggestedName: z.string().max(160).default(''),
  nameWasProvided: z.boolean().default(false),
  nameSuggestionRejected: z.boolean().default(false),
  documentReviewPending: z.boolean().default(false),
  documentReviewBaseline: z.object({
    event: updateEventSchema.default({}),
    dateHints: z.object({ startDate: z.iso.date().or(z.literal('')), endDate: z.iso.date().or(z.literal('')) })
      .default({ startDate: '', endDate: '' }),
    facts: z.array(eventFactInputSchema).max(200).default([]),
    schedule: z.array(scheduleItemSchema).max(200).default([]),
    guests: z.array(chatGuestSchema).max(500).default([]),
  }).nullable().default(null),
  pendingDocumentNames: z.array(z.string().max(255)).max(100).default([]),
});

type SetupDraft = z.infer<typeof setupDraftSchema>;

const categoryLabels: Record<string, string> = {
  CORPORATE_INCENTIVE: 'Incentive Experience',
  CONFERENCE: 'Conference',
  CORPORATE_RETREAT: 'Leadership Retreat',
  WEDDING: 'Wedding Celebration',
  SPORTS_TRAVEL: 'Sports Journey',
  GROUP_TOUR: 'Group Journey',
  MEETING: 'Meeting',
  OTHER: 'Special Event',
};

const missingLabels: Record<string, string> = {
  name: 'the event name',
  category: 'the event type',
  description: 'the event purpose and description',
  location: 'the destination or venue',
  startAt: 'the event start date and time',
  endAt: 'the event end date and time',
  timezone: 'the event timezone',
  organizerName: 'the organizer name',
  organizerEmail: 'the organizer email',
};

@Injectable()
export class EventSetupAnalysisService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly validation: FileValidationService,
    private readonly extractor: DocumentTextExtractorService,
    private readonly ai: AiProvider,
    private readonly completeness: EventCompletenessService,
    private readonly storage: FileStorage,
  ) {}

  async start(actor: AuthenticatedActor, body: unknown) {
    const input = setupStartSchema.parse(body);
    this.authorization.assert(actor, input.clientId, Permission.EVENT_CREATE);
    const client = await this.prisma.client.findUnique({
      where: { id: input.clientId },
      select: { id: true, name: true },
    });
    if (!client) throw new ApplicationError(404, 'CLIENT_NOT_FOUND', 'Client not found.');

    if (input.restart) {
      await this.prisma.conversation.updateMany({
        where: {
          clientId: client.id,
          userId: actor.userId,
          type: 'EVENT_SETUP',
          state: 'ACTIVE',
          eventId: null,
        },
        data: { state: 'ARCHIVED', completedAt: new Date() },
      });
    }

    let session = input.restart
      ? null
      : await this.prisma.conversation.findFirst({
          where: {
            clientId: client.id,
            userId: actor.userId,
            type: 'EVENT_SETUP',
            state: 'ACTIVE',
            eventId: null,
          },
          orderBy: { updatedAt: 'desc' },
          include: {
            messages: { orderBy: { createdAt: 'asc' }, take: 100 },
            setupDocuments: {
              orderBy: { createdAt: 'asc' },
              select: { id: true, originalName: true, size: true },
            },
          },
        });
    const resumed = Boolean(session);
    const welcome = `Let’s set up a new event for ${client.name}. First, tell me its purpose, event type, and name if you have one. You can also add the location, organizer, and guest names and email addresses, or attach a file. After the basics, I’ll show a separate date step with a calendar and time controls.`;
    if (!session) {
      session = await this.prisma.conversation.create({
        data: {
          clientId: client.id,
          userId: actor.userId,
          type: 'EVENT_SETUP',
          messages: {
            create: { role: 'CONCIERGE', content: welcome, status: 'COMPLETE' },
          },
        },
        include: {
          messages: { orderBy: { createdAt: 'asc' }, take: 100 },
          setupDocuments: {
            orderBy: { createdAt: 'asc' },
            select: { id: true, originalName: true, size: true },
          },
        },
      });
    }
    return {
      sessionId: session.id,
      clientId: client.id,
      clientName: client.name,
      resumed,
      messages: session.messages.map((message, index) => ({
        id: message.id,
        role: message.role,
        content: index === 0 && message.role === 'CONCIERGE' &&
          message.content.startsWith(`Let’s set up a new event for ${client.name}. Tell me what you know about its purpose, dates, location, and organizer.`)
          ? welcome : message.content,
        metadata: message.metadata,
        createdAt: message.createdAt,
      })),
      documents: session.setupDocuments,
      draft: this.readDraft(session.draft),
    };
  }

  async analyze(
    actor: AuthenticatedActor,
    body: unknown,
    file: Express.Multer.File | undefined,
    requestId: string,
  ) {
    const input = setupSchema.parse(body);
    this.authorization.assert(actor, input.clientId, Permission.EVENT_CREATE);
    const session = await this.prisma.conversation.findFirst({
      where: {
        id: input.sessionId,
        clientId: input.clientId,
        userId: actor.userId,
        type: 'EVENT_SETUP',
        state: 'ACTIVE',
        eventId: null,
      },
      include: {
        setupDocuments: { include: { extraction: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 20 },
      },
    });
    if (!session)
      throw new ApplicationError(
        404,
        'EVENT_SETUP_NOT_FOUND',
        'This event setup is no longer active. Start a new conversation to continue.',
      );
    const client = await this.prisma.client.findUnique({
      where: { id: input.clientId },
      select: { name: true },
    });
    if (!client) throw new ApplicationError(404, 'CLIENT_NOT_FOUND', 'Client not found.');
    const previous = this.readDraft(session.draft);

    if (input.nameDecision || input.eventName) {
      if (previous.documentReviewPending)
        throw new ApplicationError(409, 'EVENT_DOCUMENT_REVIEW_REQUIRED', 'Confirm the document details before choosing an event name.');
      return this.resolveEventName(session.id, previous, input);
    }

    if (!file && input.text && previous.documentReviewPending &&
      this.confirmsDocumentReview(input.text)) {
      return this.resolveDocumentReview(session.id, previous, input.text, true);
    }
    if (!file && input.text && previous.documentReviewPending &&
      this.rejectsDocumentReview(input.text)) {
      return this.resolveDocumentReview(session.id, previous, input.text, false);
    }

    if (!file && input.text && this.requestsTemplate(input.text)) {
      const userMessage = await this.prisma.conversationMessage.create({
        data: {
          conversationId: session.id,
          role: 'USER',
          content: input.text,
          status: 'COMPLETE',
        },
      });
      const message =
        'Download the event brief template below, fill in everything you know, and attach it here when you are ready. You can leave unknown details blank.';
      const assistantMessage = await this.prisma.conversationMessage.create({
        data: {
          conversationId: session.id,
          role: 'CONCIERGE',
          content: message,
          status: 'COMPLETE',
          metadata: { setupTemplate: 'EVENT_BRIEF' },
        },
      });
      return {
        sessionId: session.id,
        message,
        messages: [userMessage, assistantMessage],
        event: { ...previous.event, name: previous.event.name ?? undefined },
        dateHints: previous.dateHints,
        suggestedName: previous.suggestedName,
        nameWasProvided: Boolean(previous.event.name),
        nameSuggestionRejected: previous.nameSuggestionRejected,
        completeness: this.completeness.evaluate(this.projectEvent(previous.event)),
        facts: previous.facts,
        schedule: previous.schedule,
        guests: previous.guests,
        documentReviewPending: previous.documentReviewPending,
        extractedFacts: previous.facts.length,
        extractedScheduleItems: previous.schedule.length,
        file: null,
        template: { kind: 'EVENT_BRIEF', fileName: 'feliam-event-brief-template.docx' },
      };
    }

    let fileText = '';
    let savedFile: { id: string; name: string; size: number } | null = null;
    let fileExtension = '';
    let extractedFile: { text: string; metadata: Record<string, number | string> } | undefined;
    if (file) {
      fileExtension = this.validation.validate(file);
      extractedFile = await this.extractor.extract(fileExtension, file.buffer);
      fileText = extractedFile.text;
    }
    const meaningfulSource = [input.text, fileText].filter(Boolean).join('').trim();
    if (!meaningfulSource) {
      throw new ApplicationError(
        400,
        'EVENT_SOURCE_REQUIRED',
        file
          ? 'I could not read any text from that file. Try a text-based PDF, DOCX, TXT, CSV, or XLSX file, or describe its details in chat.'
          : 'Describe the event or attach an event file to continue.',
      );
    }
    if (meaningfulSource.length > 60_000) {
      throw new ApplicationError(
        400, 'EVENT_SOURCE_TOO_LONG',
        'Please split this information into shorter files or messages (up to 60,000 characters each) so I can review every detail.',
      );
    }
    if (file && extractedFile) {
      savedFile = await this.saveSetupDocument(
        actor,
        session.id,
        input.clientId,
        file,
        fileExtension,
        extractedFile,
        requestId,
      );
    }

    const userMessage = await this.prisma.conversationMessage.create({
      data: {
        conversationId: session.id,
        role: 'USER',
        content: input.text || `Attached event file: ${file?.originalname ?? 'event document'}`,
        status: 'COMPLETE',
        metadata: savedFile ? { documentId: savedFile.id, fileName: savedFile.name } : {},
      },
    });
    const recentConversation = [...(session.messages ?? [])]
      .reverse()
      .map(
        (message) =>
          `${message.role === 'USER' ? 'Event creator' : 'Concierge'}: ${message.content}`,
      )
      .join('\n');
    const priorContext = [
      `Current event setup draft (document details may be unconfirmed):\n${JSON.stringify({
        event: previous.event, dateHints: previous.dateHints, facts: previous.facts,
        schedule: previous.schedule, guests: previous.guests,
      })}`,
      recentConversation ? `Recent setup conversation:\n${recentConversation}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 18_000);
    const source = [
      priorContext,
      input.text ? `Latest event creator message:\n${input.text}` : '',
      fileText ? `Attached event file content:\n${fileText}` : '',
    ].filter(Boolean).join('\n\n');
    const extracted = await this.ai.extractEventInformation(source, requestId);
    const extractedEvent = extracted.event ?? {};
    const validEventFields = Object.fromEntries(
      Object.entries(updateEventSchema.shape).flatMap(([key, schema]) => {
        const value = extractedEvent[key as keyof typeof extractedEvent];
        if (value === undefined) return [];
        const parsed = schema.safeParse(value);
        return parsed.success ? [[key, parsed.data]] : [];
      }),
    ) as SetupDraft['event'];
    const event = this.mergeEvent(
      this.mergeEvent(previous.event, validEventFields),
      {
        startAt: input.startAt,
        endAt: input.endAt,
        timezone: input.timezone,
      },
    );
    const extractedFacts = extracted.facts.flatMap((fact) => {
      const result = eventFactInputSchema.safeParse(fact);
      return result.success ? [result.data] : [];
    });
    const extractedSchedule = extracted.schedule.flatMap((item) => {
      const result = scheduleItemSchema.safeParse(item);
      return result.success ? [result.data] : [];
    });
    const facts = this.mergeFacts(previous.facts, extractedFacts);
    const schedule = this.mergeSchedule(previous.schedule, extractedSchedule);
    const parsedGuests = validChatGuests(extracted.guests ?? []);
    const mayManageGuests = this.authorization.can(actor, input.clientId, Permission.GUEST_MANAGE);
    const guests = mayManageGuests
      ? validChatGuests([...previous.guests, ...parsedGuests.guests]).guests
      : [];
    if (guests.length > 500) {
      throw new ApplicationError(
        400, 'SETUP_GUEST_LIMIT_EXCEEDED',
        'The setup chat supports up to 500 guests. Create the event workspace, then import the full guest list from Guests.',
      );
    }
    const suggestedName =
      event.name ?? this.suggestName(event, client.name);
    const completeness = this.completeness.evaluate(this.projectEvent(event));
    const documentReviewPending = previous.documentReviewPending || Boolean(file);
    const draft: SetupDraft = {
      event,
      dateHints: {
        startDate: extracted.event?.startDate ?? previous.dateHints.startDate,
        endDate: extracted.event?.endDate ?? previous.dateHints.endDate,
      },
      suggestedName,
      nameWasProvided: Boolean(event.name),
      nameSuggestionRejected: !event.name && previous.nameSuggestionRejected,
      facts,
      schedule,
      guests,
      documentReviewPending,
      documentReviewBaseline: previous.documentReviewBaseline ?? (file ? {
        event: previous.event,
        dateHints: previous.dateHints,
        facts: previous.facts,
        schedule: previous.schedule,
        guests: previous.guests,
      } : null),
      pendingDocumentNames: file
        ? [...previous.pendingDocumentNames, file.originalname.slice(0, 255)].slice(0, 100)
        : previous.pendingDocumentNames,
    };
    const message = (documentReviewPending
      ? this.buildDocumentReviewReply(draft, file?.originalname)
      : this.buildReply(extracted.reply, completeness)) +
      (parsedGuests.missingEmails.length
        ? ` I still need email addresses before I can add these guests: ${parsedGuests.missingEmails.join(', ')}.`
        : '') +
      (parsedGuests.guests.length && !mayManageGuests
        ? ' A team member with guest management access will need to add these guests.'
        : '');
    const assistantMessage = await this.prisma.$transaction(async (transaction) => {
      await transaction.conversation.update({
        where: { id: session.id },
        data: { draft: JSON.parse(JSON.stringify(draft)) as Prisma.InputJsonValue },
      });
      return transaction.conversationMessage.create({
        data: {
          conversationId: session.id,
          role: 'CONCIERGE',
          content: message,
          status: 'COMPLETE',
        },
      });
    });
    return {
      sessionId: session.id,
      message,
      messages: [userMessage, assistantMessage],
      event: { ...event, name: event.name ?? undefined },
      dateHints: draft.dateHints,
      suggestedName,
      nameWasProvided: Boolean(event.name),
      nameSuggestionRejected: draft.nameSuggestionRejected,
      completeness,
      facts,
      schedule,
      guests,
      documentReviewPending,
      extractedFacts: facts.length,
      extractedScheduleItems: schedule.length,
      file: savedFile,
    };
  }

  private readDraft(value: unknown): SetupDraft {
    const parsed = setupDraftSchema.safeParse(value);
    return parsed.success
      ? parsed.data
      : {
          event: {}, dateHints: { startDate: '', endDate: '' },
          facts: [], schedule: [], guests: [], suggestedName: '',
          nameWasProvided: false, nameSuggestionRejected: false, documentReviewPending: false,
          documentReviewBaseline: null, pendingDocumentNames: [],
        };
  }

  private async resolveEventName(
    sessionId: string,
    previous: SetupDraft,
    input: { nameDecision?: 'accept' | 'reject'; eventName?: string },
  ) {
    const rejected = input.nameDecision === 'reject';
    const name = rejected ? undefined : input.eventName ?? previous.suggestedName;
    if (!rejected && !name)
      throw new ApplicationError(400, 'EVENT_NAME_REQUIRED', 'Provide an event name to continue.');
    const draft: SetupDraft = {
      ...previous,
      event: { ...previous.event, name },
      nameWasProvided: Boolean(name),
      nameSuggestionRejected: rejected,
    };
    const completeness = this.completeness.evaluate(this.projectEvent(draft.event));
    const message = rejected
      ? 'What should this event be called? Enter the event name below.'
      : `The event name is ${name}. ${this.buildReply(undefined, completeness)}`;
    const messages = await this.prisma.$transaction(async (transaction) => {
      const userMessage = await transaction.conversationMessage.create({
        data: {
          conversationId: sessionId, role: 'USER', status: 'COMPLETE',
          content: rejected ? 'I would like to choose a different event name.' : `Use this event name: ${name}`,
        },
      });
      await transaction.conversation.update({
        where: { id: sessionId },
        data: { draft: JSON.parse(JSON.stringify(draft)) as Prisma.InputJsonValue },
      });
      const assistantMessage = await transaction.conversationMessage.create({
        data: { conversationId: sessionId, role: 'CONCIERGE', content: message, status: 'COMPLETE' },
      });
      return [userMessage, assistantMessage];
    });
    return {
      sessionId, message, messages, event: draft.event, dateHints: draft.dateHints,
      suggestedName: draft.suggestedName, nameWasProvided: draft.nameWasProvided,
      nameSuggestionRejected: draft.nameSuggestionRejected,
      completeness, facts: draft.facts, schedule: draft.schedule, guests: draft.guests,
      extractedFacts: draft.facts.length, extractedScheduleItems: draft.schedule.length,
      documentReviewPending: false, file: null,
    };
  }

  private confirmsDocumentReview(text: string): boolean {
    return /^(confirm(?:ed)?(?: (?:details|information|info))?|yes|looks good|all correct|that'?s correct|approved)[.!]?$/i.test(text.trim());
  }

  private rejectsDocumentReview(text: string): boolean {
    return /^(reject|ignore|discard)(?: (?:the |that )?(?:document|extracted (?:details|information)))?[.!]?$/i.test(text.trim());
  }

  private async resolveDocumentReview(
    sessionId: string,
    previous: SetupDraft,
    text: string,
    confirmed: boolean,
  ) {
    const baseline = previous.documentReviewBaseline;
    const draft: SetupDraft = {
      ...previous,
      ...(confirmed || !baseline ? {} : baseline),
      suggestedName: !confirmed && baseline ? baseline.event.name ?? '' : previous.suggestedName,
      nameWasProvided: !confirmed && baseline ? Boolean(baseline.event.name) : previous.nameWasProvided,
      documentReviewPending: false,
      documentReviewBaseline: null,
      pendingDocumentNames: [],
    };
    const completeness = this.completeness.evaluate(this.projectEvent(draft.event));
    const message = confirmed
      ? `Thanks, I’ll use those confirmed details. ${this.buildReply(undefined, completeness)}`
      : `I set aside the extracted event details. The document is still saved as reference material. ${this.buildReply(undefined, completeness)}`;
    const messages = await this.prisma.$transaction(async (transaction) => {
      const userMessage = await transaction.conversationMessage.create({
        data: { conversationId: sessionId, role: 'USER', content: text, status: 'COMPLETE' },
      });
      await transaction.conversation.update({
        where: { id: sessionId },
        data: { draft: JSON.parse(JSON.stringify(draft)) as Prisma.InputJsonValue },
      });
      const assistantMessage = await transaction.conversationMessage.create({
        data: { conversationId: sessionId, role: 'CONCIERGE', content: message, status: 'COMPLETE' },
      });
      return [userMessage, assistantMessage];
    });
    return {
      sessionId, message, messages, event: draft.event, dateHints: draft.dateHints,
      suggestedName: draft.suggestedName,
      nameWasProvided: Boolean(draft.event.name),
      nameSuggestionRejected: draft.nameSuggestionRejected,
      completeness, facts: draft.facts, schedule: draft.schedule, guests: draft.guests,
      extractedFacts: draft.facts.length,
      extractedScheduleItems: draft.schedule.length,
      documentReviewPending: false,
      file: null,
    };
  }

  private buildDocumentReviewReply(
    draft: SetupDraft,
    latestFileName: string | undefined,
  ): string {
    const labels: Record<string, string> = {
      name: 'Event name', category: 'Type', description: 'Purpose',
      destination: 'Destination', venue: 'Venue', venueAddress: 'Venue address',
      startAt: 'Start', endAt: 'End', timezone: 'Timezone',
      organizerName: 'Organizer', organizerEmail: 'Organizer email',
    };
    const details = Object.entries(draft.event).flatMap(([key, value]) =>
      typeof value === 'string' && value.trim()
        ? [`${labels[key] ?? key}: ${value.slice(0, 300)}`]
        : [],
    );
    const lines = [
      latestFileName
        ? `I read ${latestFileName}. It can be any event document; it does not need to use our template.`
        : `Here is the current draft from ${draft.pendingDocumentNames.join(', ')} with your latest corrections.`,
      details.length ? `Current draft event details to confirm:\n${details.join('\n')}` : 'I could not identify new required event fields from it.',
      draft.facts.length ? `Additional details: ${draft.facts.map((fact) => `${fact.key}: ${fact.value.slice(0, 200)}`).join('; ')}` : '',
      draft.schedule.length ? `Schedule: ${draft.schedule.map((item) => `${item.title} (${item.startAt})`).join('; ')}` : '',
      draft.guests.length ? `Guests: ${draft.guests.map((guest) =>
        `${guest.fullName} <${guest.email}>${guest.notes ? ` — ${guest.notes.slice(0, 200)}` : ''}`,
      ).join('; ')}` : '',
      'Please confirm these extracted details, or tell me what to correct. You can also attach another document. I will ask for missing information after you confirm.',
    ];
    return lines.filter(Boolean).join('\n\n');
  }

  private requestsTemplate(text: string): boolean {
    const normalized = text.toLowerCase().trim();
    if (normalized.length > 160) return false;
    return /\btemplate\b|\b(?:blank|sample|download)\s+(?:file|document|spreadsheet)\b/.test(normalized);
  }

  private projectEvent(event: SetupDraft['event']) {
    return {
      name: event.name ?? null,
      category: event.category ?? null,
      description: event.description ?? null,
      destination: event.destination ?? null,
      venue: event.venue ?? null,
      venueAddress: event.venueAddress ?? null,
      venueDetails: event.venueDetails ?? null,
      restroomInformation: event.restroomInformation ?? null,
      accessibilityInformation: event.accessibilityInformation ?? null,
      startAt: event.startAt ? new Date(event.startAt) : null,
      endAt: event.endAt ? new Date(event.endAt) : null,
      timezone: event.timezone ?? null,
      organizerName: event.organizerName ?? null,
      organizerEmail: event.organizerEmail ?? null,
    };
  }

  private buildReply(reply: string | undefined, completeness: EventCompleteness): string {
    const acknowledgement = (reply ?? '')
      .split(/(?<=[.!?])\s+/)
      .filter((sentence) => !sentence.includes('?'))
      .join(' ')
      .trim();
    if (completeness.ready) {
      return `${acknowledgement || 'I captured the event details.'} Everything required is ready. Would you like to attach more event documents or add any guest details, such as names, emails, seating, dietary or accessibility needs, travel, or accommodation? You can also add venue directions, rooms, restrooms, parking, and Wi-Fi. If there is nothing else to add, create the event workspace to continue.`;
    }
    const missing = new Set(completeness.missing);
    let question: string;
    if (missing.has('description') || missing.has('category')) {
      const basics = ['description', 'category'].filter((field) => missing.has(field)).map((field) => missingLabels[field]);
      question = `Tell me ${basics.join(' and ')} in one message.${missing.has('name') ? ' You can choose the suggested event name below or provide your own.' : ''}`;
    } else if (missing.has('name')) {
      question = 'Choose the suggested event name below, or reject it to enter your own name.';
    } else if (
      ['startAt', 'endAt', 'timezone'].some((field) => missing.has(field)) ||
      completeness.warnings.some((warning) =>
        ['endBeforeStart', 'invalidTimezone'].includes(warning),
      )
    ) {
      question = 'Next, choose one date or a date range, the start and end times, and the event timezone in the date step below.';
    } else if (missing.has('location')) {
      question =
        'Send the destination or city, venue, and venue address in one message, separated by commas. Add “not decided” for anything you do not know yet.';
    } else if (missing.has('organizerName') || missing.has('organizerEmail')) {
      question =
        'Send the organizer’s name and email in one message, separated by a comma. For example: Morgan Reed, morgan@example.com.';
    } else {
      const next = missingLabels[completeness.missing[0] ?? ''] ?? 'the next event detail';
      question = `What should I add for ${next}?`;
    }
    return `${acknowledgement || 'Thanks, I’m ready for the next step.'} ${question}`;
  }

  private mergeEvent(previous: SetupDraft['event'], next: SetupDraft['event']) {
    const merged = { ...previous };
    for (const [key, value] of Object.entries(next)) {
      if (value !== undefined && value !== null && value !== '')
        Object.assign(merged, { [key]: value });
    }
    return merged;
  }

  private mergeFacts(previous: SetupDraft['facts'], next: SetupDraft['facts']) {
    const facts = new Map(previous.map((fact) => [fact.key.toLowerCase(), fact]));
    for (const fact of next) facts.set(fact.key.toLowerCase(), fact);
    return [...facts.values()].slice(0, 200);
  }

  private mergeSchedule(previous: SetupDraft['schedule'], next: SetupDraft['schedule']) {
    const schedule = new Map(
      previous.map((item) => [`${item.title.toLowerCase()}|${item.startAt}`, item]),
    );
    for (const item of next) schedule.set(`${item.title.toLowerCase()}|${item.startAt}`, item);
    return [...schedule.values()].slice(0, 200);
  }

  private async saveSetupDocument(
    actor: AuthenticatedActor,
    sessionId: string,
    clientId: string,
    file: Express.Multer.File,
    extension: string,
    extracted: { text: string; metadata: Record<string, number | string> },
    requestId: string,
  ) {
    const checksum = createHash('sha256').update(file.buffer).digest('hex');
    const duplicate = await this.prisma.document.findUnique({
      where: { setupConversationId_checksum: { setupConversationId: sessionId, checksum } },
    });
    if (duplicate)
      return { id: duplicate.id, name: duplicate.originalName, size: duplicate.size };

    const objectKey = `clients/${clientId}/event-setups/${sessionId}/documents/${randomUUID()}.${extension}`;
    const stored = await this.storage.upload(objectKey, file.buffer, file.mimetype);
    try {
      const document = await this.prisma.$transaction(async (transaction) => {
        const created = await transaction.document.create({
          data: {
            clientId,
            setupConversationId: sessionId,
            uploadedByUserId: actor.userId,
            originalName: file.originalname.slice(0, 255),
            objectKey: stored.objectKey,
            bucket: stored.bucket,
            mimeType: file.mimetype,
            size: file.size,
            checksum,
            processingStatus: 'PENDING',
            extraction: {
              create: {
                extractedText: extracted.text,
                parserVersion: '1.0.0',
                extractionMetadata: extracted.metadata,
              },
            },
          },
        });
        await transaction.auditLog.create({
          data: {
            actorUserId: actor.userId,
            clientId,
            action: 'EVENT_SETUP_DOCUMENT_SAVED',
            entityType: 'Document',
            entityId: created.id,
            requestId,
            metadata: { sessionId },
          },
        });
        return created;
      });
      return { id: document.id, name: document.originalName, size: document.size };
    } catch (error) {
      await this.storage.delete(objectKey).catch(() => undefined);
      throw error;
    }
  }

  private suggestName(event: Record<string, unknown>, clientName: string): string {
    const category =
      typeof event.category === 'string'
        ? (categoryLabels[event.category] ?? 'Special Event')
        : 'Special Event';
    const place =
      typeof event.destination === 'string'
        ? event.destination.split(',')[0]
        : typeof event.venue === 'string'
          ? event.venue
          : clientName;
    const year =
      typeof event.startAt === 'string' && !Number.isNaN(new Date(event.startAt).getTime())
        ? ` ${new Date(event.startAt).getUTCFullYear()}`
        : '';
    return `${place} ${category}${year}`.slice(0, 160);
  }
}
