import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SaleDocument = Sale & Document;
export type ExpenseDocument = Expense & Document;

@Schema({ timestamps: true, collection: 'sales' })
export class Sale {
  @Prop({ required: true }) vehicleTitle: string;
  /** Vehicle ObjectId as a plain string. */
  @Prop({ required: true }) vehicleId: string;
  @Prop({ required: true }) buyerName: string;
  @Prop({ required: true }) buyerEmail: string;
  /** Gross sale price (before discount). */
  @Prop({ required: true }) salePrice: number;
  /** What the dealership paid for the car — used for profit calculation. */
  @Prop({ default: 0 }) costPrice: number;
  /**
   * Reconditioning spend (repairs/service/parts/etc.) snapshotted from the
   * vehicle at sale time. Part of the cost basis: profit = (salePrice −
   * discount) − costPrice − totalSpend. Re-synced if a spend is deleted on the
   * already-sold vehicle (InventoryService.removeSpend → syncSaleSpendForVehicle).
   */
  @Prop({ default: 0 }) totalSpend: number;
  /** Discount applied off `salePrice`. Net = salePrice - discount. */
  @Prop({ default: 0 }) discount: number;
  /**
   * How much of the net the buyer has actually paid. Drives the outstanding
   * KPI:  outstanding = (salePrice - discount) - amountPaid when status≠paid.
   */
  @Prop({ default: 0 }) amountPaid: number;
  @Prop({ required: true }) saleDate: Date;
  @Prop({ default: 'cash', enum: ['cash', 'finance', 'bhph', 'trade_in'] }) paymentMethod: string;
  @Prop({ default: 'paid', enum: ['paid', 'pending', 'partial'] }) paymentStatus: string;
  @Prop({ default: '' }) notes: string;
  @Prop({ default: false }) isDeleted: boolean;
  createdAt: Date;
}

@Schema({ timestamps: true, collection: 'expenses' })
export class Expense {
  @Prop({ required: true }) title: string;
  @Prop({ required: true }) amount: number;
  @Prop({ required: true }) date: Date;
  @Prop({ default: 'general', enum: ['general', 'marketing', 'maintenance', 'staff', 'utilities', 'other', 'reconditioning'] }) category: string;
  @Prop({ default: '' }) vendor: string;
  @Prop({ default: '' }) notes: string;
  /**
   * Provenance for auto-created rows. 'vehicle-spend' marks an expense mirrored
   * from a vehicle reconditioning spend (category='reconditioning'); such rows
   * are managed via the vehicle's Spends tab, not the expense ledger, and are
   * kept in sync (and backfilled) via `spendId`.
   */
  @Prop() source?: string;
  @Prop() vehicleId?: string;
  @Prop({ index: true }) spendId?: string;
  @Prop({ default: false }) isDeleted: boolean;
  createdAt: Date;
}

export const SaleSchema = SchemaFactory.createForClass(Sale);
export const ExpenseSchema = SchemaFactory.createForClass(Expense);
SaleSchema.index({ saleDate: -1, paymentStatus: 1 });
ExpenseSchema.index({ date: -1, category: 1 });
