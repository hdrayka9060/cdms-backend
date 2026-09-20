import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types, Schema as MongooseSchema } from 'mongoose';

export type DocumentTemplateDocument = DocumentTemplate & Document;

/** Where the signature is stamped on the page. */
export enum SignatureAnchor {
  BOTTOM_RIGHT = 'bottom-right',
  BOTTOM_LEFT = 'bottom-left',
  BOTTOM_CENTER = 'bottom-center',
}

/**
 * Admin-defined reusable signable document. An admin uploads a blank PDF or
 * image (e.g. a purchase agreement, BHPH terms). Staff later assign a template
 * to a buyer, who signs it in-app; the signature is stamped into the file at the
 * configured page + anchor (see PdfStampService). Templates are pure config —
 * the per-buyer signed copy lives in `buyer_documents`.
 */
@Schema({ timestamps: true, collection: 'document_templates' })
export class DocumentTemplate {
  @Prop({ required: true }) name: string;
  @Prop({ default: '' }) description: string;
  /** Free-form grouping label, e.g. 'purchase-agreement', 'bhph', 'general'. */
  @Prop({ default: 'general' }) category: string;

  /** Uploaded source kind — drives how PdfStampService loads/wraps the file. */
  @Prop({ type: String, enum: ['pdf', 'image'], required: true }) sourceType: 'pdf' | 'image';

  /** The blank template file (StorageService URL). */
  @Prop({ required: true }) fileUrl: string;
  @Prop({ default: '' }) fileName: string;
  @Prop({ default: '' }) fileMime: string;
  @Prop({ default: 0 }) fileSize: number;

  /** 1-based page to stamp; 0/unset = last page. */
  @Prop({ default: 0 }) signaturePage: number;
  @Prop({ type: String, enum: SignatureAnchor, default: SignatureAnchor.BOTTOM_RIGHT })
  signatureAnchor: SignatureAnchor;
  @Prop({ default: true }) requireSignerName: boolean;

  @Prop({ default: true }) isActive: boolean;
  @Prop({ default: false }) isDeleted: boolean;

  // NOTE: real ObjectId ref uses MongooseSchema.Types.ObjectId — NEVER the
  // runtime Types.ObjectId (that degrades to Mixed and breaks queries/populate).
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User' }) createdBy?: Types.ObjectId;
  @Prop({ default: '' }) createdByName: string;

  createdAt: Date;
  updatedAt: Date;
}

export const DocumentTemplateSchema = SchemaFactory.createForClass(DocumentTemplate);
DocumentTemplateSchema.index({ isDeleted: 1, isActive: 1 });
DocumentTemplateSchema.index({ category: 1 });
