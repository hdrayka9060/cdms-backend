import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type BuyerLeadDocument = BuyerLead & Document;
export enum BuyerLeadStage { NEW = 'new', CONTACTED = 'contacted', TEST_DRIVE = 'test_drive', NEGOTIATION = 'negotiation', PURCHASED = 'purchased', LOST = 'lost' }

@Schema({ timestamps: true, collection: 'buyer_leads' })
export class BuyerLead {
  @Prop({ required: true }) buyerName: string;
  @Prop({ required: true }) buyerEmail: string;
  @Prop({ required: true }) buyerPhone: string;
  @Prop({ default: '' }) notes: string;
  @Prop({ type: Types.ObjectId, ref: 'Vehicle' }) interestedVehicle: Types.ObjectId;
  @Prop() budget: number;
  @Prop({ type: String, enum: BuyerLeadStage, default: BuyerLeadStage.NEW }) stage: BuyerLeadStage;
  @Prop({ type: Types.ObjectId, ref: 'User' }) assignedTo: Types.ObjectId;
  @Prop({ type: [{ vehicleId: String, vehicleTitle: String, action: String, date: Date }], default: [] }) history: any[];
  @Prop({ default: false }) isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const BuyerLeadSchema = SchemaFactory.createForClass(BuyerLead);
BuyerLeadSchema.index({ stage: 1, buyerEmail: 1 });
