export type EventExtractionCandidate = {
  reply?: string;
  event?: {
    name?: string;
    category?: string;
    description?: string;
    destination?: string;
    venue?: string;
    venueAddress?: string;
    venueDetails?: string;
    restroomInformation?: string;
    accessibilityInformation?: string;
    parkingInformation?: string;
    wifiInformation?: string;
    startAt?: string;
    endAt?: string;
    timezone?: string;
    organizerName?: string;
    organizerEmail?: string;
  };
  facts: Array<{ key: string; value: string; confidence: number }>;
  schedule: Array<{ title: string; startAt: string; endAt?: string; location?: string }>;
};

export type GroundedAnswerInput = {
  audience: 'SUPER_ADMIN' | 'CLIENT_ADMIN' | 'CLIENT_STAFF' | 'GUEST';
  question: string;
  eventName: string;
  timezone: string;
  structuredContext: string;
  untrustedDocumentContext: string;
  privateGuestContext?: string;
  requestId: string;
};

export abstract class AiProvider {
  abstract extractEventInformation(
    text: string,
    requestId: string,
  ): Promise<EventExtractionCandidate>;
  abstract answer(
    input: GroundedAnswerInput,
  ): Promise<{ answer: string; usage?: Record<string, number> }>;
  async answerStream(
    input: GroundedAnswerInput,
    onDelta: (delta: string) => void,
  ): Promise<{ answer: string; usage?: Record<string, number> }> {
    const response = await this.answer(input);
    onDelta(response.answer);
    return response;
  }
  abstract embed(texts: string[]): Promise<number[][]>;
}
