import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../../common/decorators/public.decorator';
import { PrismaService } from '../../../infrastructure/database/prisma.service';

@Public()
@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async health() {
    const startedAt = performance.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return {
        status: 'ready',
        checks: { application: 'up', database: 'up' },
        durationMs: Math.round(performance.now() - startedAt),
      };
    } catch {
      return {
        status: 'degraded',
        checks: { application: 'up', database: 'down' },
        durationMs: Math.round(performance.now() - startedAt),
      };
    }
  }
}
