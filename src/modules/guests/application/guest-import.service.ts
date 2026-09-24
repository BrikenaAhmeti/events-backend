import { Injectable } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from '../../../common/config/upload-limits';
import { ApplicationError } from '../../../common/errors/application.error';
import { validateOfficeArchive } from '../../../common/security/office-archive-validation';
import { guestSchema, type GuestInput } from './guest.contracts';

const MAX_ROWS = 5_000;

const headingAliases: Record<string, keyof GuestInput> = {
  fullname: 'fullName',
  name: 'fullName',
  guestname: 'fullName',
  firstname: 'firstName',
  givenname: 'firstName',
  lastname: 'lastName',
  surname: 'lastName',
  email: 'email',
  emailaddress: 'email',
  e_mail: 'email',
  company: 'company',
  organisation: 'company',
  organization: 'company',
  jobtitle: 'jobTitle',
  title: 'jobTitle',
  phone: 'phone',
  telephone: 'phone',
  group: 'guestGroup',
  guestgroup: 'guestGroup',
  notes: 'notes',
  dietary: 'dietaryInformation',
  dietaryinformation: 'dietaryInformation',
  accessibility: 'accessibilityInformation',
  accessibilityinformation: 'accessibilityInformation',
  accommodation: 'accommodation',
  hotel: 'accommodation',
  travel: 'travelInformation',
  flight: 'travelInformation',
};

export type GuestImportPreview = {
  mapping: Record<string, string | null>;
  rows: Array<{
    row: number;
    values: Record<string, string>;
    data: Partial<GuestInput>;
    errors: string[];
    duplicate: boolean;
  }>;
  validRows: GuestInput[];
  invalidRows: Array<{ row: number; values: Record<string, string>; errors: string[] }>;
  duplicates: Array<{ row: number; email: string }>;
  summary: { total: number; valid: number; invalid: number; duplicates: number };
};

@Injectable()
export class GuestImportService {
  async preview(file: Express.Multer.File): Promise<GuestImportPreview> {
    this.validateFile(file);
    const records = file.originalname.toLowerCase().endsWith('.csv')
      ? this.parseCsv(file.buffer)
      : await this.parseWorkbook(file.buffer);
    if (records.length > MAX_ROWS)
      throw new ApplicationError(
        400,
        'IMPORT_ROW_LIMIT_EXCEEDED',
        `Guest imports are limited to ${MAX_ROWS} rows.`,
      );
    return this.mapRecords(records);
  }

  private validateFile(file: Express.Multer.File): void {
    if (file.size > MAX_UPLOAD_BYTES)
      throw new ApplicationError(
        400,
        'FILE_TOO_LARGE',
        `Guest list files must be ${MAX_UPLOAD_LABEL} or smaller.`,
      );
    const extension = file.originalname.toLowerCase().split('.').at(-1);
    if (!extension || !['csv', 'xlsx'].includes(extension))
      throw new ApplicationError(400, 'UNSUPPORTED_FILE_TYPE', 'Upload a CSV or XLSX guest list.');
    if (extension === 'xlsx' && !(file.buffer[0] === 0x50 && file.buffer[1] === 0x4b))
      throw new ApplicationError(400, 'INVALID_FILE_SIGNATURE', 'The spreadsheet file is invalid.');
    if (extension === 'xlsx') validateOfficeArchive(file.buffer);
    const allowedMime =
      extension === 'csv'
        ? ['text/csv', 'text/plain', 'application/csv', 'application/vnd.ms-excel']
        : [
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/octet-stream',
          ];
    if (!allowedMime.includes(file.mimetype))
      throw new ApplicationError(
        400,
        'INVALID_MIME_TYPE',
        'The file content type does not match its format.',
      );
  }

  private parseCsv(buffer: Buffer): Record<string, string>[] {
    try {
      return parse(buffer, {
        columns: true,
        skip_empty_lines: true,
        bom: true,
        trim: true,
        relax_column_count: false,
      });
    } catch {
      throw new ApplicationError(400, 'MALFORMED_SPREADSHEET', 'The CSV file could not be read.');
    }
  }

  private async parseWorkbook(buffer: Buffer): Promise<Record<string, string>[]> {
    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
      const sheet = workbook.worksheets[0];
      if (!sheet || sheet.actualRowCount === 0) return [];
      const headers: string[] = [];
      sheet.getRow(1).eachCell({ includeEmpty: true }, (cell) => headers.push(cell.text.trim()));
      const rows: Record<string, string>[] = [];
      sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1 || rows.length > MAX_ROWS) return;
        const values: string[] = [];
        row.eachCell({ includeEmpty: true }, (cell) => values.push(cell.text.trim()));
        const record = Object.fromEntries(
          headers.map((header, index) => [header, values[index] ?? '']),
        );
        if (Object.values(record).some(Boolean)) rows.push(record);
      });
      return rows;
    } catch {
      throw new ApplicationError(400, 'MALFORMED_SPREADSHEET', 'The XLSX file could not be read.');
    }
  }

  private mapRecords(records: Record<string, string>[]): GuestImportPreview {
    const sourceHeaders = Object.keys(records[0] ?? {});
    const mapping = Object.fromEntries(
      sourceHeaders.map((header) => [
        header,
        headingAliases[this.normalizeHeading(header)] ?? null,
      ]),
    );
    const validRows: GuestInput[] = [];
    const rows: GuestImportPreview['rows'] = [];
    const invalidRows: GuestImportPreview['invalidRows'] = [];
    const duplicates: GuestImportPreview['duplicates'] = [];
    const seen = new Set<string>();
    records.forEach((record, index) => {
      const mapped = Object.fromEntries(
        Object.entries(record).flatMap(([key, value]) =>
          mapping[key] ? [[mapping[key], value]] : [],
        ),
      );
      const result = guestSchema.safeParse(mapped);
      if (!result.success) {
        const errors = result.error.issues.map(({ message }) => message);
        invalidRows.push({
          row: index + 2,
          values: record,
          errors,
        });
        rows.push({ row: index + 2, values: record, data: mapped, errors, duplicate: false });
        return;
      }
      if (seen.has(result.data.email)) {
        duplicates.push({ row: index + 2, email: result.data.email });
        rows.push({ row: index + 2, values: record, data: result.data, errors: [], duplicate: true });
      } else {
        seen.add(result.data.email);
        validRows.push(result.data);
        rows.push({ row: index + 2, values: record, data: result.data, errors: [], duplicate: false });
      }
    });
    return {
      mapping,
      rows,
      validRows,
      invalidRows,
      duplicates,
      summary: {
        total: records.length,
        valid: validRows.length,
        invalid: invalidRows.length,
        duplicates: duplicates.length,
      },
    };
  }

  private normalizeHeading(value: string): string {
    return value
      .toLowerCase()
      .trim()
      .replace(/[-\s.]+/g, '')
      .replace(/[^a-z0-9_]/g, '');
  }
}
