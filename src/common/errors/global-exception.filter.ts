import { ArgumentsHost, Catch, HttpException, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { ApplicationError } from './application.error';
import type { RequestContext } from '../types/request.types';

type ErrorResponse = {
  statusCode: number;
  code: string;
  message: string;
  details: Record<string, unknown>;
  requestId: string;
};

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<RequestContext>();
    const response = host.switchToHttp().getResponse<Response>();
    const payload = this.map(error, request.requestId);
    response.status(payload.statusCode).json(payload);
  }

  private map(error: unknown, requestId: string): ErrorResponse {
    if (error instanceof ApplicationError) {
      return { ...error, message: error.message, requestId };
    }
    if (error instanceof ZodError) {
      return {
        statusCode: 400,
        code: 'VALIDATION_FAILED',
        message: 'The submitted information is invalid.',
        details: { fields: error.flatten().fieldErrors },
        requestId,
      };
    }
    if (error instanceof HttpException) {
      return {
        statusCode: error.getStatus(),
        code: `HTTP_${error.getStatus()}`,
        message: error.message,
        details: {},
        requestId,
      };
    }
    return {
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
      details: {},
      requestId,
    };
  }
}
