import type { CommandBus } from '@nestjs/cqrs';
import type { AuthenticatedActor } from '../../../common/types/request.types';
import type { PrismaService } from '../../../infrastructure/database/prisma.service';
import type { AiProvider } from '../../../infrastructure/openai/ai.provider';
import type { EventCompletenessService } from '../../events/domain/event-completeness.service';
import type { EventMutationPolicyService } from '../../events/domain/event-mutation-policy.service';
import { AuthorizationService } from '../../memberships/application/authorization.service';
import { OrganizerExtractionService } from './organizer-extraction.service';

describe('OrganizerExtractionService guest chat', () => {
  it('adds valid named guests, asks for missing emails, and keeps the result in the conversation', async () => {
    const actor: AuthenticatedActor = {
      userId: 'admin-a',
      supabaseUserId: 'identity-a',
      email: 'admin@example.test',
      firstName: 'Admin',
      lastName: 'User',
      platformRole: 'SUPER_ADMIN',
      memberships: [],
    };
    const event = { id: 'event-a', clientId: 'client-a', status: 'READY' };
    const createGuests = vi.fn().mockResolvedValue({ count: 2 });
    const createMessage = vi.fn().mockImplementation(({ data }) =>
      Promise.resolve({ id: 'message-a', ...data }),
    );
    const transaction = {
      scheduleItem: { findMany: vi.fn().mockResolvedValue([]) },
      guest: { createMany: createGuests },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-a' }) },
    };
    const prisma = {
      event: {
        findUnique: vi.fn().mockResolvedValue(event),
        findUniqueOrThrow: vi.fn().mockResolvedValue(event),
      },
      conversation: { findFirst: vi.fn().mockResolvedValue({ id: 'conversation-a' }) },
      conversationMessage: {
        create: createMessage,
        findMany: vi.fn().mockResolvedValue([]),
      },
      $transaction: vi.fn((work: (value: typeof transaction) => unknown) => work(transaction)),
    } as unknown as PrismaService;
    const ai = {
      extractEventInformation: vi.fn().mockResolvedValue({
        event: {}, facts: [], schedule: [],
        guests: [
          { fullName: 'Alex Morgan', email: 'alex@example.test' },
          { fullName: 'Sam Lee', email: 'sam@example.test' },
          { fullName: 'Taylor Reed', email: null },
        ],
      }),
    } as unknown as AiProvider;
    const service = new OrganizerExtractionService(
      ai,
      { execute: vi.fn() } as unknown as CommandBus,
      prisma,
      { assertMutable: vi.fn() } as unknown as EventMutationPolicyService,
      { evaluate: vi.fn().mockReturnValue({ ready: true, missing: [] }) } as unknown as EventCompletenessService,
      new AuthorizationService(),
    );

    const result = await service.extractAndApply(
      actor, event.id, 'Alex Morgan, alex@example.test; Sam Lee, sam@example.test; Taylor Reed',
      'request-a',
    );

    expect(createGuests).toHaveBeenCalledWith(expect.objectContaining({
      skipDuplicates: true,
      data: [
        expect.objectContaining({ normalizedEmail: 'alex@example.test' }),
        expect.objectContaining({ normalizedEmail: 'sam@example.test' }),
      ],
    }));
    expect(result.addedGuests).toBe(2);
    expect(result.message.content).toContain('Added 2 guests.');
    expect(result.message.content).toContain('email addresses for: Taylor Reed');
    expect(createMessage).toHaveBeenCalledTimes(2);
  });
});
