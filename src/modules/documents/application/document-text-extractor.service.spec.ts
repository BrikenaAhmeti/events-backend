import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { DocumentTextExtractorService } from './document-text-extractor.service';

describe('DocumentTextExtractorService', () => {
  const extractor = new DocumentTextExtractorService();

  it('keeps spreadsheet cell positions and date values beside their labels', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Event brief');
    sheet.addRow(['Organizator', 'Email', 'Data e ngjarjes', 'Ora']);
    sheet.addRow(['Arta Krasniqi', 'arta@example.test', new Date('2027-10-14T00:00:00.000Z'), '09:30']);
    const result = await extractor.extract(
      'xlsx', Buffer.from(await workbook.xlsx.writeBuffer()),
    );
    expect(result.text).toContain('A1: Organizator | B1: Email');
    expect(result.text).toContain('A2: Arta Krasniqi | B2: arta@example.test');
    expect(result.text).toContain('C2: 2027-10-14T00:00:00.000Z | D2: 09:30');
  });

  it('reads UTF-16 event briefs without losing non-English text', async () => {
    const result = await extractor.extract(
      'txt', Buffer.from('\uFEFFOrganizator: Arta Krasniqi', 'utf16le'),
    );
    expect(result.text).toBe('Organizator: Arta Krasniqi');
  });
});
