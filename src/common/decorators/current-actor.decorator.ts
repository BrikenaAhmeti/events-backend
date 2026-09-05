import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { RequestContext } from '../types/request.types';

export const CurrentActor = createParamDecorator((_: unknown, context: ExecutionContext) => {
  return context.switchToHttp().getRequest<RequestContext>().actor;
});

export const CurrentRequestId = createParamDecorator((_: unknown, context: ExecutionContext) => {
  return context.switchToHttp().getRequest<RequestContext>().requestId;
});
