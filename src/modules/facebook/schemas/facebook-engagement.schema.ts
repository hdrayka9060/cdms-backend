import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type FacebookEngagementDocument = FacebookEngagement & Document;

/**
 * Append-only engagement snapshot per listing per sync (mirrors the `activities`
 * append-only pattern). The listing carries the *current* engagement; these
 * rows accumulate over time so the Analytics trend chart can plot history.
 */
@Schema({ timestamps: true, collection: 'facebook_engagement' })
export class FacebookEngagement {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'FacebookListing', required: true })
  listing: Types.ObjectId;

  @Prop({ default: 0 }) reactions: number;
  @Prop({ default: 0 }) comments: number;
  @Prop({ default: 0 }) shares: number;
  @Prop({ default: 0 }) views: number;

  @Prop({ required: true }) fetchedAt: Date;

  createdAt: Date;
  updatedAt: Date;
}

export const FacebookEngagementSchema = SchemaFactory.createForClass(FacebookEngagement);

FacebookEngagementSchema.index({ fetchedAt: 1 });
FacebookEngagementSchema.index({ listing: 1, fetchedAt: 1 });
