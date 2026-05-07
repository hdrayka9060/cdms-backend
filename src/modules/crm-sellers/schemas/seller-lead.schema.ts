import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type SellerLeadDocument = SellerLead & Document;

export enum SellerLeadStage {
  NEW = 'new',
  CONTACTED = 'contacted',
  INSPECTION = 'inspection',
  NEGOTIATION = 'negotiation',
  SOLD = 'sold',
  REJECTED = 'rejected',
}

@Schema({ timestamps: true, collection: 'seller_leads' })
export class SellerLead {
  @Prop({ required: true }) sellerName: string;
  @Prop({ required: true }) sellerEmail: string;
  @Prop({ required: true }) sellerPhone: string;
  @Prop({ default: '' }) notes: string;
  // Vehicle info they want to sell
  @Prop({ required: true }) vehicleTitle: string;
  @Prop({ required: true }) vehicleCompany: string;
  @Prop({ required: true }) vehicleModel: string;
  @Prop({ required: true }) vehicleYear: number;
  @Prop({ default: 0 }) vehicleKm: number;
  @Prop({ default: 0 }) askingPrice: number;
  @Prop({ type: [String], default: [] }) vehiclePhotos: string[];
  @Prop({ type: String, enum: SellerLeadStage, default: SellerLeadStage.NEW }) stage: SellerLeadStage;
  @Prop() inspectionDate: Date;
  @Prop({ type: Types.ObjectId, ref: 'User' }) assignedTo: Types.ObjectId;
  @Prop({ type: [{ type: String, channel: String, message: String, sentAt: Date, sentBy: String }], default: [] }) communications: any[];
  @Prop({ default: false }) isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const SellerLeadSchema = SchemaFactory.createForClass(SellerLead);
SellerLeadSchema.index({ stage: 1, sellerEmail: 1 });
