import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PinoLogger } from 'nestjs-pino';
import { JobQueue } from '../../../infrastructure/jobs/job-queue';
import { EventGateway } from '../../../infrastructure/websocket/event.gateway';

@Injectable()
export class EventPublicationWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly workerId = `event-publication-${randomUUID()}`;

  constructor(
    private readonly jobs: JobQueue,
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
    try {
      const job = await this.jobs.claim('EVENT_PUBLISHED', this.workerId);
      if (!job) return false;
      try {
        const payload = job.payload as { eventId?: string };
        if (!payload.eventId) throw new Error('InvalidEventPublicationJob');
        this.gateway.emitEvent(payload.eventId, 'event:updated', {
          eventId: payload.eventId,
          status: 'PUBLISHED',
        });
        await this.jobs.complete(job.id);
      } catch (error) {
        await this.jobs.fail(job, error);
        this.logger.warn({
          operation: 'event.publication.broadcast',
          jobId: job.id,
          error: error instanceof Error ? error.name : 'UnknownError',
        });
      }
      return true;
    } finally {
      this.running = false;
    }
  }
}
