import { Injectable, Logger } from '@nestjs/common';
import { PDFDocument, StandardFonts, rgb, PDFImage, PDFPage } from 'pdf-lib';
import { SignatureAnchor } from './schemas/document-template.schema';

/**
 * One signature to burn into the document. Position is given as normalized
 * CENTER coordinates (0..1 from the page's top-left) so it's resolution- and
 * scale-independent between the browser preview and the PDF. `widthNorm` is the
 * signature box width as a fraction of the page width. When xNorm/yNorm are
 * omitted we fall back to the legacy `anchor` (bottom corner).
 */
export interface SignaturePlacement {
  /** 1-based target page; 0/undefined = last page. */
  page?: number;
  xNorm?: number;
  yNorm?: number;
  widthNorm?: number;
  signaturePng: Buffer;
  anchor?: SignatureAnchor;
}

export interface StampSignaturesOpts {
  sourceBytes: Buffer;
  /** application/pdf | image/png | image/jpeg */
  sourceMime: string;
  placements: SignaturePlacement[];
  signerName: string;
  signedAt: Date;
}

/**
 * Burns one or more captured finger-signatures into a document, producing a
 * signed PDF. Supports multiple signatures across multiple pages, each placed at
 * an arbitrary position the signer chose.
 *  • PDF source  → load it, stamp on each placement's page.
 *  • Image source → wrap the image into a one-page PDF, then stamp.
 * Output is always a PDF Buffer (the caller uploads it via StorageService).
 */
@Injectable()
export class PdfStampService {
  private readonly logger = new Logger(PdfStampService.name);

  private readonly DEFAULT_WIDTH_NORM = 0.25; // 25% of page width
  private readonly MARGIN = 36; // 0.5in, for the legacy anchor fallback
  private readonly CAPTION_SIZE = 7;

  async stampSignatures(opts: StampSignaturesOpts): Promise<Buffer> {
    const { sourceBytes, sourceMime, signerName, signedAt } = opts;
    const placements = opts.placements?.length ? opts.placements : [];
    if (!placements.length) throw new Error('stampSignatures: no placements');

    const pdf = await this.loadAsPdf(sourceBytes, sourceMime);
    const pages = pdf.getPages();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const caption = `${signerName || 'Signed'} · ${signedAt.toLocaleString()}`;

    for (const p of placements) {
      const page = pages[this.resolvePageIndex(p.page, pages.length)];
      const { width: pageW, height: pageH } = page.getSize();

      let sig: PDFImage;
      try {
        sig = await pdf.embedPng(p.signaturePng);
      } catch (err) {
        this.logger.error(`embedPng failed: ${err instanceof Error ? err.message : err}`);
        throw err;
      }

      const boxW = Math.max(40, (p.widthNorm ?? this.DEFAULT_WIDTH_NORM) * pageW);
      const scaled = sig.scale(boxW / sig.width);
      const boxH = scaled.height;

      // Position: explicit normalized center, else legacy bottom anchor.
      let x: number;
      let yBottom: number; // pdf-lib origin is bottom-left
      if (typeof p.xNorm === 'number' && typeof p.yNorm === 'number') {
        const centerX = p.xNorm * pageW;
        const centerYFromTop = p.yNorm * pageH;
        x = this.clamp(centerX - boxW / 2, 0, Math.max(0, pageW - boxW));
        const topY = pageH - centerYFromTop; // flip to bottom-left origin (center)
        yBottom = this.clamp(topY - boxH / 2, 0, Math.max(0, pageH - boxH - this.CAPTION_SIZE - 4));
      } else {
        const anchored = this.anchorXY(page, p.anchor ?? SignatureAnchor.BOTTOM_RIGHT, boxW);
        x = anchored.x;
        yBottom = anchored.y + this.CAPTION_SIZE + 4;
      }

      page.drawImage(sig, { x, y: yBottom, width: boxW, height: boxH });
      // Small caption beneath each signature (signer + timestamp).
      page.drawText(caption, {
        x,
        y: Math.max(2, yBottom - this.CAPTION_SIZE - 2),
        size: this.CAPTION_SIZE,
        font,
        color: rgb(0.35, 0.35, 0.35),
      });
    }

    const out = await pdf.save();
    return Buffer.from(out);
  }

  /** PDF passthrough; image → single-page PDF sized to the image. */
  private async loadAsPdf(bytes: Buffer, mime: string): Promise<PDFDocument> {
    if ((mime || '').toLowerCase() === 'application/pdf') {
      return PDFDocument.load(bytes);
    }
    const pdf = await PDFDocument.create();
    const img =
      (mime || '').toLowerCase() === 'image/png'
        ? await pdf.embedPng(bytes)
        : await pdf.embedJpg(bytes);
    const page = pdf.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    return pdf;
  }

  private resolvePageIndex(page: number | undefined, count: number): number {
    if (!page || page < 1) return count - 1; // last page
    return Math.min(page, count) - 1;
  }

  private clamp(v: number, lo: number, hi: number): number {
    return Math.min(Math.max(v, lo), hi);
  }

  private anchorXY(page: PDFPage, anchor: SignatureAnchor, sigWidth: number): { x: number; y: number } {
    const { width } = page.getSize();
    const y = this.MARGIN;
    const w = sigWidth;
    switch (anchor) {
      case SignatureAnchor.BOTTOM_LEFT:
        return { x: this.MARGIN, y };
      case SignatureAnchor.BOTTOM_CENTER:
        return { x: (width - w) / 2, y };
      case SignatureAnchor.BOTTOM_RIGHT:
      default:
        return { x: width - this.MARGIN - w, y };
    }
  }
}
