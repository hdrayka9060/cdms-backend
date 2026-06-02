import {
  Injectable, Logger, NotFoundException, ConflictException, BadRequestException,
  Inject, forwardRef,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Model, FilterQuery, Types, isValidObjectId } from 'mongoose';
import { parse } from 'csv-parse/sync';
import { Vehicle, VehicleDocument, VehicleStatus } from './schemas/vehicle.schema';
import { CreateVehicleDto, UpdateVehicleDto, VehicleQueryDto } from './dto/vehicle.dto';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { SellerLead, SellerLeadDocument } from '../crm-sellers/schemas/seller-lead.schema';
import { AccountingService } from '../accounting/accounting.service';
import { ActivityService } from '../activity/activity.service';
import { VinDecodeService, DecodedVehicleFields } from './vin-decode.service';

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    @InjectModel(Vehicle.name) private vehicleModel: Model<VehicleDocument>,
    @InjectModel(SellerLead.name) private sellerLeadModel: Model<SellerLeadDocument>,
    // forwardRef: AccountingModule already imports the Vehicle schema, so DI
    // would deadlock without it.
    @Inject(forwardRef(() => AccountingService)) private accountingService: AccountingService,
    private readonly activity: ActivityService,
    private readonly vinDecode: VinDecodeService,
  ) {}

  /**
   * Create a vehicle. The optional 3rd arg `sellerId` overrides whatever `dto.seller`
   * carried — that's how the CRM Sellers flow stamps the back-link without having
   * to plumb the field through the seller form.
   */
  async create(dto: CreateVehicleDto, userId: string, sellerId?: string | null): Promise<VehicleDocument> {
    // Auto-generate a unique vehicleNumber if one wasn't supplied.
    let vehicleNumber = dto.vehicleNumber?.toUpperCase();
    if (vehicleNumber) {
      const exists = await this.vehicleModel.findOne({ vehicleNumber });
      if (exists) throw new ConflictException(`Vehicle number ${vehicleNumber} already exists`);
    } else {
      vehicleNumber = await this.generateUniqueVehicleNumber();
    }

    // VIN uniqueness: a non-deleted vehicle may not share a VIN with another.
    // A soft-deleted vehicle with the same VIN does NOT block — re-adding a car
    // whose previous listing was deleted is allowed. Matched case-insensitively
    // to catch legacy mixed-case rows; new rows are stored upper-cased.
    const vinNorm = (dto.vin ?? '').trim().toUpperCase();
    if (vinNorm) {
      const escaped = vinNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const dupe = await this.vehicleModel
        .findOne({ isDeleted: false, vin: { $regex: `^${escaped}$`, $options: 'i' } })
        .select('vehicleNumber');
      if (dupe) {
        throw new ConflictException(`A vehicle with VIN ${vinNorm} already exists (${dupe.vehicleNumber}).`);
      }
    }

    const explicitSeller = sellerId ?? dto.seller;
    const seller =
      explicitSeller && isValidObjectId(explicitSeller)
        ? new Types.ObjectId(explicitSeller)
        : null;

    const vehicle = new this.vehicleModel({
      ...dto,
      vehicleNumber,
      addedBy: userId,
      seller,
      vin: vinNorm || undefined,
    });
    const saved = await vehicle.save();
    await this.activity.log({
      module: 'inventory',
      action: 'created',
      entity: 'Vehicle',
      entityId: saved._id,
      label: `${saved.title} (${saved.vehicleNumber})`,
      byId: userId,
      meta: { price: saved.price, status: saved.status },
    });
    return saved;
  }

  private async generateUniqueVehicleNumber(): Promise<string> {
    for (let i = 0; i < 5; i++) {
      const candidate = `V-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
      const exists = await this.vehicleModel.findOne({ vehicleNumber: candidate });
      if (!exists) return candidate;
    }
    // Fallback to a timestamp-based ID if 5 random attempts all collided (essentially impossible).
    return `V-${Date.now().toString(36).toUpperCase()}`;
  }

  async findAll(query: VehicleQueryDto): Promise<PaginatedResult<VehicleDocument>> {
    const { page = 1, limit = 20, search, sort = '-createdAt', status, company, model,
      minPrice, maxPrice, minYear, maxYear, fuelType, transmission } = query;
    const skip = (page - 1) * limit;

    const filter: FilterQuery<VehicleDocument> = { isDeleted: false };
    if (status) filter.status = status;
    if (company) filter.company = { $regex: company, $options: 'i' };
    if (model) filter.model = { $regex: model, $options: 'i' };
    if (fuelType) filter.fuelType = fuelType;
    if (transmission) filter.transmission = transmission;
    if (minPrice !== undefined || maxPrice !== undefined) {
      filter.price = {};
      if (minPrice !== undefined) filter.price.$gte = minPrice;
      if (maxPrice !== undefined) filter.price.$lte = maxPrice;
    }
    if (minYear !== undefined || maxYear !== undefined) {
      filter.year = {};
      if (minYear !== undefined) filter.year.$gte = minYear;
      if (maxYear !== undefined) filter.year.$lte = maxYear;
    }
    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: 'i' } },
        { company: { $regex: search, $options: 'i' } },
        { model: { $regex: search, $options: 'i' } },
        { vehicleNumber: { $regex: search, $options: 'i' } },
      ];
    }

    const sortObj: any = {};
    if (sort.startsWith('-')) sortObj[sort.slice(1)] = -1;
    else sortObj[sort] = 1;

    const [data, total] = await Promise.all([
      this.vehicleModel
        .find(filter)
        .sort(sortObj)
        .skip(skip)
        .limit(limit)
        .populate('addedBy', 'firstName lastName email')
        .populate('seller', 'sellerName sellerEmail sellerPhone')
        .lean(),
      this.vehicleModel.countDocuments(filter),
    ]);

    return new PaginatedResult(data as unknown as VehicleDocument[], total, page, limit);
  }

  async findById(id: string): Promise<VehicleDocument> {
    const vehicle = await this.vehicleModel
      .findOne({ _id: id, isDeleted: false })
      .populate('addedBy', 'firstName lastName email')
      .populate('seller', 'sellerName sellerEmail sellerPhone');
    if (!vehicle) throw new NotFoundException('Vehicle not found');
    return vehicle;
  }

  /**
   * Bump the public traffic counter. Called explicitly by the public
   * dealer-website endpoint (anonymous browsing) — NOT by internal admin
   * routes. Keeps the view count meaningful as a marketing signal rather
   * than counting every time a staff member clicks into a vehicle.
   */
  async incrementViews(id: string): Promise<void> {
    await this.vehicleModel.findByIdAndUpdate(id, {
      $inc: { 'traffic.views': 1 },
      $set: { 'traffic.lastViewed': new Date() },
    });
  }

  async update(id: string, dto: UpdateVehicleDto, userId: string): Promise<VehicleDocument> {
    const vehicle = await this.vehicleModel.findOne({ _id: id, isDeleted: false });
    if (!vehicle) throw new NotFoundException('Vehicle not found');

    // Track history
    const historyEntries = Object.entries(dto)
      .filter(([key, value]) => vehicle[key] !== value)
      .map(([field, value]) => ({
        field,
        value: String(vehicle[field]),
        newValue: String(value),
        changedAt: new Date(),
        changedBy: userId,
      }));

    const updated = await this.vehicleModel.findByIdAndUpdate(
      id,
      { $set: dto, $push: { history: { $each: historyEntries } } },
      { new: true, runValidators: true },
    );

    // Log AFTER the write so we don't double-record if the update throws.
    // Status changes get their own action verb so the dashboard can show
    // "Vehicle sold" / "Vehicle marked unsold" rather than a generic update.
    if (updated) {
      const statusChanged = dto.status !== undefined && dto.status !== vehicle.status;
      await this.activity.log({
        module: 'inventory',
        action: statusChanged
          ? (dto.status === VehicleStatus.SOLD ? 'sold' : 'status-changed')
          : 'updated',
        entity: 'Vehicle',
        entityId: updated._id,
        label: `${updated.title} (${updated.vehicleNumber})`,
        byId: userId,
        meta: statusChanged
          ? { from: vehicle.status, to: dto.status }
          : { fieldsChanged: historyEntries.map((h) => h.field) },
      });
    }

    // If this update flipped the vehicle into "sold", make sure the sales
    // ledger has a row for it. Best-effort: a failure here must not block the
    // vehicle update itself.
    if (
      updated &&
      dto.status === VehicleStatus.SOLD &&
      vehicle.status !== VehicleStatus.SOLD
    ) {
      try {
        await this.accountingService.ensureSaleForSoldVehicle(updated);
      } catch {
        /* swallow — vehicle update is the authoritative success here */
      }
    }

    // Inverse transition: vehicle went FROM sold to any other status.
    // The dealer is saying "actually it wasn't sold" — clean up the sale,
    // the closed lead, the buyer's purchase record, and the sold price/date
    // stamps. Best-effort; the vehicle update itself has already succeeded.
    if (
      updated &&
      vehicle.status === VehicleStatus.SOLD &&
      dto.status !== undefined &&
      dto.status !== VehicleStatus.SOLD
    ) {
      try {
        const counts = await this.accountingService.cleanupSoldArtifacts(String(updated._id));
        // Clear the realised price/date so Inventory stops showing them.
        await this.vehicleModel.updateOne(
          { _id: updated._id },
          { $set: { soldAt: 0, soldDate: null } },
        );
        // Verifies the cascade. archivedLeads=0 here is the smoking gun for
        // the "sibling/closed lead didn't archive on un-sell" complaint —
        // either the lead's `vehicle` field is a string instead of ObjectId,
        // or no lead was actually in status='closed' when we ran.
        this.logger.log(
          `inverse-transition cleanup vehicleId=${String(updated._id)} ` +
          `from=${vehicle.status} to=${dto.status} ` +
          `archivedLeads=${counts.archivedLeads} ` +
          `deletedSales=${counts.deletedSales} ` +
          `pulledPurchases=${counts.pulledPurchases}`,
        );
      } catch (err) {
        // Vehicle update is already authoritative — never reject the request.
        // But surface the failure so we don't repeat the silent-swallow bug.
        this.logger.error(
          `inverse-transition cleanup failed for vehicleId=${String(updated._id)}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }

    return updated;
  }

  async addImages(id: string, filePaths: string[]): Promise<VehicleDocument> {
    const vehicle = await this.vehicleModel.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { $push: { photos: { $each: filePaths } } },
      { new: true },
    );
    if (!vehicle) throw new NotFoundException('Vehicle not found');
    return vehicle;
  }

  async removeImage(id: string, photoPath: string): Promise<VehicleDocument> {
    const vehicle = await this.vehicleModel.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { $pull: { photos: photoPath } },
      { new: true },
    );
    if (!vehicle) throw new NotFoundException('Vehicle not found');
    return vehicle;
  }

  /**
   * Record a reconditioning spend on a vehicle (repair/service/parts/etc).
   * Blocked once the vehicle is sold — its cost basis is already locked into
   * the Sale snapshot. The spend `by` is captured as a name string so the
   * Spends tab can render it without a populate.
   */
  async addSpend(
    id: string,
    dto: { amount: number; category?: string; description?: string; date?: string },
    user: any,
  ): Promise<VehicleDocument> {
    const vehicle = await this.vehicleModel.findOne({ _id: id, isDeleted: false });
    if (!vehicle) throw new NotFoundException('Vehicle not found');
    if (vehicle.status === VehicleStatus.SOLD) {
      throw new BadRequestException('Cannot add spends to a sold vehicle');
    }
    const amount = Number(dto.amount) || 0;
    if (amount <= 0) throw new BadRequestException('Spend amount must be greater than 0');

    const by =
      [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim() ||
      user?.email ||
      'System';
    const entry = {
      amount,
      category: (dto.category ?? 'other').trim() || 'other',
      description: (dto.description ?? '').trim(),
      date: dto.date ? new Date(dto.date) : new Date(),
      by,
    };
    vehicle.spends.push(entry as any);
    const saved = await vehicle.save();

    await this.activity.log({
      module: 'inventory',
      action: 'spend-added',
      entity: 'Vehicle',
      entityId: saved._id,
      label: `Spend $${amount.toLocaleString()} (${entry.category}) · ${saved.title}`,
      byId: user?._id,
      meta: { amount, category: entry.category },
    });
    return saved;
  }

  /**
   * Delete a recorded spend. Allowed even after the vehicle is sold (the
   * dealer can correct a mistake) — in that case we re-sync the Sale's
   * `totalSpend` snapshot so the P&L / margin stay accurate.
   */
  async removeSpend(id: string, spendId: string, user: any): Promise<VehicleDocument> {
    if (!isValidObjectId(spendId)) throw new BadRequestException('Invalid spend id');
    const vehicle = await this.vehicleModel.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { $pull: { spends: { _id: new Types.ObjectId(spendId) } } },
      { new: true },
    );
    if (!vehicle) throw new NotFoundException('Vehicle not found');

    await this.activity.log({
      module: 'inventory',
      action: 'spend-removed',
      entity: 'Vehicle',
      entityId: vehicle._id,
      label: `Spend removed · ${vehicle.title}`,
      byId: user?._id,
    });

    // If the vehicle has already been sold, its Sale row carries a snapshot of
    // the spend total — re-sync so the P&L and per-row margin reflect the
    // deletion. Best-effort: the spend has already been pulled.
    try {
      const total = (vehicle.spends ?? []).reduce(
        (s: number, x: any) => s + (Number(x.amount) || 0),
        0,
      );
      await this.accountingService.syncSaleSpendForVehicle(id, total);
    } catch (err) {
      this.logger.error(
        `removeSpend sale re-sync failed for vehicleId=${id}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
    return vehicle;
  }

  /**
   * Edit a recorded spend (amount/category/description/date). Allowed even
   * after the vehicle is sold (mirrors removeSpend) — if the amount changes on
   * an already-sold vehicle we re-sync the Sale's `totalSpend` snapshot so the
   * P&L / margin stay accurate.
   */
  async updateSpend(
    id: string,
    spendId: string,
    dto: { amount?: number; category?: string; description?: string; date?: string },
    user: any,
  ): Promise<VehicleDocument> {
    if (!isValidObjectId(spendId)) throw new BadRequestException('Invalid spend id');
    const vehicle = await this.vehicleModel.findOne({ _id: id, isDeleted: false });
    if (!vehicle) throw new NotFoundException('Vehicle not found');

    const spends = vehicle.spends as any[];
    const entry = spends.find((s) => String(s._id) === String(spendId));
    if (!entry) throw new NotFoundException('Spend not found');

    if (dto.amount !== undefined) {
      const amt = Number(dto.amount);
      if (!(amt > 0)) throw new BadRequestException('Spend amount must be greater than 0');
      entry.amount = amt;
    }
    if (dto.category !== undefined) entry.category = String(dto.category).trim() || entry.category;
    if (dto.description !== undefined) entry.description = String(dto.description).trim();
    if (dto.date !== undefined && dto.date) entry.date = new Date(dto.date);
    vehicle.markModified('spends');
    const saved = await vehicle.save();

    await this.activity.log({
      module: 'inventory',
      action: 'spend-updated',
      entity: 'Vehicle',
      entityId: saved._id,
      label: `Spend edited · ${saved.title}`,
      byId: user?._id,
    });

    // Keep the sold vehicle's Sale snapshot in step with the edited amount.
    try {
      const total = (saved.spends ?? []).reduce(
        (s: number, x: any) => s + (Number(x.amount) || 0),
        0,
      );
      await this.accountingService.syncSaleSpendForVehicle(id, total);
    } catch (err) {
      this.logger.error(
        `updateSpend sale re-sync failed for vehicleId=${id}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
    return saved;
  }

  async softDelete(id: string, userId?: string): Promise<void> {
    // `new: false` returns the pre-delete document so we know whether it was
    // sold — we need to fire the sale-reversal cascade for sold vehicles.
    const vehicle = await this.vehicleModel.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { isDeleted: true, deletedAt: new Date() },
      { new: false },
    );
    if (!vehicle) throw new NotFoundException('Vehicle not found');

    await this.activity.log({
      module: 'inventory',
      action: 'deleted',
      entity: 'Vehicle',
      entityId: vehicle._id,
      label: `${vehicle.title} (${vehicle.vehicleNumber})`,
      byId: userId,
      meta: { previousStatus: vehicle.status },
    });

    // Clean up the seller→vehicle back-link so the seller detail page doesn't
    // show stale rows after the vehicle has been removed from inventory.
    if (isValidObjectId(id)) {
      await this.sellerLeadModel.updateMany(
        { vehicles: new Types.ObjectId(id) },
        { $pull: { vehicles: new Types.ObjectId(id) } },
      );
    }

    // If the vehicle was sold, deleting it implicitly reverses the sale:
    //   - the Sale row gets soft-deleted (it references a deleted vehicle)
    //   - the buyer's purchases[] entry for this car gets pulled
    //   - the closed lead is archived (audit trail of "this was sold once")
    // Otherwise the dealer would be left with a sale referencing a
    // non-existent vehicle and a "closed" lead pointing into the void.
    if (vehicle.status === VehicleStatus.SOLD) {
      try {
        const counts = await this.accountingService.cleanupSoldArtifacts(id);
        this.logger.log(
          `vehicle-delete cascade vehicleId=${id} ` +
          `archivedLeads=${counts.archivedLeads} ` +
          `deletedSales=${counts.deletedSales} ` +
          `pulledPurchases=${counts.pulledPurchases}`,
        );
      } catch (err) {
        // Vehicle is already soft-deleted — never reject. Log so we can see
        // when the cascade misfires.
        this.logger.error(
          `vehicle-delete cascade failed for vehicleId=${id}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }
  }

  async getHistory(id: string): Promise<any[]> {
    const vehicle = await this.vehicleModel.findOne({ _id: id, isDeleted: false }).select('history');
    if (!vehicle) throw new NotFoundException('Vehicle not found');
    return vehicle.history || [];
  }

  async getTraffic(id: string): Promise<any> {
    const vehicle = await this.vehicleModel.findOne({ _id: id, isDeleted: false }).select('traffic vehicleNumber title');
    if (!vehicle) throw new NotFoundException('Vehicle not found');
    return vehicle.traffic;
  }

  async bulkUpload(
    csvBuffer: Buffer,
    userId: string,
  ): Promise<{ created: number; decoded: number; errors: string[]; totalRows: number }> {
    const records = parse(csvBuffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    // Enum columns (fuelType/transmission/hosting/status) must be lowercased to
    // match the schema enums, and an empty cell must become `undefined` — an
    // empty string would fail Mongoose enum validation. Free-text columns can
    // pass through as-is (their schema default is '').
    const enumCell = (v?: string): any => {
      const s = (v ?? '').trim();
      return s === '' ? undefined : s.toLowerCase();
    };
    const str = (v?: string): string => (v ?? '').toString().trim();

    // ── Decode every VIN in the file up front via NHTSA's batch endpoint ──
    // (chunked ≤50/call, sequential, best-effort). One round-trip per 50 rows
    // instead of one per row. Failed chunks just leave their VINs undecoded.
    const vinItems: { vin: string; year?: number }[] = [];
    for (const rec of records) {
      const vin = str(rec.vin).toUpperCase();
      if (this.vinDecode.isValidVin(vin)) {
        const y = parseInt(str(rec.year), 10);
        vinItems.push({ vin, year: Number.isFinite(y) ? y : undefined });
      }
    }
    let decodedMap = new Map<string, DecodedVehicleFields>();
    if (vinItems.length) {
      decodedMap = await this.vinDecode.decodeBatch(vinItems);
      this.logger.log(`bulkUpload: decoded ${decodedMap.size}/${vinItems.length} VIN(s) via NHTSA vPIC`);
    }

    const errors: string[] = [];
    const seenVins = new Set<string>();
    let created = 0;
    let decodedUsed = 0;
    let row = 0;

    for (const record of records) {
      row++;
      const vinNorm = str(record.vin).toUpperCase();
      const decoded = vinNorm ? decodedMap.get(vinNorm) : undefined;

      // Merge rule: an explicit CSV cell wins; the VIN decode fills only the
      // cells the CSV left blank. Business fields the VIN can't know (price, km,
      // color, …) always come from the CSV.
      const company = str(record.company) || decoded?.company || '';
      const model = str(record.model) || decoded?.model || '';
      const yearCsv = parseInt(str(record.year), 10);
      const year = Number.isFinite(yearCsv) ? yearCsv : decoded?.year;
      const price = parseFloat(str(record.price));

      const label =
        str(record.vehicleNumber) ||
        str(record.title) ||
        `${company} ${model}`.trim() ||
        (vinNorm ? `VIN ${vinNorm}` : `row ${row}`);

      // Intra-file duplicate VIN guard (DB duplicates are caught by create()).
      if (vinNorm && seenVins.has(vinNorm)) {
        errors.push(`Row ${label}: duplicate VIN ${vinNorm} appears earlier in the file — skipped.`);
        continue;
      }

      // Required fields. `title` is auto-built when blank. company/model/year
      // may now come from the VIN decode; price must always be in the CSV.
      const missing: string[] = [];
      if (!company) missing.push('company');
      if (!model) missing.push('model');
      if (year === undefined || Number.isNaN(year)) missing.push('year');
      if (!str(record.price) || Number.isNaN(price)) missing.push('price');
      if (missing.length) {
        const hint = vinNorm && !decoded ? ' (VIN did not decode)' : '';
        errors.push(`Row ${label}: missing/invalid required field(s): ${missing.join(', ')}${hint}`);
        continue;
      }

      try {
        await this.create(
          {
            vehicleNumber: str(record.vehicleNumber) || undefined,
            title: str(record.title) || decoded?.title || `${year} ${company} ${model}`,
            company,
            model,
            year: year as number,
            km: parseInt(record.km || '0'),
            price,
            discount: parseFloat(record.discount || '0'),
            owners: parseInt(record.owners || '1'),
            fuelType: enumCell(record.fuelType) ?? decoded?.fuelType,
            transmission: enumCell(record.transmission) ?? decoded?.transmission,
            color: record.color,
            vin: vinNorm || undefined,
            bodyType: str(record.bodyType) || decoded?.bodyType,
            trim: str(record.trim) || decoded?.trim,
            engine: str(record.engine) || decoded?.engine,
            hosting: enumCell(record.hosting),
            description: record.description,
          },
          userId,
        );
        created++;
        if (decoded) decodedUsed++;
        if (vinNorm) seenVins.add(vinNorm);
      } catch (err) {
        errors.push(`Row ${label}: ${err.message}`);
      }
    }

    return { created, decoded: decodedUsed, errors, totalRows: records.length };
  }

  async getStats(): Promise<any> {
    const [total, sold, unsold, pending, avgPrice] = await Promise.all([
      this.vehicleModel.countDocuments({ isDeleted: false }),
      this.vehicleModel.countDocuments({ status: 'sold', isDeleted: false }),
      this.vehicleModel.countDocuments({ status: 'unsold', isDeleted: false }),
      this.vehicleModel.countDocuments({ status: 'pending', isDeleted: false }),
      this.vehicleModel.aggregate([
        { $match: { isDeleted: false } },
        { $group: { _id: null, avg: { $avg: '$price' } } },
      ]),
    ]);

    return { total, sold, unsold, pending, avgPrice: avgPrice[0]?.avg || 0 };
  }

  /**
   * Hourly cron: auto-expire 'new' vehicles to 'pending' after 2 days.
   *
   * Spec: newly added vehicles start as `new` (schema default). If nobody
   * moves them off `new` within 48 hours of createdAt, the system flips
   * them to `pending`. Any manual status change moves the vehicle out of
   * this query's scope, so the timer is effectively "since createdAt,
   * while still NEW".
   *
   * Runs hourly so the worst-case slop past the 2-day mark is ~1 hour.
   * Daily would be lower-overhead but feels too coarse for the 2-day SLA.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async expireNewVehicles(): Promise<void> {
    const cutoff = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const stale = await this.vehicleModel
      .find({
        status: VehicleStatus.NEW,
        createdAt: { $lt: cutoff },
        isDeleted: false,
      })
      .select('_id title vehicleNumber')
      .lean();

    if (stale.length === 0) return;

    const ids = stale.map((v) => v._id);
    await this.vehicleModel.updateMany(
      { _id: { $in: ids } },
      {
        $set: { status: VehicleStatus.PENDING },
        $push: {
          history: {
            field: 'status',
            value: VehicleStatus.NEW,
            newValue: VehicleStatus.PENDING,
            changedAt: new Date(),
            changedBy: 'system:auto-expire',
          },
        },
      },
    );
    this.logger.log(
      `auto-expire: flipped ${stale.length} 'new' vehicle(s) → 'pending' (>2 days)`,
    );

    // Per-vehicle activity log so the Dashboard "Recent Activity" feed
    // surfaces the change. Best-effort: the status update has already
    // landed atomically above; activity-log failures must not throw.
    for (const v of stale) {
      try {
        await this.activity.log({
          module: 'inventory',
          action: 'status-changed',
          entity: 'Vehicle',
          entityId: v._id,
          label: `${v.title} (${v.vehicleNumber}) auto-expired: new → pending`,
          meta: {
            from: VehicleStatus.NEW,
            to: VehicleStatus.PENDING,
            auto: true,
            reason: '2-day timeout',
          },
        });
      } catch (err) {
        this.logger.warn(
          `activity log failed for auto-expire vehicleId=${String(v._id)}: ${err}`,
        );
      }
    }
  }
}
