import type { AuthenticatedActor, GuestActor } from '../../../common/types/request.types';
import type { PrismaService } from '../../../infrastructure/database/prisma.service';
import type { AiProvider } from '../../../infrastructure/openai/ai.provider';
import type { EventKnowledgeRepository } from '../../knowledge/infrastructure/event-knowledge.repository';
import { AuthorizationService } from '../../memberships/application/authorization.service';
import type { FieldEncryptionService } from '../../../common/security/field-encryption.service';
import { ConciergeService, type ConciergeStreamEvent } from './concierge.service';
import { requestedLanguage } from './guest-chat-language';

describe('ConciergeService streaming', () => {
  it('archives a guest’s old chat and starts a saved empty chat in the chosen language', async () => {
    const actor: GuestActor = { eventId: 'event-a', guestId: 'guest-a', sessionId: 'session-a' };
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const create = vi.fn().mockResolvedValue({ id: 'new-chat' });
    const prisma = {
      event: { findUnique: vi.fn().mockResolvedValue({ id: actor.eventId, clientId: 'client-a' }) },
      guest: { findFirst: vi.fn().mockResolvedValue({ id: actor.guestId }) },
      $transaction: vi.fn(async (operation: (tx: unknown) => Promise<unknown>) =>
        operation({ conversation: { updateMany, create } })),
    } as unknown as PrismaService;
    const service = new ConciergeService(prisma, {} as AiProvider, {} as EventKnowledgeRepository,
      new AuthorizationService(), {} as FieldEncryptionService);

    expect(await service.startGuestChat(actor, 'sq')).toEqual({ id: 'new-chat', language: 'sq', messages: [] });
    expect(updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { eventId: actor.eventId, type: 'GUEST', state: 'ACTIVE', userId: null, guestId: actor.guestId },
      data: { state: 'COMPLETED' },
    });
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      data: { guestId: actor.guestId, draft: { language: 'sq' } },
    });
  });

  it('recognizes explicit language changes without mistaking an event question for one', () => {
    expect(requestedLanguage('Please continue in Albanian.')).toBe('sq');
    expect(requestedLanguage('Can you reply in French?')).toBe('fr');
    expect(requestedLanguage('Fol shqip, ju lutem.')).toBe('sq');
    expect(requestedLanguage('Speak Albanian, please.')).toBe('sq');
    expect(requestedLanguage('Përgjigju në shqip.')).toBe('sq');
    expect(requestedLanguage('What language is the French presentation in?')).toBeNull();
  });

  it('saves a guest’s in-chat language switch for later answers', async () => {
    const actor: GuestActor = { eventId: 'event-a', guestId: 'guest-a', sessionId: 'session-a' };
    let language = 'en';
    const event = {
      id: actor.eventId, clientId: 'client-a', name: 'Forum', timezone: 'Europe/Paris',
      description: null, destination: null, venue: null, venueAddress: null, venueDetails: null,
      restroomInformation: null, accessibilityInformation: null, parkingInformation: null,
      wifiInformation: null, organizerName: null, organizerEmail: null,
      startAt: null, endAt: null, schedule: [], facts: [], contacts: [], locations: [],
    };
    const update = vi.fn().mockImplementation(({ data }: { data: { draft: { language: string } } }) => {
      language = data.draft.language;
      return Promise.resolve();
    });
    const prisma = {
      event: { findUnique: vi.fn().mockResolvedValue(event) },
      guest: { findFirst: vi.fn().mockResolvedValue({ id: actor.guestId }), findMany: vi.fn().mockResolvedValue([]) },
      conversation: {
        findFirst: vi.fn().mockImplementation(() => Promise.resolve({ id: 'chat-a', draft: { language }, messages: [] })),
        update,
      },
      conversationMessage: { create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...data, id: data.id ?? 'message-a', createdAt: new Date() })) },
    } as unknown as PrismaService;
    const answer = vi.fn().mockResolvedValue({ answer: 'Bonjour.' });
    const service = new ConciergeService(prisma,
      { embed: vi.fn().mockResolvedValue([]), answer } as unknown as AiProvider,
      { semanticSearch: vi.fn() } as unknown as EventKnowledgeRepository,
      new AuthorizationService(), {} as FieldEncryptionService);
    const events: ConciergeStreamEvent[] = [];

    await service.askGuest(actor, 'Please continue in French.', 'request-a', (item) => events.push(item));
    await service.askGuest(actor, 'Where is the venue?', 'request-b');

    expect(update).toHaveBeenCalledWith({ where: { id: 'chat-a' }, data: { draft: { language: 'fr' } } });
    expect(events[0]).toEqual({ type: 'language', language: 'fr' });
    expect(answer.mock.calls[0]?.[0]).toMatchObject({ responseLanguage: 'French' });
    expect(answer.mock.calls[1]?.[0]).toMatchObject({ responseLanguage: 'French' });
  });

  it('loads the latest guest messages in chronological order within the authenticated event and guest', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: 'conversation-a', messages: [
      { id: 'latest', content: 'The east entrance.', createdAt: new Date('2027-10-12T09:01:00Z') },
      { id: 'previous', content: 'Which entrance?', createdAt: new Date('2027-10-12T09:00:00Z') },
    ] });
    const service = new ConciergeService(
      { conversation: { findFirst } } as unknown as PrismaService,
      {} as AiProvider, {} as EventKnowledgeRepository,
      new AuthorizationService(), {} as FieldEncryptionService,
    );
    const result = await service.historyGuest({ eventId: 'event-a', guestId: 'guest-a', sessionId: 'session-a' });
    expect(result.messages.map(({ id }) => id)).toEqual(['previous', 'latest']);
    expect(findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { eventId: 'event-a', guestId: 'guest-a', userId: null, type: 'GUEST', state: 'ACTIVE' },
      select: { messages: { orderBy: { createdAt: 'desc' }, take: 100 } },
    });
  });

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

  it('localizes a privacy refusal without exposing the other guest to the language model', async () => {
    const actor: GuestActor = { eventId: 'event-a', guestId: 'guest-a', sessionId: 'session-a' };
    const prisma = {
      event: { findUnique: vi.fn().mockResolvedValue({ id: actor.eventId, clientId: 'client-a', name: 'Forum', timezone: 'Europe/Paris' }) },
      guest: {
        findFirst: vi.fn().mockResolvedValue({ id: actor.guestId }),
        findMany: vi.fn().mockResolvedValue([{ fullName: 'Alex Morgan', email: 'alex@example.test' }]),
      },
      conversation: { findFirst: vi.fn().mockResolvedValue({ id: 'chat-a', draft: { language: 'fr' } }) },
      conversationMessage: { create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...data, id: 'message-a', createdAt: new Date() })) },
    } as unknown as PrismaService;
    const answer = vi.fn().mockResolvedValue({ answer: 'Je peux vous aider avec vos informations, mais pas celles des autres invités.' });
    const service = new ConciergeService(prisma, { answer } as unknown as AiProvider,
      {} as EventKnowledgeRepository, new AuthorizationService(), {} as FieldEncryptionService);

    const result = await service.askGuest(actor, 'Where is Alex Morgan sitting?', 'request-a');

    expect(result.message.content).toContain('autres invités');
    expect(answer.mock.calls[0]?.[0]).toMatchObject({ responseLanguage: 'French', recentMessages: [], untrustedDocumentContext: '' });
    expect(JSON.stringify(answer.mock.calls[0]?.[0])).not.toContain('Alex Morgan');
    expect(JSON.stringify(answer.mock.calls[0]?.[0])).not.toContain('alex@example.test');
  });

  it('uses only the current guest’s private note and excludes other guest document content', async () => {
    const actor: GuestActor = { eventId: 'event-a', guestId: 'guest-a', sessionId: 'session-a' };
    const event = {
      id: actor.eventId, clientId: 'client-a', name: 'Leadership Forum',
      timezone: 'Europe/Rome', description: null, destination: 'Rome', venue: null,
      venueAddress: null, venueDetails: null, restroomInformation: null,
      accessibilityInformation: null, parkingInformation: null, wifiInformation: null,
      organizerName: 'Northstar Events', organizerEmail: 'events@example.test',
      startAt: null, endAt: null, schedule: [],
      facts: [
        { key: 'Restroom access', value: 'Use the lift to floor two.' },
        { key: 'Entry', value: 'All guests should use the east entrance.' },
      ],
      contacts: [], locations: [],
    };
    const createMessage = vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: typeof data.id === 'string' ? data.id : 'message-a', ...data, createdAt: new Date() }),
    );
    const findEvent = vi.fn().mockResolvedValue(event);
    const findConversation = vi.fn().mockResolvedValue({ id: 'conversation-a', messages: [
      { role: 'CONCIERGE', content: 'Registration opens at 08:00.' },
      { role: 'USER', content: 'When does registration open?' },
      { role: 'USER', content: 'Where is Alex Morgan sitting?' },
    ] });
    const prisma = {
      event: { findUnique: findEvent },
      guest: {
        findFirst: vi.fn().mockResolvedValue({ id: actor.guestId, notesEncrypted: 'encrypted-note',
          accommodationEncrypted: null, travelEncrypted: null, dietaryEncrypted: null,
          accessibilityEncrypted: null }),
        findMany: vi.fn().mockResolvedValue([{ fullName: 'Alex Morgan', email: 'alex@example.test' }]),
      },
      conversation: { findFirst: findConversation },
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
    expect(findEvent).toHaveBeenCalledWith({
      where: { id: actor.eventId },
      include: {
        schedule: { where: { visibility: 'SHARED' }, orderBy: { startAt: 'asc' }, take: 100 },
        facts: { take: 200 }, contacts: { take: 50 }, locations: { take: 50 },
      },
    });
    const context = answer.mock.calls[0]?.[0] as { structuredContext: string };
    expect(context.structuredContext).toContain('Organizer email: events@example.test');
    expect(context.structuredContext).toContain('Restroom access: Use the lift to floor two.');
    expect(context.structuredContext).toContain('All guests should use the east entrance.');
    expect(answer.mock.calls[0]?.[0]).toMatchObject({
      privateGuestContext: 'Your arrangements: Seat B12',
      untrustedDocumentContext: 'Registration opens at 08:00.',
      recentMessages: [
        { role: 'user', content: 'When does registration open?' },
        { role: 'assistant', content: 'Registration opens at 08:00.' },
      ],
    });
    expect(findConversation.mock.calls[0]?.[0]).toMatchObject({ where: {
      eventId: actor.eventId, guestId: actor.guestId, userId: null, type: 'GUEST', state: 'ACTIVE',
    } });
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
