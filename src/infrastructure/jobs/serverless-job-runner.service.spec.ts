import type { DocumentProcessingWorker } from '../../modules/documents/application/document-processing.worker';
import type { EventPublicationWorker } from '../../modules/events/application/event-publication.worker';
import type { CommunicationWorker } from '../../modules/invitations/application/communication.worker';
import type { OutboxService } from './outbox.service';
import { ServerlessJobRunner } from './serverless-job-runner.service';

const vercel = vi.hoisted(() => ({ waitUntil: vi.fn() }));

vi.mock('@vercel/functions', () => ({ waitUntil: vercel.waitUntil }));

describe('ServerlessJobRunner', () => {
  it('keeps draining dispatched work within the request lifetime', async () => {
    const dispatchBatch = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const communicationTick = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const documentTick = vi.fn().mockResolvedValue(false);
    const publicationTick = vi.fn().mockResolvedValue(false);
    const outbox = {
      dispatchBatch,
    } as unknown as OutboxService;
    const communications = {
      tick: communicationTick,
    } as unknown as CommunicationWorker;
    const documents = {
      tick: documentTick,
    } as unknown as DocumentProcessingWorker;
    const publications = {
      tick: publicationTick,
    } as unknown as EventPublicationWorker;
    const runner = new ServerlessJobRunner(outbox, communications, documents, publications);

    runner.schedule();

    const task = vercel.waitUntil.mock.calls[0]?.[0] as Promise<void>;
    await task;
    expect(dispatchBatch).toHaveBeenCalledTimes(2);
    expect(communicationTick).toHaveBeenCalledTimes(2);
    expect(documentTick).toHaveBeenCalledTimes(2);
    expect(publicationTick).toHaveBeenCalledTimes(2);
  });
});
