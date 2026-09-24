import { Controller, Get, Headers } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Environment } from '../../common/config/environment';
import { Public } from '../../common/decorators/public.decorator';
import { ApplicationError } from '../../common/errors/application.error';
import { ServerlessJobRunner } from './serverless-job-runner.service';

@Controller('internal/jobs')
export class ScheduledJobsController {
  constructor(
    private readonly config: ConfigService<Environment, true>,
    private readonly jobs: ServerlessJobRunner,
  ) {}

  @Public()
  @Get('run')
  run(@Headers('authorization') authorization?: string) {
    const secret = this.config.get('CRON_SECRET', { infer: true });
    const supplied = Buffer.from(authorization ?? '');
    const expected = Buffer.from(`Bearer ${secret}`);
    if (!secret || supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      throw new ApplicationError(401, 'JOB_AUTH_REQUIRED', 'Job authorization is required.');
    this.jobs.schedule();
    return { scheduled: true };
  }
}
