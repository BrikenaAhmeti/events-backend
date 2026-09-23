import type { PinoLogger } from 'nestjs-pino';
import type { PrismaService } from '../../../infrastructure/database/prisma.service';
import type { JobQueue } from '../../../infrastructure/jobs/job-queue';
import type { AiProvider } from '../../../infrastructure/openai/ai.provider';
import type { FileStorage } from '../../../infrastructure/storage/file-storage';
import type { EventGateway } from '../../../infrastructure/websocket/event.gateway';
import type { DocumentTextExtractorService } from './document-text-extractor.service';
import { DocumentProcessingWorker } from './document-processing.worker';

describe('DocumentProcessingWorker', () => {
  it('indexes a promoted setup document for guest answers without applying unconfirmed event changes', async () => {
    const documentId = '04c974f5-2aa9-4252-809a-e43cd8d746e0';
    const eventId = 'c93d13bb-82e4-4d5a-9c59-ceefb15b6aa0';
    const clientId = '5cc417cc-4a67-4ef2-8fa1-6cd4a7dd173f';
    const transaction = {
      documentExtraction: { upsert: vi.fn().mockResolvedValue({}) },
      documentChunk: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      $executeRaw: vi.fn().mockResolvedValue(1),
      document: { update: vi.fn().mockResolvedValue({}) },
      event: { update: vi.fn() },
      eventFact: { upsert: vi.fn() },
      scheduleItem: { create: vi.fn() },
    };
    const prisma = {
      document: {
        findUnique: vi.fn().mockResolvedValue({
          id: documentId, clientId, eventId, event: { id: eventId },
          objectKey: 'setup/agenda.txt', originalName: 'agenda.txt',
          uploadedByUserId: 'organizer-a',
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      $transaction: vi.fn((work: (value: typeof transaction) => unknown) => work(transaction)),
      conversation: { findFirst: vi.fn().mockResolvedValue({ id: 'conversation-a' }) },
      conversationMessage: { create: vi.fn().mockResolvedValue({
        id: 'message-a', role: 'CONCIERGE', content: 'Ready',
        status: 'COMPLETE', createdAt: new Date(),
      }) },
    };
    const jobs = {
      claim: vi.fn().mockResolvedValue({ id: 'job-a', payload: { documentId } }),
      complete: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn(),
    };
    const ai = { embed: vi.fn().mockResolvedValue([[0.1, 0.2]]), extractEventInformation: vi.fn() };
    const worker = new DocumentProcessingWorker(
      prisma as unknown as PrismaService,
      jobs as unknown as JobQueue,
      { download: vi.fn().mockResolvedValue(Buffer.from('Welcome at 9 AM.')) } as unknown as FileStorage,
      {
        extract: vi.fn().mockResolvedValue({ text: 'Welcome at 9 AM.', metadata: {} }),
        chunks: vi.fn().mockReturnValue(['Welcome at 9 AM.']),
      } as unknown as DocumentTextExtractorService,
      ai as unknown as AiProvider,
      { emitEvent: vi.fn(), emitToUser: vi.fn() } as unknown as EventGateway,
      { warn: vi.fn() } as unknown as PinoLogger,
    );

    expect(await worker.tick()).toBe(true);

    expect(jobs.complete).toHaveBeenCalledWith('job-a');
    expect(jobs.fail).not.toHaveBeenCalled();
    expect(ai.embed).toHaveBeenCalledWith(['Welcome at 9 AM.']);
    expect(ai.extractEventInformation).not.toHaveBeenCalled();
    expect(transaction.documentExtraction.upsert).toHaveBeenCalledOnce();
    expect(transaction.$executeRaw).toHaveBeenCalledOnce();
    expect(transaction.document.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { processingStatus: 'COMPLETED', parserVersion: '1.0.0' },
    }));
    expect(transaction.event.update).not.toHaveBeenCalled();
    expect(transaction.eventFact.upsert).not.toHaveBeenCalled();
    expect(transaction.scheduleItem.create).not.toHaveBeenCalled();
  });
});
