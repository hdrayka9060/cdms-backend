import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type LoanDocument = Loan & Document;
export enum LoanStatus { ACTIVE = 'active', PAID_OFF = 'paid_off', DEFAULTED = 'defaulted' }

@Schema({ timestamps: true, collection: 'loans' })
export class Loan {
  @Prop({ required: true }) borrowerName: string;
  @Prop({ required: true }) borrowerEmail: string;
  @Prop({ required: true }) borrowerPhone: string;
  @Prop({ type: Types.ObjectId, ref: 'Vehicle' }) vehicle: Types.ObjectId;
  @Prop({ required: true }) vehicleTitle: string;
  @Prop({ required: true }) principal: number;
  @Prop({ required: true, min: 0, max: 100 }) interestRatePercent: number;
  @Prop({ required: true, min: 1 }) termMonths: number;
  @Prop() emiAmount: number;
  @Prop({ required: true }) startDate: Date;
  @Prop() endDate: Date;
  @Prop({ default: 0 }) totalPaid: number;
  @Prop({ type: String, enum: LoanStatus, default: LoanStatus.ACTIVE }) status: LoanStatus;
  @Prop({ type: [{ amount: Number, date: Date, method: String, notes: String, receiptNumber: String }], default: [] }) payments: any[];
  @Prop({ default: '' }) notes: string;
  @Prop({ default: false }) isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const LoanSchema = SchemaFactory.createForClass(Loan);
LoanSchema.index({ status: 1, borrowerEmail: 1 });
