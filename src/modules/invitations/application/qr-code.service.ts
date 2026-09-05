import { Injectable } from '@nestjs/common';
import QRCode from 'qrcode';

@Injectable()
export class QrCodeService {
  toSvg(url: string): Promise<string> {
    return QRCode.toString(url, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 2,
      color: { dark: '#16292B', light: '#F5F2EC' },
    });
  }

  toPng(url: string): Promise<Buffer> {
    return QRCode.toBuffer(url, {
      type: 'png',
      width: 560,
      errorCorrectionLevel: 'H',
      margin: 3,
      color: { dark: '#16292B', light: '#F5F2EC' },
    });
  }
}
