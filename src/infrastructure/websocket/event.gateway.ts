import { ConfigService } from '@nestjs/config';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import type { Environment } from '../../common/config/environment';
import { isSameOrigin } from '../../common/security/origin';
import type { AuthenticatedActor } from '../../common/types/request.types';
import { AuthorizationService } from '../../modules/memberships/application/authorization.service';
import { Permission } from '../../modules/memberships/domain/permission';
import { PrismaService } from '../database/prisma.service';
import { WebsocketTicketService } from './websocket-ticket.service';

type SocketData = { actor?: AuthenticatedActor };

const allowConfiguredOrigin = (
  origin: string | undefined,
  callback: (error: Error | null, allowed?: boolean) => void,
) => {
  callback(null, isSameOrigin(origin, process.env.FRONTEND_URL ?? 'http://localhost:5173'));
};

@WebSocketGateway({
  namespace: '/events',
  cors: {
    origin: allowConfiguredOrigin,
    credentials: true,
    allowedHeaders: ['X-CSRF-Token'],
  },
})
export class EventGateway implements OnGatewayConnection {
  @WebSocketServer()
  private readonly server!: Server;

  constructor(
    private readonly tickets: WebsocketTicketService,
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  handleConnection(socket: Socket): void {
    const origin = socket.handshake.headers.origin;
    if (!isSameOrigin(origin, this.config.get('FRONTEND_URL', { infer: true }))) {
      socket.disconnect(true);
      return;
    }
    const ticket =
      typeof socket.handshake.auth.ticket === 'string' ? socket.handshake.auth.ticket : '';
    const actor = this.tickets.consume(ticket);
    if (!actor) socket.disconnect(true);
    else (socket as unknown as { data: SocketData }).data.actor = actor;
  }

  @SubscribeMessage('event:subscribe')
  async subscribe(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    const eventId =
      typeof body === 'object' && body && 'eventId' in body ? String(body.eventId) : '';
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { id: true, clientId: true, client: { select: { status: true } } },
    });
    const actor = (socket as unknown as { data: SocketData }).data.actor;
    if (
      !event ||
      !actor ||
      (event.client.status !== 'ACTIVE' && actor.platformRole !== 'SUPER_ADMIN') ||
      !this.authorization.can(actor, event.clientId, Permission.EVENT_READ)
    ) {
      return { ok: false, code: 'FORBIDDEN' };
    }
    await socket.join(`event:${event.id}`);
    await socket.join(`event:${event.id}:user:${actor.userId}`);
    return { ok: true };
  }

  emitEvent(eventId: string, type: string, payload: Record<string, unknown>): void {
    this.server.to(`event:${eventId}`).emit(type, payload);
  }

  emitToUser(
    eventId: string,
    userId: string,
    type: string,
    payload: Record<string, unknown>,
  ): void {
    this.server.to(`event:${eventId}:user:${userId}`).emit(type, payload);
  }
}
