import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type ActivityDocument = Activity & Document;

/**
 * Append-only audit log used to power the Dashboard's Recent Activity feed
 * (and, later, per-entity history surfaces). One row per interesting mutation.
 * Services call `ActivityService.log()` from create/update/delete/close paths;
 * nothing else writes here.
 *
 * Fields chosen for "answer at a glance":
 *   - module   — which feature area ('inventory', 'leads', etc.) for icon + filter
 *   - action   — short verb slug ('created', 'updated', 'deleted', 'closed', ...)
 *   - entity   — human-readable resource type ('Vehicle', 'Lead', 'Sale', ...)
 *   - entityId — opaque id of the resource (so future detail pages can deeplink)
 *   - label    — pre-formatted display ("2024 Honda Civic", "John Doe — Test Drive")
 *   - by       — actor display name (snapshot — survives if the user is renamed)
 *   - byId     — actor User._id (when we can identify them; null for System)
 *   - meta     — small bag for extra context (status change, sale price, etc.)
 *
 * `createdAt` doubles as the activity timestamp; no separate `at` field.
 */
@Schema({ timestamps: true, collection: 'activities' })
export class Activity {
  @Prop({ type: String, required: true, index: true })
  module: string;

  @Prop({ type: String, required: true })
  action: string;

  @Prop({ type: String, required: true })
  entity: string;

  @Prop({ type: String })
  entityId?: string;

  @Prop({ type: String, required: true })
  label: string;

  @Prop({ type: String, default: 'System' })
  by: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User' })
  byId?: Types.ObjectId;

  @Prop({ type: Object, default: {} })
  meta?: Record<string, any>;

  @Prop({ default: false })
  isDeleted: boolean;

  createdAt: Date;
  updatedAt: Date;
}

export const ActivitySchema = SchemaFactory.createForClass(Activity);

// Optimised for the dashboard's "most recent first" query.
ActivitySchema.index({ createdAt: -1 });
ActivitySchema.index({ module: 1, createdAt: -1 });
