import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ReceivableDocument = Receivable & Document;

/**
 * Open balance on a partial/unpaid NON-BHPH sale (cash / finance / trade-in).
 * A lightweight receivable — NOT a financing loan (no interest, no schedule).
 * It is the payment tracker for the sale: recording a payment here bumps the
 * linked Sale's `amountPaid` (see ReceivablesService.syncSale), so Accounting's
 * outstanding/collected figures shrink/grow automatically. BHPH sales use a
 * `Loan` instead; this is the parallel for everything else.
 */
export enum ReceivableStatus {
  OPEN = 'open',
  SETTLED = 'settled',
  ARCHIVED = 'archived',
}

@Schema({ _id: true })
export class ReceivablePayment {
  @Prop({ required: true }) amount: number;
  @Prop({ required: true, default: Date.now }) date: Date;
  @Prop({ default: 'cash' }) method: string;
  @Prop({ default: '' }) notes: string;
  @Prop({ default: '' }) receiptNumber: string;
}
export const ReceivablePaymentSchema = SchemaFactory.createForClass(ReceivablePayment);

@Schema({ timestamps: true, collection: 'receivables' })
export class Receivable {
  /** Linked sales-ledger row (ObjectId hex). */
  @Prop({ required: true }) saleId: string;
  @Prop() vehicleId?: string;
  @Prop() vehicleTitle?: string;
  @Prop() buyerName?: string;
  @Prop() buyerEmail?: string;
  @Prop() buyerPhone?: string;
  @Prop() leadId?: string;
  @Prop() buyerLeadId?: string;
  /** Original sale payment method: cash | finance | trade_in. */
  @Prop({ default: 'cash' }) paymentMethod: string;

  /** Net amount owed for the sale (salePrice − discount). */
  @Prop({ required: true }) totalAmount: number;
  /** Amount already collected at sale time (the sale's initial amountPaid). */
  @Prop({ default: 0 }) downPayment: number;
  /** Additional payments collected after the sale. */
  @Prop({ type: [ReceivablePaymentSchema], default: [] }) payments: ReceivablePayment[];

  @Prop({ type: String, enum: ReceivableStatus, default: ReceivableStatus.OPEN }) status: ReceivableStatus;
  @Prop({ default: '' }) notes: string;
  @Prop() archivedAt?: Date;
  @Prop({ default: false }) isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const ReceivableSchema = SchemaFactory.createForClass(Receivable);
ReceivableSchema.index({ status: 1, saleId: 1 });
ReceivableSchema.index({ vehicleId: 1 });
ReceivableSchema.index({ leadId: 1 });
