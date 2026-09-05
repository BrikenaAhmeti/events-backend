import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../infrastructure/database/prisma.service';

type SearchRow = { id: string; content: string; section: string | null; distance: number };

@Injectable()
export class EventKnowledgeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async semanticSearch(eventId: string, embedding: number[], limit = 6): Promise<SearchRow[]> {
    if (embedding.length === 0) return [];
    const vector = `[${embedding.join(',')}]`;
    return this.prisma.$queryRaw<SearchRow[]>(Prisma.sql`
      SELECT "id", "content", "section", "embedding" <=> ${vector}::vector AS "distance"
      FROM "DocumentChunk"
      WHERE "eventId" = ${eventId}::uuid AND "embedding" IS NOT NULL
      ORDER BY "embedding" <=> ${vector}::vector
      LIMIT ${Math.min(limit, 10)}
    `);
  }
}
