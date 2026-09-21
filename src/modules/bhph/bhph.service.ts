import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model, isValidObjectId } from 'mongoose';
import { Loan, LoanDocument, LoanPayment, LoanStatus } from './schemas/loan.schema';
import { Lead, LeadDocument } from '../leads/schemas/lead.schema';
import { BuyerLead, BuyerLeadDocument } from '../crm-buyers/schemas/buyer-lead.schema';
import { Vehicle, VehicleDocument } from '../inventory/schemas/vehicle.schema';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { AmortizationRow, buildAmortization, EmiSolved, solveEmi } from './emi-math';
import { AccountingService } from '../accounting/accounting.service';
import { CrmBuyersService } from '../crm-buyers/crm-buyers.service';
import { ActivityService } from '../activity/activity.service';
import { MailService } from '../mail/mail.service';
import {
  NotificationEvent, BhphPaymentRecordedEvent, BhphPaymentDueEvent,
  BhphPaymentOverdueEvent, BhphLoanPaidOffEvent,
} from '../notifications/notification-events';

/** Borrower + vehicle + CRM links resolved from a create payload. */
interface ResolvedParties {
  borrowerName: string;
  borrowerEmail: string;
  borrowerPhone: string;
  vehicleId?: string;
  vehicleTitle?: string;
  buyerLeadId?: string;
  leadId?: string;
}

/** Per-installment payment state, drives the color-coded schedule grid. */
export type InstallmentState = 'paid' | 'overpaid' | 'partial' | 'overdue' | 'upcoming';

export interface ScheduleRow extends AmortizationRow {
  /** Total allocated to this installment (explicit + waterfall from unallocated). */
  paidAmount: number;
  /** Remaining due on this installment (0 when paid/overpaid). */
  remaining: number;
  state: InstallmentState;
  /** True when not fully paid AND past due — lets the UI flag a late partial. */
  isLate: boolean;
  /** Payments explicitly allocated to this installment. */
  payments: any[];
}

export interface LoanAnalysis {
  rows: ScheduleRow[];
  totalScheduled: number; // Σ EMI over the whole term (principal + interest)
  totalInterest: number;
  totalPaid: number; // Σ of every payment amount
  principalCollected: number; // portion of payments applied to principal (for Phase 3 sale sync)
  interestCollected: number;
  nextDueAt?: Date;
  overdueCount: number;
  derivedStatus: LoanStatus; // active | defaulted | paid_off (never closed/archived here)
}

const EPS = 0.005;
/** Days past an installment's due date before the loan auto-defaults. */
const DEFAULT_GRACE_DAYS = 60;

@Injectable()
export class BhphService {
  private readonly logger = new Logger(BhphService.name);

  constructor(
    @InjectModel(Loan.name) private model: Model<LoanDocument>,
    @InjectModel(Lead.name) private leadModel: Model<LeadDocument>,
    @InjectModel(BuyerLead.name) private buyerModel: Model<BuyerLeadDocument>,
    @InjectModel(Vehicle.name) private vehicleModel: Model<VehicleDocument>,
    private readonly accounting: AccountingService,
    private readonly crmBuyers: CrmBuyersService,
    private readonly activity: ActivityService,
    private readonly mail: MailService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Resolve borrower + vehicle + CRM links for a new loan from one of:
   *   - `leadId`     → auto-fill buyer + vehicle from the lead.
   *   - `buyerLeadId`→ existing CRM buyer supplies borrower contact.
   *   - `newBuyer*`  → create (or link, if the email exists) a CRM buyer inline.
   *   - explicit borrower* fields (walk-in style) as a fallback.
   * Vehicle comes from the lead or an explicit `vehicle`/`vehicleId`; its title
   * is looked up when not supplied.
   */
  private async resolveParties(dto: any): Promise<ResolvedParties> {
    // 1. From a lead — the richest source (buyer + vehicle in one).
    if (dto.leadId && isValidObjectId(dto.leadId)) {
      const lead = await this.leadModel
        .findOne({ _id: dto.leadId, isDeleted: false })
        .populate('buyer', 'buyerName buyerEmail buyerPhone')
        .populate('vehicle', 'title');
      if (!lead) throw new NotFoundException('Lead not found');
      const buyer: any = lead.buyer;
      const vehicle: any = lead.vehicle;
      if (!buyer || typeof buyer === 'string') {
        throw new BadRequestException('This lead has no buyer — assign one before creating a loan.');
      }
      return {
        borrowerName: buyer.buyerName,
        borrowerEmail: buyer.buyerEmail,
        borrowerPhone: buyer.buyerPhone,
        vehicleId: vehicle?._id ? String(vehicle._id) : undefined,
        vehicleTitle: vehicle?.title ?? dto.vehicleTitle,
        buyerLeadId: String(buyer._id),
        leadId: String(lead._id),
      };
    }

    // 2. Resolve the buyer (existing id, inline create, or explicit contact).
    let buyerLeadId: string | undefined = dto.buyerLeadId && isValidObjectId(dto.buyerLeadId) ? dto.buyerLeadId : undefined;
    let borrowerName = dto.borrowerName;
    let borrowerEmail = dto.borrowerEmail;
    let borrowerPhone = dto.borrowerPhone;

    if (buyerLeadId) {
      const b = await this.buyerModel.findOne({ _id: buyerLeadId, isDeleted: false }).select('buyerName buyerEmail buyerPhone');
      if (!b) throw new NotFoundException('Buyer not found');
      borrowerName = b.buyerName; borrowerEmail = b.buyerEmail; borrowerPhone = b.buyerPhone;
    } else if ((dto.newBuyerEmail ?? '').trim()) {
      buyerLeadId = await this.resolveOrCreateBuyer(dto.newBuyerName, dto.newBuyerEmail, dto.newBuyerPhone);
      const b = await this.buyerModel.findById(buyerLeadId).select('buyerName buyerEmail buyerPhone');
      if (b) { borrowerName = b.buyerName; borrowerEmail = b.buyerEmail; borrowerPhone = b.buyerPhone; }
    }

    // 3. Vehicle + title.
    const vehicleId = dto.vehicle || dto.vehicleId;
    let vehicleTitle = dto.vehicleTitle;
    if (vehicleId && isValidObjectId(vehicleId) && !vehicleTitle) {
      const v = await this.vehicleModel.findById(vehicleId).select('title');
      vehicleTitle = v?.title;
    }

    return {
      borrowerName, borrowerEmail, borrowerPhone,
      vehicleId: vehicleId && isValidObjectId(vehicleId) ? String(vehicleId) : undefined,
      vehicleTitle,
      buyerLeadId,
      leadId: undefined,
    };
  }

  /** Create a CRM buyer inline, or link to the existing one if the email is taken. */
  private async resolveOrCreateBuyer(name?: string, email?: string, phone?: string): Promise<string> {
    const cleanEmail = (email ?? '').trim();
    const cleanPhone = (phone ?? '').trim();
    if (!cleanPhone) throw new BadRequestException('Buyer phone is required to add a new buyer.');
    try {
      const buyer: any = await this.crmBuyers.create({
        buyerName: (name ?? '').trim() || 'Walk-in',
        buyerEmail: cleanEmail,
        buyerPhone: cleanPhone,
      } as any);
      return String(buyer._id ?? buyer.id);
    } catch (err) {
      if (err instanceof ConflictException) {
        const existing = await this.buyerModel.findOne({ buyerEmail: cleanEmail, isDeleted: false }).select('_id');
        if (existing) return String(existing._id);
      }
      throw err;
    }
  }

  /**
   * Resolve the financed amount + solved EMI trio from a create/update-style
   * payload. Derives `principal` from `salePrice − downPayment` when principal
   * isn't given directly, then fills in whichever of rate/term/EMI is missing.
   * Solver errors (unsolvable inputs, <2 provided) surface as clean 400s.
   */
  private resolveLoanTerms(dto: any): { principal: number; downPayment: number; salePrice: number } & EmiSolved {
    const downPayment = Math.max(0, Number(dto.downPayment) || 0);
    let principal = dto.principal !== undefined && dto.principal !== null && dto.principal !== ''
      ? Number(dto.principal)
      : undefined;
    const salePrice = dto.salePrice !== undefined && dto.salePrice !== null && dto.salePrice !== ''
      ? Number(dto.salePrice)
      : undefined;
    if ((principal === undefined || Number.isNaN(principal)) && salePrice !== undefined) {
      principal = Math.max(0, salePrice - downPayment);
    }
    if (principal === undefined || Number.isNaN(principal) || principal <= 0) {
      throw new BadRequestException('A positive principal (or salePrice) is required.');
    }
    try {
      const solved = solveEmi({
        principal,
        interestRatePercent: dto.interestRatePercent,
        termMonths: dto.termMonths,
        emiAmount: dto.emiAmount,
      });
      return { ...solved, downPayment, salePrice: salePrice ?? principal + downPayment };
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : 'Invalid loan terms');
    }
  }

