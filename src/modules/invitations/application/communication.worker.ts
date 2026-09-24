import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PinoLogger } from 'nestjs-pino';
import type { Environment } from '../../../common/config/environment';
import { FieldEncryptionService } from '../../../common/security/field-encryption.service';
import { TokenService } from '../../../common/security/token.service';
import { EmailProvider } from '../../../infrastructure/email/email.provider';
import { buildStaffInvitationEmail } from '../../../infrastructure/email/account-emails';
import { emailBrand } from '../../../infrastructure/email/email-template';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { JobQueue } from '../../../infrastructure/jobs/job-queue';
import { EventGateway } from '../../../infrastructure/websocket/event.gateway';
import { SupabaseAuthProvider } from '../../auth/infrastructure/supabase-auth.provider';
import { QrCodeService } from './qr-code.service';
import { buildGuestInvitationEmail } from './guest-invitation-email';

@Injectable()
export class CommunicationWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly workerId = `communications-${randomUUID()}`;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobQueue,
    private readonly tokens: TokenService,
    private readonly encryption: FieldEncryptionService,
    private readonly email: EmailProvider,
    private readonly auth: SupabaseAuthProvider,
    private readonly config: ConfigService<Environment, true>,
    private readonly gateway: EventGateway,
    private readonly logger: PinoLogger,
    private readonly qr: QrCodeService,
  ) {}

  onModuleInit(): void {
    if (process.env.VERCEL) return;
    this.timer = setInterval(() => void this.tick(), 3_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      const invitation = await this.jobs.claim('INVITATION_SEND', this.workerId);
      const job = invitation ?? (await this.jobs.claim('STAFF_INVITATION_EMAIL', this.workerId));
      if (!job) return false;
      try {
        if (job.type === 'INVITATION_SEND')
          await this.sendGuestInvitation(job.payload as { invitationId?: string });
        else
          await this.sendStaffInvitation(
            job.payload as { membershipId?: string; clientId?: string; email?: string },
          );
        await this.jobs.complete(job.id);
      } catch (error) {
        await this.jobs.fail(job, error);
        if (job.type === 'INVITATION_SEND') {
          const payload = job.payload as { invitationId?: string };
          if (payload.invitationId) {
            const exhausted = job.attempts >= job.maxAttempts;
            await this.prisma.invitation.updateMany({
              where: { id: payload.invitationId, status: { not: 'REVOKED' } },
              data: {
                status: exhausted ? 'FAILED' : 'QUEUED',
                failureCode: error instanceof Error ? error.name : 'EmailFailed',
                ...(exhausted ? { tokenHash: null, tokenEncrypted: null } : {}),
              },
            });
            if (job.eventId)
              this.gateway.emitEvent(job.eventId, 'invitation:progress', {
                invitationId: payload.invitationId,
                status: exhausted ? 'FAILED' : 'QUEUED',
              });
          }
        }
        this.logger.warn({
          operation: 'communications.send',
          jobId: job.id,
          error: error instanceof Error ? error.name : 'UnknownError',
        });
      }
      return true;
    } finally {
      this.running = false;
    }
  }

  private async sendGuestInvitation(payload: { invitationId?: string }): Promise<void> {
    if (!payload.invitationId) throw new Error('InvalidInvitationJob');
    const invitation = await this.prisma.invitation.findUnique({
      where: { id: payload.invitationId },
      include: { guest: true, event: { include: { client: { select: { name: true } } } } },
    });
    if (!invitation?.guest || invitation.status === 'REVOKED' || invitation.sentAt) return;
    if (invitation.event.status !== 'PUBLISHED' || !invitation.expiresAt || invitation.expiresAt <= new Date()) {
      await this.prisma.invitation.update({
        where: { id: invitation.id },
        data: { status: 'REVOKED', revokedAt: new Date(), tokenHash: null, tokenEncrypted: null },
      });
      return;
    }
    const issued = invitation.tokenEncrypted
      ? {
          raw: this.encryption.decrypt(invitation.tokenEncrypted),
          hash: invitation.tokenHash,
        }
      : this.tokens.issue();
    if (!issued.raw || !issued.hash) throw new Error('InvitationTokenUnavailable');
    if (!invitation.tokenEncrypted) {
      await this.prisma.invitation.update({
        where: { id: invitation.id },
        data: { tokenHash: issued.hash, tokenEncrypted: this.encryption.encrypt(issued.raw) },
      });
    }
    const url = `${this.config.get('PUBLIC_APP_URL', { infer: true })}/i/${issued.raw}`;
    const qrPng = await this.qr.toPng(url);
    await this.email.send({
      to: invitation.guest.email,
      ...buildGuestInvitationEmail({
        brand: emailBrand(this.config),
        companyName: invitation.event.client.name,
        guestName: invitation.guest.fullName,
        eventName: invitation.event.name,
        eventDescription: invitation.event.description,
        venue: invitation.event.venue,
        destination: invitation.event.destination,
        startAt: invitation.event.startAt,
        endAt: invitation.event.endAt,
        timezone: invitation.event.timezone,
        personalDetails: this.encryption.decrypt(invitation.guest.notesEncrypted),
        invitationUrl: url,
        qrPng,
      }),
      idempotencyKey: `invitation-${invitation.id}`,
    });
    await this.prisma.invitation.update({
      where: { id: invitation.id },
      data: { status: 'SENT', sentAt: new Date(), tokenEncrypted: null, failureCode: null },
    });
    this.gateway.emitEvent(invitation.eventId, 'invitation:progress', {
      invitationId: invitation.id,
      status: 'SENT',
    });
  }

  private async sendStaffInvitation(payload: {
    membershipId?: string;
    clientId?: string;
    email?: string;
  }): Promise<void> {
    const membership = payload.membershipId
      ? await this.prisma.clientMembership.findUnique({
          where: { id: payload.membershipId },
          include: { user: true, client: true },
        })
      : payload.clientId && payload.email
        ? await this.prisma.clientMembership.findFirst({
            where: { clientId: payload.clientId, user: { email: payload.email } },
            include: { user: true, client: true },
          })
        : null;
    if (!membership || membership.status !== 'INVITED') return;
    const tokenHash = await this.auth.inviteUser(
      membership.user.email,
      `${this.config.get('PUBLIC_APP_URL', { infer: true })}/activate`,
      { clientId: membership.clientId },
    );
    const actionLink = `${this.config.get('PUBLIC_APP_URL', { infer: true })}/activate?token_hash=${encodeURIComponent(tokenHash)}`;
    await this.email.send({
      to: membership.user.email,
      ...buildStaffInvitationEmail({
        brand: emailBrand(this.config),
        firstName: membership.user.firstName,
        companyName: membership.client.name,
        invitationUrl: actionLink,
      }),
      idempotencyKey: `staff-${membership.id}-${membership.invitedAt?.getTime() ?? 0}`,
    });
  }
}
