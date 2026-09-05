import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import type { Environment } from '../../common/config/environment';
import { ApplicationError } from '../../common/errors/application.error';
import { EmailProvider, type EmailMessage } from './email.provider';

@Injectable()
export class ResendEmailProvider extends EmailProvider {
  constructor(private readonly config: ConfigService<Environment, true>) {
    super();
  }

  async send(message: EmailMessage): Promise<{ id: string }> {
    const apiKey = this.config.get('RESEND_API_KEY', { infer: true });
    const from = this.config.get('EMAIL_FROM', { infer: true });
    if (!apiKey || !from)
      throw new ApplicationError(503, 'EMAIL_UNAVAILABLE', 'Email is not configured.');
    const result = await new Resend(apiKey).emails.send(
      {
        from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        attachments: message.attachments?.map((attachment) => ({
          filename: attachment.filename,
          content: attachment.content,
          contentType: attachment.contentType,
          contentId: attachment.contentId,
        })),
      },
      { idempotencyKey: message.idempotencyKey },
    );
    if (result.error || !result.data)
      throw new ApplicationError(502, 'EMAIL_SEND_FAILED', 'Email could not be sent.');
    return { id: result.data.id };
  }
}