  /** Preview the solved EMI trio (rate/term/EMI) without persisting. */
  previewEmi(dto: any): { principal: number; downPayment: number; salePrice: number } & EmiSolved {
    return this.resolveLoanTerms(dto);
  }

  // ── Allocation engine ─────────────────────────────────────────────────────
  /**
   * The single source of truth for a loan's payment state. Builds the
   * amortization schedule, allocates every payment to an installment (explicit
   * `installmentNo` first, then unallocated payments waterfall oldest-unpaid
   * first), derives each month's state (paid/partial/overpaid/overdue/upcoming),
   * and rolls up loan-level figures (totalPaid, principal/interest collected,
   * nextDueAt, derived status). Pure read over the hydrated payments array.
   */
  private analyze(loan: LoanDocument, now: Date = new Date()): LoanAnalysis {
    const rows = buildAmortization(
      loan.principal,
      loan.interestRatePercent,
      loan.termMonths,
      loan.emiAmount,
      loan.startDate,
    );
    const n = rows.length;
    const payments = (loan.payments ?? []) as any[];

    // Explicit allocation.
    const allocated = new Array(n + 1).fill(0); // 1-based
    const byInst: Record<number, any[]> = {};
    const unallocated: any[] = [];
    for (const p of payments) {
      const amt = Number(p.amount) || 0;
      const inst = Number(p.installmentNo);
      if (inst >= 1 && inst <= n) {
        allocated[inst] += amt;
        (byInst[inst] ||= []).push(p);
      } else {
        unallocated.push(p);
      }
    }

    // Waterfall unallocated payments over remaining dues, oldest month first.
    // Interest-bearing (normal) payments fill first; principal-only "payoff"
    // payments (early payoff — future interest waived) fill afterward and are
    // tracked in payoffPaid[] so they never count as collected interest.
    const paid = allocated.slice();
    const payoffPaid = new Array(n + 1).fill(0); // 1-based; principal-only portion
    const isPayoffPay = (p: any) => (p?.method ?? '') === 'payoff';
    const fillPool = (amount: number, track: number[] | null) => {
      let pool = amount;
      for (let i = 1; i <= n && pool > EPS; i++) {
        const remaining = Math.max(0, rows[i - 1].emiAmount - paid[i]);
        const fill = Math.min(pool, remaining);
        paid[i] += fill;
        if (track) track[i] += fill;
        pool -= fill;
      }
      // Any leftover credit lands on the final installment as an overpayment.
      if (pool > EPS && n > 0) { paid[n] += pool; if (track) track[n] += pool; }
    };
    fillPool(unallocated.filter((p) => !isPayoffPay(p)).reduce((s, p) => s + (Number(p.amount) || 0), 0), null);
    fillPool(unallocated.filter(isPayoffPay).reduce((s, p) => s + (Number(p.amount) || 0), 0), payoffPaid);

    let principalCollected = 0;
    let interestCollected = 0;
    let overdueCount = 0;
    let nextDueAt: Date | undefined;
    const scheduleRows: ScheduleRow[] = rows.map((r, idx) => {
      const i = idx + 1;
      const paidAmount = Math.round(paid[i] * 100) / 100;
      const remaining = Math.max(0, Math.round((r.emiAmount - paidAmount) * 100) / 100);
      const past = r.dueDate.getTime() < now.getTime();

      // Split what's paid on this row into interest-first, then principal
      // (interest is earned before principal is reduced). A payoff payment's
      // portion is principal-only, so exclude it from the interest-eligible base.
      const payoffAmount = Math.round(payoffPaid[i] * 100) / 100;
      const interestEligible = Math.max(0, paidAmount - payoffAmount);
      const interestPaid = Math.min(interestEligible, r.interestPart);
      const principalPaid = Math.max(0, paidAmount - interestPaid);
      interestCollected += interestPaid;
      principalCollected += principalPaid;

      let state: InstallmentState;
      if (paidAmount >= r.emiAmount + EPS) state = 'overpaid';
      else if (paidAmount >= r.emiAmount - EPS) state = 'paid';
      else if (paidAmount > EPS) state = 'partial';
      else state = past ? 'overdue' : 'upcoming';

      const isLate = remaining > EPS && past;
      if (isLate) overdueCount++;
      if (!nextDueAt && remaining > EPS) nextDueAt = r.dueDate;

      return {
        ...r,
        paidAmount,
        remaining,
        state,
        isLate,
        payments: (byInst[i] ?? []).map((p) => ({
          _id: p._id,
          amount: p.amount,
          date: p.date,
          method: p.method,
          receiptNumber: p.receiptNumber,
          notes: p.notes,
          installmentNo: p.installmentNo,
        })),
      };
    });

    const totalScheduled = Math.round(rows.reduce((s, r) => s + r.emiAmount, 0) * 100) / 100;
    const totalInterest = Math.round(rows.reduce((s, r) => s + r.interestPart, 0) * 100) / 100;
    const totalPaid = Math.round(payments.reduce((s, p) => s + (Number(p.amount) || 0), 0) * 100) / 100;

    // Derived status (never overrides a terminal closed/archived — callers guard).
    let derivedStatus: LoanStatus = LoanStatus.ACTIVE;
    if (totalPaid + EPS >= totalScheduled && totalScheduled > 0) {
      derivedStatus = LoanStatus.PAID_OFF;
    } else if (nextDueAt) {
      const daysLate = (now.getTime() - nextDueAt.getTime()) / 86_400_000;
      if (daysLate > DEFAULT_GRACE_DAYS) derivedStatus = LoanStatus.DEFAULTED;
    }

    return {
      rows: scheduleRows,
      totalScheduled,
      totalInterest,
      totalPaid,
      principalCollected: Math.round(principalCollected * 100) / 100,
      interestCollected: Math.round(interestCollected * 100) / 100,
      nextDueAt,
      overdueCount,
      derivedStatus,
    };
  }

