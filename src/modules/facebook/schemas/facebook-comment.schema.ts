import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type FacebookCommentDocument = FacebookComment & Document;

export enum FacebookCommentStatus {
  NEW = 'new',
  REPLIED = 'replied',
  RESOLVED = 'resolved',
}

/**
 * A comment received on a published Page post. Ingested via the webhook
 * (`feed`/`comment` events) and/or the engagement sync. `fbCommentId` is unique
 * so both paths upsert idempotently.
 */
@Schema({ timestamps: true, collection: 'facebook_comments' })
export class FacebookComment {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'FacebookListing' })
  listing: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'FacebookConnection' })
  connection: Types.ObjectId;

  @Prop({ required: true, unique: true }) fbCommentId: string;
  @Prop({ default: '' }) fbPostId: string;

  @Prop({ default: '' }) authorName: string;
  @Prop({ default: '' }) authorId: string;
  @Prop({ default: '' }) message: string;
  @Prop() fbCreatedTime: Date;

  @Prop({
    type: String,
    enum: FacebookCommentStatus,
    default: FacebookCommentStatus.NEW,
  })
  status: FacebookCommentStatus;

  @Prop({ default: '' }) replyText: string;
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User' }) repliedBy: Types.ObjectId;
  @Prop() repliedAt: Date;

  /** Seen/unseen flag, independent of `status`. New comments arrive unread;
   *  opening the listing's comments marks them read. Drives the unread badges. */
  @Prop({ default: true }) unread: boolean;

  @Prop({ default: false }) isDeleted: boolean;
  @Prop() deletedAt: Date;

  createdAt: Date;
  updatedAt: Date;
}

export const FacebookCommentSchema = SchemaFactory.createForClass(FacebookComment);

FacebookCommentSchema.index({ status: 1, isDeleted: 1 });
FacebookCommentSchema.index({ listing: 1 });
FacebookCommentSchema.index({ listing: 1, unread: 1, isDeleted: 1 });
