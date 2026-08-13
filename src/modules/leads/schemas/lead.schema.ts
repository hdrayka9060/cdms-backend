import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type LeadDocument = Lead & Document;

export enum LeadSource {
  WEBSITE = 'website',
  GOOGLE_ADS = 'google_ads',
  META_ADS = 'meta_ads',
  REFERRAL = 'referral',
  WALK_IN = 'walk_in',
}

export enum LeadStatus {
  NEW = 'new',
  CONTACTED = 'contacted',
  TEST_DRIVE = 'test_drive',
  NEGOTIATION = 'negotiation',
  CLOSED = 'closed',
  /**
   * Terminal "no action needed" state. Set when a vehicle is sold to another
   * buyer (auto-archive of sibling inquiries), when a sale is reverted (the
   * previously-closed lead lands here instead of being deleted, so the audit
   * trail survives), or manually by staff to retire a stale inquiry.
   * Previously named "dropped".
   */
  ARCHIVED = 'archived',
}

export enum LeadChannel {
  CALL = 'call',
  EMAIL = 'email',
  WHATSAPP = 'whatsapp',
  SMS = 'sms',
  /** Walk-in / in-person / face-to-face — anything without a digital channel. */
  OFFLINE = 'offline',
  /** Public storefront form submission (Contact Us / Text Us Now). */
  WEBSITE = 'website',
}

@Schema({ timestamps: true, collection: 'leads' })
export class Lead {
  // NB: must use `MongooseSchema.Types.ObjectId` here, not `Types.ObjectId`.
  // The latter is the runtime constructor and Mongoose silently treats it as
  // a Mixed schema type — strings stay strings on save, and any subsequent
  // `{ vehicle: new Types.ObjectId(id) }` filter matches zero documents.
  // That bug masked the entire sibling-archive cascade for months.
  // Optional: walk-in leads have no buyer yet (a buyer can be assigned later).
  // When absent the lead displays as a "Walk-in". Guard 2 (buyer×vehicle
  // uniqueness) is skipped for buyer-less leads.
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'BuyerLead', required: false })
  buyer?: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Vehicle', required: true })
  vehicle: Types.ObjectId;

  @Prop({ type: String, enum: LeadSource, required: true })
  source: LeadSource;

  @Prop({ type: String, enum: LeadStatus, default: LeadStatus.NEW })
  status: LeadStatus;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User' })
  assignedTo: Types.ObjectId;

  @Prop({ default: '' })
  notes: string;

  /**
   * Price the buyer asked / offered for the vehicle. Setting it advances the
   * lead pipeline to "negotiation" (handled in LeadsService.update).
   */
  @Prop({ default: 0, min: 0 })
  askedPrice: number;

  @Prop({
    type: [{ date: Date, action: String, by: String }],
    default: [],
  })
  timeline: { date: Date; action: string; by: string }[];

  /**
   * Communication log — one entry per interaction (call / email / whatsapp /
   * sms / offline). Each entry can optionally reference a Vehicle the comm
   * was about and the staff member who performed it.
   *
   * Every subfield uses the explicit `{ type: X }` form so Mongoose doesn't
   * misread the inline shorthand around `vehicle` / `byStaff` refs.
   */
  @Prop({
    type: [{
      date: { type: Date, default: Date.now },
      channel: { type: String, enum: LeadChannel, required: true },
      summary: { type: String, default: '' },
      vehicle: { type: MongooseSchema.Types.ObjectId, ref: 'Vehicle' },
      vehicleTitle: { type: String },
      byStaff: { type: MongooseSchema.Types.ObjectId, ref: 'User' },
    }],
    default: [],
  })
  log: {
    _id?: Types.ObjectId;
    date: Date;
    channel: LeadChannel;
    summary: string;
    vehicle?: Types.ObjectId;
    vehicleTitle?: string;
    byStaff?: Types.ObjectId;
  }[];

  @Prop({ default: false })
  isDeleted: boolean;

  createdAt: Date;
  updatedAt: Date;
}

export const LeadSchema = SchemaFactory.createForClass(Lead);
LeadSchema.index({ status: 1, source: 1 });
LeadSchema.index({ assignedTo: 1 });
LeadSchema.index({ buyer: 1 });
LeadSchema.index({ vehicle: 1 });
// NOTE: no DB-level unique (buyer, vehicle) index. Uniqueness is enforced at the
// application layer by Guard 2 in LeadsService.create, which is *status-aware*:
// only a non-archived lead holds the buyer×vehicle slot, so archiving a lead
// releases it for a fresh one (archived is treated as deleted). A partial unique
// index can't express "status != archived" (partialFilterExpression forbids
// $ne), and an { isDeleted: false } filter alone wrongly blocks re-creation
// after archiving — the exact bug this replaces. LeadsMigrator drops the stale
// buyer_1_vehicle_1 unique index left on older databases.
