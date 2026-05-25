import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import { Sale, SaleDocument, Expense, ExpenseDocument } from './schemas/accounting.schema';
import { Vehicle, VehicleDocument, VehicleStatus } from '../inventory/schemas/vehicle.schema';
import { BuyerLead, BuyerLeadDocument } from '../crm-buyers/schemas/buyer-lead.schema';
import { Lead, LeadDocument, LeadStatus } from '../leads/schemas/lead.schema';
import { PaginatedResult } from '../../common/dto/pagination.dto';

@Injectable()
export class AccountingService {
  private readonly logger = new Logger(AccountingService.name);

  constructor(
    @InjectModel(Sale.name) private saleModel: Model<SaleDocument>,
    @InjectModel(Expense.name) private expenseModel: Model<ExpenseDocument>,
    @InjectModel(Vehicle.name) private vehicleModel: Model<VehicleDocument>,
    @InjectModel(BuyerLead.name) private buyerModel: Model<BuyerLeadDocument>,
    @InjectModel(Lead.name) private leadModel: Model<LeadDocument>,
  ) {}

  /**
   * Financial summary.
   *
   * Calculation details (all over non-deleted records):
   *   - `revenue`   = Σ(salePrice − discount)            // NET, not gross
   *   - `cost`      = Σ(costPrice)                       // what dealer paid for the cars
   *   - `expenses`  = Σ(expense.amount)                  // overhead, marketing, etc.
   *   - `profit`    = revenue − cost − expenses
   *   - `outstanding` = Σ((salePrice − discount) − amountPaid)
   *                    over sales where paymentStatus IN (pending, partial)
   *
   * IMPORTANT: when a date range is passed, BOTH sales AND expenses are
   * filtered by it. Previously the expense aggregation ignored the range,
   * which produced misleading "year-to-date" profit numbers.
   */
  async getSummary(startDate?: string, endDate?: string): Promise<any> {
    const saleDateFilter: any = {};
    const expenseDateFilter: any = {};
    if (startDate) {
      saleDateFilter.$gte = new Date(startDate);
      expenseDateFilter.$gte = new Date(startDate);
    }
    if (endDate) {
      saleDateFilter.$lte = new Date(endDate);
      expenseDateFilter.$lte = new Date(endDate);
    }
    const salesMatch: any = { isDeleted: false };
    if (Object.keys(saleDateFilter).length) salesMatch.saleDate = saleDateFilter;
    const expensesMatch: any = { isDeleted: false };
    if (Object.keys(expenseDateFilter).length) expensesMatch.date = expenseDateFilter;

    const [salesAgg, expensesAgg, outstandingAgg] = await Promise.all([
      this.saleModel.aggregate([
        { $match: salesMatch },
        {
          $group: {
            _id: null,
            totalRevenue: { $sum: { $subtract: ['$salePrice', { $ifNull: ['$discount', 0] }] } },
            totalCost: { $sum: '$costPrice' },
            totalDiscount: { $sum: '$discount' },
            count: { $sum: 1 },
          },
        },
      ]),
      this.expenseModel.aggregate([
        { $match: expensesMatch },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      this.saleModel.aggregate([
        { $match: { ...salesMatch, paymentStatus: { $in: ['pending', 'partial'] } } },
        {
          $group: {
            _id: null,
            total: {
              $sum: {
                $max: [
                  0,
                  {
                    $subtract: [
                      { $subtract: ['$salePrice', { $ifNull: ['$discount', 0] }] },
                      { $ifNull: ['$amountPaid', 0] },
                    ],
                  },
                ],
              },
            },
          },
        },
      ]),
    ]);

    const revenue = salesAgg[0]?.totalRevenue || 0;
    const cost = salesAgg[0]?.totalCost || 0;
    const expenses = expensesAgg[0]?.total || 0;
    // Profit = realised sale price − cost of acquisition (gross margin on
    // vehicles sold). Operating expenses stay surfaced separately so the
    // dealer can decide whether to net them out themselves.
    return {
      totalRevenue: revenue,
      totalCost: cost,
      totalExpenses: expenses,
      totalProfit: revenue - cost,
      totalSales: salesAgg[0]?.count || 0,
      outstanding: outstandingAgg[0]?.total || 0,
    };
  }

  /**
   * Edit an existing sale row. Whitelist of editable fields; recomputes
   * amountPaid heuristically when paymentStatus changes (mirrors createSale).
   * Does NOT re-sync the vehicle status — that side-effect should only fire
   * on initial creation. If you really want to re-mark the vehicle, edit the
   * vehicle directly.
   */
  async updateSale(id: string, dto: any): Promise<SaleDocument> {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid sale id');
    const existing = await this.saleModel.findOne({ _id: id, isDeleted: false });
    if (!existing) throw new NotFoundException('Sale not found');

    const patch: any = {};
    const num = (v: any, fallback: number) =>
      v === undefined || v === null || v === '' ? fallback : Number(v) || 0;

    if (dto.vehicleId !== undefined) patch.vehicleId = dto.vehicleId;
    if (dto.vehicleTitle !== undefined) patch.vehicleTitle = dto.vehicleTitle;
    if (dto.buyerName !== undefined) patch.buyerName = dto.buyerName;
    if (dto.buyerEmail !== undefined) patch.buyerEmail = dto.buyerEmail;
    if (dto.salePrice !== undefined) patch.salePrice = num(dto.salePrice, existing.salePrice);
    if (dto.costPrice !== undefined) patch.costPrice = num(dto.costPrice, existing.costPrice);
    if (dto.discount !== undefined) patch.discount = num(dto.discount, existing.discount);
    if (dto.saleDate !== undefined) patch.saleDate = new Date(dto.saleDate);
    if (dto.paymentMethod !== undefined) patch.paymentMethod = dto.paymentMethod;
    if (dto.paymentStatus !== undefined) patch.paymentStatus = dto.paymentStatus;
    if (dto.notes !== undefined) patch.notes = dto.notes;

    // Compute net + amountPaid using the merged-effective values.
    const effSalePrice = patch.salePrice ?? existing.salePrice;
    const effDiscount = patch.discount ?? existing.discount;
    const effStatus = patch.paymentStatus ?? existing.paymentStatus;
    const net = Math.max(0, effSalePrice - effDiscount);

    if (dto.amountPaid !== undefined && dto.amountPaid !== null && dto.amountPaid !== '') {
      patch.amountPaid = Math.max(0, Math.min(net, Number(dto.amountPaid) || 0));
    } else if (dto.paymentStatus !== undefined) {
      // Status changed but amountPaid wasn't supplied — re-derive.
      if (effStatus === 'paid') patch.amountPaid = net;
      else if (effStatus === 'pending') patch.amountPaid = 0;
      // partial → leave existing amountPaid alone
    }

    const updated = await this.saleModel.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { $set: patch },
      { new: true },
    );
    if (!updated) throw new NotFoundException('Sale not found');
    return updated;
  }

  async removeSale(id: string): Promise<void> {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid sale id');
    const updated = await this.saleModel.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { $set: { isDeleted: true } },
    );
    if (!updated) throw new NotFoundException('Sale not found');
  }

