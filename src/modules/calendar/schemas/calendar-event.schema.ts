import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type CalendarEventDocument = CalendarEvent & Document;
export enum EventType { TEST_DRIVE = 'test_drive', INSPECTION = 'inspection', MEETING = 'meeting', BLOCKED = 'blocked' }
export enum EventStatus { SCHEDULED = 'scheduled', COMPLETED = 'completed', CANCELLED = 'cancelled', NO_SHOW = 'no_show' }

@Schema({ timestamps: true, collection: 'calendar_events' })
export class CalendarEvent {
  @Prop({ required: true }) title: string;
  @Prop({ default: '' }) description: string;
  @Prop({ required: true }) startDateTime: Date;
  @Prop({ required: true }) endDateTime: Date;
  @Prop({ type: String, enum: EventType, required: true }) eventType: EventType;
  @Prop({ type: String, enum: EventStatus, default: EventStatus.SCHEDULED }) status: EventStatus;
  @Prop({ type: Types.ObjectId, ref: 'User' }) assignedTo: Types.ObjectId;
  @Prop({ default: '' }) customerName: string;
  @Prop({ default: '' }) customerPhone: string;
  @Prop({ default: '' }) customerEmail: string;
  @Prop({ type: Types.ObjectId, ref: 'Vehicle' }) vehicle: Types.ObjectId;
  @Prop({ default: '' }) meetLink: string;
  @Prop({ default: '' }) location: string;
  @Prop({ default: '' }) notes: string;
  @Prop({ default: false }) isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const CalendarEventSchema = SchemaFactory.createForClass(CalendarEvent);
CalendarEventSchema.index({ startDateTime: 1, endDateTime: 1, eventType: 1 });
