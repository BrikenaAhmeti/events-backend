import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { RequestContext } from '../types/request.types';

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(request: RequestContext, response: Response, next: NextFunction): void {
    const supplied = request.header('x-request-id');
    request.requestId = supplied?.slice(0, 128) || randomUUID();
    response.setHeader('x-request-id', request.requestId);
    next();
  }
}
