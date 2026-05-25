import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type BuyerLeadDocument = BuyerLead & Document;
export enum BuyerLeadStage { NEW = 'new', CONTACTED = 'contacted', TEST_DRIVE = 'test_drive', NEGOTIATION = 'negotiation', PURCHASED = 'purchased', LOST = 'lost' }

@Schema({ timestamps: true, collection: 'buyer_leads' })
export class BuyerLead {
  @Prop({ required: true }) buyerName: string;
  @Prop({ required: true }) buyerEmail: string;
  @Prop({ required: true }) buyerPhone: string;
  @Prop({ default: '' }) notes: string;

  /**
   * Canonical list of vehicles the buyer is interested in. Drives the
   * "Vehicles Interested" section on the buyer detail page. Each entry is a
   * Vehicle ObjectId; populated on read for display.
   */
  @Prop({ type: [{ type: Types.ObjectId, ref: 'Vehicle' }], default: [] })
  interestedVehicles: Types.ObjectId[];

  /**
   * Legacy singular field — kept so pre-migration documents still render via
   * the mapper fallback. New writes go to `interestedVehicles[]` above.
   */
  @Prop({ type: Types.ObjectId, ref: 'Vehicle' }) interestedVehicle: Types.ObjectId;

  @Prop() budget: number;
  @Prop({ type: String, enum: BuyerLeadStage, default: BuyerLeadStage.NEW }) stage: BuyerLeadStage;
  @Prop({ type: Types.ObjectId, ref: 'User' }) assignedTo: Types.ObjectId;

  /** Test-drive bookings + other actions. */
  @Prop({ type: [{ vehicleId: String, vehicleTitle: String, action: String, date: Date }], default: [] }) history: any[];

  /**
   * Per-interaction communication log. Each entry has a channel, optional
   * vehicle context, and a short summary. Editable from the buyer detail page.
   *
   * NOTE: every subfield uses `{ type: X }` to avoid the Mongoose footgun
   * where `type: String` at the top of an array-element spec is read as the
   * SchemaType definition rather than a field name.
   */
  @Prop({
    type: [{
      at: { type: Date, default: Date.now },
      channel: { type: String, required: true },
      vehicle: { type: Types.ObjectId, ref: 'Vehicle' },
      vehicleTitle: { type: String },
      summary: { type: String, default: '' },
      by: { type: String },
      /** User ObjectId of the staff member responsible — drives the "by" label on the UI. */
      byStaff: { type: Types.ObjectId, ref: 'User' },
    }],
    default: [],
  })
  communications: {
    _id?: Types.ObjectId;
    at: Date;
    channel: string;
    vehicle?: Types.ObjectId;
    vehicleTitle?: string;
    summary: string;
    by?: string;
    byStaff?: Types.ObjectId;
  }[];

  /**
   * Confirmed purchases by this buyer. One entry per closed-and-won lead.
   * Drives the "Purchased" KPI on the buyer detail page.
   *
   * Subfield types use explicit `{ type: X }` form to dodge the Mongoose
   * footgun where `type: String` at the top of an array element is read as
   * the SchemaType definition.
   */
  @Prop({
    type: [{
      at: { type: Date, default: Date.now },
      vehicle: { type: Types.ObjectId, ref: 'Vehicle' },
      vehicleTitle: { type: String },
      soldAt: { type: Number, default: 0 },
      soldDate: { type: Date },
      paymentMethod: { type: String },
      paymentStatus: { type: String },
      leadId: { type: Types.ObjectId, ref: 'Lead' },
      saleId: { type: Types.ObjectId, ref: 'Sale' },
    }],
    default: [],
  })
  purchases: {
    _id?: Types.ObjectId;
    at: Date;
    vehicle?: Types.ObjectId;
    vehicleTitle?: string;
    soldAt: number;
    soldDate?: Date;
    paymentMethod?: string;
    paymentStatus?: string;
    leadId?: Types.ObjectId;
    saleId?: Types.ObjectId;
  }[];

  @Prop({ default: false }) isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const BuyerLeadSchema = SchemaFactory.createForClass(BuyerLead);
BuyerLeadSchema.index({ stage: 1, buyerEmail: 1 });
