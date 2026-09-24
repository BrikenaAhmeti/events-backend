import type { ConfigService } from '@nestjs/config';
import type { Environment } from '../../common/config/environment';
import type { GroundedAnswerInput } from './ai.provider';
import { conciergeAudienceInstructions, OpenAiProvider } from './openai.provider';

const openAi = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('openai', () => ({
  default: class {
    responses = { create: openAi.create };
  },
}));

describe('Concierge audience instructions', () => {
  it.each([
    ['SUPER_ADMIN', 'platform administrator'],
    ['CLIENT_ADMIN', 'client administrator'],
    ['CLIENT_STAFF', 'client staff member'],
    ['GUEST', 'authenticated event guest'],
  ] as const)('defines a constrained prompt for %s', (audience, expectedContext) => {
    const instructions = conciergeAudienceInstructions(audience);
    expect(instructions).toContain(expectedContext);
    expect(instructions).toMatch(/supplied|published/);
  });
});

describe('OpenAiProvider streaming', () => {
  it('forwards response deltas immediately and returns usage', async () => {
    async function* events() {
      await Promise.resolve();
      yield { type: 'response.output_text.delta', delta: 'Welcome ' };
      yield { type: 'response.output_text.delta', delta: 'to Feliam.' };
      yield {
        type: 'response.completed',
        response: { usage: { input_tokens: 21, output_tokens: 5 } },
      };
    }
    openAi.create.mockResolvedValueOnce(events());
    const values: Record<string, string> = {
      OPENAI_API_KEY: 'test-key',
      OPENAI_MODEL: 'test-model',
      PRODUCT_NAME: 'Feliam',
    };
    const config = {
      get: (key: string) => values[key],
    } as unknown as ConfigService<Environment, true>;
    const provider = new OpenAiProvider(config);
    const input: GroundedAnswerInput = {
      audience: 'GUEST',
      question: 'Where should I go?',
      eventName: 'Leadership Forum',
      timezone: 'Europe/Lisbon',
      structuredContext: 'Venue: Riverside Hall',
      untrustedDocumentContext: '',
      recentMessages: [
        { role: 'user', content: 'Where is registration?' },
        { role: 'assistant', content: 'Registration is at Riverside Hall.' },
      ],
      requestId: 'request-a',
    };
    const deltas: string[] = [];

    const result = await provider.answerStream(input, (delta) => deltas.push(delta));

    expect(deltas).toEqual(['Welcome ', 'to Feliam.']);
    expect(result).toEqual({
      answer: 'Welcome to Feliam.',
      usage: { inputTokens: 21, outputTokens: 5 },
    });
    expect(openAi.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'test-model', stream: true }),
      expect.objectContaining({ headers: { 'X-Client-Request-Id': 'request-a' } }),
    );
    const request = openAi.create.mock.calls.at(-1)?.[0] as unknown as {
      input: Array<{ role: string; content: string }>;
    };
    expect(request.input[0]?.content).toContain('Answer only questions that are relevant');
    expect(request.input.slice(-3)).toEqual([
      ...(input.recentMessages ?? []), { role: 'user', content: input.question },
    ]);
    expect(request.input[0]?.content).toContain(
      'General guidance — not confirmed by the event creator:',
    );
  });
});

