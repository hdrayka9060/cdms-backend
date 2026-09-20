import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { Receivable, ReceivableDocument, ReceivablePayment, ReceivableStatus } from './schemas/receivable.schema';
import { Sale, SaleDocument } from './schemas/accounting.schema';
import { ActivityService } from '../activity/activity.service';
import { PaginatedResult } from '../../common/dto/pagination.dto';

const EPS = 0.005;

@Injectable()
export class ReceivablesService {
  private readonly logger = new Logger(ReceivablesService.name);

  constructor(
    @InjectModel(Receivable.name) private model: Model<ReceivableDocument>,
    @InjectModel(Sale.name) private saleModel: Model<SaleDocument>,
    private readonly activity: ActivityService,
  ) {}

  /** Collected = down payment + every subsequent payment. */
  collected(r: Receivable): number {
    const sum = (r.payments ?? []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
    return Math.round(((Number(r.downPayment) || 0) + sum) * 100) / 100;
  }
  outstanding(r: Receivable): number {
    return Math.max(0, Math.round(((Number(r.totalAmount) || 0) - this.collected(r)) * 100) / 100);
  }

  /**
   * Create an open receivable for a partial/unpaid non-BHPH sale. Called by
   * AccountingService.createSale. No-op if one already exists for the sale.
   */
  async createForSale(opts: {
    saleId: string; vehicleId?: string; vehicleTitle?: string;
    buyerName?: string; buyerEmail?: string; buyerPhone?: string;
    leadId?: string; buyerLeadId?: string; paymentMethod?: string;
    totalAmount: number; downPayment: number;
  }): Promise<ReceivableDocument | null> {
    const existing = await this.model.findOne({ saleId: String(opts.saleId), isDeleted: false });
    if (existing) return existing;
    const outstanding = Math.max(0, (opts.totalAmount || 0) - (opts.downPayment || 0));
    const doc = await new this.model({
      saleId: String(opts.saleId),
      vehicleId: opts.vehicleId,
      vehicleTitle: opts.vehicleTitle,
      buyerName: opts.buyerName,
      buyerEmail: opts.buyerEmail,
      buyerPhone: opts.buyerPhone,
      leadId: opts.leadId,
      buyerLeadId: opts.buyerLeadId,
      paymentMethod: opts.paymentMethod ?? 'cash',
      totalAmount: Math.max(0, opts.totalAmount || 0),
      downPayment: Math.max(0, opts.downPayment || 0),
      status: outstanding <= EPS ? ReceivableStatus.SETTLED : ReceivableStatus.OPEN,
    }).save();
    await this.activity.log({
      module: 'accounting', action: 'created', entity: 'Receivable', entityId: doc._id,
      label: `Open balance · ${opts.vehicleTitle ?? 'Vehicle'} (${opts.buyerName ?? 'buyer'}) · $${outstanding.toLocaleString()} due`,
    });
    return doc;
  }

  private async load(id: string): Promise<ReceivableDocument> {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid receivable id');
    const r = await this.model.findOne({ _id: id, isDeleted: false });
    if (!r) throw new NotFoundException('Receivable not found');
    return r;
  }
  private assertMutable(r: ReceivableDocument): void {
    if (r.status === ReceivableStatus.ARCHIVED) {
      throw new BadRequestException('This receivable is archived and can no longer be modified.');
    }
  }

  /** Push the collected total onto the linked Sale so Accounting stays in sync. */
  private async syncSale(r: ReceivableDocument): Promise<void> {
    if (!r.saleId || !isValidObjectId(r.saleId)) return;
    try {
      const sale = await this.saleModel.findOne({ _id: r.saleId, isDeleted: false }).select('salePrice discount');
      if (!sale) return;
      const net = Math.max(0, (Number(sale.salePrice) || 0) - (Number(sale.discount) || 0));
      const collected = this.collected(r);
      const amountPaid = Math.min(net, collected);
      const paymentStatus = net - amountPaid < 0.01 ? 'paid' : amountPaid > EPS ? 'partial' : 'pending';
      await this.saleModel.updateOne({ _id: r.saleId, isDeleted: false }, { $set: { amountPaid, paymentStatus } });
    } catch (err) {
      this.logger.error(`receivable syncSale failed for ${r._id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  private toPayment(dto: any): ReceivablePayment {
    return {
      amount: Number(dto.amount),
      date: dto.date ? new Date(dto.date) : new Date(),
      method: dto.method || 'cash',
      notes: dto.notes || '',
      receiptNumber: dto.receiptNumber || '',
    } as ReceivablePayment;
  }
  private async recompute(r: ReceivableDocument): Promise<ReceivableDocument> {
    if (r.status !== ReceivableStatus.ARCHIVED) {
      r.status = this.outstanding(r) <= EPS ? ReceivableStatus.SETTLED : ReceivableStatus.OPEN;
    }
    const saved = await r.save();
    await this.syncSale(saved);
    return saved;
  }

  async recordPayment(id: string, dto: any): Promise<ReceivableDocument> {
    const r = await this.load(id);
    this.assertMutable(r);
    if (!(Number(dto.amount) > 0)) throw new BadRequestException('Payment amount must be greater than 0.');
    r.payments.push(this.toPayment(dto));
    const saved = await this.recompute(r);
    await this.activity.log({
      module: 'accounting', action: 'payment', entity: 'Receivable', entityId: saved._id,
      label: `Payment $${Number(dto.amount).toLocaleString()} · ${saved.vehicleTitle ?? 'Vehicle'} (${saved.buyerName ?? 'buyer'})`,
    });
    return saved;
  }

  async updatePayment(id: string, paymentId: string, dto: any): Promise<ReceivableDocument> {
    const r = await this.load(id);
    this.assertMutable(r);
    const p: any = (r.payments as any).id(paymentId);
    if (!p) throw new NotFoundException('Payment not found');
    if (dto.amount !== undefined) {
      if (!(Number(dto.amount) > 0)) throw new BadRequestException('Payment amount must be greater than 0.');
      p.amount = Number(dto.amount);
    }
    if (dto.method !== undefined) p.method = dto.method;
    if (dto.receiptNumber !== undefined) p.receiptNumber = dto.receiptNumber;
    if (dto.notes !== undefined) p.notes = dto.notes;
    if (dto.date !== undefined) p.date = new Date(dto.date);
    return this.recompute(r);
  }

  async deletePayment(id: string, paymentId: string): Promise<ReceivableDocument> {
    const r = await this.load(id);
    this.assertMutable(r);
    const p: any = (r.payments as any).id(paymentId);
    if (!p) throw new NotFoundException('Payment not found');
    p.deleteOne();
    return this.recompute(r);
  }

  async findAll(query: any): Promise<PaginatedResult<ReceivableDocument>> {
    const { page = 1, limit = 20, status, sort = '-createdAt' } = query;
    const skip = (page - 1) * limit;
    const filter: any = { isDeleted: false };
    if (status) filter.status = status;
    else filter.status = { $ne: ReceivableStatus.ARCHIVED };
    const sortObj: any = sort.startsWith('-') ? { [sort.slice(1)]: -1 } : { [sort]: 1 };
    const [data, total] = await Promise.all([
      this.model.find(filter).sort(sortObj).skip(skip).limit(limit).lean(),
      this.model.countDocuments(filter),
    ]);
    // Decorate with computed collected/outstanding for the UI.
    const decorated = (data as any[]).map((r) => ({
      ...r,
      collected: this.collected(r as Receivable),
      outstanding: this.outstanding(r as Receivable),
    }));
    return new PaginatedResult(decorated as any, total, page, limit);
  }

  async findById(id: string): Promise<any> {
    const r = await this.load(id);
    return { ...r.toObject(), collected: this.collected(r), outstanding: this.outstanding(r) };
  }

  /** Find the live receivable for a sale (used by Vehicle/Lead detail). */
  async findBySale(saleId: string): Promise<any | null> {
    const r = await this.model.findOne({ saleId: String(saleId), isDeleted: false, status: { $ne: ReceivableStatus.ARCHIVED } });
    if (!r) return null;
    return { ...r.toObject(), collected: this.collected(r), outstanding: this.outstanding(r) };
  }

  /** Archive the receivable(s) for a sale — used when the sale is reversed. */
  async archiveForSale(saleId: string): Promise<number> {
    const res = await this.model.updateMany(
      { saleId: String(saleId), isDeleted: false, status: { $ne: ReceivableStatus.ARCHIVED } },
      { $set: { status: ReceivableStatus.ARCHIVED, archivedAt: new Date() } },
    );
    return res.modifiedCount ?? 0;
  }

  /** Keep totalAmount in step when a sale's price is edited. */
  async syncTotalForSale(saleId: string, totalAmount: number): Promise<void> {
    const r = await this.model.findOne({ saleId: String(saleId), isDeleted: false, status: { $ne: ReceivableStatus.ARCHIVED } });
    if (!r) return;
    r.totalAmount = Math.max(0, totalAmount);
    await this.recompute(r);
  }
}