  async getSales(query: any): Promise<PaginatedResult<SaleDocument>> {
    const { page = 1, limit = 20, search, sort = '-saleDate', paymentStatus, startDate, endDate } = query;
    const skip = (page - 1) * limit;
    const filter: any = { isDeleted: false };
    if (paymentStatus) filter.paymentStatus = paymentStatus;
    if (search) filter.$or = [{ vehicleTitle: { $regex: search, $options: 'i' } }, { buyerName: { $regex: search, $options: 'i' } }];
    if (startDate || endDate) {
      filter.saleDate = {};
      if (startDate) filter.saleDate.$gte = new Date(startDate);
      if (endDate) filter.saleDate.$lte = new Date(endDate);
    }
    const sortObj: any = sort.startsWith('-') ? { [sort.slice(1)]: -1 } : { [sort]: 1 };
    const [data, total] = await Promise.all([
      this.saleModel.find(filter).sort(sortObj).skip(skip).limit(limit).lean(),
      this.saleModel.countDocuments(filter),
    ]);
    return new PaginatedResult(data as unknown as SaleDocument[], total, page, limit);
  }

  /**
   * Record a sale — the single source of truth for "we sold a car".
   *
   * Side-effects (all best-effort, none should block the sale itself):
   *   1. Flips Vehicle.status → sold, stamps Vehicle.soldAt + Vehicle.soldDate.
   *   2. If `buyerLeadId` is supplied, pushes onto buyer.purchases[] and bumps
   *      stage → 'purchased'.
   *   3. If `leadId` is supplied, sets Lead.status → 'closed' and appends a
   *      timeline entry.
   *
   * Callers:
   *   - POST /accounting/sales (Record Sale form) — vehicleId mandatory,
   *     buyerLeadId + leadId optional.
   *   - LeadsService.closeLead — passes both leadId + the lead's buyer.
   *   - InventoryService.softDelete (no — only ensureSaleForSoldVehicle).
   */
  async createSale(dto: any): Promise<SaleDocument> {
    // Guard: a vehicle can only be sold once. If a non-deleted Sale already
    // exists for this vehicleId, reject — the dealer needs to delete or edit
    // the existing sale instead of stacking duplicates.
    if (dto.vehicleId && isValidObjectId(dto.vehicleId)) {
      const existing = await this.saleModel.findOne({
        vehicleId: String(dto.vehicleId),
        isDeleted: false,
      }).select('_id');
      if (existing) {
        throw new ConflictException(
          'A sale record for this vehicle already exists. Edit or delete it before recording another.',
        );
      }
    }

    const salePrice = Number(dto.salePrice) || 0;
    const discount = Number(dto.discount) || 0;
    const net = Math.max(0, salePrice - discount);

    let amountPaid: number;
    if (dto.amountPaid !== undefined && dto.amountPaid !== null && dto.amountPaid !== '') {
      amountPaid = Math.max(0, Math.min(net, Number(dto.amountPaid) || 0));
    } else if (dto.paymentStatus === 'pending') {
      amountPaid = 0;
    } else if (dto.paymentStatus === 'partial') {
      amountPaid = 0; // user can edit later when payments arrive
    } else {
      amountPaid = net; // 'paid' (default)
    }

    // Strip the orchestration fields before saving — they aren't on the Sale
    // schema. (Mongoose would drop them anyway under strict mode, but being
    // explicit avoids accidental persistence if the schema ever changes.)
    const { buyerLeadId, leadId, ...saleFields } = dto;
    const sale = await new this.saleModel({ ...saleFields, amountPaid }).save();

    // ── Side-effect 1: vehicle → sold + realised price + date ──────────────
    if (dto.vehicleId && isValidObjectId(dto.vehicleId)) {
      try {
        await this.vehicleModel.updateOne(
          { _id: new Types.ObjectId(dto.vehicleId), isDeleted: false },
          {
            $set: {
              status: VehicleStatus.SOLD,
              soldAt: net,
              soldDate: sale.saleDate,
            },
          },
        );
      } catch (err) {
        // Sale row already committed — log and continue so the dealer can
        // still see the Sale even if the vehicle flip failed.
        this.logger.error(
          `createSale side-effect 1 (vehicle → sold) failed for vehicleId=${dto.vehicleId}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }

    // ── Side-effect 2: buyer → purchases[] + stage=purchased ───────────────
    if (buyerLeadId && isValidObjectId(buyerLeadId)) {
      try {
        await this.buyerModel.updateOne(
          { _id: new Types.ObjectId(buyerLeadId), isDeleted: false },
          {
            $set: { stage: 'purchased' },
            $push: {
              purchases: {
                at: new Date(),
                vehicle: dto.vehicleId && isValidObjectId(dto.vehicleId)
                  ? new Types.ObjectId(dto.vehicleId) : undefined,
                vehicleTitle: dto.vehicleTitle,
                soldAt: net,
                soldDate: sale.saleDate,
                paymentMethod: dto.paymentMethod,
                paymentStatus: dto.paymentStatus,
                leadId: leadId && isValidObjectId(leadId) ? new Types.ObjectId(leadId) : undefined,
                saleId: sale._id,
              },
            },
          },
        );
      } catch (err) {
        this.logger.error(
          `createSale side-effect 2 (buyer purchases push) failed for buyerLeadId=${buyerLeadId}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }

    // ── Side-effect 3: lead → closed + timeline entry ──────────────────────
    if (leadId && isValidObjectId(leadId)) {
      try {
        await this.leadModel.updateOne(
          { _id: new Types.ObjectId(leadId), isDeleted: false },
          {
            $set: { status: LeadStatus.CLOSED },
            $push: {
              timeline: {
                date: new Date(),
                action: `Lead closed — sold for $${net.toLocaleString()} (${dto.paymentStatus ?? 'paid'})`,
                by: dto.actorName ?? 'System',
              },
            },
          },
        );
      } catch (err) {
        this.logger.error(
          `createSale side-effect 3 (lead → closed) failed for leadId=${leadId}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }

    // ── Side-effect 4: every other open lead for this vehicle → archived ───
    // The car is no longer available so any rival inquiry is by definition
    // lost. Adds a timeline note so the change is auditable.
    if (dto.vehicleId && isValidObjectId(dto.vehicleId)) {
      try {
        const vehicleObj = new Types.ObjectId(dto.vehicleId);
        const exclude = leadId && isValidObjectId(leadId) ? new Types.ObjectId(leadId) : null;
        const siblingFilter: any = {
          vehicle: vehicleObj,
          isDeleted: false,
          status: { $nin: [LeadStatus.CLOSED, LeadStatus.ARCHIVED] },
        };
        if (exclude) siblingFilter._id = { $ne: exclude };
        const result = await this.leadModel.updateMany(siblingFilter, {
          $set: { status: LeadStatus.ARCHIVED },
          $push: {
            timeline: {
              date: new Date(),
              action: 'Auto-archived — vehicle was sold to another buyer',
              by: dto.actorName ?? 'System',
            },
          },
        });
        // Verifies sibling-drop ran. If matched=0 here when the user expected
        // siblings to drop, the bug is upstream (filter / data shape) — not a
        // silent exception. Logged at debug so it's easy to enable when chasing.
        this.logger.log(
          `createSale sibling-archive vehicleId=${dto.vehicleId} ` +
          `excludeLeadId=${leadId ?? 'none'} matched=${result.matchedCount} modified=${result.modifiedCount}`,
        );
      } catch (err) {
        this.logger.error(
          `createSale side-effect 4 (sibling leads → dropped) failed for vehicleId=${dto.vehicleId}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }

    return sale;
  }

  async getExpenses(query: any): Promise<PaginatedResult<ExpenseDocument>> {
    const { page = 1, limit = 20, category, sort = '-date', startDate, endDate } = query;
    const skip = (page - 1) * limit;
    const filter: any = { isDeleted: false };
    if (category) filter.category = category;
    if (startDate || endDate) {
      filter.date = {};
      if (startDate) filter.date.$gte = new Date(startDate);
      if (endDate) filter.date.$lte = new Date(endDate);
    }
    const sortObj: any = sort.startsWith('-') ? { [sort.slice(1)]: -1 } : { [sort]: 1 };
    const [data, total] = await Promise.all([
      this.expenseModel.find(filter).sort(sortObj).skip(skip).limit(limit).lean(),
      this.expenseModel.countDocuments(filter),
    ]);
    return new PaginatedResult(data as unknown as ExpenseDocument[], total, page, limit);
  }

  async createExpense(dto: any): Promise<ExpenseDocument> { return new this.expenseModel(dto).save(); }

  async updateExpense(id: string, dto: any): Promise<ExpenseDocument> {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid expense id');
    // Only allow specific fields through — strip anything else from the body.
    const patch: any = {};
    if (dto.title !== undefined) patch.title = dto.title;
    if (dto.amount !== undefined) patch.amount = Number(dto.amount);
    if (dto.date !== undefined) patch.date = new Date(dto.date);
    if (dto.category !== undefined) patch.category = dto.category;
    if (dto.vendor !== undefined) patch.vendor = dto.vendor;
    if (dto.notes !== undefined) patch.notes = dto.notes;
    const updated = await this.expenseModel.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { $set: patch },
      { new: true },
    );
    if (!updated) throw new NotFoundException('Expense not found');
    return updated;
  }

  async removeExpense(id: string): Promise<void> {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid expense id');
    const updated = await this.expenseModel.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { $set: { isDeleted: true } },
    );
    if (!updated) throw new NotFoundException('Expense not found');
  }

  async getProfitLoss(startDate: string, endDate: string): Promise<any> {
    const dateFilter = { $gte: new Date(startDate), $lte: new Date(endDate) };
    const [sales, expenses] = await Promise.all([
      this.saleModel.aggregate([
        { $match: { isDeleted: false, saleDate: dateFilter } },
        {
          $group: {
            _id: { $month: '$saleDate' },
            // Net revenue (post-discount) so it lines up with the summary card.
            revenue: { $sum: { $subtract: ['$salePrice', { $ifNull: ['$discount', 0] }] } },
            cost: { $sum: '$costPrice' },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      this.expenseModel.aggregate([
        { $match: { isDeleted: false, date: dateFilter } },
        { $group: { _id: { $month: '$date' }, total: { $sum: '$amount' } } },
        { $sort: { _id: 1 } },
      ]),
    ]);
    return { sales, expenses, summary: await this.getSummary(startDate, endDate) };
  }

  /**
   * Inverse of the "marked as sold" flow. Called when a vehicle's status moves
   * FROM sold to anything else — InventoryService.update fires this on a
   * status flip, and LeadsService.remove fires it when a closed lead is
   * deleted. The dealer is undoing the sale.
   *
   *   - Soft-deletes every non-deleted Sale row for this vehicle.
   *   - Pulls matching entries from buyer.purchases[].
   *   - **Archives** (not soft-deletes) the closed leads, so the audit trail
   *     survives and the dealer can see "this was once a sale that got
   *     reversed". A timeline entry on each archived lead records the why.
   *
   * Best-effort: failures don't propagate; the caller has already committed
   * its primary write (vehicle update or lead delete).
   */
  async cleanupSoldArtifacts(vehicleId: string): Promise<void> {
    if (!isValidObjectId(vehicleId)) return;
    const vehicleObj = new Types.ObjectId(vehicleId);
    const vehicleIdStr = String(vehicleId);

    // Pull buyer.purchases entries that reference any of the sales we're
    // about to soft-delete, BEFORE we hide the sales (so we still have ids).
    const sales = await this.saleModel.find({
      vehicleId: vehicleIdStr,
      isDeleted: false,
    }).select('_id').lean();
    const saleIds = sales.map((s: any) => s._id);
    if (saleIds.length) {
      await this.buyerModel.updateMany(
        { 'purchases.saleId': { $in: saleIds } },
        { $pull: { purchases: { saleId: { $in: saleIds } } } },
      );
    }

    await Promise.all([
      this.saleModel.updateMany(
        { vehicleId: vehicleIdStr, isDeleted: false },
        { $set: { isDeleted: true } },
      ),
      this.leadModel.updateMany(
        { vehicle: vehicleObj, status: LeadStatus.CLOSED, isDeleted: false },
        {
          $set: { status: LeadStatus.ARCHIVED },
          $push: {
            timeline: {
              date: new Date(),
              action: 'Auto-archived — sale was reverted',
              by: 'System',
            },
          },
        },
      ),
    ]);
  }

  /**
   * Ensure there is a placeholder Sale row for a vehicle the dealer just
   * flipped to "sold". Called by InventoryService.update so the accounting
   * ledger stays in sync even when the user changes status from the vehicle
   * detail page instead of going through Record Sale.
   */
  async ensureSaleForSoldVehicle(vehicle: VehicleDocument): Promise<void> {
    const existing = await this.saleModel.findOne({
      vehicleId: String(vehicle._id),
      isDeleted: false,
    });
    if (existing) return;
    await new this.saleModel({
      vehicleTitle: vehicle.title,
      vehicleId: String(vehicle._id),
      buyerName: 'Pending — edit in Sales Ledger',
      buyerEmail: 'pending@example.com',
      salePrice: vehicle.price ?? 0,
      costPrice: 0,
      discount: vehicle.discount ?? 0,
      amountPaid: 0,
      saleDate: new Date(),
      paymentMethod: 'cash',
      paymentStatus: 'pending',
      notes: 'Auto-created when the vehicle was marked sold from Inventory.',
    }).save();
  }
}