  /**
   * Recompute cached fields (totalPaid, status, nextDueAt, defaultedAt) from the
   * payments array and save. Terminal statuses (closed/archived) are preserved —
   * only active/defaulted/paid_off are (re)derived. Returns the saved doc.
   */
  private async recomputeAndSave(loan: LoanDocument): Promise<LoanDocument> {
    const a = this.analyze(loan);
    loan.totalPaid = a.totalPaid;
    loan.nextDueAt = a.nextDueAt;
    if (loan.status !== LoanStatus.CLOSED && loan.status !== LoanStatus.ARCHIVED) {
      loan.status = a.derivedStatus;
      if (a.derivedStatus === LoanStatus.DEFAULTED && !loan.defaultedAt) {
        loan.defaultedAt = new Date();
      } else if (a.derivedStatus !== LoanStatus.DEFAULTED) {
        loan.defaultedAt = undefined;
      }
    }
    const saved = await loan.save();
    // Keep the linked sale's outstanding + the interest-income ledger in step
    // with the new payment state (no-op when the loan has no linked sale).
    await this.syncLoanFinancials(saved);
    return saved;
  }

  private async loadLoan(id: string): Promise<LoanDocument> {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid loan id');
    const loan = await this.model.findOne({ _id: id, isDeleted: false });
    if (!loan) throw new NotFoundException('Loan not found');
    return loan;
  }

  async create(dto: any): Promise<LoanDocument> {
    const parties = await this.resolveParties(dto);
    if (!parties.borrowerName || !parties.borrowerEmail || !parties.borrowerPhone) {
      throw new BadRequestException(
        'Borrower name, email and phone are required — pick a lead/buyer or enter new-buyer details.',
      );
    }
    const { principal, downPayment, salePrice, interestRatePercent, termMonths, emiAmount } =
      this.resolveLoanTerms(dto);
    const startDate = dto.startDate ? new Date(dto.startDate) : new Date();
    const endDate = new Date(startDate);
    endDate.setMonth(endDate.getMonth() + termMonths);
    const loan = await new this.model({
      borrowerName: parties.borrowerName,
      borrowerEmail: parties.borrowerEmail,
      borrowerPhone: parties.borrowerPhone,
      vehicle: parties.vehicleId,
      vehicleTitle: parties.vehicleTitle,
      salePrice,
      downPayment,
      principal,
      interestRatePercent,
      termMonths,
      emiAmount,
      startDate,
      endDate,
      // Repayment of the FINANCED principal only. The down payment already
      // reduced `principal` (= salePrice − downPayment), so it is not an EMI
      // repayment and must not seed totalPaid (that would falsely fill the
      // installment grid). EMI payments accrue here from 0.
      totalPaid: 0,
      leadId: parties.leadId || undefined,
      buyerLeadId: parties.buyerLeadId || undefined,
      saleId: dto.saleId || undefined,
      notes: dto.notes || '',
    }).save();

    // linkSaleForLoan reads vehicle/buyer/lead from the resolved parties.
    await this.linkSaleForLoan(loan, { ...dto, vehicle: parties.vehicleId });
    // Seed nextDueAt so the reminder cron can see a brand-new (never-paid) loan.
    loan.nextDueAt = this.analyze(loan).nextDueAt;
    await loan.save();
    await this.activity.log({
      module: 'bhph',
      action: 'created',
      entity: 'Loan',
      entityId: loan._id,
      label: `BHPH loan · ${loan.borrowerName} · ${loan.vehicleTitle ?? 'vehicle'} · $${loan.principal.toLocaleString()} @ ${loan.emiAmount.toFixed(2)}/mo`,
      meta: { principal: loan.principal, emi: loan.emiAmount, termMonths: loan.termMonths },
    });
    return loan;
  }

