import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { finalize, type Observable } from 'rxjs';
import { ServerlessJobRunner } from './serverless-job-runner.service';

const mutationMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

@Injectable()
export class ServerlessJobsInterceptor implements NestInterceptor {
  constructor(private readonly jobs: ServerlessJobRunner) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    if (!process.env.VERCEL || !mutationMethods.has(request.method)) return next.handle();
    return next.handle().pipe(finalize(() => this.jobs.schedule()));
  }
}
