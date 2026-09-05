import type { MembershipRole, MembershipStatus, PlatformRole } from '@prisma/client';
import type { Request } from 'express';

export type ActorMembership = {
  clientId: string;
  role: MembershipRole;
  status: MembershipStatus;
  permissions: string[];
};

export type AuthenticatedActor = {
  userId: string;
  supabaseUserId: string;
  email: string;
  firstName: string;
  lastName: string;
  platformRole: PlatformRole | null;
  memberships: ActorMembership[];
};

export type GuestActor = {
  sessionId: string;
  guestId: string;
  eventId: string;
};

export type RequestContext = Request & {
  actor?: AuthenticatedActor;
  guestActor?: GuestActor;
  requestId: string;
};
