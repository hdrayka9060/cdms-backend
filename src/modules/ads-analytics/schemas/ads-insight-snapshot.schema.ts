import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { AdsProvider } from './ads-connection.schema';

export type AdsInsightSnapshotDocument = AdsInsightSnapshot & Document;

/**
 * One day of metrics for one campaign, pulled from a provider and stored so the
 * analytics view (and trend) reads from our DB rather than hammering the ad API
 * on every page load. Mirrors the Facebook `facebook_engagement` snapshot idea,
 * but upserted by (provider, accountId, date, campaignId) so re-pulling the
 * same day OVERWRITES that day (idempotent) while historical days are retained.
 *
 * Account-level + per-platform + portfolio numbers are all derived by
 * aggregating these campaign-day rows in AdsAnalyticsService.getAnalytics.
 */
@Schema({ timestamps: true, collection: 'ads_insight_snapshots' })
export class AdsInsightSnapshot {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'AdsConnection', index: true })
  connection: Types.ObjectId;

  @Prop({ type: String, enum: AdsProvider, required: true, index: true })
  provider: AdsProvider;

  @Prop({ default: '' }) accountId: string;

  /** YYYY-MM-DD (lexicographically sortable; matches range filters). */
  @Prop({ required: true, index: true }) date: string;

  @Prop({ default: '' }) campaignId: string;
  @Prop({ default: '' }) campaignName: string;

  @Prop({ default: 0 }) spend: number;
  @Prop({ default: 0 }) impressions: number;
  @Prop({ default: 0 }) clicks: number;
  @Prop({ default: 0 }) conversions: number;
  @Prop({ default: 0 }) conversionValue: number;

  @Prop() fetchedAt: Date;

  @Prop({ default: false }) isDeleted: boolean;

  createdAt: Date;
  updatedAt: Date;
}

export const AdsInsightSnapshotSchema = SchemaFactory.createForClass(AdsInsightSnapshot);

// Idempotent per campaign-day: re-syncing a day overwrites its row.
AdsInsightSnapshotSchema.index(
  { provider: 1, accountId: 1, date: 1, campaignId: 1 },
  { unique: true },
);
