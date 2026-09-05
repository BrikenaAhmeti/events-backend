import { Injectable } from '@nestjs/common';
import { ApplicationError } from '../../../common/errors/application.error';
import { validateOfficeArchive } from '../../../common/security/office-archive-validation';

const MAX_SIZE = 20 * 1024 * 1024;

const formats: Record<string, { mime: string[]; signature: (buffer: Buffer) => boolean }> = {
  pdf: {
    mime: ['application/pdf'],
    signature: (buffer) => buffer.subarray(0, 5).toString() === '%PDF-',
  },
  docx: {
    mime: [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/octet-stream',
    ],
    signature: (buffer) => buffer[0] === 0x50 && buffer[1] === 0x4b,
  },
  xlsx: {
    mime: [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/octet-stream',
    ],
    signature: (buffer) => buffer[0] === 0x50 && buffer[1] === 0x4b,
  },
  csv: {
    mime: ['text/csv', 'text/plain', 'application/csv', 'application/vnd.ms-excel'],
    signature: (buffer) => !buffer.subarray(0, 512).includes(0),
  },
  txt: { mime: ['text/plain'], signature: (buffer) => !buffer.subarray(0, 512).includes(0) },
};

@Injectable()
export class FileValidationService {
  validate(file: Express.Multer.File): string {
    if (!file) throw new ApplicationError(400, 'FILE_REQUIRED', 'Choose a file to upload.');
    if (file.size <= 0 || file.size > MAX_SIZE)
      throw new ApplicationError(400, 'FILE_TOO_LARGE', 'Files must be 20 MB or smaller.');
    const extension = file.originalname.toLowerCase().split('.').at(-1) ?? '';
    const format = formats[extension];
    if (!format)
      throw new ApplicationError(
        400,
        'UNSUPPORTED_FILE_TYPE',
        'Supported formats are PDF, DOCX, TXT, CSV and XLSX.',
      );
    if (!format.mime.includes(file.mimetype))
      throw new ApplicationError(
        400,
        'INVALID_MIME_TYPE',
        'The file content type does not match its format.',
      );
    if (!format.signature(file.buffer))
      throw new ApplicationError(400, 'INVALID_FILE_SIGNATURE', 'The uploaded file is invalid.');
    if (extension === 'docx' || extension === 'xlsx') validateOfficeArchive(file.buffer);
    return extension;
  }
}
