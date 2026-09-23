import type { AuthenticatedActor, GuestActor } from '../../../common/types/request.types';
import type { PrismaService } from '../../../infrastructure/database/prisma.service';
import type { AiProvider } from '../../../infrastructure/openai/ai.provider';
import type { EventKnowledgeRepository } from '../../knowledge/infrastructure/event-knowledge.repository';
import { AuthorizationService } from '../../memberships/application/authorization.service';
import type { FieldEncryptionService } from '../../../common/security/field-encryption.service';
import { ConciergeService, type ConciergeStreamEvent } from './concierge.service';

describe('ConciergeService streaming', () => {
  it('shows the completed event setup and new organizer messages as one chat history', async () => {
    const actor: AuthenticatedActor = {
      userId: 'user-a',
      supabaseUserId: 'identity-a',
      email: 'admin@example.test',
      firstName: 'Elena',
      lastName: 'Hart',
      platformRole: 'SUPER_ADMIN',
      memberships: [],
    };
    const setupAt = new Date('2027-10-01T10:00:00Z');
    const organizerAt = new Date('2027-10-02T10:00:00Z');
    const prisma = {
      event: { findUnique: vi.fn().mockResolvedValue({ id: 'event-a', clientId: 'client-a' }) },
      conversation: {
        findFirst: vi.fn().mockImplementation(({ where }: { where: { type: string } }) =>
          Promise.resolve(where.type === 'EVENT_SETUP'
            ? { messages: [{ id: 'setup-message', role: 'USER', content: 'The conference is in Lisbon.', createdAt: setupAt }] }
            : { id: 'organizer-a', messages: [{ id: 'organizer-message', role: 'CONCIERGE', content: 'Ready to publish.', createdAt: organizerAt }] }),
        ),
      },
    } as unknown as PrismaService;
    const service = new ConciergeService(
      prisma,
      {} as AiProvider,
      {} as EventKnowledgeRepository,
      new AuthorizationService(),
      {} as FieldEncryptionService,
    );

    const result = await service.historyPlatform(actor, 'event-a');

    expect(result.messages.map((message) => message.id)).toEqual([
      'setup-message', 'organizer-message',
    ]);
  });

  it('publishes progressive answer text and stores the completed message', async () => {
    const now = new Date('2027-10-12T08:00:00Z');
    const event = {
      id: 'event-a',
      clientId: 'client-a',
      name: 'Leadership Forum',
      description: 'A leadership event.',
      destination: 'Lisbon',
      venue: 'Riverside Hall',
      venueAddress: '1 River Road',
      venueDetails: null,
      restroomInformation: null,
      accessibilityInformation: null,
      parkingInformation: null,
      wifiInformation: null,
      startAt: now,
      endAt: new Date('2027-10-12T18:00:00Z'),
      timezone: 'Europe/Lisbon',
      schedule: [],
      facts: [],
      contacts: [],
      locations: [],
    };
    const createMessage = vi
      .fn<(input: { data: Record<string, unknown> }) => Promise<Record<string, unknown>>>()
      .mockResolvedValueOnce({ id: 'question-a' })
      .mockImplementationOnce(({ data }) => Promise.resolve({ ...data, createdAt: now }));
    const prisma = {
      event: { findUnique: vi.fn().mockResolvedValue(event) },
      conversation: { findFirst: vi.fn().mockResolvedValue({ id: 'conversation-a' }) },
      conversationMessage: { create: createMessage },
    } as unknown as PrismaService;
    const answerStream = vi.fn((_: unknown, onDelta: (delta: string) => void) => {
      onDelta('Doors open ');
      onDelta('at 08:00.');
      return Promise.resolve({
        answer: 'Doors open at 08:00.',
        usage: { outputTokens: 8 },
      });
    });
    const semanticSearch = vi.fn().mockResolvedValue([
      { content: 'The event file says doors open at 08:00.' },
    ]);
    const ai = {
      embed: vi.fn().mockResolvedValue([[0.1, 0.2]]),
      answerStream,
    } as unknown as AiProvider;
    const actor: AuthenticatedActor = {
      userId: 'user-a',
      supabaseUserId: 'identity-a',
      email: 'admin@example.test',
      firstName: 'Elena',
      lastName: 'Hart',
      platformRole: 'SUPER_ADMIN',
      memberships: [],
    };
    const service = new ConciergeService(
      prisma,
      ai,
      { semanticSearch } as unknown as EventKnowledgeRepository,
      new AuthorizationService(),
      {} as FieldEncryptionService,
    );
    const streamed: ConciergeStreamEvent[] = [];

    const result = await service.askPlatform(
      actor,
      event.id,
      'What time do doors open?',
      'req-a',
      (streamEvent) => streamed.push(streamEvent),
    );

    expect(streamed.map(({ type }) => type)).toEqual(['status', 'delta', 'delta', 'message']);
    expect(result.message.content).toBe('Doors open at 08:00.');
    expect(semanticSearch).toHaveBeenCalledWith(event.id, [0.1, 0.2]);
    expect(answerStream.mock.calls[0]?.[0]).toMatchObject({
      untrustedDocumentContext: 'The event file says doors open at 08:00.',
    });
    expect(createMessage.mock.calls.at(-1)?.[0].data).toMatchObject({
      role: 'CONCIERGE',
      content: 'Doors open at 08:00.',
      status: 'COMPLETE',
    });
  });

  it('refuses another guest’s details before sending any context to the AI', async () => {
    const actor: GuestActor = { eventId: 'event-a', guestId: 'guest-a', sessionId: 'session-a' };
    const createMessage = vi.fn().mockImplementation(({ data }) =>
      Promise.resolve({ id: 'message-a', ...data, createdAt: new Date() }),
    );
    const prisma = {
      event: { findUnique: vi.fn().mockResolvedValue({ id: actor.eventId, clientId: 'client-a' }) },
      guest: {
        findFirst: vi.fn().mockResolvedValue({ id: actor.guestId, notesEncrypted: null }),
        findMany: vi.fn().mockResolvedValue([{ fullName: 'Alex Morgan', email: 'alex@example.test' }]),
      },
      conversation: { findFirst: vi.fn().mockResolvedValue({ id: 'conversation-a' }) },
      conversationMessage: { create: createMessage },
    } as unknown as PrismaService;
    const answer = vi.fn();
    const service = new ConciergeService(
      prisma,
      { answer } as unknown as AiProvider,
      {} as EventKnowledgeRepository,
      new AuthorizationService(),
      {} as FieldEncryptionService,
    );
    const events: ConciergeStreamEvent[] = [];

    const result = await service.askGuest(
      actor, 'Where is Alex Morgan sitting?', 'request-a', (event) => events.push(event),
    );

    expect(answer).not.toHaveBeenCalled();
    expect(result.message.content).toContain('cannot share another guest');
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('message');
    const nearby = await service.askGuest(actor, 'Who is next to me?', 'request-nearby');
    expect(nearby.message.content).toContain('cannot share another guest');
    expect(answer).not.toHaveBeenCalled();
  });

  it('uses only the current guest’s private note and excludes other guest document content', async () => {
    const actor: GuestActor = { eventId: 'event-a', guestId: 'guest-a', sessionId: 'session-a' };
    const event = {
      id: actor.eventId, clientId: 'client-a', name: 'Leadership Forum',
      timezone: 'Europe/Rome', description: null, destination: 'Rome', venue: null,
      venueAddress: null, venueDetails: null, restroomInformation: null,
      accessibilityInformation: null, parkingInformation: null, wifiInformation: null,
      startAt: null, endAt: null, schedule: [], facts: [], contacts: [], locations: [],
    };
    const createMessage = vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: typeof data.id === 'string' ? data.id : 'message-a', ...data, createdAt: new Date() }),
    );
    const prisma = {
      event: { findUnique: vi.fn().mockResolvedValue(event) },
      guest: {
        findFirst: vi.fn().mockResolvedValue({ id: actor.guestId, notesEncrypted: 'encrypted-note',
          accommodationEncrypted: null, travelEncrypted: null, dietaryEncrypted: null,
          accessibilityEncrypted: null }),
        findMany: vi.fn().mockResolvedValue([{ fullName: 'Alex Morgan', email: 'alex@example.test' }]),
      },
      conversation: { findFirst: vi.fn().mockResolvedValue({ id: 'conversation-a' }) },
      conversationMessage: { create: createMessage },
    } as unknown as PrismaService;
    const answer = vi.fn()
      .mockResolvedValueOnce({ answer: 'Your seat is B12.' })
      .mockResolvedValueOnce({ answer: 'Alex Morgan sits in A1.' });
    const ai = {
      embed: vi.fn().mockResolvedValue([[0.1]]), answer,
    } as unknown as AiProvider;
    const semanticSearch = vi.fn().mockResolvedValue([
      { content: 'Alex Morgan sits in A1.' },
      { content: 'Guest list: Jane sits in C4.' },
      { content: 'Registration opens at 08:00.' },
    ]);
    let noteText = 'Seat B12';
    const service = new ConciergeService(
      prisma, ai, { semanticSearch } as unknown as EventKnowledgeRepository,
      new AuthorizationService(),
      { decrypt: vi.fn((value: string | null) => value === 'encrypted-note' ? noteText : null) } as unknown as FieldEncryptionService,
    );
    const events: ConciergeStreamEvent[] = [];

    const result = await service.askGuest(actor, 'Where is my seat?', 'request-seat',
      (streamEvent) => events.push(streamEvent));

    expect(result.message.content).toBe('Your seat is B12.');
    expect(answer.mock.calls[0]?.[0]).toMatchObject({
      privateGuestContext: 'Your arrangements: Seat B12',
      untrustedDocumentContext: 'Registration opens at 08:00.',
    });
    expect(events.map(({ type }) => type)).toEqual(['status', 'delta', 'message']);

    noteText = 'Seat B12 next to Alex Morgan';
    const filteredEvents: ConciergeStreamEvent[] = [];
    const filtered = await service.askGuest(actor, 'Tell me my seating arrangements', 'request-seat-2',
      (streamEvent) => filteredEvents.push(streamEvent));
    expect(filtered.message.content).not.toContain('Alex Morgan');
    expect(answer.mock.calls[1]?.[0]).toMatchObject({ privateGuestContext: '' });
    expect(filteredEvents.some((streamEvent) =>
      streamEvent.type === 'delta' && streamEvent.delta.includes('Alex Morgan'))).toBe(false);
  });
});
