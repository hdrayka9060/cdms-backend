import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type FacebookListingDocument = FacebookListing & Document;

/** Where a listing is published. Phase 1 ships `page`; `marketplace_catalog`
 *  and `group_manual` arrive in later phases (kept here so the enum is stable). */
export enum FacebookDestinationType {
  PAGE = 'page',
  MARKETPLACE_CATALOG = 'marketplace_catalog',
  GROUP_MANUAL = 'group_manual',
}

/** Canonical listing lifecycle (matches docs/FACEBOOK_LISTINGS_PLAN.md §3.5).
 *  Phase 1 exercises draft / active / failed / removed; scheduled / sold /
 *  expired are reserved for later phases. */
export enum FacebookListingStatus {
  DRAFT = 'draft',
  SCHEDULED = 'scheduled',
  ACTIVE = 'active',
  SOLD = 'sold',
  EXPIRED = 'expired',
  REMOVED = 'removed',
  FAILED = 'failed',
}

/**
 * One published (or draft) Facebook listing = one vehicle × one destination.
 * Selecting multiple destinations in the UI fans out to multiple rows so each
 * can carry its own Facebook post id / status independently.
 *
 * Content fields are snapshotted at create time (not joined from the vehicle)
 * so the listing reads correctly even if the vehicle later changes — mirrors
 * how `Sale` denormalises `vehicleTitle`.
 */
@Schema({ timestamps: true, collection: 'facebook_listings' })
export class FacebookListing {
  // Source vehicle. Schema.Types.ObjectId (never the runtime Types.ObjectId —
  // PROJECT_MEMORY §3). Used for the Listings filter + per-vehicle history.
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Vehicle', required: true })
  vehicle: Types.ObjectId;

  @Prop({ default: '' }) vehicleTitle: string;

  @Prop({
    type: String,
    enum: FacebookDestinationType,
    default: FacebookDestinationType.PAGE,
  })
  destinationType: FacebookDestinationType;

  // The connected Page this listing targets (for destinationType=page).
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'FacebookConnection' })
  connection: Types.ObjectId;

  // The target group (for destinationType=group_manual — assisted-manual paste).
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'FacebookGroupTarget' })
  groupTarget: Types.ObjectId;

  /** Denormalised destination label (Page / Group name) so the list renders
   *  without a populate/join. */
  @Prop({ default: '' }) destinationName: string;

  /** Denormalised destination URL — the Group URL for group_manual listings, so
   *  the "prepare & paste" flow can deep-link the user into the group composer. */
  @Prop({ default: '' }) destinationUrl: string;

  // ── Content (snapshotted) ────────────────────────────────────────────────
  @Prop({ required: true }) title: string;
  @Prop({ default: '' }) description: string;
  @Prop({ default: 0 }) price: number;
  @Prop({ type: [String], default: [] }) photos: string[];
  @Prop({ default: '' }) location: string;
  @Prop({ default: '' }) contact: string;

  @Prop({
    type: String,
    enum: FacebookListingStatus,
    default: FacebookListingStatus.DRAFT,
  })
  status: FacebookListingStatus;

  // ── Facebook-side identifiers (set on publish) ───────────────────────────
  @Prop({ default: '' }) fbPostId: string;
  @Prop({ default: '' }) fbPermalink: string;
  @Prop() scheduledAt: Date;
  @Prop() publishedAt: Date;
  @Prop({ default: '' }) lastError: string;

  // Current engagement snapshot (refreshed by the sync cron / on-demand). A
  // plain blob (no refs) so Mixed is fine; queries can still sort by
  // `engagement.reactions` for a future "best performing" view.
  @Prop({ type: Object, default: {} })
  engagement: {
    reactions?: number;
    comments?: number;
    shares?: number;
    views?: number;
    leads?: number;
    fetchedAt?: Date;
  };

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User' })
  createdBy: Types.ObjectId;

  @Prop({ default: false }) isDeleted: boolean;
  @Prop() deletedAt: Date;

  createdAt: Date;
  updatedAt: Date;
}

export const FacebookListingSchema = SchemaFactory.createForClass(FacebookListing);

FacebookListingSchema.index({ status: 1, isDeleted: 1 });
FacebookListingSchema.index({ vehicle: 1 });
FacebookListingSchema.index({ connection: 1 });
