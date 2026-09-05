import type { ConfigService } from '@nestjs/config';
import type { Socket } from 'socket.io';
import type { Environment } from '../../common/config/environment';
import type { AuthenticatedActor } from '../../common/types/request.types';
import { AuthorizationService } from '../../modules/memberships/application/authorization.service';
import { Permission } from '../../modules/memberships/domain/permission';
import type { PrismaService } from '../database/prisma.service';
import { EventGateway } from './event.gateway';
import { WebsocketTicketService } from './websocket-ticket.service';

const actor: AuthenticatedActor = {
  userId: 'user-a',
  supabaseUserId: 'identity-a',
  email: 'staff@example.test',
  firstName: 'Morgan',
  lastName: 'Reed',
  platformRole: null,
  memberships: [
    {
      clientId: 'client-a',
      role: 'CLIENT_STAFF',
      status: 'ACTIVE',
      permissions: [Permission.EVENT_READ],
    },
  ],
};

const socketWith = (currentActor: AuthenticatedActor) => {
  const join = vi.fn(() => Promise.resolve());
  return { socket: { data: { actor: currentActor }, join } as unknown as Socket, join };
};

describe('EventGateway room isolation', () => {
  const createGateway = (clientId: string, status = 'ACTIVE') => {
    const prisma = {
      event: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'event-b',
          clientId,
          client: { status },
        }),
      },
    } as unknown as PrismaService;
    const config = {
      get: vi.fn().mockReturnValue('http://localhost:5173'),
    } as unknown as ConfigService<Environment, true>;
    return new EventGateway(
      new WebsocketTicketService(),
      prisma,
      new AuthorizationService(),
      config,
    );
  };

  it('denies joining another client event room', async () => {
    const gateway = createGateway('client-b');
    const { socket, join } = socketWith(actor);
    await expect(gateway.subscribe(socket, { eventId: 'event-b' })).resolves.toEqual({
      ok: false,
      code: 'FORBIDDEN',
    });
    expect(join).not.toHaveBeenCalled();
  });

  it('allows an explicitly permitted event room and consumes tickets once', async () => {
    const gateway = createGateway('client-a');
    const { socket, join } = socketWith(actor);
    await expect(gateway.subscribe(socket, { eventId: 'event-b' })).resolves.toEqual({ ok: true });
    expect(join).toHaveBeenCalledWith('event:event-b');

    const tickets = new WebsocketTicketService();
    const issued = tickets.issue(actor);
    expect(tickets.consume(issued.ticket)).toEqual(actor);
    expect(tickets.consume(issued.ticket)).toBeNull();
  });

  it('denies subscriptions after a client is deactivated', async () => {
    const gateway = createGateway('client-a', 'INACTIVE');
    const { socket, join } = socketWith(actor);

    await expect(gateway.subscribe(socket, { eventId: 'event-b' })).resolves.toEqual({
      ok: false,
      code: 'FORBIDDEN',
    });
    expect(join).not.toHaveBeenCalled();
  });
});
