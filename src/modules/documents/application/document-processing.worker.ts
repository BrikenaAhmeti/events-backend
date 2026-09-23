import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PinoLogger } from 'nestjs-pino';
import { AiProvider } from '../../../infrastructure/openai/ai.provider';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { JobQueue } from '../../../infrastructure/jobs/job-queue';
import { FileStorage } from '../../../infrastructure/storage/file-storage';
import { EventGateway } from '../../../infrastructure/websocket/event.gateway';
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
      const payload = job.payload as { documentId?: string };
      if (!payload.documentId) throw new Error('InvalidDocumentJob');
      await this.process(payload.documentId);
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

  private async process(documentId: string): Promise<void> {
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
      const embeddings = await this.ai.embed(chunks);
      await this.prisma.$transaction(async (transaction) => {
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
          content: `${document.originalName} is ready as reference material for Concierge answers. Review any event details from this document in chat before treating them as confirmed.`,
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
