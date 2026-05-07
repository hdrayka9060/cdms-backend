import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type TicketDocument = Ticket & Document;
export enum TicketStatus { OPEN = 'open', IN_PROGRESS = 'in_progress', RESOLVED = 'resolved', CLOSED = 'closed' }
export enum TicketPriority { LOW = 'low', MEDIUM = 'medium', HIGH = 'high', URGENT = 'urgent' }
export enum TicketCategory { TECHNICAL = 'technical', BILLING = 'billing', VEHICLE = 'vehicle', GENERAL = 'general', COMPLAINT = 'complaint' }

@Schema({ timestamps: true, collection: 'tickets' })
export class Ticket {
  @Prop({ required: true }) subject: string;
  @Prop({ required: true }) description: string;
  @Prop({ type: String, enum: TicketStatus, default: TicketStatus.OPEN }) status: TicketStatus;
  @Prop({ type: String, enum: TicketPriority, default: TicketPriority.MEDIUM }) priority: TicketPriority;
  @Prop({ type: String, enum: TicketCategory, default: TicketCategory.GENERAL }) category: TicketCategory;
  @Prop({ required: true }) raisedByName: string;
  @Prop({ required: true }) raisedByEmail: string;
  @Prop({ type: Types.ObjectId, ref: 'User' }) assignedTo: Types.ObjectId;
  @Prop({ type: [String], default: [] }) attachments: string[];
  @Prop({ type: [{ message: String, sentByName: String, sentByEmail: String, sentAt: Date, isInternal: Boolean, attachments: [String] }], default: [] }) thread: any[];
  @Prop() resolvedAt: Date;
  @Prop({ default: false }) isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const TicketSchema = SchemaFactory.createForClass(Ticket);
TicketSchema.index({ status: 1, priority: 1, category: 1 });
