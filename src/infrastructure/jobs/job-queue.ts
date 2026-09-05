import { Injectable } from '@nestjs/common';
import type { BackgroundJob, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

export type EnqueueJob = {
  type: string;
  idempotencyKey: string;
  payload: Prisma.InputJsonValue;
  clientId?: string;
  eventId?: string;
  maxAttempts?: number;
};

@Injectable()
export class JobQueue {
  constructor(private readonly prisma: PrismaService) {}

  enqueue(input: EnqueueJob): Promise<BackgroundJob> {
    return this.prisma.backgroundJob.upsert({
      where: { idempotencyKey: input.idempotencyKey },
      create: {
        ...input,
        maxAttempts: input.maxAttempts ?? 5,
      },
      update: {},
    });
  }

  async claim(type: string, workerId: string): Promise<BackgroundJob | null> {
    const candidate = await this.prisma.backgroundJob.findFirst({
      where: {
        type,
        OR: [
          { status: 'PENDING', availableAt: { lte: new Date() } },
          { status: 'RUNNING', lockedAt: { lt: new Date(Date.now() - 5 * 60 * 1000) } },
        ],
      },
      orderBy: { createdAt: 'asc' },
    });
    if (!candidate) return null;
    if (candidate.attempts >= candidate.maxAttempts) {
      await this.prisma.backgroundJob.update({
        where: { id: candidate.id },
        data: {
          status: 'FAILED',
          lastError: 'WorkerLeaseExpired',
          lockedAt: null,
          lockedBy: null,
        },
      });
      return null;
    }
    const claimed = await this.prisma.backgroundJob.updateMany({
      where: { id: candidate.id, status: candidate.status, lockedAt: candidate.lockedAt },
      data: {
        status: 'RUNNING',
        lockedAt: new Date(),
        lockedBy: workerId,
        attempts: { increment: 1 },
      },
    });
    if (claimed.count === 0) return null;
    return this.prisma.backgroundJob.findUnique({ where: { id: candidate.id } });
  }

  async complete(id: string): Promise<void> {
    await this.prisma.backgroundJob.update({
      where: { id },
      data: {
        status: 'COMPLETED',
        progress: 100,
        completedAt: new Date(),
        lockedAt: null,
        lockedBy: null,
      },
    });
  }

  async fail(job: BackgroundJob, error: unknown): Promise<void> {
    const exhausted = job.attempts >= job.maxAttempts;
    await this.prisma.backgroundJob.update({
      where: { id: job.id },
      data: {
        status: exhausted ? 'FAILED' : 'PENDING',
        lastError: error instanceof Error ? error.name : 'UnknownError',
        availableAt: new Date(Date.now() + Math.min(60_000, 1000 * 2 ** job.attempts)),
        lockedAt: null,
        lockedBy: null,
      },
    });
  }
}