describe('OpenAiProvider event setup', () => {
  it('returns a structured conversational reply with the extracted event details', async () => {
    openAi.create.mockClear();
    openAi.create.mockResolvedValueOnce({
      output_text: JSON.stringify({
        reply: 'I captured the venue. What dates should I add?',
        event: null,
        facts: [],
        schedule: [],
        guests: [{ fullName: 'Alex Morgan', email: 'alex@example.test', company: null,
          guestGroup: null, notes: 'Seat B12' }],
      }),
    });
    const values: Record<string, string> = {
      OPENAI_API_KEY: 'test-key',
      OPENAI_MODEL: 'test-model',
      PRODUCT_NAME: 'Feliam',
    };
    const config = {
      get: (key: string) => values[key],
    } as unknown as ConfigService<Environment, true>;
    const provider = new OpenAiProvider(config);

    const result = await provider.extractEventInformation('The venue is Riverside Hall.', 'request-a');

    expect(result.reply).toBe('I captured the venue. What dates should I add?');
    expect(result.guests?.[0]).toMatchObject({ fullName: 'Alex Morgan', notes: 'Seat B12' });
    const request = openAi.create.mock.calls[0]?.[0] as unknown as {
      model: string;
      text: { format: { type: string; strict: boolean } };
    };
    const options = openAi.create.mock.calls[0]?.[1] as unknown as {
      headers: Record<string, string>;
    };
    expect(request.model).toBe('test-model');
    expect(request.text.format).toMatchObject({ type: 'json_schema', strict: true });
    expect(options.headers).toEqual({ 'X-Client-Request-Id': 'request-a' });
  });

  it('keeps valid event details when extracted dates lack times and offsets', async () => {
    openAi.create.mockResolvedValueOnce({
      output_text: JSON.stringify({
        reply: 'I captured the conference details.',
        event: {
          name: 'Europe Dev Conference',
          category: 'CONFERENCE',
          destination: 'Rome',
          startAt: '2026-09-22',
          endAt: '2026-09-23',
          startDate: '2026-09-22',
          endDate: '2026-09-23',
          organizerName: 'Alex Morgan',
          organizerEmail: 'alex@example.com',
        },
        facts: [],
        schedule: [],
        guests: [],
      }),
    });
    const config = {
      get: (key: string) => ({ OPENAI_API_KEY: 'test-key', OPENAI_MODEL: 'test-model' })[key],
    } as unknown as ConfigService<Environment, true>;
    const provider = new OpenAiProvider(config);

    const result = await provider.extractEventInformation(
      'Europe Dev Conference, 22 September to 23 September 2026, Rome, Alex Morgan',
      'request-date-only',
    );

    expect(result.event).toMatchObject({
      name: 'Europe Dev Conference',
      category: 'CONFERENCE',
      destination: 'Rome',
      organizerName: 'Alex Morgan',
      organizerEmail: 'alex@example.com',
    });
    expect(result.event?.startAt).toBeUndefined();
    expect(result.event?.endAt).toBeUndefined();
    expect(result.event?.startDate).toBe('2026-09-22');
    expect(result.event?.endDate).toBe('2026-09-23');
  });

  it('normalizes complete offset datetimes to the UTC format used by event details', async () => {
    openAi.create.mockResolvedValueOnce({
      output_text: JSON.stringify({
        reply: 'I captured the times.',
        event: {
          startAt: '2026-09-22T09:00:00+02:00',
          endAt: '2026-09-23T18:00:00+02:00',
        },
        facts: [],
        schedule: [],
        guests: [],
      }),
    });
    const config = {
      get: (key: string) => ({ OPENAI_API_KEY: 'test-key', OPENAI_MODEL: 'test-model' })[key],
    } as unknown as ConfigService<Environment, true>;
    const provider = new OpenAiProvider(config);

    const result = await provider.extractEventInformation(
      '22 September at 9am until 23 September at 6pm in Rome',
      'request-offset',
    );

    expect(result.event?.startAt).toBe('2026-09-22T07:00:00.000Z');
    expect(result.event?.endAt).toBe('2026-09-23T16:00:00.000Z');
  });

  it('reports malformed model output as an extraction failure rather than bad user input', async () => {
    openAi.create.mockResolvedValueOnce({ output_text: '{invalid-json' });
    const config = {
      get: (key: string) => ({ OPENAI_API_KEY: 'test-key', OPENAI_MODEL: 'test-model' })[key],
    } as unknown as ConfigService<Environment, true>;
    const provider = new OpenAiProvider(config);

    await expect(provider.extractEventInformation('A conference in Rome', 'request-invalid'))
      .rejects.toMatchObject({ statusCode: 502, code: 'EVENT_EXTRACTION_FAILED' });
  });
});
