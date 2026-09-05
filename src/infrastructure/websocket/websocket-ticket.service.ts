import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { AuthenticatedActor } from '../../common/types/request.types';

type TicketRecord = { actor: AuthenticatedActor; expiresAt: number };

@Injectable()
export class WebsocketTicketService {
  private readonly tickets = new Map<string, TicketRecord>();

  issue(actor: AuthenticatedActor): { ticket: string; expiresAt: string } {
    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + 60_000;
    this.tickets.set(ticket, { actor, expiresAt });
    return { ticket, expiresAt: new Date(expiresAt).toISOString() };
  }

  consume(ticket: string): AuthenticatedActor | null {
    const record = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!record || record.expiresAt < Date.now()) return null;
    return record.actor;
  }
}
