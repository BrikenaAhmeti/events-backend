import { FileValidationService } from './file-validation.service';
import { MAX_UPLOAD_BYTES } from '../../../common/config/upload-limits';

const file = (name: string, mimetype: string, buffer: Buffer): Express.Multer.File => ({
  fieldname: 'file',
  originalname: name,
  encoding: '7bit',
  mimetype,
  size: buffer.length,
  destination: '',
  filename: '',
  path: '',
  buffer,
  stream: null as never,
});

describe('FileValidationService', () => {
  const service = new FileValidationService();

  it('accepts a PDF only when extension, MIME and signature agree', () => {
    expect(service.validate(file('program.pdf', 'application/pdf', Buffer.from('%PDF-1.7')))).toBe(
      'pdf',
    );
  });

  it('rejects executable content disguised as a PDF', () => {
    expect(() =>
      service.validate(file('program.pdf', 'application/pdf', Buffer.from('MZ executable'))),
    ).toThrow('invalid');
  });

  it('rejects files above the deployed upload limit', () => {
    const oversized = file('program.pdf', 'application/pdf', Buffer.from('%PDF-1.7'));
    oversized.size = MAX_UPLOAD_BYTES + 1;
    expect(() => service.validate(oversized)).toThrow('Files must be 20 MB or smaller.');
  });

  it('rejects unsupported extensions', () => {
    expect(() =>
      service.validate(file('program.exe', 'application/octet-stream', Buffer.from('MZ'))),
    ).toThrow('Supported formats');
  });

  it('rejects a ZIP signature that is not a valid Office archive', () => {
    expect(() =>
      service.validate(
        file(
          'attendees.xlsx',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          Buffer.from('PK malformed'),
        ),
      ),
    ).toThrow('archive');
  });
});
