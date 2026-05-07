import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SaleDocument = Sale & Document;
export type ExpenseDocument = Expense & Document;

@Schema({ timestamps: true, collection: 'sales' })
export class Sale {
  @Prop({ required: true }) vehicleTitle: string;
  @Prop({ required: true }) vehicleId: string;
  @Prop({ required: true }) buyerName: string;
  @Prop({ required: true }) buyerEmail: string;
  @Prop({ required: true }) salePrice: number;
  @Prop({ default: 0 }) costPrice: number;
  @Prop({ default: 0 }) discount: number;
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
  @Prop({ default: 'general', enum: ['general', 'marketing', 'maintenance', 'staff', 'utilities', 'other'] }) category: string;
  @Prop({ default: '' }) vendor: string;
  @Prop({ default: '' }) notes: string;
  @Prop({ default: false }) isDeleted: boolean;
  createdAt: Date;
}

export const SaleSchema = SchemaFactory.createForClass(Sale);
export const ExpenseSchema = SchemaFactory.createForClass(Expense);
SaleSchema.index({ saleDate: -1, paymentStatus: 1 });
ExpenseSchema.index({ date: -1, category: 1 });
