import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type CommunicationLogDocument = CommunicationLog & Document;
export enum CommChannel { EMAIL = 'email', SMS = 'sms', WHATSAPP = 'whatsapp', CALL = 'call' }
export enum CommDirection { INBOUND = 'inbound', OUTBOUND = 'outbound' }

@Schema({ timestamps: true, collection: 'communication_logs' })
export class CommunicationLog {
  @Prop({ type: String, enum: CommChannel, required: true }) channel: CommChannel;
  @Prop({ type: String, enum: CommDirection, default: CommDirection.OUTBOUND }) direction: CommDirection;
  @Prop({ required: true }) recipientName: string;
  @Prop({ required: true }) recipientContact: string;
  @Prop({ required: true }) subject: string;
  @Prop({ default: '' }) message: string;
  @Prop({ type: Types.ObjectId, ref: 'Vehicle' }) linkedVehicle: Types.ObjectId;
  @Prop({ default: '' }) linkedLeadId: string;
  @Prop({ default: 'customer', enum: ['customer', 'lead', 'borrower'] }) contactType: string;
  @Prop({ type: Types.ObjectId, ref: 'User' }) sentBy: Types.ObjectId;
  @Prop({ default: 'sent', enum: ['sent', 'delivered', 'failed', 'pending'] }) deliveryStatus: string;
  @Prop() callDurationSeconds: number;
  createdAt: Date;
}

export const CommunicationLogSchema = SchemaFactory.createForClass(CommunicationLog);
CommunicationLogSchema.index({ channel: 1, createdAt: -1 });
CommunicationLogSchema.index({ linkedVehicle: 1 });
