export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
  attachments?: Array<{
    filename: string;
    contentType: string;
    content: Buffer;
    contentId?: string;
  }>;
};

export abstract class EmailProvider {
  abstract send(message: EmailMessage): Promise<{ id: string }>;
}
