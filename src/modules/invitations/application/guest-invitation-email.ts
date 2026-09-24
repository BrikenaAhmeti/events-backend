import {
  buildEmail,
  type EmailBrand,
  type EmailContent,
} from '../../../infrastructure/email/email-template';

type GuestInvitationEmailInput = {
  brand: EmailBrand;
  companyName: string;
  guestName: string;
  eventName: string;
  eventDescription: string | null;
  venue: string | null;
  destination: string | null;
  startAt: Date | null;
  endAt: Date | null;
  timezone: string | null;
  personalDetails?: string | null;
  invitationUrl: string;
  qrPng: Buffer;
};

const formatDate = (value: Date, timezone: string | null): string => {
  const options: Intl.DateTimeFormatOptions = {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: timezone || 'UTC',
  };
  try {
    return `${new Intl.DateTimeFormat('en-GB', options).format(value)} (${options.timeZone})`;
  } catch {
    return `${new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC' }).format(value)} (UTC)`;
  }
};

export function buildGuestInvitationEmail(input: GuestInvitationEmailInput): EmailContent {
  const location = [
    ...new Set([input.venue, input.destination].filter((value) => value?.trim())),
  ].join(', ');
  return buildEmail({
    brand: input.brand,
    hostName: input.companyName,
    subject: `${input.companyName}: your invitation to ${input.eventName}`,
    preheader: `Your invitation to ${input.eventName}, with event details and personal concierge access.`,
    eyebrow: 'Your personal invitation',
    heading: input.eventName,
    greeting: input.guestName.trim() ? `Hello ${input.guestName.trim()},` : 'Hello,',
    paragraphs: [
      `${input.companyName} invites you to ${input.eventName}. We look forward to welcoming you.`,
      ...(input.eventDescription?.trim() ? [input.eventDescription] : []),
      `Your personal invitation gives you access to the event details and the ${input.brand.productName} guest concierge, where you can find answers about your visit.`,
    ],
    details: [
      { label: 'Hosted by', value: input.companyName },
      {
        label: 'Starts',
        value: input.startAt ? formatDate(input.startAt, input.timezone) : 'To be confirmed',
      },
      ...(input.endAt
        ? [{ label: 'Ends', value: formatDate(input.endAt, input.timezone) }]
        : []),
      { label: 'Location', value: location || 'To be confirmed' },
      ...(input.personalDetails?.trim()
        ? [{ label: 'Your arrangements', value: input.personalDetails.trim() }]
        : []),
    ],
    action: { label: 'Open event invitation', url: input.invitationUrl },
    afterAction:
      'Confirm your name and email when you open your invitation. You can ask the guest concierge about your event right away, until four hours after the event ends.',
    notice:
      'This secure link is personal. Please do not forward it. If you were not expecting this invitation, contact the organizer or ignore this email.',
    reason: `Sent for ${input.companyName} through ${input.brand.productName}. You received this email because the organizer added you to the guest list for ${input.eventName}.`,
    qr: { content: input.qrPng, eventName: input.eventName },
  });
}
