import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type PushSubscriptionDocument = PushSubscription & Document;

/**
 * One row per browser/device that opted into Web Push. The `endpoint` is the
 * push-service URL the browser gave us and is globally unique per install, so
 * we upsert on it (a re-subscribe from the same device replaces the row).
 * A user can have many (phone + desktop + …). Dead endpoints (404/410 on send)
 * are pruned by PushService.
 */
@Schema({ timestamps: true, collection: 'push_subscriptions' })
export class PushSubscription {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  user: Types.ObjectId;

  @Prop({ required: true, unique: true }) endpoint: string;

  @Prop({ type: Object, required: true }) keys: { p256dh: string; auth: string };

  @Prop({ default: '' }) userAgent: string;

  createdAt: Date;
  updatedAt: Date;
}

export const PushSubscriptionSchema = SchemaFactory.createForClass(PushSubscription);
PushSubscriptionSchema.index({ user: 1 });