  /**
   * Edit loan terms (borrower, price, down payment, rate/term/EMI, start date,
   * notes). Re-solves the EMI trio from the effective values, rebuilds the
   * schedule + end date, then re-syncs the linked sale + interest income.
   */
  async update(id: string, dto: any): Promise<LoanDocument> {
    const loan = await this.loadLoan(id);
    this.assertMutable(loan);

    const salePrice = dto.salePrice != null ? Number(dto.salePrice) : loan.salePrice;
    const downPayment = dto.downPayment != null ? Number(dto.downPayment) : loan.downPayment;
    const principal = dto.principal != null ? Number(dto.principal) : Math.max(0, salePrice - downPayment);

    // Choose the EMI pair from what the caller supplied, filling from the loan.
    const hasRate = dto.interestRatePercent != null;
    const hasTerm = dto.termMonths != null;
    const hasEmi = dto.emiAmount != null;
    let solveInput: any;
    if (hasEmi && !hasRate && !hasTerm) solveInput = { principal, termMonths: loan.termMonths, emiAmount: dto.emiAmount };
    else if (hasEmi && hasTerm && !hasRate) solveInput = { principal, termMonths: dto.termMonths, emiAmount: dto.emiAmount };
    else if (hasEmi && hasRate && !hasTerm) solveInput = { principal, interestRatePercent: dto.interestRatePercent, emiAmount: dto.emiAmount };
    else solveInput = { principal, interestRatePercent: dto.interestRatePercent ?? loan.interestRatePercent, termMonths: dto.termMonths ?? loan.termMonths };

    let solved;
    try { solved = solveEmi(solveInput); }
    catch (err) { throw new BadRequestException(err instanceof Error ? err.message : 'Invalid loan terms'); }

    if (dto.borrowerName != null) loan.borrowerName = dto.borrowerName;
    if (dto.borrowerEmail != null) loan.borrowerEmail = dto.borrowerEmail;
    if (dto.borrowerPhone != null) loan.borrowerPhone = dto.borrowerPhone;
    if (dto.notes != null) loan.notes = dto.notes;
    if (dto.startDate != null) loan.startDate = new Date(dto.startDate);
    loan.salePrice = salePrice;
    loan.downPayment = downPayment;
    loan.principal = solved.principal;
    loan.interestRatePercent = solved.interestRatePercent;
    loan.termMonths = solved.termMonths;
    loan.emiAmount = solved.emiAmount;
    const endDate = new Date(loan.startDate);
    endDate.setMonth(endDate.getMonth() + solved.termMonths);
    loan.endDate = endDate;

    const saved = await this.recomputeAndSave(loan); // re-syncs sale + income
    await this.activity.log({
      module: 'bhph', action: 'updated', entity: 'Loan', entityId: saved._id,
      label: `BHPH loan edited · ${saved.borrowerName} · $${saved.principal.toLocaleString()} @ ${saved.emiAmount.toFixed(2)}/mo`,
    });
    return saved;
  }

  /**
   * Close a loan. `outcome` picks how:
   *   - 'payoff'   — borrower settles the remaining PRINCIPAL now (future
   *                  interest waived). Records a principal-only payoff payment
   *                  (→ sale becomes paid), sets status paid_off, and optionally
   *                  books an early-closure `earlyClosureFee` as 'other' income.
   *   - 'defaulted'— borrower stopped paying; keep whatever was collected (down
   *                  payment + payments + booked interest), just stop reminders.
   *   - (default)  — legacy settle/write-off: status closed, sale + income kept.
   * The linked sale + interest income are only ever backed out by `archive`.
   */
  async close(id: string, dto: any = {}): Promise<LoanDocument> {
    const loan = await this.loadLoan(id);
    if (loan.status === LoanStatus.ARCHIVED) throw new BadRequestException('This loan is archived.');
    const outcome = (dto?.outcome ?? '').toString();

    if (outcome === 'defaulted') {
      loan.status = LoanStatus.DEFAULTED;
      loan.defaultedAt = new Date();
      loan.nextDueAt = undefined;
      if (dto?.note) loan.notes = `${loan.notes ? loan.notes + '\n' : ''}Defaulted: ${dto.note}`;
      const saved = await loan.save();
      await this.activity.log({
        module: 'bhph', action: 'defaulted', entity: 'Loan', entityId: saved._id,
        label: `BHPH loan marked defaulted · ${saved.borrowerName} · ${saved.vehicleTitle ?? 'vehicle'}`,
      });
      return saved;
    }

    if (outcome === 'payoff') {
      const a = this.analyze(loan);
      const remainingPrincipal = Math.max(0, Math.round((loan.principal - a.principalCollected) * 100) / 100);
      if (remainingPrincipal > EPS) {
        loan.payments.push(
          this.toPayment({ amount: remainingPrincipal, method: 'payoff', notes: dto?.note || 'Early payoff (remaining principal)' }),
        );
      }
      // Re-sync the sale (→ paid) + income; the payoff payment books no interest.
      await this.recomputeAndSave(loan);
      loan.status = LoanStatus.PAID_OFF;
      loan.nextDueAt = undefined;
      const saved = await loan.save();
      const fee = Math.max(0, Number(dto?.earlyClosureFee) || 0);
      if (fee > 0) {
        await this.accounting
          .bookOther({
            loanId: String(saved._id),
            title: `Early closure fee · ${saved.borrowerName || 'Borrower'}`,
            amount: fee,
            source: 'bhph-early-closure-fee',
          })
          .catch((err) => this.logger.error(`early-closure fee booking failed: ${err instanceof Error ? err.message : err}`));
      }
      await this.activity.log({
        module: 'bhph', action: 'paid_off', entity: 'Loan', entityId: saved._id,
        label: `BHPH loan paid off early · ${saved.borrowerName} · ${saved.vehicleTitle ?? 'vehicle'}${fee > 0 ? ` (+$${fee.toLocaleString()} fee)` : ''}`,
      });
      return saved;
    }

    loan.status = LoanStatus.CLOSED;
    loan.nextDueAt = undefined;
    const saved = await loan.save();
    await this.activity.log({
      module: 'bhph', action: 'closed', entity: 'Loan', entityId: saved._id,
      label: `BHPH loan closed · ${saved.borrowerName} · ${saved.vehicleTitle ?? 'vehicle'}`,
    });
    return saved;
  }

