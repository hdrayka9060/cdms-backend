import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types, Schema as MongooseSchema } from 'mongoose';
import { SignatureAnchor } from './document-template.schema';

export type BuyerDocumentDocument = BuyerDocument & Document;

export enum BuyerDocumentKind {
  UPLOAD = 'upload',
  SIGNABLE = 'signable',
}

export enum BuyerDocumentStatus {
  UPLOADED = 'uploaded', // plain uploads
  PENDING = 'pending', // signable, awaiting signature
  SIGNED = 'signed', // signable, signed + stamped
  VOID = 'void', // signable, cancelled
}

/** Captured signature + audit trail for a signed document. */
@Schema({ _id: false })
export class DocumentSignature {
  @Prop({ default: '' }) signerName: string;
  @Prop() signedAt?: Date;
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User' }) signedByStaffId?: Types.ObjectId;
  @Prop({ default: '' }) signedByStaffName: string;
  /** Raw signature PNG (StorageService URL) kept for audit alongside the stamped PDF. */
  @Prop({ default: '' }) signatureImageUrl: string;
  @Prop({ default: '' }) ipAddress: string;
  @Prop({ default: '' }) userAgent: string;
}
export const DocumentSignatureSchema = SchemaFactory.createForClass(DocumentSignature);

/**
 * A document attached to a CRM buyer (`buyer_leads`). Unified list of BOTH plain
 * uploads (driver's license, insurance, proof of address) and signable documents
 * created from a `DocumentTemplate`. Surfaced on Buyer Detail and, via the
 * buyer link, on Lead Detail.
 */
@Schema({ timestamps: true, collection: 'buyer_documents' })
export class BuyerDocument {
  // Real ObjectId refs → MongooseSchema.Types.ObjectId (footgun rule).
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'BuyerLead', required: true })
  buyerLeadId: Types.ObjectId;
  /** Optional sales-lead context this doc was created in. */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Lead' }) leadId?: Types.ObjectId;
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Vehicle' }) vehicleId?: Types.ObjectId;

  @Prop({ type: String, enum: BuyerDocumentKind, required: true }) kind: BuyerDocumentKind;
  @Prop({ required: true }) title: string;
  /** For uploads: drivers_license | insurance | proof_of_address | other. */
  @Prop({ default: 'other' }) docType: string;

  /** Original file (upload) or the template's file copy-ref (signable). */
  @Prop({ default: '' }) fileUrl: string;
  @Prop({ default: '' }) fileName: string;
  @Prop({ default: '' }) fileMime: string;
  @Prop({ default: 0 }) fileSize: number;

  // Signable snapshot (copied from the template at creation).
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'DocumentTemplate' }) templateId?: Types.ObjectId;
  @Prop({ default: '' }) templateName: string;
  @Prop({ default: 0 }) signaturePage: number;
  @Prop({ type: String, enum: SignatureAnchor, default: SignatureAnchor.BOTTOM_RIGHT })
  signatureAnchor: SignatureAnchor;

  @Prop({ type: String, enum: BuyerDocumentStatus, default: BuyerDocumentStatus.UPLOADED })
  status: BuyerDocumentStatus;
  /** The stamped signed PDF (signable only). */
  @Prop({ default: '' }) signedFileUrl: string;
  @Prop({ type: DocumentSignatureSchema }) signature?: DocumentSignature;

  @Prop({ default: '' }) notes: string;
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User' }) uploadedBy?: Types.ObjectId;
  @Prop({ default: '' }) uploadedByName: string;
  @Prop({ default: false }) isDeleted: boolean;

  createdAt: Date;
  updatedAt: Date;
}

export const BuyerDocumentSchema = SchemaFactory.createForClass(BuyerDocument);
BuyerDocumentSchema.index({ buyerLeadId: 1, isDeleted: 1 });
BuyerDocumentSchema.index({ leadId: 1 });
BuyerDocumentSchema.index({ status: 1 });
