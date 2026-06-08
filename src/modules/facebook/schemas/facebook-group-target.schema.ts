import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type FacebookGroupTargetDocument = FacebookGroupTarget & Document;

/**
 * A Facebook Group the dealer posts to. **Registry only** — Facebook removed
 * the Groups publishing API (Apr 2024), so CDMS can't auto-post. This stores
 * the group + category so the "prepare & paste" assisted-manual flow can build
 * a caption and deep-link the user into the group composer. `category` is
 * free-text (e.g. "Local Car Sales", "Luxury", "SUVs", "Dealers").
 */
@Schema({ timestamps: true, collection: 'facebook_group_targets' })
export class FacebookGroupTarget {
  @Prop({ required: true }) name: string;
  @Prop({ required: true }) groupUrl: string;
  @Prop({ default: '' }) groupId: string;
  @Prop({ default: '' }) category: string;
  @Prop({ default: '' }) notes: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User' })
  createdBy: Types.ObjectId;

  @Prop({ default: false }) isDeleted: boolean;
  @Prop() deletedAt: Date;

  createdAt: Date;
  updatedAt: Date;
}

export const FacebookGroupTargetSchema =
  SchemaFactory.createForClass(FacebookGroupTarget);

FacebookGroupTargetSchema.index({ category: 1, isDeleted: 1 });
