import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import { Sale, SaleDocument, Expense, ExpenseDocument } from './schemas/accounting.schema';
import { Vehicle, VehicleDocument, VehicleStatus } from '../inventory/schemas/vehicle.schema';
import { BuyerLead, BuyerLeadDocument } from '../crm-buyers/schemas/buyer-lead.schema';
import { Lead, LeadDocument, LeadStatus } from '../leads/schemas/lead.schema';
import { ActivityService } from '../activity/activity.service';
import { PaginatedResult } from '../../common/dto/pagination.dto';

/** Category tag for vehicle reconditioning spends mirrored into the expense ledger. */
export const RECONDITIONING_CATEGORY = 'reconditioning';

@Injectable()
export class AccountingService implements OnModuleInit {
  private readonly logger = new Logger(AccountingService.name);

  /**
   * Backfill: mirror every existing vehicle reconditioning spend into the
   * expense ledger as a category='reconditioning' row. Idempotent — keyed on
   * `spendId`, so it only creates rows that don't yet exist. Runs on boot so
   * pre-existing spends (recorded before spends became expense records) show up
   * in the ledger and count toward reconditioning exactly once.
   */
  async onModuleInit(): Promise<void> {
    try {
      // lean() shows the RAW stored spends — Mongoose would otherwise inject
      // ephemeral (unpersisted) `_id`s on hydration, which must not be used as
      // the sync key. Legacy/seeded spends lack `_id`; assign one and PERSIST it
      // via a direct $set so the mirrored expense's spendId stays stable.
      const vehicles = await this.vehicleModel
        .find({ isDeleted: false, 'spends.0': { $exists: true } })
        .lean();
      let created = 0;
      let idsAssigned = 0;
      for (const v of vehicles as any[]) {
        const spends = (v.spends ?? []) as any[];
        let dirty = false;
        for (const s of spends) {
          if (!s._id) {
            s._id = new Types.ObjectId();
            dirty = true;
            idsAssigned++;
          }
        }
        if (dirty) {
          await this.vehicleModel.updateOne({ _id: v._id }, { $set: { spends } });
        }
        for (const s of spends) {
          const exists = await this.expenseModel.exists({ spendId: String(s._id) });
          if (exists) continue;
          await this.upsertSpendExpense({
            vehicleId: String(v._id),
            spendId: String(s._id),
            vehicleTitle: v.title,
            amount: Number(s.amount) || 0,
            date: s.date ? new Date(s.date) : new Date(),
            description: s.description ?? '',
          });
          created++;
        }
      }
      if (created || idsAssigned) {
        this.logger.log(
          `reconditioning backfill: assigned ${idsAssigned} spend id(s), created ${created} expense(s)`,
        );
      }
    } catch (err) {
      this.logger.error(
        `reconditioning-expense backfill failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Create or update the expense-ledger row mirroring a vehicle reconditioning
   * spend. Upsert keyed on `spendId` so edits sync and re-runs never duplicate.
   */
  async upsertSpendExpense(opts: {
    vehicleId: string;
    spendId: string;
    vehicleTitle: string;
    amount: number;
    date: Date;
    description?: string;
  }): Promise<void> {
    await this.expenseModel.updateOne(
      { spendId: String(opts.spendId) },
      {
        $set: {
          title: `Reconditioning · ${opts.vehicleTitle ?? 'Vehicle'}`,
          amount: Math.max(0, Number(opts.amount) || 0),
          date: opts.date,
          category: RECONDITIONING_CATEGORY,
          source: 'vehicle-spend',
          vehicleId: String(opts.vehicleId),
          spendId: String(opts.spendId),
          notes: opts.description ?? '',
          isDeleted: false,
        },
      },
      { upsert: true },
    );
  }

  /** Soft-delete the expense-ledger row mirroring a removed vehicle spend. */
  async removeSpendExpense(spendId: string): Promise<void> {
    await this.expenseModel.updateOne(
      { spendId: String(spendId) },
      { $set: { isDeleted: true } },
    );
  }

  constructor(
    @InjectModel(Sale.name) private saleModel: Model<SaleDocument>,
    @InjectModel(Expense.name) private expenseModel: Model<ExpenseDocument>,
    @InjectModel(Vehicle.name) private vehicleModel: Model<VehicleDocument>,
    @InjectModel(BuyerLead.name) private buyerModel: Model<BuyerLeadDocument>,
    @InjectModel(Lead.name) private leadModel: Model<LeadDocument>,
    private readonly activity: ActivityService,
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
            totalSpend: { $sum: { $ifNull: ['$totalSpend', 0] } },
            totalDiscount: { $sum: '$discount' },
            count: { $sum: 1 },
          },
        },
      ]),
      this.expenseModel.aggregate([
        { $match: expensesMatch },
        {
          $group: {
            _id: null,
            // Operating expenses = everything EXCEPT reconditioning.
            operational: { $sum: { $cond: [{ $eq: ['$category', 'reconditioning'] }, 0, '$amount'] } },
            // Reconditioning = vehicle spends mirrored into the ledger. Recognised
            // when the spend is recorded (independent of sold status).
            reconditioning: { $sum: { $cond: [{ $eq: ['$category', 'reconditioning'] }, '$amount', 0] } },
          },
        },
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
    const operational = expensesAgg[0]?.operational || 0;
    const reconditioning = expensesAgg[0]?.reconditioning || 0;
    // Full-cost accounting: every dollar out is an expense.
    //   Total Expenses = Operational + Reconditioning + Cost(of sold)
    //   Profit         = Revenue − Total Expenses
    // Reconditioning is now sourced from the expense ledger (category
    // 'reconditioning'), recognised when the spend is recorded and independent
    // of sold status — NOT from Sale.totalSpend — so each spend is counted once.
    // Cost of vehicles is still recognised at sale (Sale.costPrice).
    const totalExpenses = operational + reconditioning + cost;
    return {
      totalRevenue: revenue,
      totalCost: cost,
      totalSpend: reconditioning,
      // Component breakdown so the UI can render Operational / Reconditioning /
      // Cost-of-vehicles lines that sum to totalExpenses.
      totalOperational: operational,
      totalReconditioning: reconditioning,
      totalCostOfVehicles: cost,
      totalExpenses,
      totalProfit: revenue - totalExpenses,
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
    await this.activity.log({
      module: 'accounting',
      action: 'updated',
      entity: 'Sale',
      entityId: updated._id,
      label: `Sale edited · ${updated.vehicleTitle ?? 'Vehicle'} (${updated.buyerName})`,
      meta: { fields: Object.keys(patch) },
    });
    return updated;
  }

  async removeSale(id: string): Promise<void> {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid sale id');
    const updated = await this.saleModel.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { $set: { isDeleted: true } },
      { new: false },
    );
    if (!updated) throw new NotFoundException('Sale not found');
    await this.activity.log({
      module: 'accounting',
      action: 'deleted',
      entity: 'Sale',
      entityId: updated._id,
      label: `Sale removed · ${updated.vehicleTitle ?? 'Vehicle'} (${updated.buyerName})`,
    });
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

    // Snapshot the vehicle's reconditioning spend into the Sale. Sourced from
    // the vehicle (never from the client) so it can't be tampered with — same
    // contract as costPrice. Folded into the cost basis for margin/P&L.
    let totalSpend = 0;
    if (dto.vehicleId && isValidObjectId(dto.vehicleId)) {
      const v = await this.vehicleModel.findById(dto.vehicleId).select('spends').lean();
      totalSpend = ((v as any)?.spends ?? []).reduce(
        (s: number, x: any) => s + (Number(x.amount) || 0),
        0,
      );
    }

    // Strip the orchestration fields before saving — they aren't on the Sale
    // schema. (Mongoose would drop them anyway under strict mode, but being
    // explicit avoids accidental persistence if the schema ever changes.)
    const { buyerLeadId, leadId, ...saleFields } = dto;
    const sale = await new this.saleModel({ ...saleFields, amountPaid, totalSpend }).save();

    // The most user-visible activity entry in the whole app. Logged BEFORE
    // the side-effects so the dashboard sees "Vehicle sold" first, then the
    // dependent lead-archive / vehicle-sold events can land after.
    await this.activity.log({
      module: 'accounting',
      action: 'sale-recorded',
      entity: 'Sale',
      entityId: sale._id,
      label: `${dto.vehicleTitle ?? 'Vehicle'} sold to ${dto.buyerName} · $${net.toLocaleString()}`,
      byName: dto.actorName,
      meta: { salePrice, discount, net, paymentMethod: dto.paymentMethod, paymentStatus: dto.paymentStatus },
    });

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

  /**
   * Attach a buyer to the existing (non-deleted) Sale for a vehicle — used when
   * a buyer is assigned to an already-sold walk-in lead. Updates the Sale's
   * buyer name/email and pushes the purchase onto the buyer's purchases[]
   * (stage → purchased), mirroring createSale side-effect 2. Best-effort / no-op
   * when there's no sale.
   */
  async attachBuyerToSale(
    vehicleId: string,
    buyer: { buyerLeadId?: string; buyerName: string; buyerEmail?: string },
  ): Promise<void> {
    if (!isValidObjectId(vehicleId)) return;
    const sale = await this.saleModel.findOne({ vehicleId: String(vehicleId), isDeleted: false });
    if (!sale) return;

    sale.buyerName = buyer.buyerName;
    if (buyer.buyerEmail) sale.buyerEmail = buyer.buyerEmail;
    await sale.save();

    if (buyer.buyerLeadId && isValidObjectId(buyer.buyerLeadId)) {
      const net = Math.max(0, (Number(sale.salePrice) || 0) - (Number(sale.discount) || 0));
      await this.buyerModel.updateOne(
        { _id: new Types.ObjectId(buyer.buyerLeadId), isDeleted: false },
        {
          $set: { stage: 'purchased' },
          $push: {
            purchases: {
              at: new Date(),
              vehicle: new Types.ObjectId(vehicleId),
              vehicleTitle: sale.vehicleTitle,
              soldAt: net,
              soldDate: sale.saleDate,
              paymentMethod: sale.paymentMethod,
              paymentStatus: sale.paymentStatus,
              saleId: sale._id,
            },
          },
        },
      );
    }
  }

  /**
   * Flatten every non-deleted vehicle's reconditioning spends into a single
   * ledger-style list for the Accounting page.
   *
   * READ-ONLY and deliberately separate from the operating-expense ledger:
   * vehicle spends are cost-of-goods (already folded into gross margin at sale
   * time via Sale.totalSpend). They are surfaced here for visibility only — NOT
   * written into the `expenses` collection — so they are never double-counted
   * against profit. The date filter (when supplied) matches on the spend's own
   * date, not the vehicle's createdAt.
   */
  async getReconditioningSpends(
    startDate?: string,
    endDate?: string,
  ): Promise<{ items: any[]; totalAmount: number; count: number }> {
    const dateMatch: any = {};
    if (startDate) dateMatch.$gte = new Date(startDate);
    if (endDate) dateMatch.$lte = new Date(endDate);

    const pipeline: any[] = [
      { $match: { isDeleted: false } },
      { $unwind: '$spends' },
    ];
    if (Object.keys(dateMatch).length) {
      pipeline.push({ $match: { 'spends.date': dateMatch } });
    }
    pipeline.push(
      { $sort: { 'spends.date': -1 } },
      {
        $project: {
          _id: '$spends._id',
          vehicleId: '$_id',
          vehicleTitle: '$title',
          vehicleNumber: '$vehicleNumber',
          amount: '$spends.amount',
          category: '$spends.category',
          description: '$spends.description',
          date: '$spends.date',
          by: '$spends.by',
        },
      },
    );

    const items = await this.vehicleModel.aggregate(pipeline);
    const totalAmount = items.reduce((s, x) => s + (Number(x.amount) || 0), 0);
    return { items, totalAmount, count: items.length };
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

  async createExpense(dto: any): Promise<ExpenseDocument> {
    const saved = await new this.expenseModel(dto).save();
    await this.activity.log({
      module: 'accounting',
      action: 'created',
      entity: 'Expense',
      entityId: saved._id,
      label: `${saved.title} · $${Number(saved.amount).toLocaleString()} (${saved.category})`,
      meta: { amount: saved.amount, category: saved.category },
    });
    return saved;
  }

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
    await this.activity.log({
      module: 'accounting',
      action: 'updated',
      entity: 'Expense',
      entityId: updated._id,
      label: `Expense edited · ${updated.title}`,
      meta: { fields: Object.keys(patch) },
    });
    return updated;
  }

  async removeExpense(id: string): Promise<void> {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid expense id');
    const updated = await this.expenseModel.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { $set: { isDeleted: true } },
      { new: false },
    );
    if (!updated) throw new NotFoundException('Expense not found');
    await this.activity.log({
      module: 'accounting',
      action: 'deleted',
      entity: 'Expense',
      entityId: updated._id,
      label: `Expense removed · ${updated.title}`,
    });
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
            spend: { $sum: { $ifNull: ['$totalSpend', 0] } },
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
   * Pass `options.archiveLeads = false` when the CALLER is going to set the
   * lead's status explicitly (e.g. `LeadsService.update` reversing a sale via
   * a PATCH closed→other). Otherwise the cleanup would archive the lead
   * before the caller's update lands, and the caller's chosen status would
   * just be applied on top — wasteful and double-writes the timeline.
   *
   * Returns the per-collection mutation counts so the caller (and downstream
   * UI) can confirm the cascade actually fired. Best-effort: failures don't
   * propagate; the caller has already committed its primary write.
   */
  async cleanupSoldArtifacts(
    vehicleId: string,
    options?: { archiveLeads?: boolean },
  ): Promise<{
    deletedSales: number;
    pulledPurchases: number;
    archivedLeads: number;
  }> {
    if (!isValidObjectId(vehicleId)) {
      return { deletedSales: 0, pulledPurchases: 0, archivedLeads: 0 };
    }
    const vehicleObj = new Types.ObjectId(vehicleId);
    const vehicleIdStr = String(vehicleId);
    const archiveLeads = options?.archiveLeads !== false; // default true

    // Pull buyer.purchases entries that reference any of the sales we're
    // about to soft-delete, BEFORE we hide the sales (so we still have ids).
    const sales = await this.saleModel.find({
      vehicleId: vehicleIdStr,
      isDeleted: false,
    }).select('_id').lean();
    const saleIds = sales.map((s: any) => s._id);

    let pulledPurchases = 0;
    if (saleIds.length) {
      const pullRes = await this.buyerModel.updateMany(
        { 'purchases.saleId': { $in: saleIds } },
        { $pull: { purchases: { saleId: { $in: saleIds } } } },
      );
      pulledPurchases = pullRes.modifiedCount ?? 0;
    }

    const ops: Promise<any>[] = [
      this.saleModel.updateMany(
        { vehicleId: vehicleIdStr, isDeleted: false },
        { $set: { isDeleted: true } },
      ),
    ];
    if (archiveLeads) {
      ops.push(
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
      );
    }

    const results = await Promise.all(ops);
    const saleRes = results[0];
    const leadRes = archiveLeads ? results[1] : { modifiedCount: 0 };

    return {
      deletedSales: saleRes.modifiedCount ?? 0,
      pulledPurchases,
      archivedLeads: leadRes.modifiedCount ?? 0,
    };
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
    const totalSpend = ((vehicle as any).spends ?? []).reduce(
      (s: number, x: any) => s + (Number(x.amount) || 0),
      0,
    );
    await new this.saleModel({
      vehicleTitle: vehicle.title,
      vehicleId: String(vehicle._id),
      buyerName: 'Pending — edit in Sales Ledger',
      buyerEmail: 'pending@example.com',
      salePrice: vehicle.price ?? 0,
      costPrice: 0,
      totalSpend,
      discount: vehicle.discount ?? 0,
      amountPaid: 0,
      saleDate: new Date(),
      paymentMethod: 'cash',
      paymentStatus: 'pending',
      notes: 'Auto-created when the vehicle was marked sold from Inventory.',
    }).save();
  }

  /**
   * Re-sync a sold vehicle's Sale row with its current reconditioning-spend
   * total. Called by InventoryService.removeSpend when a spend is deleted on a
   * vehicle that's already sold, so the snapshot (and therefore the P&L /
   * margin) doesn't drift. No-op if there's no live Sale for the vehicle.
   */
  async syncSaleSpendForVehicle(vehicleId: string, totalSpend: number): Promise<void> {
    if (!isValidObjectId(vehicleId)) return;
    await this.saleModel.updateOne(
      { vehicleId: String(vehicleId), isDeleted: false },
      { $set: { totalSpend: Math.max(0, Number(totalSpend) || 0) } },
    );
  }
}
