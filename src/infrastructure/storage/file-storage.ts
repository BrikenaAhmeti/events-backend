export type StoredFile = { objectKey: string; bucket: string };

export abstract class FileStorage {
  abstract upload(objectKey: string, content: Buffer, mimeType: string): Promise<StoredFile>;
  abstract download(objectKey: string): Promise<Buffer>;
  abstract delete(objectKey: string): Promise<void>;
  abstract exists(objectKey: string): Promise<boolean>;
  abstract createSignedDownloadUrl(objectKey: string, expiresInSeconds: number): Promise<string>;
}
