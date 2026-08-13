import {
  BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, forwardRef,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types, isValidObjectId } from 'mongoose';
import { Lead, LeadDocument, LeadStatus } from './schemas/lead.schema';
import {
  AddLogEntryDto,
  AddTimelineEntryDto,
  AssignBuyerDto,
  CloseLeadDto,
  CreateLeadDto,
  LeadBookTestDriveDto,
  LeadQueryDto,
  UpdateLeadDto,
  UpdateLogEntryDto,
} from './dto/lead.dto';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { Vehicle, VehicleDocument, VehicleStatus } from '../inventory/schemas/vehicle.schema';
import { BuyerLead, BuyerLeadDocument } from '../crm-buyers/schemas/buyer-lead.schema';
import { AccountingService } from '../accounting/accounting.service';
import { CrmBuyersService } from '../crm-buyers/crm-buyers.service';
import { ActivityService } from '../activity/activity.service';

/**
 * What vehicle status should reflect, given a lead's new status.
 *
 * Triggered only when a CLOSED lead is moved to something else — i.e. the
 * dealer is reversing the sale via the lead. Without this mapping, the
 * vehicle would stay in 'sold' even after the lead became 'contacted' etc.,
 * which is the inconsistency this hook was added to fix.
 *
 * The vehicle lifecycle is now just NEW / SOLD / NONE(''). Only a CLOSED
 * (sold) lead changes the car's status → SOLD. Every other lead state leaves
 * the car simply available (NONE) via the fallback below.
 */
const LEAD_TO_VEHICLE_STATUS: Partial<Record<LeadStatus, VehicleStatus>> = {
  [LeadStatus.CLOSED]: VehicleStatus.SOLD,
};

