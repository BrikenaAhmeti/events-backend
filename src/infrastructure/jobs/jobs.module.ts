import { Global, Module } from '@nestjs/common';
import { JobQueue } from './job-queue';
import { OutboxService } from './outbox.service';
import { OutboxWorker } from './outbox.worker';

@Global()
@Module({ providers: [JobQueue, OutboxService, OutboxWorker], exports: [JobQueue, OutboxService] })
export class JobsModule {}
