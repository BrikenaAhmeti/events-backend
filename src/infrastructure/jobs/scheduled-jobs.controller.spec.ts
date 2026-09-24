import type { ConfigService } from '@nestjs/config';
import type { Environment } from '../../common/config/environment';
import type { ServerlessJobRunner } from './serverless-job-runner.service';
import { ScheduledJobsController } from './scheduled-jobs.controller';

describe('ScheduledJobsController', () => {
  it('schedules durable queue work only with the configured secret', () => {
    let secret = 'a'.repeat(32);
    const schedule = vi.fn();
    const controller = new ScheduledJobsController({ get: () => secret } as unknown as ConfigService<Environment, true>,
      { schedule } as unknown as ServerlessJobRunner);
    expect(() => controller.run()).toThrow('Job authorization is required.');
    expect(() => controller.run(`Bearer ${'b'.repeat(32)}`)).toThrow('Job authorization is required.');
    expect(schedule).not.toHaveBeenCalled();
    expect(controller.run(`Bearer ${secret}`)).toEqual({ scheduled: true });
    expect(schedule).toHaveBeenCalledOnce();
    secret = '';
    expect(() => controller.run('Bearer ')).toThrow('Job authorization is required.');
    expect(schedule).toHaveBeenCalledOnce();
  });
});
