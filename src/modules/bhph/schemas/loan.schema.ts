import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types, Schema as MongooseSchema } from 'mongoose';

export type LoanDocument = Loan & Document;

/**
 * Loan lifecycle:
 *   active    — being repaid.
 *   paid_off  — principal fully recovered.
 *   defaulted — overdue beyond the grace window (auto or manual).
 *   closed    — settled/written-off early; Sale + interest income KEPT.
 *   archived  — terminal reversal: car un-sold, Sale + income backed out.
 *               Excluded from all lists/calcs. NOT recoverable.
 */
export enum LoanStatus {
  ACTIVE = 'active',
  PAID_OFF = 'paid_off',
  DEFAULTED = 'defaulted',
  CLOSED = 'closed',
  ARCHIVED = 'archived',
}

/**
 * A single payment transaction against a loan. `installmentNo` (optional) is the
 * amortization month this payment is allocated to — the basis for per-month
 * paid/partial/overpaid/overdue state. Payments with no `installmentNo` are
 * applied oldest-unpaid-first when rolling up. `_id` is enabled so individual
 * payments can be edited/deleted/reallocated.
 */
@Schema({ _id: true })
export class LoanPayment {
  @Prop({ required: true }) amount: number;
  @Prop({ required: true, default: Date.now }) date: Date;
  @Prop({ default: 'cash' }) method: string;
  @Prop({ default: '' }) notes: string;
  @Prop({ default: '' }) receiptNumber: string;
  /** Amortization installment this payment pays toward (1-based). */
  @Prop() installmentNo?: number;
}
export const LoanPaymentSchema = SchemaFactory.createForClass(LoanPayment);

@Schema({ timestamps: true, collection: 'loans' })
export class Loan {
  @Prop({ required: true }) borrowerName: string;
  @Prop({ required: true }) borrowerEmail: string;
  @Prop({ required: true }) borrowerPhone: string;

  // Use MongooseSchema.Types.ObjectId (NOT the runtime `Types.ObjectId`) as the
  // schema type so string ids are cast to real ObjectIds on save — the runtime
  // constructor silently degrades to Mixed, leaving ids as un-castable strings
  // that break ObjectId queries + populate.
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Vehicle' }) vehicle: Types.ObjectId;
  @Prop({ required: true }) vehicleTitle: string;

  /**
   * Agreed sale price of the car. `principal` (below) is the financed amount =
   * salePrice − downPayment. Defaults to 0 for legacy loans created before the
   * down-payment model (their principal already equals the financed amount).
   */
  @Prop({ default: 0 }) salePrice: number;
  /** Amount paid up-front by the borrower; the rest is financed. */
  @Prop({ default: 0 }) downPayment: number;
  /** Financed amount the EMI schedule amortizes (= salePrice − downPayment). */
  @Prop({ required: true }) principal: number;

  @Prop({ required: true, min: 0, max: 100 }) interestRatePercent: number;
  @Prop({ required: true, min: 1 }) termMonths: number;
  @Prop() emiAmount: number;
  @Prop({ required: true }) startDate: Date;
  @Prop() endDate: Date;

  @Prop({ default: 0 }) totalPaid: number;
  @Prop({ type: String, enum: LoanStatus, default: LoanStatus.ACTIVE }) status: LoanStatus;
  @Prop({ type: [LoanPaymentSchema], default: [] }) payments: LoanPayment[];
  @Prop({ default: '' }) notes: string;

  // ── Ledger / CRM links (stored as ObjectId hex strings, matching the sales
  //    module's string-id convention; queried explicitly, not populated). ──
  /** Linked sales-ledger row (`sales` collection) so accounting stays in sync. */
  @Prop() saleId?: string;
  /** Originating lead, when created from a lead close. */
  @Prop() leadId?: string;
  /** CRM buyer this loan belongs to. */
  @Prop() buyerLeadId?: string;

  // ── Server-side scheduling state (drives reminders + overdue, Phase 2/3). ──
  /** Next unpaid installment's due date. Recomputed on every payment change. */
  @Prop() nextDueAt?: Date;
  /** Dedupe key for the due/overdue reminder cron. */
  @Prop() lastReminderAt?: Date;
  /** When the loan was auto/manually marked defaulted. */
  @Prop() defaultedAt?: Date;
  /** When the loan was archived (terminal reversal). */
  @Prop() archivedAt?: Date;

  @Prop({ default: false }) isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const LoanSchema = SchemaFactory.createForClass(Loan);
LoanSchema.index({ status: 1, borrowerEmail: 1 });
LoanSchema.index({ status: 1, nextDueAt: 1 }); // reminder cron scan
LoanSchema.index({ saleId: 1 });
LoanSchema.index({ leadId: 1 });
LoanSchema.index({ vehicle: 1 });
