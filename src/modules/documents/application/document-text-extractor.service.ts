import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';
import { ApplicationError } from '../../../common/errors/application.error';

@Injectable()
export class DocumentTextExtractorService {
  async extract(
    extension: string,
    content: Buffer,
  ): Promise<{ text: string; metadata: Record<string, number | string> }> {
    if (extension === 'txt' || extension === 'csv') return this.plain(content);
    if (extension === 'docx') return this.docx(content);
    if (extension === 'xlsx') return this.xlsx(content);
    if (extension === 'pdf') return this.pdf(content);
    throw new ApplicationError(400, 'UNSUPPORTED_FILE_TYPE', 'The document cannot be processed.');
  }

  chunks(text: string, size = 1_200, overlap = 160): string[] {
    const normalized = text.replace(/\0/g, '').replace(/\s+/g, ' ').trim();
    const chunks: string[] = [];
    for (let start = 0; start < normalized.length && chunks.length < 500; start += size - overlap) {
      chunks.push(normalized.slice(start, start + size));
    }
    return chunks.filter((chunk) => chunk.length >= 30);
  }

  private plain(content: Buffer) {
    const text = content.toString('utf8').slice(0, 1_000_000);
    return { text, metadata: { characters: text.length } };
  }

  private async docx(content: Buffer) {
    const result = await mammoth.extractRawText({ buffer: content });
    const text = result.value.slice(0, 1_000_000);
    return { text, metadata: { characters: text.length, warnings: result.messages.length } };
  }

  private async xlsx(content: Buffer) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(content as unknown as ExcelJS.Buffer);
    if (workbook.worksheets.reduce((sum, sheet) => sum + sheet.actualRowCount, 0) > 20_000) {
      throw new ApplicationError(
        400,
        'DOCUMENT_ROW_LIMIT_EXCEEDED',
        'The workbook contains too many rows.',
      );
    }
    const lines: string[] = [];
    workbook.eachSheet((sheet) => {
      lines.push(`Sheet: ${sheet.name}`);
      sheet.eachRow((row) => {
        const values: string[] = [];
        row.eachCell({ includeEmpty: true }, (cell) => values.push(cell.text));
        lines.push(values.join(' | '));
      });
    });
    const text = lines.join('\n').slice(0, 1_000_000);
    return { text, metadata: { characters: text.length, sheets: workbook.worksheets.length } };
  }

  private async pdf(content: Buffer) {
    const document = await getDocumentProxy(new Uint8Array(content));
    if (document.numPages > 300)
      throw new ApplicationError(
        400,
        'DOCUMENT_PAGE_LIMIT_EXCEEDED',
        'PDF files are limited to 300 pages.',
      );
    const result = await extractText(document, { mergePages: true });
    const text = String(result.text).slice(0, 1_000_000);
    return { text, metadata: { characters: text.length, pages: document.numPages } };
  }
}
