import { GuestImportService } from './guest-import.service';
import ExcelJS from 'exceljs';

const csv = (content: string): Express.Multer.File => {
  const buffer = Buffer.from(content);
  return {
    fieldname: 'file',
    originalname: 'guests.csv',
    encoding: '7bit',
    mimetype: 'text/csv',
    size: buffer.length,
    destination: '',
    filename: '',
    path: '',
    buffer,
    stream: null as never,
  };
};

describe('GuestImportService', () => {
  const service = new GuestImportService();

  it('maps common column aliases and normalizes emails', async () => {
    const preview = await service.preview(
      csv('Guest Name,E-mail,Organisation\nAvery Stone,AVERY@example.test,Juniper Works'),
    );
    expect(preview.summary).toEqual({ total: 1, valid: 1, invalid: 0, duplicates: 0 });
    expect(preview.validRows[0]).toMatchObject({
      fullName: 'Avery Stone',
      email: 'avery@example.test',
      company: 'Juniper Works',
    });
  });

  it('detects duplicate and invalid rows before confirmation', async () => {
    const preview = await service.preview(
      csv(
        'Name,Email\nAvery Stone,avery@example.test\nAvery Stone,avery@example.test\nMissing Email,invalid',
      ),
    );
    expect(preview.summary).toEqual({ total: 3, valid: 1, invalid: 1, duplicates: 1 });
  });

  it('parses a bounded XLSX guest list', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Guests').addRows([
      ['Name', 'Email'],
      ['Morgan Reed', 'morgan@example.test'],
    ]);
    const content = Buffer.from(await workbook.xlsx.writeBuffer());
    const preview = await service.preview({
      ...csv(''),
      originalname: 'guests.xlsx',
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: content.length,
      buffer: content,
    });
    expect(preview.validRows).toEqual([
      expect.objectContaining({ fullName: 'Morgan Reed', email: 'morgan@example.test' }),
    ]);
  });

  it('rejects oversized spreadsheets instead of silently dropping guests', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Guests');
    sheet.addRow(['Name', 'Email']);
    for (let index = 0; index < 5_001; index += 1)
      sheet.addRow([`Guest ${index}`, `guest${index}@example.test`]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    await expect(service.preview({
      ...csv(''), originalname: 'guests.xlsx', buffer, size: buffer.length,
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })).rejects.toMatchObject({ code: 'IMPORT_ROW_LIMIT_EXCEEDED' });
  });
});
