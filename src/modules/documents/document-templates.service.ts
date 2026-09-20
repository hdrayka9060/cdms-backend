import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { StorageService } from '../../common/storage/storage.service';
import {
  DocumentTemplate,
  DocumentTemplateDocument,
  SignatureAnchor,
} from './schemas/document-template.schema';

export interface CreateTemplateInput {
  name: string;
  description?: string;
  category?: string;
  signaturePage?: number;
  signatureAnchor?: SignatureAnchor;
  requireSignerName?: boolean;
  isActive?: boolean;
  createdById?: string;
  createdByName?: string;
  file: { buffer: Buffer; originalname: string; mimetype: string; size: number };
}

const PDF = 'application/pdf';
const IMAGES = ['image/png', 'image/jpeg'];

@Injectable()
export class DocumentTemplatesService {
  constructor(
    @InjectModel(DocumentTemplate.name)
    private readonly model: Model<DocumentTemplateDocument>,
    private readonly storage: StorageService,
  ) {}

  private assertFileType(mime: string): 'pdf' | 'image' {
    if (mime === PDF) return 'pdf';
    if (IMAGES.includes(mime)) return 'image';
    throw new BadRequestException('Template file must be a PDF, PNG, or JPEG.');
  }

  async create(input: CreateTemplateInput): Promise<DocumentTemplate> {
    if (!input.file) throw new BadRequestException('A template file is required.');
    const sourceType = this.assertFileType(input.file.mimetype);
    const fileUrl = await this.storage.upload(
      input.file.buffer,
      input.file.originalname,
      input.file.mimetype,
      'documents/templates',
    );
    const doc = await this.model.create({
      name: input.name,
      description: input.description ?? '',
      category: input.category || 'general',
      sourceType,
      fileUrl,
      fileName: input.file.originalname,
      fileMime: input.file.mimetype,
      fileSize: input.file.size,
      signaturePage: input.signaturePage ?? 0,
      signatureAnchor: input.signatureAnchor ?? SignatureAnchor.BOTTOM_RIGHT,
      requireSignerName: input.requireSignerName ?? true,
      isActive: input.isActive ?? true,
      createdBy: isValidObjectId(input.createdById) ? input.createdById : undefined,
      createdByName: input.createdByName ?? '',
    });
    return doc.toObject();
  }

  async findAll(query: { includeInactive?: boolean } = {}): Promise<DocumentTemplate[]> {
    const filter: any = { isDeleted: false };
    if (!query.includeInactive) filter.isActive = true;
    return this.model.find(filter).sort({ createdAt: -1 }).lean();
  }

  async findById(id: string): Promise<DocumentTemplate> {
    if (!isValidObjectId(id)) throw new NotFoundException('Template not found');
    const doc = await this.model.findOne({ _id: id, isDeleted: false }).lean();
    if (!doc) throw new NotFoundException('Template not found');
    return doc;
  }

  async update(
    id: string,
    patch: Partial<Omit<CreateTemplateInput, 'file' | 'createdById' | 'createdByName'>>,
  ): Promise<DocumentTemplate> {
    if (!isValidObjectId(id)) throw new NotFoundException('Template not found');
    const set: any = {};
    for (const k of [
      'name',
      'description',
      'category',
      'signaturePage',
      'signatureAnchor',
      'requireSignerName',
      'isActive',
    ] as const) {
      if (patch[k] !== undefined) set[k] = patch[k];
    }
    const doc = await this.model
      .findOneAndUpdate({ _id: id, isDeleted: false }, { $set: set }, { new: true })
      .lean();
    if (!doc) throw new NotFoundException('Template not found');
    return doc;
  }

  async remove(id: string): Promise<{ deleted: true }> {
    if (!isValidObjectId(id)) throw new NotFoundException('Template not found');
    const doc = await this.model.findOne({ _id: id, isDeleted: false });
    if (!doc) throw new NotFoundException('Template not found');
    doc.isDeleted = true;
    await doc.save();
    await this.storage.remove(doc.fileUrl).catch(() => undefined);
    return { deleted: true };
  }
}
