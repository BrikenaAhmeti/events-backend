import { Injectable } from '@nestjs/common';

export type CompletenessEvent = {
  name: string | null;
  category: string | null;
  description: string | null;
  destination: string | null;
  venue: string | null;
  venueAddress?: string | null;
  venueDetails?: string | null;
  restroomInformation?: string | null;
  accessibilityInformation?: string | null;
  startAt: Date | null;
  endAt: Date | null;
  timezone: string | null;
  organizerName: string | null;
  organizerEmail: string | null;
};

export type EventCompleteness = {
  score: number;
  ready: boolean;
  missing: string[];
  warnings: string[];
  recommendations: string[];
};

@Injectable()
export class EventCompletenessService {
  evaluate(event: CompletenessEvent): EventCompleteness {
    const required: Array<[string, unknown]> = [
      ['name', event.name],
      ['category', event.category],
      ['description', event.description],
      ['location', event.destination || event.venue],
      ['startAt', event.startAt],
      ['endAt', event.endAt],
      ['timezone', event.timezone],
      ['organizerName', event.organizerName],
      ['organizerEmail', event.organizerEmail],
    ];
    const missing = required.filter(([, value]) => !value).map(([field]) => field);
    const warnings: string[] = [];
    if (event.startAt && event.endAt && event.endAt <= event.startAt)
      warnings.push('endBeforeStart');
    if (event.timezone && !this.isTimezone(event.timezone)) warnings.push('invalidTimezone');
    const valid = required.length - missing.length;
    return {
      score: Math.round((valid / required.length) * 100),
      ready: missing.length === 0 && warnings.length === 0,
      missing,
      warnings,
      recommendations: [
        ...(!event.venue ? ['Add a primary venue when it becomes available.'] : []),
        ...(event.venue && !event.venueAddress ? ['Add the full venue address.'] : []),
        ...(!event.venueDetails ? ['Add entrances, rooms, floors and internal wayfinding.'] : []),
        ...(!event.restroomInformation ? ['Add restroom locations and availability.'] : []),
        ...(!event.accessibilityInformation ? ['Add venue accessibility information.'] : []),
      ],
    };
  }

  private isTimezone(value: string): boolean {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }
}
