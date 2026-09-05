import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class OutboxService {
  constructor(private readonly prisma: PrismaService) {}

  create(
    transaction: Prisma.TransactionClient,
    input: {
      type: string;
      aggregateId: string;
      payload: Prisma.InputJsonValue;
      clientId?: string;
      eventId?: string;
    },
  ) {
    return transaction.outboxEvent.create({ data: input });
  }

  async dispatchBatch(): Promise<number> {
    const entries = await this.prisma.outboxEvent.findMany({
      where: { processedAt: null, availableAt: { lte: new Date() } },
      take: 25,
      orderBy: { createdAt: 'asc' },
    });
    for (const entry of entries) {
      await this.prisma.$transaction(async (transaction) => {
        await transaction.backgroundJob.upsert({
          where: { idempotencyKey: `outbox:${entry.id}` },
          create: {
            type: entry.type,
            idempotencyKey: `outbox:${entry.id}`,
            clientId: entry.clientId,
            eventId: entry.eventId,
            payload: entry.payload as Prisma.InputJsonValue,
          },
          update: {},
        });
        await transaction.outboxEvent.update({
          where: { id: entry.id },
          data: { processedAt: new Date() },
        });
      });
    }
    return entries.length;
  }
}
