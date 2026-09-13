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
});
