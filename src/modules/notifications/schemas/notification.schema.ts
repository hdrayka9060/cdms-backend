import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type NotificationDocument = Notification & Document;

/**
 * Coarse buckets used for per-user preferences (a user can mute a whole
 * category rather than every individual `type`). Mirrored on the frontend
 * in notifications-mapper.ts.
 */
export enum NotificationCategory {
  LEADS = 'leads',
  APPOINTMENTS = 'appointments',
  SALES = 'sales',
  SOCIAL = 'social',
  SUPPORT = 'support',
  SYSTEM = 'system',
}

/**
 * One row per (recipient user × event). Persistent + per-user, unlike a toast:
 * survives reload and carries an unread state. Written by NotificationsService;
 * pushed live over the existing Socket.io gateway; read by the header bell.
 *
 * NOTE: `MongooseSchema.Types.ObjectId` (schema-type API), never the runtime
 * `Types.ObjectId` — the latter silently degrades to Mixed (the bug fixed on
 * Lead / users.roleId).
 */
@Schema({ timestamps: true, collection: 'notifications' })
export class Notification {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  user: Types.ObjectId;

  /** Fine-grained event key, e.g. 'lead.assigned' / 'lead.new'. Drives the icon. */
  @Prop({ required: true }) type: string;

  /** Coarse bucket for preferences (NotificationCategory). */
  @Prop({ required: true, default: NotificationCategory.SYSTEM }) category: string;

  @Prop({ required: true }) title: string;
  @Prop({ default: '' }) body: string;

  /** What the notification points at, so the bell can deep-link. */
  @Prop({ type: Object, default: null }) entity: { kind: string; id: string } | null;

  /** Client-side route to open on click, e.g. '/leads/<id>'. */
  @Prop({ default: '' }) link: string;

  /** null = unread. Set to the read timestamp when the user reads it. */
  @Prop({ type: Date, default: null }) readAt: Date | null;

  /**
   * When Mongo should auto-purge this row (TTL). Set to readAt + retention when
   * a notification is marked read; stays null while unread so unread rows are
   * never expired. Keeps the collection from growing without bound.
   */
  @Prop({ type: Date, default: null }) deleteAt: Date | null;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', default: null })
  actorId: Types.ObjectId | null;
  @Prop({ default: '' }) actorName: string;

  @Prop({ type: Object, default: {} }) meta: Record<string, unknown>;

  createdAt: Date;
  updatedAt: Date;
}

export const NotificationSchema = SchemaFactory.createForClass(Notification);

// The one hot query: a user's list, newest-first, optionally unread-only.
NotificationSchema.index({ user: 1, readAt: 1, createdAt: -1 });
// TTL: Mongo deletes a row once `deleteAt` passes. Unread rows have deleteAt=null
// and are never touched (a missing/null field is ignored by TTL indexes).
NotificationSchema.index({ deleteAt: 1 }, { expireAfterSeconds: 0 });
