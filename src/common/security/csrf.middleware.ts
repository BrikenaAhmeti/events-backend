import { Injectable, type NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Response } from 'express';
import type { Environment } from '../config/environment';
import { ApplicationError } from '../errors/application.error';
import type { RequestContext } from '../types/request.types';
import { CSRF_COOKIE } from './cookie.constants';
import { CsrfService } from './csrf.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  constructor(
    private readonly csrf: CsrfService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  use(request: RequestContext, _: Response, next: NextFunction): void {
    if (SAFE_METHODS.has(request.method)) {
      next();
      return;
    }
    this.validateOrigin(request);
    const cookie = request.cookies?.[CSRF_COOKIE] as string | undefined;
    const header = request.header('x-csrf-token');
    if (!cookie || !header || cookie !== header || !this.csrf.verify(header)) {
      throw new ApplicationError(
        403,
        'CSRF_VALIDATION_FAILED',
        'Security token validation failed.',
      );
    }
    next();
  }

  private validateOrigin(request: RequestContext): void {
    const allowed = new URL(this.config.get('FRONTEND_URL', { infer: true })).origin;
    const supplied = request.header('origin') ?? request.header('referer');
    try {
      if (!supplied || new URL(supplied).origin !== allowed) {
        throw new ApplicationError(403, 'ORIGIN_NOT_ALLOWED', 'Request origin is not allowed.');
      }
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError(403, 'ORIGIN_NOT_ALLOWED', 'Request origin is not allowed.');
    }
  }
}
