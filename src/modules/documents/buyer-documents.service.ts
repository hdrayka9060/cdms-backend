import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { StorageService } from '../../common/storage/storage.service';
import { PdfStampService } from './pdf-stamp.service';
import { DocumentTemplatesService } from './document-templates.service';
import {
  BuyerDocument,
  BuyerDocumentDocument,
  BuyerDocumentKind,
  BuyerDocumentStatus,
} from './schemas/buyer-document.schema';

const PDF = 'application/pdf';
const IMAGES = ['image/png', 'image/jpeg'];

export interface UploadPlainInput {
  buyerLeadId: string;
  title: string;
  docType?: string;
  leadId?: string;
  vehicleId?: string;
  notes?: string;
  uploadedById?: string;
  uploadedByName?: string;
  file: { buffer: Buffer; originalname: string; mimetype: string; size: number };
}

export interface FromTemplateInput {
  buyerLeadId: string;
  templateId: string;
  leadId?: string;
  vehicleId?: string;
  title?: string;
  uploadedById?: string;
  uploadedByName?: string;
}

export interface UploadSignableInput {
  buyerLeadId: string;
  title?: string;
  leadId?: string;
  vehicleId?: string;
  /** When true, also register the file as a reusable DocumentTemplate. */
  saveAsTemplate?: boolean;
  templateName?: string;
  category?: string;
  uploadedById?: string;
  uploadedByName?: string;
  file: { buffer: Buffer; originalname: string; mimetype: string; size: number };
}

/** One signature the signer placed on the document (normalized center coords). */
export interface SignPlacementInput {
  page?: number; // 1-based; 0/undefined = last page
  x?: number; // 0..1 center from left
  y?: number; // 0..1 center from top
  width?: number; // 0..1 of page width
  signatureImage: string; // base64 data URL or bare base64 PNG (per-spot signature)
}