  /**
   * Archive a loan — TERMINAL, unrecoverable financial reversal:
   *   1. Un-sell the car (status → available, clear soldAt/soldDate).
   *   2. Soft-delete the linked Sale + pull the buyer's purchase entry.
   *   3. Soft-delete the loan's interest-income rows.
   * All financials (ledger / accounting / dashboard) back out automatically.
   */
  async archive(id: string): Promise<LoanDocument> {
    const loan = await this.loadLoan(id);
    if (loan.status === LoanStatus.ARCHIVED) throw new BadRequestException('Loan is already archived.');

    const vehicleId = loan.vehicle ? String(loan.vehicle) : undefined;
    if (vehicleId && isValidObjectId(vehicleId)) {
      // Soft-delete the sale(s) for this vehicle + pull buyer purchases. Leads
      // are left as-is (archiveLeads:false) — the dealer manages those.
      await this.accounting.cleanupSoldArtifacts(vehicleId, { archiveLeads: false });
      // Put the car back on the lot.
      await this.vehicleModel.updateOne(
        { _id: vehicleId, isDeleted: false },
        { $set: { status: '' }, $unset: { soldAt: '', soldDate: '' } },
      );
    }
    // Back out the interest income.
    await this.accounting.removeLoanIncome(String(loan._id));

    loan.status = LoanStatus.ARCHIVED;
    loan.archivedAt = new Date();
    loan.nextDueAt = undefined;
    const saved = await loan.save(); // NOT recomputeAndSave — must not re-book income
    await this.activity.log({
      module: 'bhph', action: 'archived', entity: 'Loan', entityId: saved._id,
      label: `BHPH loan archived (sale reversed, car un-sold) · ${saved.borrowerName} · ${saved.vehicleTitle ?? 'vehicle'}`,
    });
    return saved;
  }

