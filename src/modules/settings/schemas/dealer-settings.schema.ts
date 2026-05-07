import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type DealerSettingsDocument = DealerSettings & Document;

@Schema({ timestamps: true, collection: 'dealer_settings' })
export class DealerSettings {
  @Prop({ default: 'My Dealership' }) dealershipName: string;
  @Prop({ default: '' }) logo: string;
  @Prop({ default: '' }) address: string;
  @Prop({ default: '' }) city: string;
  @Prop({ default: '' }) state: string;
  @Prop({ default: '' }) zipCode: string;
  @Prop({ default: '' }) country: string;
  @Prop({ default: '' }) phone: string;
  @Prop({ default: '' }) email: string;
  @Prop({ default: '' }) website: string;
  @Prop({ default: '' }) taxId: string;
  @Prop({ default: '' }) licenseNumber: string;
  @Prop({ type: Object, default: { mon: '9am-6pm', tue: '9am-6pm', wed: '9am-6pm', thu: '9am-6pm', fri: '9am-6pm', sat: '10am-4pm', sun: 'closed' } }) businessHours: Record<string, string>;
  @Prop({ type: Object, default: { emailNotifications: true, smsNotifications: false, leadAlerts: true, paymentAlerts: true, supportAlerts: true } }) notifications: Record<string, boolean>;
  @Prop({ default: 'USD' }) currency: string;
  @Prop({ default: 'en' }) language: string;
  @Prop({ default: '' }) primaryColor: string;
  createdAt: Date;
  updatedAt: Date;
}

export const DealerSettingsSchema = SchemaFactory.createForClass(DealerSettings);
