import type { AuthenticatedActor } from '../../../common/types/request.types';
import type { PrismaService } from '../../../infrastructure/database/prisma.service';
import type { AiProvider } from '../../../infrastructure/openai/ai.provider';
import type { EventKnowledgeRepository } from '../../knowledge/infrastructure/event-knowledge.repository';
import { AuthorizationService } from '../../memberships/application/authorization.service';
import type { FieldEncryptionService } from '../../../common/security/field-encryption.service';
import { ConciergeService, type ConciergeStreamEvent } from './concierge.service';

describe('ConciergeService streaming', () => {
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
    const ai = {
      answerStream: vi.fn((_: unknown, onDelta: (delta: string) => void) => {
        onDelta('Doors open ');
        onDelta('at 08:00.');
        return Promise.resolve({
          answer: 'Doors open at 08:00.',
          usage: { outputTokens: 8 },
        });
      }),
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
      {} as EventKnowledgeRepository,
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
    expect(createMessage.mock.calls.at(-1)?.[0].data).toMatchObject({
      role: 'CONCIERGE',
      content: 'Doors open at 08:00.',
      status: 'COMPLETE',
    });
  });
});
