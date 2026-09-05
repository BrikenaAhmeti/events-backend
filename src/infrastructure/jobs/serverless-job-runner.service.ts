import { Injectable, Logger } from '@nestjs/common';
import { waitUntil } from '@vercel/functions';
import { DocumentProcessingWorker } from '../../modules/documents/application/document-processing.worker';
import { EventPublicationWorker } from '../../modules/events/application/event-publication.worker';
import { CommunicationWorker } from '../../modules/invitations/application/communication.worker';
import { OutboxService } from './outbox.service';

@Injectable()
export class ServerlessJobRunner {
  private readonly logger = new Logger(ServerlessJobRunner.name);
  private running?: Promise<void>;

  constructor(
    private readonly outbox: OutboxService,
    private readonly communications: CommunicationWorker,
    private readonly documents: DocumentProcessingWorker,
    private readonly publications: EventPublicationWorker,
  ) {}

  schedule(): void {
    if (!this.running) {
      const task = this.drain()
        .catch((error: unknown) => {
          this.logger.warn({
            operation: 'serverless.jobs.drain',
            error: error instanceof Error ? error.name : 'UnknownError',
          });
        })
        .finally(() => {
          if (this.running === task) this.running = undefined;
        });
      this.running = task;
    }
    waitUntil(this.running);
  }

  private async drain(): Promise<void> {
    const deadline = Date.now() + 240_000;
    let workFound = true;
    while (workFound && Date.now() < deadline) {
      const dispatched = await this.outbox.dispatchBatch();
      const processed = await Promise.all([
        this.communications.tick(),
        this.documents.tick(),
        this.publications.tick(),
      ]);
      workFound = dispatched > 0 || processed.some(Boolean);
    }
  }
}
