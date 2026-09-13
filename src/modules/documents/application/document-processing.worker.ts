import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PinoLogger } from 'nestjs-pino';
import { AiProvider } from '../../../infrastructure/openai/ai.provider';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { JobQueue } from '../../../infrastructure/jobs/job-queue';
import { FileStorage } from '../../../infrastructure/storage/file-storage';
import { EventGateway } from '../../../infrastructure/websocket/event.gateway';
import { scheduleItemSchema, updateEventSchema } from '../../events/application/event.contracts';
import { EventCompletenessService } from '../../events/domain/event-completeness.service';
import { DocumentTextExtractorService } from './document-text-extractor.service';

@Injectable()
export class DocumentProcessingWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly workerId = `document-${randomUUID()}`;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobQueue,
    private readonly storage: FileStorage,
    private readonly extractor: DocumentTextExtractorService,
    private readonly ai: AiProvider,
    private readonly gateway: EventGateway,
    private readonly completeness: EventCompletenessService,
    private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    if (process.env.VERCEL) return;
    this.timer = setInterval(() => void this.tick(), 3_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    const job = await this.jobs.claim('DOCUMENT_PROCESS', this.workerId).catch(() => null);
    if (!job) {
      this.running = false;
      return false;
    }
    try {
      const payload = job.payload as { documentId?: string; requestId?: string };
      if (!payload.documentId) throw new Error('InvalidDocumentJob');
      await this.process(payload.documentId, payload.requestId ?? job.id);
      await this.jobs.complete(job.id);
    } catch (error) {
      await this.jobs.fail(job, error);
      this.logger.warn({
        operation: 'document.process',
        jobId: job.id,
        error: error instanceof Error ? error.name : 'UnknownError',
      });
    } finally {
      this.running = false;
    }
    return true;
  }

  private async process(documentId: string, requestId: string): Promise<void> {
    const storedDocument = await this.prisma.document.findUnique({
      where: { id: documentId },
      include: { event: true },
    });
    if (!storedDocument) throw new Error('DocumentNotFound');
    if (!storedDocument.event || !storedDocument.eventId)
      throw new Error('SetupDocumentNotReady');
    const document = {
      ...storedDocument,
      event: storedDocument.event,
      eventId: storedDocument.eventId,
    };
    await this.prisma.document.update({
      where: { id: documentId },
      data: { processingStatus: 'PROCESSING', processingError: null },
    });
    this.gateway.emitEvent(document.eventId, 'document:progress', {
      documentId,
      status: 'PROCESSING',
      progress: 10,
    });
    try {
      const content = await this.storage.download(document.objectKey);
      const extension = document.originalName.toLowerCase().split('.').at(-1) ?? '';
      const extracted = await this.extractor.extract(extension, content);
      const chunks = this.extractor.chunks(extracted.text);
      const [candidate, embeddings] = await Promise.all([
        this.ai.extractEventInformation(extracted.text, requestId),
        this.ai.embed(chunks),
      ]);
      await this.prisma.$transaction(async (transaction) => {
        const validatedCandidate = updateEventSchema.safeParse(candidate.event ?? {});
        const proposed = validatedCandidate.success ? validatedCandidate.data : {};
        const proposedSchedule = candidate.schedule.flatMap((item) => {
          const parsed = scheduleItemSchema.safeParse(item);
          return parsed.success ? [parsed.data] : [];
        });
        const eventUpdate: Prisma.EventUpdateInput = {
          category: document.event.category === 'OTHER' ? proposed.category : undefined,
          description: document.event.description ?? proposed.description,
          destination: document.event.destination ?? proposed.destination,
          venue: document.event.venue ?? proposed.venue,
          venueAddress: document.event.venueAddress ?? proposed.venueAddress,
          venueDetails: document.event.venueDetails ?? proposed.venueDetails,
          restroomInformation: document.event.restroomInformation ?? proposed.restroomInformation,
          accessibilityInformation:
            document.event.accessibilityInformation ?? proposed.accessibilityInformation,
          parkingInformation: document.event.parkingInformation ?? proposed.parkingInformation,
          wifiInformation: document.event.wifiInformation ?? proposed.wifiInformation,
          startAt:
            document.event.startAt ?? (proposed.startAt ? new Date(proposed.startAt) : undefined),
          endAt: document.event.endAt ?? (proposed.endAt ? new Date(proposed.endAt) : undefined),
          timezone: document.event.timezone ?? proposed.timezone,
          organizerName: document.event.organizerName ?? proposed.organizerName,
          organizerEmail: document.event.organizerEmail ?? proposed.organizerEmail,
        };
        const projected = {
          name: document.event.name,
          category:
            document.event.category === 'OTHER'
              ? (proposed.category ?? document.event.category)
              : document.event.category,
          description: document.event.description ?? proposed.description ?? null,
          destination: document.event.destination ?? proposed.destination ?? null,
          venue: document.event.venue ?? proposed.venue ?? null,
          venueAddress: document.event.venueAddress ?? proposed.venueAddress ?? null,
          venueDetails: document.event.venueDetails ?? proposed.venueDetails ?? null,
          restroomInformation:
            document.event.restroomInformation ?? proposed.restroomInformation ?? null,
          accessibilityInformation:
            document.event.accessibilityInformation ?? proposed.accessibilityInformation ?? null,
          startAt: document.event.startAt ?? (proposed.startAt ? new Date(proposed.startAt) : null),
          endAt: document.event.endAt ?? (proposed.endAt ? new Date(proposed.endAt) : null),
          timezone: document.event.timezone ?? proposed.timezone ?? null,
          organizerName: document.event.organizerName ?? proposed.organizerName ?? null,
          organizerEmail: document.event.organizerEmail ?? proposed.organizerEmail ?? null,
        };
        const completeness = this.completeness.evaluate(projected);
        await transaction.event.update({
          where: { id: document.eventId },
          data: {
            ...eventUpdate,
            status:
              document.event.status === 'PUBLISHED' || document.event.status === 'ARCHIVED'
                ? document.event.status
                : completeness.ready
                  ? 'READY'
                  : 'DRAFT',
          },
        });
        await transaction.documentExtraction.upsert({
          where: { documentId },
          create: {
            documentId,
            extractedText: extracted.text,
            parserVersion: '1.0.0',
            extractionMetadata: extracted.metadata,
          },
          update: {
            extractedText: extracted.text,
            parserVersion: '1.0.0',
            extractionMetadata: extracted.metadata,
            processedAt: new Date(),
          },
        });
        await transaction.documentChunk.deleteMany({ where: { documentId } });
        for (const [index, chunk] of chunks.entries()) {
          const vector = `[${(embeddings[index] ?? []).join(',')}]`;
          await transaction.$executeRaw(Prisma.sql`
            INSERT INTO "DocumentChunk" ("id", "clientId", "eventId", "documentId", "content", "embedding", "metadata", "createdAt")
            VALUES (${randomUUID()}::uuid, ${document.clientId}::uuid, ${document.eventId}::uuid, ${documentId}::uuid, ${chunk}, ${vector}::vector, ${JSON.stringify({ index })}::jsonb, NOW())
          `);
        }
        for (const fact of candidate.facts) {
          const existing = await transaction.eventFact.findUnique({
            where: { eventId_key: { eventId: document.eventId, key: fact.key } },
          });
          if (!existing || existing.precedence <= 100) {
            await transaction.eventFact.upsert({
              where: { eventId_key: { eventId: document.eventId, key: fact.key } },
              create: {
                eventId: document.eventId,
                key: fact.key,
                value: fact.value,
                sourceType: 'DOCUMENT',
                sourceDocumentId: documentId,
                confidence: fact.confidence,
                precedence: 100,
              },
              update: {
                value: fact.value,
                sourceType: 'DOCUMENT',
                sourceDocumentId: documentId,
                confidence: fact.confidence,
                precedence: 100,
              },
            });
          }
        }
        const existingSchedule = await transaction.scheduleItem.findMany({
          where: { eventId: document.eventId },
          select: { title: true, startAt: true },
        });
        for (const item of proposedSchedule) {
          const startAt = new Date(item.startAt);
          const exists = existingSchedule.some(
            (existing) =>
              existing.title.toLowerCase() === item.title.toLowerCase() &&
              existing.startAt.getTime() === startAt.getTime(),
          );
          if (!exists) {
            await transaction.scheduleItem.create({
              data: {
                eventId: document.eventId,
                title: item.title,
                startAt,
                endAt: item.endAt ? new Date(item.endAt) : undefined,
                location: item.location,
              },
            });
          }
        }
        await transaction.document.update({
          where: { id: documentId },
          data: { processingStatus: 'COMPLETED', parserVersion: '1.0.0' },
        });
      });
      this.gateway.emitEvent(document.eventId, 'document:progress', {
        documentId,
        status: 'COMPLETED',
        progress: 100,
      });
      const refreshed = await this.prisma.event.findUniqueOrThrow({
        where: { id: document.eventId },
      });
      const eventCompleteness = this.completeness.evaluate(refreshed);
      const conversation =
        (await this.prisma.conversation.findFirst({
          where: {
            eventId: document.eventId,
            userId: document.uploadedByUserId,
            type: 'ORGANIZER',
          },
          orderBy: { createdAt: 'desc' },
        })) ??
        (await this.prisma.conversation.create({
          data: {
            clientId: document.clientId,
            eventId: document.eventId,
            userId: document.uploadedByUserId,
            type: 'ORGANIZER',
          },
        }));
      const message = await this.prisma.conversationMessage.create({
        data: {
          conversationId: conversation.id,
          role: 'CONCIERGE',
          content: eventCompleteness.ready
            ? `${document.originalName} was reviewed. All mandatory event details are complete.`
            : `${document.originalName} was reviewed. Still needed: ${eventCompleteness.missing.join(', ')}.`,
          status: 'COMPLETE',
          metadata: { documentId },
        },
      });
      this.gateway.emitToUser(document.eventId, document.uploadedByUserId, 'concierge:message', {
        conversationId: conversation.id,
        message: {
          id: message.id,
          role: message.role,
          content: message.content,
          status: message.status,
          createdAt: message.createdAt,
        },
      });
    } catch (error) {
      await this.prisma.document.update({
        where: { id: documentId },
        data: {
          processingStatus: 'FAILED',
          processingError: error instanceof Error ? error.name : 'ProcessingFailed',
        },
      });
      this.gateway.emitEvent(document.eventId, 'document:progress', {
        documentId,
        status: 'FAILED',
        progress: 0,
      });
      throw error;
    }
  }
}
