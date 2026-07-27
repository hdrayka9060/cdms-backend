import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type SellerLeadDocument = SellerLead & Document;

export enum SellerLeadStage {
  NEW = 'new',
  CONTACTED = 'contacted',
  INSPECTION = 'inspection',
  NEGOTIATION = 'negotiation',
  SOLD = 'sold',
  REJECTED = 'rejected',
}

@Schema({ timestamps: true, collection: 'seller_leads' })
export class SellerLead {
  @Prop({ required: true }) sellerName: string;
  @Prop({ required: true }) sellerEmail: string;
  @Prop({ required: true }) sellerPhone: string;
  @Prop({ default: '' }) notes: string;

  // Address — surfaced on seller cards / detail view
  @Prop({ default: '' }) address: string;
  @Prop({ default: '' }) city: string;
  @Prop({ default: '' }) state: string;
  @Prop({ default: '' }) zipCode: string;
  @Prop({ default: '' }) country: string;

  // Canonical seller → inventory relation. Each ObjectId is a real Vehicle in
  // the inventory collection, created via InventoryService when the seller
  // submits a car (either at seller-creation time or via the "Add Vehicle"
  // action on the detail page).
  @Prop({ type: [{ type: Types.ObjectId, ref: 'Vehicle' }], default: [] })
  vehicles: Types.ObjectId[];

  // Legacy embedded vehicle snapshot — kept for backward compatibility with
  // pre-multi-vehicle seller leads. New seller leads should use `vehicles[]`
  // above instead. Made optional so creation can skip vehicle info entirely.
  @Prop({ default: '' }) vehicleTitle: string;
  @Prop({ default: '' }) vehicleCompany: string;
  @Prop({ default: '' }) vehicleModel: string;
  @Prop({ default: 0 }) vehicleYear: number;
  @Prop({ default: 0 }) vehicleKm: number;
  @Prop({ default: 0 }) askingPrice: number;
  @Prop({ type: [String], default: [] }) vehiclePhotos: string[];

  @Prop({ type: String, enum: SellerLeadStage, default: SellerLeadStage.NEW }) stage: SellerLeadStage;
  @Prop() inspectionDate: Date;
  @Prop({ type: Types.ObjectId, ref: 'User' }) assignedTo: Types.ObjectId;
  /**
   * Logged communications (email / sms / whatsapp / call).
   *
   * Every subfield uses the explicit `{ type: X }` form. The previous shorthand
   * (`{ type: String, channel: String, ... }`) tripped the Mongoose footgun where
   * `type: String` at the top of an array-element spec makes Mongoose treat each
   * element as a plain String — so `$push`ing a full object silently failed. Same
   * rule the `activity[]` field below already follows.
   */
  @Prop({
    type: [{
      channel: { type: String, required: true },
      message: { type: String, required: true },
      sentAt: { type: Date, default: Date.now },
      sentBy: { type: String },
    }],
    default: [],
  })
  communications: { channel: string; message: string; sentAt: Date; sentBy?: string }[];

  /**
   * Audit / activity log. Each entry is one notable event on this seller —
   * created, vehicle added, inspection scheduled, fields edited, etc. Drives
   * the Activity Timeline on the seller detail page.
   *
   * NOTE: every subfield uses the explicit `{ type: X }` form to avoid the
   * Mongoose footgun where `type: String` at the top of an array-element spec
   * is interpreted as "this element is a String".
   */
  @Prop({
    type: [{
      at: { type: Date, default: Date.now },
      action: { type: String, required: true },
      label: { type: String, required: true },
      by: { type: String },
      meta: { type: Object },
    }],
    default: [],
  })
  activity: { at: Date; action: string; label: string; by?: string; meta?: any }[];

  @Prop({ default: false }) isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const SellerLeadSchema = SchemaFactory.createForClass(SellerLead);
SellerLeadSchema.index({ stage: 1, sellerEmail: 1 });
