import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { OutboxService } from './outbox.service';

@Injectable()
export class OutboxWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly outbox: OutboxService,
    private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    if (process.env.VERCEL) return;
    this.timer = setInterval(() => void this.tick(), 5_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    try {
      await this.outbox.dispatchBatch();
    } catch (error) {
      this.logger.warn({
        operation: 'outbox.dispatch',
        error: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }
}
