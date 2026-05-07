import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CampaignDocument = Campaign & Document;
export enum CampaignPlatform { GOOGLE = 'google', META = 'meta', INSTAGRAM = 'instagram', EMAIL = 'email' }
export enum CampaignStatus { DRAFT = 'draft', ACTIVE = 'active', PAUSED = 'paused', COMPLETED = 'completed' }

@Schema({ timestamps: true, collection: 'campaigns' })
export class Campaign {
  @Prop({ required: true }) name: string;
  @Prop({ default: '' }) description: string;
  @Prop({ type: String, enum: CampaignPlatform, required: true }) platform: CampaignPlatform;
  @Prop({ type: String, enum: CampaignStatus, default: CampaignStatus.DRAFT }) status: CampaignStatus;
  @Prop({ default: 0 }) budget: number;
  @Prop({ default: 0 }) spent: number;
  @Prop() startDate: Date;
  @Prop() endDate: Date;
  // Mock metrics
  @Prop({ default: 0 }) impressions: number;
  @Prop({ default: 0 }) clicks: number;
  @Prop({ default: 0 }) leads: number;
  @Prop({ default: 0 }) conversions: number;
  @Prop({ default: false }) isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const CampaignSchema = SchemaFactory.createForClass(Campaign);