  /**
   * Ensure the loan is backed by a sales-ledger row so accounting/dashboard stay
   * in sync. If `saleId` was already supplied (close-lead / mark-sold path), just
   * run the initial sync. Otherwise, when a real vehicle is attached, create a
   * BHPH Sale via AccountingService (down payment = amount already collected); on
   * a duplicate-sale conflict, link to the existing sale instead of double-booking.
   * Best-effort: a failure here never blocks loan creation.
   */
  private async linkSaleForLoan(loan: LoanDocument, dto: any): Promise<void> {
    try {
      if (loan.saleId) { await this.syncLoanFinancials(loan); return; }
      const vehicleId = dto.vehicle || dto.vehicleId;
      if (!vehicleId || !isValidObjectId(vehicleId)) return; // no vehicle → no sale
      const net = Math.max(0, loan.salePrice);
      const paymentStatus = loan.downPayment >= net - 0.005 ? 'paid' : 'partial';
      // Source the vehicle's cost price for accurate P&L unless caller provided one.
      let costPrice = Number(dto.costPrice) || 0;
      if (!costPrice) {
        const v = await this.vehicleModel.findById(vehicleId).select('costPrice');
        costPrice = Number((v as any)?.costPrice) || 0;
      }
      try {
        const sale = await this.accounting.createSale({
          vehicleId,
          vehicleTitle: loan.vehicleTitle,
          buyerName: loan.borrowerName || 'BHPH Borrower',
          buyerEmail: loan.borrowerEmail || 'pending@example.com',
          salePrice: loan.salePrice,
          costPrice,
          discount: 0,
          amountPaid: loan.downPayment,
          paymentStatus,
          paymentMethod: 'bhph',
          saleDate: loan.startDate,
          buyerLeadId: loan.buyerLeadId,
          leadId: loan.leadId,
          actorName: dto.actorName,
          actorId: dto.actorId,
          notes: `BHPH financing · loan ${loan._id}`,
        });
        loan.saleId = String(sale._id);
      } catch (err) {
        if (err instanceof ConflictException) {
          // A sale already exists for this vehicle — link the loan to it.
          const existingId = await this.accounting.findLiveSaleIdByVehicle(vehicleId);
          if (existingId) loan.saleId = existingId;
        } else {
          throw err;
        }
      }
      if (loan.saleId) {
        await loan.save();
        await this.syncLoanFinancials(loan);
      }
    } catch (err) {
      this.logger.error(
        `linkSaleForLoan failed for loan ${loan._id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Archive every active loan for a vehicle (income backed out, status archived)
   * WITHOUT touching the vehicle/sale — the caller (InventoryService.markUnsold)
   * owns the sale soft-delete + un-selling the car. Returns how many archived.
   */
  async archiveLoansForVehicle(vehicleId: string): Promise<number> {
    if (!isValidObjectId(vehicleId)) return 0;
    const loans = await this.model.find({
      vehicle: vehicleId,
      isDeleted: false,
      status: { $nin: [LoanStatus.ARCHIVED] },
    });
    for (const loan of loans) {
      await this.accounting.removeLoanIncome(String(loan._id));
      loan.status = LoanStatus.ARCHIVED;
      loan.archivedAt = new Date();
      loan.nextDueAt = undefined;
      await loan.save();
      await this.activity.log({
        module: 'bhph', action: 'archived', entity: 'Loan', entityId: loan._id,
        label: `BHPH loan archived (vehicle un-sold) · ${loan.borrowerName} · ${loan.vehicleTitle ?? 'vehicle'}`,
      });
    }
    return loans.length;
  }

  /**
   * Push the loan's collected principal onto the linked Sale (shrinks
   * outstanding) and mirror its collected interest into the income ledger.
   * No-op for loans with no linked sale (e.g. legacy/seed loans) so they never
   * touch accounting. Best-effort — never throws into the payment write.
   */
  private async syncLoanFinancials(loan: LoanDocument): Promise<void> {
    if (!loan.saleId) return;
    try {
      const a = this.analyze(loan);
      const net = Math.max(0, loan.salePrice);
      const principalCollected = Math.min(loan.principal, a.principalCollected);
      let amountPaid = Math.min(net, (loan.downPayment || 0) + principalCollected);
      // Absorb cent-level amortization rounding: within $1 of the full price
      // counts as paid off (otherwise the sale would sit at "partial" forever).
      let status: 'paid' | 'partial' | 'pending';
      if (net - amountPaid < 1) { amountPaid = net; status = 'paid'; }
      else status = amountPaid > 0.005 ? 'partial' : 'pending';
      // Pass salePrice so an updated loan price keeps the linked sale in lockstep.
      await this.accounting.syncSalePayment(loan.saleId, { salePrice: loan.salePrice, amountPaid, paymentStatus: status });

      const interest = this.attributeInterest(loan).map((r) => ({
        paymentId: r.paymentId,
        date: r.date,
        amount: r.amount,
        title: `BHPH interest · ${loan.borrowerName || 'Borrower'}`,
      }));
      await this.accounting.syncLoanInterestIncome(String(loan._id), interest);
    } catch (err) {
      this.logger.error(
        `syncLoanFinancials failed for loan ${loan._id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Attribute each payment's interest portion. Explicit-allocated payments are
   * applied to their installment first (interest-first within the month), then
   * unallocated payments waterfall oldest-remaining first — mirroring the
   * allocation used for state. The sum of per-payment interest equals the loan's
   * total collected interest, and each row carries the payment's date so income
   * is recognized in the right period.
   */
  private attributeInterest(loan: LoanDocument): { paymentId: string; date: Date; amount: number }[] {
    const rows = buildAmortization(loan.principal, loan.interestRatePercent, loan.termMonths, loan.emiAmount, loan.startDate);
    const n = rows.length;
    const filled = new Array(n).fill(0);
    const interestFilled = new Array(n).fill(0);
    const applyTo = (i: number, amount: number): number => {
      const cap = Math.max(0, rows[i].emiAmount - filled[i]);
      const amt = Math.min(amount, cap);
      const interestRemaining = Math.max(0, rows[i].interestPart - interestFilled[i]);
      const interestShare = Math.min(amt, interestRemaining);
      interestFilled[i] += interestShare;
      filled[i] += amt;
      return interestShare;
    };
    const byDate = (a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime();
    const payments = [...((loan.payments as any[]) ?? [])];
    const isAlloc = (p: any) => Number(p.installmentNo) >= 1 && Number(p.installmentNo) <= n;
    const interestByPayment = new Map<string, number>();
    const add = (id: string, v: number) => interestByPayment.set(id, (interestByPayment.get(id) || 0) + v);

    for (const p of payments.filter(isAlloc).sort(byDate)) {
      add(String(p._id), applyTo(Number(p.installmentNo) - 1, Number(p.amount) || 0));
    }
    for (const p of payments.filter((x) => !isAlloc(x)).sort(byDate)) {
      const isPayoff = (p?.method ?? '') === 'payoff';
      let remain = Number(p.amount) || 0;
      let acc = 0;
      for (let i = 0; i < n && remain > EPS; i++) {
        const cap = rows[i].emiAmount - filled[i];
        if (cap <= EPS) continue;
        const applied = Math.min(remain, cap);
        // Payoff = principal-only: consume the installment's capacity so later
        // payments see the right remaining, but book zero interest on it.
        if (isPayoff) filled[i] += applied;
        else acc += applyTo(i, applied);
        remain -= applied;
      }
      add(String(p._id), acc);
    }

    const out: { paymentId: string; date: Date; amount: number }[] = [];
    for (const p of payments) {
      const amt = interestByPayment.get(String(p._id)) || 0;
      if (amt > EPS) out.push({ paymentId: String(p._id), date: p.date, amount: Math.round(amt * 100) / 100 });
    }
    return out;
  }

  async findAll(query: any): Promise<PaginatedResult<LoanDocument>> {
    const { page = 1, limit = 20, status, sort = '-createdAt' } = query;
    const skip = (page - 1) * limit;
    const filter: any = { isDeleted: false };
    // Archived loans are terminal + excluded from all lists/calcs unless asked for.
    if (status) filter.status = status;
    else filter.status = { $ne: LoanStatus.ARCHIVED };
    const sortObj: any = sort.startsWith('-') ? { [sort.slice(1)]: -1 } : { [sort]: 1 };
    const [data, total] = await Promise.all([this.model.find(filter).sort(sortObj).skip(skip).limit(limit).populate('vehicle', 'title vehicleNumber').lean(), this.model.countDocuments(filter)]);
    return new PaginatedResult(data as unknown as LoanDocument[], total, page, limit);
  }

  async findById(id: string): Promise<{ loan: LoanDocument; schedule: ScheduleRow[]; summary: any }> {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid loan id');
    const loan = await this.model.findOne({ _id: id, isDeleted: false }).populate('vehicle');
    if (!loan) throw new NotFoundException('Loan not found');
    const a = this.analyze(loan);
    return {
      loan,
      schedule: a.rows,
      summary: {
        totalScheduled: a.totalScheduled,
        totalInterest: a.totalInterest,
        totalPaid: a.totalPaid,
        principalCollected: a.principalCollected,
        interestCollected: a.interestCollected,
        outstanding: Math.max(0, Math.round((a.totalScheduled - a.totalPaid) * 100) / 100),
        outstandingPrincipal: Math.max(0, Math.round((loan.principal - a.principalCollected) * 100) / 100),
        nextDueAt: a.nextDueAt,
        overdueCount: a.overdueCount,
        status: loan.status,
      },
    };
  }

  /**
   * Compact loan summary for a vehicle's active (non-archived) loan — powers the
   * Financing panel on the Inventory car-detail page. Null when the car has no
   * live loan. Includes `outstandingPrincipal` (the early-payoff amount).
   */
  async getByVehicle(vehicleId: string): Promise<any | null> {
    if (!isValidObjectId(vehicleId)) return null;
    const loan = await this.model
      .findOne({ vehicle: vehicleId, isDeleted: false, status: { $ne: LoanStatus.ARCHIVED } })
      .sort({ createdAt: -1 });
    if (!loan) return null;
    const a = this.analyze(loan);
    return {
      _id: String(loan._id),
      status: loan.status,
      borrowerName: loan.borrowerName,
      vehicleTitle: loan.vehicleTitle,
      salePrice: loan.salePrice,
      downPayment: loan.downPayment,
      principal: loan.principal,
      interestRatePercent: loan.interestRatePercent,
      termMonths: loan.termMonths,
      emiAmount: loan.emiAmount,
      totalPaid: a.totalPaid,
      totalScheduled: a.totalScheduled,
      outstanding: Math.max(0, Math.round((a.totalScheduled - a.totalPaid) * 100) / 100),
      outstandingPrincipal: Math.max(0, Math.round((loan.principal - a.principalCollected) * 100) / 100),
      nextDueAt: a.nextDueAt,
      overdueCount: a.overdueCount,
      saleId: loan.saleId,
    };
  }

  private assertMutable(loan: LoanDocument): void {
    if (loan.status === LoanStatus.ARCHIVED) {
      throw new BadRequestException('This loan is archived and can no longer be modified.');
    }
  }

  /** Record a single payment (optionally allocated to a specific installment). */
  async recordPayment(id: string, dto: any): Promise<LoanDocument> {
    const loan = await this.loadLoan(id);
    this.assertMutable(loan);
    if (!(Number(dto.amount) > 0)) throw new BadRequestException('Payment amount must be greater than 0.');
    const wasPaidOff = loan.status === LoanStatus.PAID_OFF;
    loan.payments.push(this.toPayment(dto));
    const saved = await this.recomputeAndSave(loan);
    this.emitPaymentRecorded(saved, Number(dto.amount), wasPaidOff, dto.actorId, dto.actorName);
    return saved;
  }

  /**
   * Mark one or more installments fully paid in a single call. For each
   * requested installment, creates a payment allocated to it for exactly the
   * amount still outstanding on that month (skips months already covered).
   */
  async bulkMarkPaid(id: string, dto: any): Promise<LoanDocument> {
    const loan = await this.loadLoan(id);
    this.assertMutable(loan);
    const nos: number[] = Array.isArray(dto.installmentNos) ? dto.installmentNos : [];
    if (!nos.length) throw new BadRequestException('Provide at least one installment number.');
    const a = this.analyze(loan);
    const date = dto.date ? new Date(dto.date) : new Date();
    const method = dto.method || 'cash';
    const wasPaidOff = loan.status === LoanStatus.PAID_OFF;
    let added = 0;
    let addedAmount = 0;
    for (const no of nos) {
      const row = a.rows.find((r) => r.installmentNo === no);
      if (!row) continue;
      if (row.remaining <= EPS) continue; // already covered
      loan.payments.push(
        this.toPayment({ amount: row.remaining, method, date, installmentNo: no, notes: 'Bulk mark paid' }),
      );
      added++;
      addedAmount += row.remaining;
    }
    if (!added) throw new BadRequestException('All selected installments are already paid.');
    const saved = await this.recomputeAndSave(loan);
    this.emitPaymentRecorded(saved, Math.round(addedAmount * 100) / 100, wasPaidOff, dto.actorId, dto.actorName);
    return saved;
  }

  /** Emit payment-recorded (+ loan-paid-off on the flip) + best-effort borrower emails. */
  private emitPaymentRecorded(loan: LoanDocument, amount: number, wasPaidOff: boolean, actorId?: string, actorName?: string): void {
    const base = {
      loanId: String(loan._id),
      borrowerName: loan.borrowerName,
      borrowerEmail: loan.borrowerEmail,
      vehicleTitle: loan.vehicleTitle,
    };
    this.events.emit(NotificationEvent.BHPH_PAYMENT_RECORDED, { ...base, amount, actorId, actorName } as BhphPaymentRecordedEvent);
    if (loan.borrowerEmail) {
      this.mail.sendNotification({
        to: loan.borrowerEmail,
        title: 'Payment received',
        body: `We received your payment of $${amount.toLocaleString()} for ${loan.vehicleTitle ?? 'your vehicle'}. Thank you.`,
      }).catch(() => undefined);
    }
    if (loan.status === LoanStatus.PAID_OFF && !wasPaidOff) {
      this.events.emit(NotificationEvent.BHPH_LOAN_PAID_OFF, base as BhphLoanPaidOffEvent);
      if (loan.borrowerEmail) {
        this.mail.sendNotification({
          to: loan.borrowerEmail,
          title: 'Your loan is paid off 🎉',
          body: `Congratulations — your financing for ${loan.vehicleTitle ?? 'your vehicle'} is fully paid off.`,
        }).catch(() => undefined);
      }
    }
  }

  /** Edit a recorded payment (amount / date / method / notes / allocation). */
  async updatePayment(id: string, paymentId: string, dto: any): Promise<LoanDocument> {
    const loan = await this.loadLoan(id);
    this.assertMutable(loan);
    const p: any = (loan.payments as any).id(paymentId);
    if (!p) throw new NotFoundException('Payment not found');
    if (dto.amount !== undefined) {
      if (!(Number(dto.amount) > 0)) throw new BadRequestException('Payment amount must be greater than 0.');
      p.amount = Number(dto.amount);
    }
    if (dto.method !== undefined) p.method = dto.method;
    if (dto.receiptNumber !== undefined) p.receiptNumber = dto.receiptNumber;
    if (dto.notes !== undefined) p.notes = dto.notes;
    if (dto.date !== undefined) p.date = new Date(dto.date);
    if (dto.installmentNo !== undefined) p.installmentNo = dto.installmentNo === null ? undefined : Number(dto.installmentNo);
    return this.recomputeAndSave(loan);
  }

  /** Delete a single recorded payment. */
  async deletePayment(id: string, paymentId: string): Promise<LoanDocument> {
    const loan = await this.loadLoan(id);
    this.assertMutable(loan);
    const p: any = (loan.payments as any).id(paymentId);
    if (!p) throw new NotFoundException('Payment not found');
    p.deleteOne();
    return this.recomputeAndSave(loan);
  }

  /** "Mark month unpaid" — remove every payment allocated to an installment. */
  async unpayInstallment(id: string, installmentNo: number): Promise<LoanDocument> {
    const loan = await this.loadLoan(id);
    this.assertMutable(loan);
    const no = Number(installmentNo);
    const before = loan.payments.length;
    loan.payments = loan.payments.filter((p: any) => Number(p.installmentNo) !== no) as any;
    if (loan.payments.length === before) {
      throw new BadRequestException(`No payments are allocated to installment ${no}.`);
    }
    return this.recomputeAndSave(loan);
  }

  /** Paginated payment history (embedded array paged in-memory, newest first). */
  async getPayments(id: string, query: any): Promise<PaginatedResult<any>> {
    const loan = await this.loadLoan(id);
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const all = [...(loan.payments as any[])]
      .map((p) => ({
        _id: p._id,
        amount: p.amount,
        date: p.date,
        method: p.method,
        receiptNumber: p.receiptNumber,
        notes: p.notes,
        installmentNo: p.installmentNo,
      }))
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    const start = (page - 1) * limit;
    return new PaginatedResult(all.slice(start, start + limit), all.length, page, limit);
  }

  private toPayment(dto: any): LoanPayment {
    return {
      amount: Number(dto.amount),
      date: dto.date ? new Date(dto.date) : new Date(),
      method: dto.method || 'cash',
      notes: dto.notes || '',
      receiptNumber: dto.receiptNumber || '',
      installmentNo: dto.installmentNo !== undefined && dto.installmentNo !== null ? Number(dto.installmentNo) : undefined,
    } as LoanPayment;
  }

  async getLoanSummary(): Promise<any> {
    return this.model.aggregate([
      { $match: { isDeleted: false, status: { $ne: LoanStatus.ARCHIVED } } },
      { $group: { _id: '$status', count: { $sum: 1 }, totalPrincipal: { $sum: '$principal' }, totalPaid: { $sum: '$totalPaid' } } },
    ]);
  }

  /** Installments due within this many days count as "due soon". */
  private static DUE_WINDOW_DAYS = 3;

  /**
   * Remind about BHPH installments that are due soon or overdue. Emits
   * bhph.payment-due / bhph.payment-overdue (staff in-app) + a best-effort
   * borrower email, deduped to at most one reminder per loan per ~day via
   * `lastReminderAt`. Runs daily; also callable via POST /bhph/reminders/run
   * (ops), with an optional `loanId` to scope one loan. Uses the stored
   * `nextDueAt` (kept current by recomputeAndSave). Mirrors the stale-lead cron.
   */
  async sendDuePaymentReminders(
    opts: { loanId?: string; now?: Date; dueWindowDays?: number } = {},
  ): Promise<{ due: number; overdue: number }> {
    const now = opts.now ?? new Date();
    const windowDays = opts.dueWindowDays ?? BhphService.DUE_WINDOW_DAYS;
    const soon = new Date(now.getTime() + windowDays * 86_400_000);
    const dedupeCutoff = new Date(now.getTime() - 20 * 3_600_000); // ~once/day

    const filter: any = {
      isDeleted: false,
      status: { $in: [LoanStatus.ACTIVE, LoanStatus.DEFAULTED] },
      nextDueAt: { $ne: null, $lte: soon },
      $or: [{ lastReminderAt: null }, { lastReminderAt: { $lte: dedupeCutoff } }],
    };
    if (opts.loanId && isValidObjectId(opts.loanId)) filter._id = opts.loanId;

    const loans = await this.model.find(filter);
    let due = 0;
    let overdue = 0;
    for (const loan of loans) {
      const nextDue = loan.nextDueAt ? new Date(loan.nextDueAt) : undefined;
      if (!nextDue) continue;
      await this.model.updateOne({ _id: loan._id }, { $set: { lastReminderAt: now } });
      const dueDate = nextDue.toISOString().slice(0, 10);
      const emi = loan.emiAmount || 0;
      const base = {
        loanId: String(loan._id),
        borrowerName: loan.borrowerName,
        borrowerEmail: loan.borrowerEmail,
        vehicleTitle: loan.vehicleTitle,
        dueDate,
        amount: emi,
      };
      if (nextDue.getTime() < now.getTime()) {
        const daysLate = Math.floor((now.getTime() - nextDue.getTime()) / 86_400_000);
        this.events.emit(NotificationEvent.BHPH_PAYMENT_OVERDUE, { ...base, daysLate } as BhphPaymentOverdueEvent);
        if (loan.borrowerEmail) {
          this.mail.sendNotification({
            to: loan.borrowerEmail,
            title: 'BHPH payment overdue',
            body: `Your payment of $${emi.toLocaleString()} for ${loan.vehicleTitle ?? 'your vehicle'} was due ${dueDate} (${daysLate} day(s) ago). Please make a payment as soon as possible.`,
          }).catch(() => undefined);
        }
        overdue++;
      } else {
        this.events.emit(NotificationEvent.BHPH_PAYMENT_DUE, base as BhphPaymentDueEvent);
        if (loan.borrowerEmail) {
          this.mail.sendNotification({
            to: loan.borrowerEmail,
            title: 'BHPH payment due soon',
            body: `Your next payment of $${emi.toLocaleString()} for ${loan.vehicleTitle ?? 'your vehicle'} is due ${dueDate}.`,
          }).catch(() => undefined);
        }
        due++;
      }
    }
    if (due || overdue) this.logger.log(`bhph reminders: ${due} due, ${overdue} overdue`);
    return { due, overdue };
  }

  @Cron(CronExpression.EVERY_DAY_AT_9AM)
  async cronDuePayments(): Promise<void> {
    try {
      await this.sendDuePaymentReminders();
    } catch (err) {
      this.logger.error(`bhph reminder cron failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