export interface SignInput {
  /** Free-placement signatures (new flow): one or more, across any pages. */
  placements?: SignPlacementInput[];
  /** Legacy single-signature fallback (stamped at the template anchor). */
  signatureImage?: string;
  signerName?: string;
  staffId?: string;
  staffName?: string;
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class BuyerDocumentsService {
  constructor(
    @InjectModel(BuyerDocument.name)
    private readonly model: Model<BuyerDocumentDocument>,
    private readonly storage: StorageService,
    private readonly stamper: PdfStampService,
    private readonly templates: DocumentTemplatesService,
  ) {}

  async findAll(query: { buyerLeadId?: string; leadId?: string; status?: string }): Promise<BuyerDocument[]> {
    const filter: any = { isDeleted: false };
    if (query.buyerLeadId && isValidObjectId(query.buyerLeadId)) filter.buyerLeadId = query.buyerLeadId;
    if (query.leadId && isValidObjectId(query.leadId)) filter.leadId = query.leadId;
    if (query.status) filter.status = query.status;
    return this.model.find(filter).sort({ createdAt: -1 }).lean();
  }

  async findById(id: string): Promise<BuyerDocument> {
    if (!isValidObjectId(id)) throw new NotFoundException('Document not found');
    const doc = await this.model.findOne({ _id: id, isDeleted: false }).lean();
    if (!doc) throw new NotFoundException('Document not found');
    return doc;
  }

  async uploadPlain(input: UploadPlainInput): Promise<BuyerDocument> {
    if (!isValidObjectId(input.buyerLeadId)) throw new BadRequestException('Valid buyerLeadId is required.');
    if (!input.file) throw new BadRequestException('A file is required.');
    const mime = input.file.mimetype;
    if (mime !== PDF && !IMAGES.includes(mime)) {
      throw new BadRequestException('File must be a PDF, PNG, or JPEG.');
    }
    const fileUrl = await this.storage.upload(
      input.file.buffer,
      input.file.originalname,
      mime,
      'documents/buyer',
    );
    const doc = await this.model.create({
      buyerLeadId: input.buyerLeadId,
      leadId: isValidObjectId(input.leadId) ? input.leadId : undefined,
      vehicleId: isValidObjectId(input.vehicleId) ? input.vehicleId : undefined,
      kind: BuyerDocumentKind.UPLOAD,
      title: input.title || input.file.originalname,
      docType: input.docType || 'other',
      fileUrl,
      fileName: input.file.originalname,
      fileMime: mime,
      fileSize: input.file.size,
      status: BuyerDocumentStatus.UPLOADED,
      notes: input.notes ?? '',
      uploadedBy: isValidObjectId(input.uploadedById) ? input.uploadedById : undefined,
      uploadedByName: input.uploadedByName ?? '',
    });
    return doc.toObject();
  }

  /**
   * Create a signable document for a buyer from a NEWLY uploaded file (not an
   * existing template). If `saveAsTemplate` is set, the file is also registered
   * as a reusable DocumentTemplate; otherwise it's a one-off, buyer-specific
   * signable. Either way the buyer gets a `pending` signable to sign.
   */
  async uploadSignable(input: UploadSignableInput): Promise<BuyerDocument> {
    if (!isValidObjectId(input.buyerLeadId)) throw new BadRequestException('Valid buyerLeadId is required.');
    if (!input.file) throw new BadRequestException('A file is required.');
    const mime = input.file.mimetype;
    if (mime !== PDF && !IMAGES.includes(mime)) {
      throw new BadRequestException('File must be a PDF, PNG, or JPEG.');
    }

    if (input.saveAsTemplate) {
      // Reusable: create the template, then a signable referencing it.
      const tpl = await this.templates.create({
        name: input.templateName || input.title || input.file.originalname,
        category: input.category,
        createdById: input.uploadedById,
        createdByName: input.uploadedByName,
        file: input.file,
      });
      return this.createFromTemplate({
        buyerLeadId: input.buyerLeadId,
        templateId: String((tpl as any)._id),
        title: input.title,
        leadId: input.leadId,
        vehicleId: input.vehicleId,
        uploadedById: input.uploadedById,
        uploadedByName: input.uploadedByName,
      });
    }

    // One-off, buyer-specific: upload the file and create a signable directly.
    const fileUrl = await this.storage.upload(input.file.buffer, input.file.originalname, mime, 'documents/buyer');
    const doc = await this.model.create({
      buyerLeadId: input.buyerLeadId,
      leadId: isValidObjectId(input.leadId) ? input.leadId : undefined,
      vehicleId: isValidObjectId(input.vehicleId) ? input.vehicleId : undefined,
      kind: BuyerDocumentKind.SIGNABLE,
      title: input.title || input.file.originalname,
      docType: 'agreement',
      fileUrl,
      fileName: input.file.originalname,
      fileMime: mime,
      fileSize: input.file.size,
      status: BuyerDocumentStatus.PENDING,
      uploadedBy: isValidObjectId(input.uploadedById) ? input.uploadedById : undefined,
      uploadedByName: input.uploadedByName ?? '',
    });
    return doc.toObject();
  }

  async createFromTemplate(input: FromTemplateInput): Promise<BuyerDocument> {
    if (!isValidObjectId(input.buyerLeadId)) throw new BadRequestException('Valid buyerLeadId is required.');
    const tpl = await this.templates.findById(input.templateId); // throws if missing
    const doc = await this.model.create({
      buyerLeadId: input.buyerLeadId,
      leadId: isValidObjectId(input.leadId) ? input.leadId : undefined,
      vehicleId: isValidObjectId(input.vehicleId) ? input.vehicleId : undefined,
      kind: BuyerDocumentKind.SIGNABLE,
      title: input.title || tpl.name,
      docType: 'agreement',
      fileUrl: tpl.fileUrl,
      fileName: tpl.fileName,
      fileMime: tpl.fileMime,
      fileSize: tpl.fileSize,
      templateId: (tpl as any)._id,
      templateName: tpl.name,
      signaturePage: tpl.signaturePage,
      signatureAnchor: tpl.signatureAnchor,
      status: BuyerDocumentStatus.PENDING,
      uploadedBy: isValidObjectId(input.uploadedById) ? input.uploadedById : undefined,
      uploadedByName: input.uploadedByName ?? '',
    });
    return doc.toObject();
  }

  /** Stamp the captured signature into the document → signed PDF. */
  async sign(id: string, input: SignInput): Promise<BuyerDocument> {
    if (!isValidObjectId(id)) throw new NotFoundException('Document not found');
    const doc = await this.model.findOne({ _id: id, isDeleted: false });
    if (!doc) throw new NotFoundException('Document not found');
    if (doc.kind !== BuyerDocumentKind.SIGNABLE) {
      throw new BadRequestException('Only signable documents can be signed.');
    }
    if (doc.status === BuyerDocumentStatus.SIGNED) {
      throw new BadRequestException('Document is already signed.');
    }
    if (doc.status === BuyerDocumentStatus.VOID) {
      throw new BadRequestException('Voided documents cannot be signed.');
    }

    const signedAt = new Date();

    // Build the placement list. New flow: one entry per spot the signer placed
    // (each with its own drawn signature). Legacy fallback: a single signature
    // stamped at the template's anchor/page.
    const rawPlacements =
      input.placements && input.placements.length
        ? input.placements
        : input.signatureImage
          ? [{ signatureImage: input.signatureImage, page: doc.signaturePage }]
          : [];
    if (!rawPlacements.length) {
      throw new BadRequestException('At least one signature placement is required.');
    }
    const placements = rawPlacements.map((p) => ({
      page: p.page ?? doc.signaturePage,
      xNorm: typeof p.x === 'number' ? p.x : undefined,
      yNorm: typeof p.y === 'number' ? p.y : undefined,
      widthNorm: typeof p.width === 'number' ? p.width : undefined,
      signaturePng: this.decodePng(p.signatureImage),
      anchor: doc.signatureAnchor,
    }));

    // Load original bytes, stamp every placement, upload signed PDF + a
    // representative raw signature PNG (the first spot) for the audit record.
    const sourceBytes = await this.storage.read(doc.fileUrl);
    const signedPdf = await this.stamper.stampSignatures({
      sourceBytes,
      sourceMime: doc.fileMime || PDF,
      placements,
      signerName: input.signerName || '',
      signedAt,
    });
    const signaturePng = placements[0].signaturePng;

    const baseName = (doc.title || 'document').replace(/[^\w.-]+/g, '_');
    const signedFileUrl = await this.storage.upload(
      signedPdf,
      `signed-${baseName}.pdf`,
      PDF,
      'documents/signed',
    );
    const signatureImageUrl = await this.storage
      .upload(signaturePng, `signature-${baseName}.png`, 'image/png', 'documents/signatures')
      .catch(() => '');

    doc.signedFileUrl = signedFileUrl;
    doc.status = BuyerDocumentStatus.SIGNED;
    doc.signature = {
      signerName: input.signerName || '',
      signedAt,
      signedByStaffId: isValidObjectId(input.staffId) ? (input.staffId as any) : undefined,
      signedByStaffName: input.staffName || '',
      signatureImageUrl,
      ipAddress: input.ipAddress || '',
      userAgent: input.userAgent || '',
    };
    await doc.save();
    return doc.toObject();
  }

  async voidDoc(id: string): Promise<BuyerDocument> {
    if (!isValidObjectId(id)) throw new NotFoundException('Document not found');
    const doc = await this.model.findOne({ _id: id, isDeleted: false });
    if (!doc) throw new NotFoundException('Document not found');
    if (doc.kind !== BuyerDocumentKind.SIGNABLE) {
      throw new BadRequestException('Only signable documents can be voided.');
    }
    doc.status = BuyerDocumentStatus.VOID;
    await doc.save();
    return doc.toObject();
  }

  async remove(id: string): Promise<{ deleted: true }> {
    if (!isValidObjectId(id)) throw new NotFoundException('Document not found');
    const doc = await this.model.findOne({ _id: id, isDeleted: false });
    if (!doc) throw new NotFoundException('Document not found');
    doc.isDeleted = true;
    await doc.save();
    // Best-effort object cleanup. Never delete a template's shared file — only
    // plain-upload originals, the stamped signed PDF, and the raw signature.
    if (doc.kind === BuyerDocumentKind.UPLOAD) await this.storage.remove(doc.fileUrl).catch(() => undefined);
    if (doc.signedFileUrl) await this.storage.remove(doc.signedFileUrl).catch(() => undefined);
    if (doc.signature?.signatureImageUrl) {
      await this.storage.remove(doc.signature.signatureImageUrl).catch(() => undefined);
    }
    return { deleted: true };
  }

  /** Accept a data-URL ("data:image/png;base64,...") or bare base64 PNG. */
  private decodePng(input: string): Buffer {
    if (!input) throw new BadRequestException('signatureImage is required.');
    const comma = input.indexOf(',');
    const b64 = input.startsWith('data:') && comma >= 0 ? input.slice(comma + 1) : input;
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) throw new BadRequestException('signatureImage is not valid base64.');
    return buf;
  }
}