@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);

  constructor(
    @InjectModel(Lead.name) private readonly model: Model<LeadDocument>,
    @InjectModel(Vehicle.name) private readonly vehicleModel: Model<VehicleDocument>,
    @InjectModel(BuyerLead.name) private readonly buyerModel: Model<BuyerLeadDocument>,
    @Inject(forwardRef(() => AccountingService)) private readonly accountingService: AccountingService,
    private readonly crmBuyersService: CrmBuyersService,
    private readonly activity: ActivityService,
  ) {}

  /**
   * Resolve a buyer for a lead from one of three inputs:
   *   - `buyerId`  → an existing CRM buyer, used as-is.
   *   - `newBuyer` (email present) → create a CRM buyer inline via
   *     CrmBuyersService.create, which rejects (409) a duplicate email. Phone
   *     required. Single source of truth for buyer creation.
   *   - neither    → walk-in; returns null (no buyer).
   */
  private async resolveBuyerId(input: {
    buyerId?: string;
    newBuyerName?: string;
    newBuyerEmail?: string;
    newBuyerPhone?: string;
  }): Promise<string | null> {
    if (input.buyerId && isValidObjectId(input.buyerId)) return input.buyerId;
    const email = (input.newBuyerEmail ?? '').trim();
    if (!email) return null; // walk-in
    const phone = (input.newBuyerPhone ?? '').trim();
    if (!phone) {
      throw new BadRequestException('Buyer phone is required to add a new buyer.');
    }
    const buyer = await this.crmBuyersService.create({
      buyerName: (input.newBuyerName ?? '').trim() || 'Walk-in',
      buyerEmail: email,
      buyerPhone: phone,
    } as any);
    return String((buyer as any)._id ?? (buyer as any).id);
  }

  /**
   * Hydrate log[].vehicle and log[].byStaff in a single batch so the response
   * always carries display data (vehicle title, staff name). Avoids the
   * Mongoose populate quirks we hit on freshly-pushed subdoc refs.
   */
  private async hydrateLog(lead: any): Promise<any> {
    if (!lead) return lead;
    const log: any[] = lead.log ?? [];
    if (!log.length) return lead;

    // An unpopulated ref read from `.lean()` is a Mongoose ObjectId — which
    // is `typeof === 'object'`. So we can't gate on `typeof !== 'object'`;
    // we look for the populated-shape marker (`title` for a Vehicle,
    // `firstName` for a User). Absent → still an ObjectId → hydrate.
    const isPopulatedVehicle = (v: any) => v && typeof v === 'object' && 'title' in v;
    const isPopulatedUser = (u: any) => u && typeof u === 'object' && 'firstName' in u;

    const vehicleIds = new Set<string>();
    const staffIds = new Set<string>();
    for (const entry of log) {
      if (entry?.vehicle && !isPopulatedVehicle(entry.vehicle)) {
        vehicleIds.add(String(entry.vehicle));
      }
      if (entry?.byStaff && !isPopulatedUser(entry.byStaff)) {
        staffIds.add(String(entry.byStaff));
      }
    }

    const [vehicles, staff] = await Promise.all([
      vehicleIds.size
        ? this.vehicleModel
            .find({ _id: { $in: [...vehicleIds].map((id) => new Types.ObjectId(id)) } })
            .select('title vehicleNumber')
            .lean()
        : Promise.resolve([] as any[]),
      staffIds.size
        ? this.model.db
            .collection('users')
            .find(
              { _id: { $in: [...staffIds].map((id) => new Types.ObjectId(id)) } },
              { projection: { firstName: 1, lastName: 1, email: 1 } },
            )
            .toArray()
        : Promise.resolve([] as any[]),
    ]);

    const vById = new Map(vehicles.map((v: any) => [String(v._id), v]));
    const sById = new Map(staff.map((u: any) => [String(u._id), u]));

    const hydratedLog = log.map((entry) => {
      const out = { ...entry };
      if (entry?.vehicle && !isPopulatedVehicle(entry.vehicle)) {
        const v = vById.get(String(entry.vehicle));
        if (v) out.vehicle = v;
      }
      if (entry?.byStaff && !isPopulatedUser(entry.byStaff)) {
        const u = sById.get(String(entry.byStaff));
        if (u) out.byStaff = u;
      }
      return out;
    });
    return { ...lead, log: hydratedLog };
  }

  async create(dto: CreateLeadDto, userId: string, actorId?: string): Promise<any> {
    // NOTE: `userId` is the actor's display NAME (used for timeline `by`), NOT
    // an ObjectId. `actorId` is the real User _id, used to default the assignee.
    if (!isValidObjectId(dto.vehicle)) {
      throw new BadRequestException('Invalid vehicle id');
    }
    const vehicleObj = new Types.ObjectId(dto.vehicle);

    // Peel sale details + inline new-buyer fields off the lead fields — they
    // belong to the Sale / CRM buyer, not the Lead schema. `buyer` is set
    // explicitly below once resolved.
    const {
      soldAt, amountPaid, paymentMethod, paymentStatus, saleDate,
      buyer: _dtoBuyer, newBuyerName, newBuyerEmail, newBuyerPhone, ...leadFields
    } = dto;
    const closingOnCreate = dto.status === LeadStatus.CLOSED;

    // Guard 1: never let a lead be opened on a vehicle that's already sold —
    // the car isn't available anymore, so a new inquiry would be misleading.
    const vehicle = await this.vehicleModel
      .findOne({ _id: vehicleObj, isDeleted: false })
      .select('status title costPrice');
    if (!vehicle) throw new NotFoundException('Vehicle not found');
    if (vehicle.status === 'sold') {
      throw new ConflictException(
        `Vehicle "${vehicle.title}" is already sold; can't open a new lead on it.`,
      );
    }

    // A lead may only start life as CLOSED if the sale is actually captured —
    // otherwise we'd get a "closed lead with an unsold car" (the exact
    // data-integrity drift that broke the closed-count invariant). Validate the
    // sale details up front and route through the same createSale path as
    // /close so the car is sold, the Sale row exists, and the buyer's
    // purchases[] is updated — all atomically-in-spirit.
    if (closingOnCreate) {
      if (!soldAt || soldAt <= 0) {
        throw new BadRequestException('Sold price is required to create a closed lead.');
      }
      if (paymentStatus === 'partial' && (amountPaid === undefined || amountPaid <= 0)) {
        throw new BadRequestException('Amount paid is required for a partial payment.');
      }
    }

    // Resolve the buyer now — AFTER the guards, so we never create a CRM buyer
    // for a request that then gets rejected. Existing id → use it; new-buyer
    // email → create (deduped, 409 on dup); neither → null (walk-in).
    const buyerId = await this.resolveBuyerId({
      buyerId: dto.buyer, newBuyerName, newBuyerEmail, newBuyerPhone,
    });
    const buyerObj = buyerId ? new Types.ObjectId(buyerId) : null;

    // Guard 2: a buyer can only have one lead per vehicle that isn't archived.
    // Skipped for walk-in (buyer-less) leads. Archived is the only terminal
    // state that releases the slot — closed leads still hold it.
    if (buyerObj) {
      const dupe = await this.model.findOne({
        buyer: buyerObj,
        vehicle: vehicleObj,
        isDeleted: false,
        status: { $ne: LeadStatus.ARCHIVED },
      }).select('_id status');
      if (dupe) {
        throw new ConflictException(
          `A lead already exists for this buyer and vehicle. Archive the existing lead (status: ${dupe.status}) to create a new one.`,
        );
      }
    }

    // Leads are never unassigned — default to whoever is creating it (by _id).
    const assignedTo =
      leadFields.assignedTo && isValidObjectId(leadFields.assignedTo)
        ? leadFields.assignedTo
        : actorId && isValidObjectId(actorId)
          ? actorId
          : undefined;

    // Save as NEW when closing-on-create; createSale below flips it to closed
    // with its own timeline entry, so we don't pre-stamp a bogus closed state.
    const lead = await new this.model({
      ...leadFields,
      buyer: buyerObj ?? undefined,
      assignedTo,
      status: closingOnCreate ? LeadStatus.NEW : leadFields.status,
      timeline: [{ date: new Date(), action: 'Lead created', by: userId }],
    }).save();
    // Pull buyer + vehicle title for the activity label — small extra reads
    // but the dashboard surface really wants "John Doe → 2024 Civic", not
    // bare ObjectIds. Buyer is null for walk-in leads.
    const [b, v] = await Promise.all([
      buyerObj
        ? this.buyerModel.findOne({ _id: buyerObj }).select('buyerName buyerEmail').lean()
        : Promise.resolve(null),
      this.vehicleModel.findOne({ _id: vehicleObj }).select('title vehicleNumber').lean(),
    ]);
    await this.activity.log({
      module: 'leads',
      action: 'created',
      entity: 'Lead',
      entityId: lead._id,
      label: `${b?.buyerName ?? 'Walk-in'} → ${v?.title ?? 'Vehicle'}`,
      byName: userId,
      meta: { source: dto.source, status: dto.status ?? 'new' },
    });

    // Closing-on-create: run the unified sale flow (sale + vehicle sold +
    // buyer purchase + lead closed + sibling-archive), mirroring closeLead.
    if (closingOnCreate) {
      await this.accountingService.createSale({
        vehicleId: String(vehicleObj),
        vehicleTitle: vehicle.title,
        buyerName: b?.buyerName ?? 'Walk-in',
        buyerEmail: b?.buyerEmail ?? '—',
        salePrice: soldAt as number,
        costPrice: (vehicle as any).costPrice ?? 0,
        discount: 0,
        amountPaid,
        saleDate: saleDate ? new Date(saleDate) : new Date(),
        paymentMethod: paymentMethod ?? 'cash',
        paymentStatus: paymentStatus ?? 'paid',
        notes: dto.notes ?? `Closed on creation · lead ${String(lead._id)}`,
        buyerLeadId: buyerObj ? String(buyerObj) : undefined,
        leadId: String(lead._id),
        actorName: userId,
      });
      await this.activity.log({
        module: 'leads',
        action: 'closed',
        entity: 'Lead',
        entityId: lead._id,
        label: `${b?.buyerName ?? 'Walk-in'} bought ${vehicle.title} for $${Number(soldAt).toLocaleString()}`,
        byName: userId,
        meta: { soldAt, paymentMethod, paymentStatus, closedOnCreate: true },
      });
    }

    // Mirror the inquiry onto the buyer's CRM record so the vehicle shows up
    // under "Vehicles Interested" on the buyer detail page. Skipped for walk-in
    // (no buyer). $addToSet keeps it idempotent. Best-effort — a sync failure
    // must never fail lead creation.
    if (buyerObj) {
      try {
        await this.buyerModel.updateOne(
          { _id: buyerObj, isDeleted: false },
          { $addToSet: { interestedVehicles: vehicleObj } },
        );
      } catch (err) {
        this.logger.warn(
          `lead create: buyer interestedVehicles sync failed buyer=${buyerId}: ${err}`,
        );
      }
    }

    return this.findById(String(lead._id));
  }

  /**
   * Assign a buyer to an existing walk-in (buyer-less) lead. Accepts an existing
   * CRM buyer id or new-buyer details (created inline, deduped by email). If the
   * lead is already CLOSED (a completed walk-in sale), the linked Sale row's
   * buyer + that buyer's purchases[] are updated too (attachBuyerToSale).
   */
  async assignBuyer(id: string, dto: AssignBuyerDto, userName: string): Promise<any> {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid lead id');
    const lead = await this.model.findOne({ _id: id, isDeleted: false });
    if (!lead) throw new NotFoundException('Lead not found');
    if (lead.buyer) throw new ConflictException('This lead already has a buyer.');

    const buyerId = await this.resolveBuyerId({
      buyerId: dto.buyerLeadId,
      newBuyerName: dto.newBuyerName,
      newBuyerEmail: dto.newBuyerEmail,
      newBuyerPhone: dto.newBuyerPhone,
    });
    if (!buyerId) {
      throw new BadRequestException('Provide an existing buyer or new-buyer details to assign.');
    }
    const buyerObj = new Types.ObjectId(buyerId);

    // Guard 2 for non-terminal leads: a buyer can't hold two active leads on the
    // same vehicle. Closed/archived leads are exempt (the sale is the record).
    if (lead.status !== LeadStatus.CLOSED && lead.status !== LeadStatus.ARCHIVED) {
      const dupe = await this.model.findOne({
        buyer: buyerObj,
        vehicle: lead.vehicle,
        isDeleted: false,
        status: { $ne: LeadStatus.ARCHIVED },
        _id: { $ne: lead._id },
      }).select('_id status');
      if (dupe) {
        throw new ConflictException(
          `That buyer already has a lead for this vehicle (status: ${dupe.status}).`,
        );
      }
    }

    const buyer = await this.buyerModel
      .findOne({ _id: buyerObj })
      .select('buyerName buyerEmail')
      .lean();

    lead.buyer = buyerObj;
    lead.timeline.push({
      date: new Date(),
      action: `Buyer assigned: ${buyer?.buyerName ?? 'buyer'}`,
      by: userName,
    });
    await lead.save();

    await this.activity.log({
      module: 'leads',
      action: 'updated',
      entity: 'Lead',
      entityId: lead._id,
      label: `Buyer assigned — ${buyer?.buyerName ?? 'buyer'}`,
      byName: userName,
      meta: { buyerId },
    });

    // Buyer's interested-vehicles mirror.
    try {
      await this.buyerModel.updateOne(
        { _id: buyerObj, isDeleted: false },
        { $addToSet: { interestedVehicles: lead.vehicle } },
      );
    } catch (err) {
      this.logger.warn(`assignBuyer interestedVehicles sync failed: ${err}`);
    }

    // Closed walk-in sale → reflect the buyer on the Sale + purchases[].
    if (lead.status === LeadStatus.CLOSED && lead.vehicle && buyer) {
      try {
        await this.accountingService.attachBuyerToSale(String(lead.vehicle), {
          buyerLeadId: buyerId,
          buyerName: buyer.buyerName,
          buyerEmail: buyer.buyerEmail,
        });
      } catch (err) {
        this.logger.error(
          `assignBuyer: attachBuyerToSale failed vehicle=${lead.vehicle}: ${err instanceof Error ? err.stack : err}`,
        );
      }
    }

    return this.findById(String(lead._id));
  }

  async findAll(query: LeadQueryDto): Promise<PaginatedResult<any>> {
    const { page = 1, limit = 20, search, sort = '-createdAt', status, source, assignedTo, buyer, vehicle } = query;
    const skip = (page - 1) * limit;

    const filter: FilterQuery<LeadDocument> = { isDeleted: false };
    if (status) filter.status = status;
    if (source) filter.source = source;
    if (assignedTo) filter.assignedTo = assignedTo;
    if (buyer) filter.buyer = buyer;
    if (vehicle) filter.vehicle = vehicle;
    if (search) {
      filter.$or = [{ notes: { $regex: search, $options: 'i' } }];
    }

    const sortObj: Record<string, 1 | -1> = sort.startsWith('-')
      ? { [sort.slice(1)]: -1 }
      : { [sort]: 1 };

    const [data, total] = await Promise.all([
      this.model
        .find(filter)
        .sort(sortObj)
        .skip(skip)
        .limit(limit)
        .populate('buyer', 'buyerName buyerEmail')
        .populate('vehicle', 'title vehicleNumber')
        .populate('assignedTo', 'firstName lastName')
        .lean(),
      this.model.countDocuments(filter),
    ]);

    // Log hydration only matters for the detail view; list view doesn't render comms.
    return new PaginatedResult(data, total, page, limit);
  }

  async findById(id: string): Promise<any> {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid lead id');
    const lead = await this.model
      .findOne({ _id: id, isDeleted: false })
      .populate('buyer', 'buyerName buyerEmail buyerPhone')
      .populate('vehicle', 'title vehicleNumber company model year price')
      .populate('assignedTo', 'firstName lastName email')
      .lean();
    if (!lead) throw new NotFoundException('Lead not found');
    return this.hydrateLog(lead);
  }

  async update(id: string, dto: UpdateLeadDto, userId: string): Promise<any> {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid lead id');
    const existing = await this.model.findOne({ _id: id, isDeleted: false });
    if (!existing) throw new NotFoundException('Lead not found');

    // ── Terminal-state guards ────────────────────────────────────────────────
    // Closing must go through /close (which records the sale). A plain PATCH to
    // 'closed' would produce a closed lead with an unsold car — the exact drift
    // we're eliminating.
    if (dto.status === LeadStatus.CLOSED && existing.status !== LeadStatus.CLOSED) {
      throw new BadRequestException(
        'Use the Close Lead action to close a lead — it records the sale.',
      );
    }
    // Once CLOSED, a lead can only be archived (which voids the sale) — never
    // back into the pipeline.
    if (
      existing.status === LeadStatus.CLOSED &&
      dto.status !== undefined &&
      dto.status !== LeadStatus.CLOSED &&
      dto.status !== LeadStatus.ARCHIVED
    ) {
      throw new ConflictException(
        'A closed lead can only be archived; it cannot be moved back into the pipeline.',
      );
    }
    // ARCHIVED is terminal — archived leads can't be recovered.
    if (
      existing.status === LeadStatus.ARCHIVED &&
      dto.status !== undefined &&
      dto.status !== LeadStatus.ARCHIVED
    ) {
      throw new ConflictException('Archived leads cannot be recovered.');
    }
    // Assignee + asked price are locked on terminal leads (closed / archived).
    // Silently drop any attempted change so a bundled "archive" save — which
    // resends them unchanged — still succeeds.
    if (
      existing.status === LeadStatus.CLOSED ||
      existing.status === LeadStatus.ARCHIVED
    ) {
      delete (dto as { assignedTo?: unknown }).assignedTo;
      delete (dto as { askedPrice?: unknown }).askedPrice;
    }
    // Otherwise a lead is never unassigned once it has one.
    else if (!dto.assignedTo && 'assignedTo' in dto && existing.assignedTo) {
      throw new BadRequestException('A lead cannot be unassigned.');
    }

    // Setting an asked price for the first time (or changing it) auto-bumps
    // the pipeline to negotiation — unless the caller is explicitly setting a
    // terminal state (closed / dropped). Avoids forcing the user to remember
    // to bump status manually after entering a quote.
    const willSetAskedPrice =
      dto.askedPrice !== undefined &&
      dto.askedPrice !== null &&
      Number(dto.askedPrice) > 0 &&
      Number(dto.askedPrice) !== Number(existing.askedPrice ?? 0);
    // Setting an asked price no longer auto-advances the pipeline to
    // Negotiation (product decision) — staff move the status explicitly. The
    // price change is still recorded in the timeline + activity feed below.
    const effectiveStatus = dto.status;

    const $set: any = { ...dto };
    if (effectiveStatus) $set.status = effectiveStatus;

    const timelineEntries: { date: Date; action: string; by: string }[] = [];
    if (effectiveStatus && effectiveStatus !== existing.status) {
      timelineEntries.push({
        date: new Date(),
        action: `Status changed: ${existing.status} → ${effectiveStatus}`,
        by: userId,
      });
    }
    if (dto.assignedTo && String(existing.assignedTo) !== dto.assignedTo) {
      timelineEntries.push({
        date: new Date(),
        action: `Assigned to a different staff member`,
        by: userId,
      });
    }
    if (willSetAskedPrice) {
      timelineEntries.push({
        date: new Date(),
        action: `Asked price set to $${Number(dto.askedPrice).toLocaleString()}`,
        by: userId,
      });
    }

    const updateOps: Record<string, unknown> = { $set };
    if (timelineEntries.length > 0) {
      updateOps.$push = { timeline: { $each: timelineEntries } };
    }

    const lead = await this.model.findOneAndUpdate(
      { _id: id, isDeleted: false },
      updateOps,
      { new: true },
    );
    if (!lead) throw new NotFoundException('Lead not found');

    // Log every PATCH — status flips, asked-price tweaks, reassignments all
    // appear in the activity feed so the dashboard reflects pipeline progress.
    if (effectiveStatus && effectiveStatus !== existing.status) {
      await this.activity.log({
        module: 'leads',
        action: effectiveStatus === LeadStatus.ARCHIVED ? 'archived' : 'status-changed',
        entity: 'Lead',
        entityId: lead._id,
        label: `Lead moved ${existing.status} → ${effectiveStatus}`,
        byName: userId,
        meta: { from: existing.status, to: effectiveStatus },
      });
    } else if (willSetAskedPrice) {
      await this.activity.log({
        module: 'leads',
        action: 'updated',
        entity: 'Lead',
        entityId: lead._id,
        label: `Asked price set to $${Number(dto.askedPrice).toLocaleString()}`,
        byName: userId,
        meta: { askedPrice: dto.askedPrice },
      });
    }

    // Closed → anything else: the dealer is reversing the sale via the lead.
    // Cascade the unwind so the vehicle, sale row, and buyer's purchases[]
    // entry don't drift out of sync with the lead's new state.
    //
    // - The vehicle's status follows LEAD_TO_VEHICLE_STATUS: only CLOSED maps
    //   to SOLD; every other lead state falls back to NONE (available).
    // - cleanupSoldArtifacts soft-deletes the Sale row and pulls the buyer's
    //   purchases[] entry. We pass archiveLeads: false because we've ALREADY
    //   updated this lead's status above — letting cleanup overwrite it to
    //   ARCHIVED would defeat the dealer's explicit choice.
    if (
      existing.status === LeadStatus.CLOSED &&
      effectiveStatus &&
      effectiveStatus !== LeadStatus.CLOSED &&
      existing.vehicle
    ) {
      const vehicleId = String(existing.vehicle);
      const newVehicleStatus =
        LEAD_TO_VEHICLE_STATUS[effectiveStatus] ?? VehicleStatus.NONE;
      try {
        const counts = await this.accountingService.cleanupSoldArtifacts(
          vehicleId,
          { archiveLeads: false },
        );
        await this.vehicleModel.updateOne(
          { _id: existing.vehicle, isDeleted: false },
          { $set: { status: newVehicleStatus, soldAt: 0, soldDate: null } },
        );
        this.logger.log(
          `closed-lead-edit cascade leadId=${id} vehicleId=${vehicleId} ` +
          `newLeadStatus=${effectiveStatus} newVehicleStatus=${newVehicleStatus} ` +
          `deletedSales=${counts.deletedSales} pulledPurchases=${counts.pulledPurchases}`,
        );
      } catch (err) {
        this.logger.error(
          `closed-lead-edit cascade failed for leadId=${id} vehicleId=${vehicleId}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }

    return this.findById(id);
  }

  async addTimelineEntry(id: string, dto: AddTimelineEntryDto, userId: string): Promise<any> {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid lead id');
    const lead = await this.model.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { $push: { timeline: { date: new Date(), action: dto.action, by: dto.by ?? userId } } },
      { new: true },
    );
    if (!lead) throw new NotFoundException('Lead not found');
    return this.findById(id);
  }

  async addLogEntry(id: string, dto: AddLogEntryDto, userId?: string): Promise<any> {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid lead id');
    const entry: any = {
      _id: new Types.ObjectId(),
      date: dto.at ? new Date(dto.at) : new Date(),
      channel: dto.channel,
      summary: dto.summary,
    };
    if (dto.vehicleId && isValidObjectId(dto.vehicleId)) {
      entry.vehicle = new Types.ObjectId(dto.vehicleId);
    }
    if (dto.byStaffId && isValidObjectId(dto.byStaffId)) {
      entry.byStaff = new Types.ObjectId(dto.byStaffId);
    } else if (userId && isValidObjectId(userId)) {
      entry.byStaff = new Types.ObjectId(userId);
    }

    // Fetch the current lead so we can decide whether logging this
    // communication should advance the pipeline (new → contacted).
    const existing = await this.model.findOne({ _id: id, isDeleted: false });
    if (!existing) throw new NotFoundException('Lead not found');

    const update: any = { $push: { log: entry } };
    if (existing.status === LeadStatus.NEW) {
      update.$set = { status: LeadStatus.CONTACTED };
      update.$push.timeline = {
        date: new Date(),
        action: `Status changed: new → contacted (first communication logged)`,
        by: userId,
      };
    }

    const lead = await this.model.findOneAndUpdate(
      { _id: id, isDeleted: false },
      update,
      { new: true },
    );
    if (!lead) throw new NotFoundException('Lead not found');

    // Mirror this communication onto the buyer's CRM record so it appears in
    // the buyer detail page's Communication History, with the lead's vehicle
    // attached (same as the interestedVehicles sync). Best-effort, add-only —
    // lead-log edits/deletes don't propagate back.
    try {
      const vehId = entry.vehicle ?? existing.vehicle;
      let vehicleTitle = '';
      if (vehId) {
        const v = await this.vehicleModel.findById(vehId).select('title').lean();
        vehicleTitle = v?.title ?? '';
      }
      await this.buyerModel.updateOne(
        { _id: existing.buyer, isDeleted: false },
        {
          $push: {
            communications: {
              _id: new Types.ObjectId(),
              at: entry.date,
              channel: entry.channel,
              ...(vehId ? { vehicle: vehId } : {}),
              vehicleTitle,
              summary: entry.summary ?? '',
              ...(entry.byStaff ? { byStaff: entry.byStaff } : {}),
            },
          },
        },
      );
    } catch (err) {
      this.logger.warn(
        `addLogEntry: buyer communications sync failed buyer=${String(existing.buyer)}: ${err}`,
      );
    }

    return this.findById(id);
  }

  /**
   * Book a test drive against this lead's vehicle. Pushes a history entry on
   * the buyer (via the calendar event when the frontend creates it) and
   * advances the lead pipeline to test_drive.
   *
   * The calendar event itself is created by the frontend (`useCreateCalendarEvent`)
   * because the calendar module owns event hydration. This endpoint just
   * updates the lead state so the two stay in sync.
   */
  async bookTestDrive(id: string, dto: LeadBookTestDriveDto, userId: string): Promise<any> {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid lead id');
    const existing = await this.model.findOne({ _id: id, isDeleted: false });
    if (!existing) throw new NotFoundException('Lead not found');

    const update: any = {
      $push: {
        timeline: {
          date: new Date(),
          action: `Test drive booked for ${new Date(dto.scheduledAt).toISOString().slice(0, 16).replace('T', ' ')}`,
          by: userId,
        },
      },
    };
    if (dto.assignedTo && isValidObjectId(dto.assignedTo)) {
      update.$set = { ...(update.$set ?? {}), assignedTo: new Types.ObjectId(dto.assignedTo) };
    }
    // Only auto-advance if not already past test-drive in the pipeline.
    if (
      existing.status === LeadStatus.NEW ||
      existing.status === LeadStatus.CONTACTED
    ) {
      update.$set = { ...(update.$set ?? {}), status: LeadStatus.TEST_DRIVE };
      update.$push.timeline = {
        date: new Date(),
        action: `Status changed: ${existing.status} → test_drive`,
        by: userId,
      };
      // $push of timeline above was overwritten by re-assignment; restore
      // the original test-drive note alongside the status note.
      update.$push = {
        timeline: {
          $each: [
            {
              date: new Date(),
              action: `Test drive booked for ${new Date(dto.scheduledAt).toISOString().slice(0, 16).replace('T', ' ')}`,
              by: userId,
            },
            {
              date: new Date(),
              action: `Status changed: ${existing.status} → test_drive`,
              by: userId,
            },
          ],
        },
      };
    }

    const lead = await this.model.findOneAndUpdate(
      { _id: id, isDeleted: false },
      update,
      { new: true },
    );
    if (!lead) throw new NotFoundException('Lead not found');
    await this.activity.log({
      module: 'calendar',
      action: 'test-drive-booked',
      entity: 'Lead',
      entityId: lead._id,
      label: `Test drive booked · ${new Date(dto.scheduledAt).toLocaleString()}`,
      byName: userId,
      meta: { scheduledAt: dto.scheduledAt },
    });

    // Mirror onto the buyer's CRM record so it appears under "Test Drives &
    // Purchases" on the buyer detail page. The buyer mapper filters history by
    // action === 'test_drive_booked', so we use that exact slug. Best-effort.
    try {
      const v = await this.vehicleModel
        .findById(existing.vehicle)
        .select('title')
        .lean();
      await this.buyerModel.updateOne(
        { _id: existing.buyer, isDeleted: false },
        {
          $push: {
            history: {
              vehicleId: String(existing.vehicle),
              vehicleTitle: v?.title ?? '',
              action: 'test_drive_booked',
              date: new Date(dto.scheduledAt),
            },
          },
        },
      );
    } catch (err) {
      this.logger.warn(
        `bookTestDrive: buyer history sync failed buyer=${String(existing.buyer)}: ${err}`,
      );
    }

    return this.findById(id);
  }

  async updateLogEntry(id: string, logId: string, dto: UpdateLogEntryDto): Promise<any> {
    if (!isValidObjectId(id) || !isValidObjectId(logId)) {
      throw new BadRequestException('Invalid id');
    }
    const $set: Record<string, unknown> = {};
    if (dto.channel !== undefined) $set['log.$.channel'] = dto.channel;
    if (dto.summary !== undefined) $set['log.$.summary'] = dto.summary;
    if (dto.at) $set['log.$.date'] = new Date(dto.at);
    if (dto.vehicleId && isValidObjectId(dto.vehicleId)) {
      $set['log.$.vehicle'] = new Types.ObjectId(dto.vehicleId);
    } else if (dto.vehicleId === '' || dto.vehicleId === null) {
      $set['log.$.vehicle'] = null;
    }
    if (dto.byStaffId && isValidObjectId(dto.byStaffId)) {
      $set['log.$.byStaff'] = new Types.ObjectId(dto.byStaffId);
    } else if (dto.byStaffId === '' || dto.byStaffId === null) {
      $set['log.$.byStaff'] = null;
    }
    const lead = await this.model.findOneAndUpdate(
      { _id: id, isDeleted: false, 'log._id': new Types.ObjectId(logId) },
      { $set },
      { new: true },
    );
    if (!lead) throw new NotFoundException('Log entry not found');
    return this.findById(id);
  }

  async removeLogEntry(id: string, logId: string): Promise<any> {
    if (!isValidObjectId(id) || !isValidObjectId(logId)) {
      throw new BadRequestException('Invalid id');
    }
    const lead = await this.model.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { $pull: { log: { _id: new Types.ObjectId(logId) } } },
      { new: true },
    );
    if (!lead) throw new NotFoundException('Lead not found');
    return this.findById(id);
  }

  /**
   * Close a lead — the canonical "we sold the car" action.
   *
   * Single mutation orchestrating four collections:
   *   1. Sales       — creates the Sale via AccountingService (which itself
   *                    flips vehicle.status to "sold" and sets soldAt+soldDate).
   *   2. Vehicle     — no extra write needed; AccountingService handled it.
   *   3. BuyerLead   — pushes a purchases[] entry + bumps stage to purchased.
   *   4. Lead        — status → closed + timeline entry.
   *
   * Returns the refreshed Lead.
   */
  async closeLead(id: string, dto: CloseLeadDto, userId: string): Promise<any> {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid lead id');

    const lead = await this.model
      .findOne({ _id: id, isDeleted: false })
      .populate('buyer', 'buyerName buyerEmail buyerPhone')
      .populate('vehicle', 'title vehicleNumber costPrice price');
    if (!lead) throw new NotFoundException('Lead not found');
    if (lead.status === LeadStatus.CLOSED) {
      throw new ConflictException('Lead is already closed');
    }
    const buyer: any = lead.buyer;
    const vehicle: any = lead.vehicle;
    if (!buyer || typeof buyer === 'string') throw new BadRequestException('Lead buyer is not populated');
    if (!vehicle || typeof vehicle === 'string') throw new BadRequestException('Lead vehicle is not populated');

    const saleDate = dto.saleDate ? new Date(dto.saleDate) : new Date();

    // Delegate to the unified createSale — it handles the sale + vehicle
    // status/soldAt/soldDate + buyer purchase push + lead close + timeline
    // all in one place, so this orchestration stays a thin wrapper.
    await this.accountingService.createSale({
      vehicleId: String(vehicle._id),
      vehicleTitle: vehicle.title,
      buyerName: buyer.buyerName,
      buyerEmail: buyer.buyerEmail,
      salePrice: dto.soldAt,
      costPrice: vehicle.costPrice ?? 0,
      discount: 0,
      amountPaid: dto.amountPaid,
      saleDate,
      paymentMethod: dto.paymentMethod,
      paymentStatus: dto.paymentStatus,
      notes: dto.notes ?? `Closed via lead ${id}`,
      buyerLeadId: String(buyer._id),
      leadId: String(lead._id),
      actorName: userId,
    });

    await this.activity.log({
      module: 'leads',
      action: 'closed',
      entity: 'Lead',
      entityId: lead._id,
      label: `${buyer.buyerName} bought ${vehicle.title} for $${Number(dto.soldAt).toLocaleString()}`,
      byName: userId,
      meta: { soldAt: dto.soldAt, paymentMethod: dto.paymentMethod, paymentStatus: dto.paymentStatus },
    });

    return this.findById(id);
  }

  /**
   * Soft-delete a lead.
   *
   * If the lead being deleted was `closed`, we also undo the sale it
   * represented: the linked vehicle goes back to UNSOLD with cleared
   * soldAt/soldDate, the Sale row gets soft-deleted, and the buyer's
   * purchases[] entry is pulled. Without this the dealer would be left
   * with a sold vehicle whose paperwork (the lead) is gone, which is
   * exactly the inconsistency the unified createSale/cleanup pair was
   * built to prevent.
   *
   * The reversal is best-effort: if any of it fails, the lead is still
   * deleted (the primary write) and the dealer can recover via the
   * Inventory "edit status" path which routes through cleanupSoldArtifacts
   * too.
   */
  async remove(id: string): Promise<void> {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid lead id');
    // `new: false` returns the doc as it was BEFORE the update — we need its
    // pre-delete status + vehicle to decide whether to revert the sale.
    const lead = await this.model.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { $set: { isDeleted: true, deletedAt: new Date() } },
      { new: false },
    );
    if (!lead) throw new NotFoundException('Lead not found');

    if (lead.status === LeadStatus.CLOSED && lead.vehicle) {
      const vehicleId = String(lead.vehicle);
      try {
        // Run the sale-cleanup and the vehicle revert in parallel — they
        // touch different collections so there's no ordering constraint.
        await Promise.all([
          this.accountingService.cleanupSoldArtifacts(vehicleId),
          this.vehicleModel.updateOne(
            { _id: lead.vehicle, isDeleted: false },
            { $set: { status: VehicleStatus.NONE, soldAt: 0, soldDate: null } },
          ),
        ]);
      } catch (err) {
        this.logger.error(
          `closed-lead-delete sale reversal failed for leadId=${id} vehicleId=${vehicleId}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }

    await this.activity.log({
      module: 'leads',
      action: 'deleted',
      entity: 'Lead',
      entityId: lead._id,
      label: `Lead deleted (was ${lead.status})`,
      meta: { previousStatus: lead.status },
    });
  }

  async getPipelineStats(): Promise<{ _id: string; count: number }[]> {
    return this.model.aggregate([
      { $match: { isDeleted: false } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
  }
}
