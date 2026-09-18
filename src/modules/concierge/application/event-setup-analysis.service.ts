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

const setupSchema = z.object({
  clientId: z.uuid(),
  sessionId: z.uuid(),
  text: z.string().trim().max(80_000).optional(),
  startAt: z.iso.datetime().optional(),
  endAt: z.iso.datetime().optional(),
  timezone: z.string().trim().min(3).max(100).optional(),
});
const setupStartSchema = z.object({
  clientId: z.uuid(),
  restart: z.boolean().optional().default(false),
});
const setupDraftSchema = z.object({
  event: updateEventSchema.default({}),
  facts: z.array(eventFactInputSchema).max(200).default([]),
  schedule: z.array(scheduleItemSchema).max(200).default([]),
  suggestedName: z.string().max(160).default(''),
  nameWasProvided: z.boolean().default(false),
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
    if (!session) {
      const welcome = `Let’s set up a new event for ${client.name}. I can guide you through a few short chat steps, grouping related answers together, or you can ask for a file template to fill in and upload here.`;
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
      messages: session.messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
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
        suggestedName: previous.suggestedName,
        nameWasProvided: Boolean(previous.event.name),
        completeness: this.completeness.evaluate(this.projectEvent(previous.event)),
        facts: previous.facts,
        schedule: previous.schedule,
        extractedFacts: previous.facts.length,
        extractedScheduleItems: previous.schedule.length,
        file: null,
        template: { kind: 'EVENT_BRIEF', fileName: 'feliam-event-brief-template.txt' },
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
    if (meaningfulSource.length < 10) {
      throw new ApplicationError(
        400,
        'EVENT_SOURCE_REQUIRED',
        'Describe the event or attach an event file to continue.',
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
    const source = [
      `Previously confirmed event setup state:\n${JSON.stringify(previous)}`,
      recentConversation ? `Recent setup conversation:\n${recentConversation}` : '',
      input.text ? `Latest event creator message:\n${input.text}` : '',
      fileText ? `Attached event file content:\n${fileText}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')
      .trim();
    const extracted = await this.ai.extractEventInformation(source, requestId);
    const parsed = updateEventSchema.safeParse(extracted.event ?? {});
    const event = this.mergeEvent(
      this.mergeEvent(previous.event, parsed.success ? parsed.data : {}),
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
    const suggestedName =
      event.name ?? (previous.suggestedName || this.suggestName(event, client.name));
    const completeness = this.completeness.evaluate(this.projectEvent(event));
    const draft: SetupDraft = {
      event,
      suggestedName,
      nameWasProvided: Boolean(event.name),
      facts,
      schedule,
    };
    const message = this.buildReply(extracted.reply, completeness);
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
      suggestedName,
      nameWasProvided: Boolean(event.name),
      completeness,
      facts,
      schedule,
      extractedFacts: facts.length,
      extractedScheduleItems: schedule.length,
      file: savedFile,
    };
  }

  private readDraft(value: unknown): SetupDraft {
    const parsed = setupDraftSchema.safeParse(value);
    return parsed.success
      ? parsed.data
      : { event: {}, facts: [], schedule: [], suggestedName: '', nameWasProvided: false };
  }

  private requestsTemplate(text: string): boolean {
    const normalized = text.toLowerCase().trim();
    if (normalized.length > 160) return false;
    return /\b(file|template|spreadsheet|document)\b/.test(normalized);
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
      return `${acknowledgement || 'I captured the event details.'} Everything required is ready. Review the summary and tell me if you want to change anything.`;
    }
    const missing = new Set(completeness.missing);
    let question: string;
    if (['name', 'description', 'category'].some((field) => missing.has(field))) {
      question =
        'Send the event name, a short description, and the event type in one message, separated by commas. For example: Leadership Summit, Annual gathering for regional directors, Conference.';
    } else if (
      ['startAt', 'endAt', 'timezone'].some((field) => missing.has(field)) ||
      completeness.warnings.some((warning) =>
        ['endBeforeStart', 'invalidTimezone'].includes(warning),
      )
    ) {
      question = 'Choose the start and end date and time below. I’ll include your local timezone.';
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
