import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { Environment } from '../../common/config/environment';
import { ApplicationError } from '../../common/errors/application.error';
import { EmailProvider, type EmailMessage } from './email.provider';
import { emailSubject } from './email-template';

@Injectable()
export class SmtpEmailProvider extends EmailProvider {
  constructor(private readonly config: ConfigService<Environment, true>) {
    super();
  }

  async send(message: EmailMessage): Promise<{ id: string }> {
    const host = this.config.get('SMTP_HOST', { infer: true });
    const port = this.config.get('SMTP_PORT', { infer: true });
    const secure = this.config.get('SMTP_SECURE', { infer: true });
    const user = this.config.get('SMTP_USER', { infer: true });
    const password = this.config.get('SMTP_PASSWORD', { infer: true });
    const from = this.config.get('EMAIL_FROM', { infer: true });
    if (!host || !user || !password || !from) {
      throw new ApplicationError(503, 'EMAIL_UNAVAILABLE', 'Email is not configured.');
    }
    const messageId = createHash('sha256').update(message.idempotencyKey).digest('hex');
    const senderDomain = from.match(/@([^\s<>]+)>?\s*$/)?.[1];
    if (!senderDomain || !/^[a-z0-9.-]+$/i.test(senderDomain)) {
      throw new ApplicationError(503, 'EMAIL_UNAVAILABLE', 'Email sender is invalid.');
    }
    try {
      const result = await nodemailer
        .createTransport({
          host,
          port,
          secure,
          requireTLS: !secure,
          auth: { user, pass: password },
          connectionTimeout: 15_000,
          greetingTimeout: 15_000,
          socketTimeout: 30_000,
          tls: { minVersion: 'TLSv1.2' },
        })
        .sendMail({
          from,
          replyTo: this.config.get('EMAIL_REPLY_TO', { infer: true }) || from,
          to: message.to,
          subject: emailSubject(message.subject),
          html: message.html,
          text: message.text,
          attachments: message.attachments?.map((attachment) => ({
            filename: attachment.filename,
            content: attachment.content,
            contentType: attachment.contentType,
            cid: attachment.contentId,
            contentDisposition: attachment.contentId ? 'inline' : 'attachment',
          })),
          messageId: `<${messageId}@${senderDomain.toLowerCase()}>`,
        });
      return { id: result.messageId };
    } catch {
      throw new ApplicationError(502, 'EMAIL_SEND_FAILED', 'Email could not be sent.');
    }
  }
}
