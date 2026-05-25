import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery, Types, isValidObjectId } from 'mongoose';
import { SellerLead, SellerLeadDocument, SellerLeadStage } from './schemas/seller-lead.schema';
import {
  CreateSellerLeadDto, UpdateSellerLeadDto, CommunicateDto, ScheduleInspectionDto,
  SellerVehicleInputDto,
} from './dto/seller-lead.dto';
import { PaginationDto, PaginatedResult } from '../../common/dto/pagination.dto';
import { InventoryService } from '../inventory/inventory.service';
import { Vehicle, VehicleDocument } from '../inventory/schemas/vehicle.schema';

/** Shape of one activity-log entry pushed onto SellerLead.activity[]. */
interface ActivityEntry {
  at?: Date;
  action: string;
  label: string;
  by?: string;
  meta?: Record<string, unknown>;
}

/** Human-friendly labels for fields edited via `update()` — keeps the timeline readable. */
const UPDATE_FIELD_LABELS: Record<string, string> = {
  sellerName: 'name',
  sellerEmail: 'email',
  sellerPhone: 'phone',
  address: 'address',
  city: 'city',
  state: 'state',
  zipCode: 'zip',
  country: 'country',
  notes: 'notes',
  stage: 'pipeline stage',
  assignedTo: 'assignee',
  askingPrice: 'asking price',
  inspectionDate: 'inspection date',
};

@Injectable()
export class CrmSellersService {
  constructor(
    @InjectModel(SellerLead.name) private model: Model<SellerLeadDocument>,
    @InjectModel(Vehicle.name) private vehicleModel: Model<VehicleDocument>,
    private readonly inventoryService: InventoryService,
  ) {}

  // ── Activity-log helper ─────────────────────────────────────────────────
  private async logActivity(id: string, entry: ActivityEntry): Promise<void> {
    await this.model.updateOne(
      { _id: id },
      { $push: { activity: { at: new Date(), ...entry } } },
    );
  }

  // ── Vehicle reverse-lookup ─────────────────────────────────────────────
  private async loadVehiclesForSeller(sellerId: string): Promise<VehicleDocument[]> {
    const docs = await this.vehicleModel
      .find({ seller: new Types.ObjectId(sellerId), isDeleted: false })
      .sort({ createdAt: 1, _id: 1 })
      .populate('addedBy', 'firstName lastName email')
      .lean();
    return docs as unknown as VehicleDocument[];
  }

  private async loadVehiclesGrouped(sellerIds: Types.ObjectId[]): Promise<Map<string, VehicleDocument[]>> {
    if (!sellerIds.length) return new Map();
    const docs = await this.vehicleModel
      .find({ seller: { $in: sellerIds }, isDeleted: false })
      .sort({ createdAt: 1, _id: 1 })
      .lean();
    const grouped = new Map<string, VehicleDocument[]>();
    for (const v of docs as unknown as (VehicleDocument & { seller: Types.ObjectId })[]) {
      const key = String(v.seller);
      const list = grouped.get(key);
      if (list) list.push(v);
      else grouped.set(key, [v]);
    }
    return grouped;
  }

  async create(dto: CreateSellerLeadDto, userId: string): Promise<any> {
    const { vehicles: vehicleInputs, ...sellerFields } = dto;

    const seller = await new this.model(sellerFields).save();
    const sellerId = String(seller._id);

    const initialActivity: ActivityEntry[] = [
      { at: new Date(), action: 'seller_created', label: 'Seller created', by: userId },
    ];

    if (vehicleInputs?.length) {
      for (const v of vehicleInputs) {
        const vehicle = await this.inventoryService.create(v, userId, sellerId);
        initialActivity.push({
          at: new Date(),
          action: 'vehicle_added',
          label: `Listed ${vehicle.title}`,
          by: userId,
          meta: { vehicleId: String(vehicle._id), title: vehicle.title },
        });
      }
    }

    await this.model.updateOne(
      { _id: seller._id },
      { $push: { activity: { $each: initialActivity } } },
    );

    return this.findById(sellerId);
  }

  async findAll(query: PaginationDto & { stage?: SellerLeadStage }): Promise<PaginatedResult<any>> {
    const { page = 1, limit = 20, search, sort = '-createdAt', stage } = query;
    const skip = (page - 1) * limit;
    const filter: FilterQuery<SellerLeadDocument> = { isDeleted: false };
    if (stage) filter.stage = stage;
    if (search) {
      filter.$or = [
        { sellerName: { $regex: search, $options: 'i' } },
        { sellerEmail: { $regex: search, $options: 'i' } },
        { city: { $regex: search, $options: 'i' } },
        { vehicleTitle: { $regex: search, $options: 'i' } },
      ];
    }
    const sortObj: any = sort.startsWith('-') ? { [sort.slice(1)]: -1 } : { [sort]: 1 };
    const [data, total] = await Promise.all([
      this.model
        .find(filter)
        .sort(sortObj)
        .skip(skip)
        .limit(limit)
        .populate('assignedTo', 'firstName lastName')
        .lean(),
      this.model.countDocuments(filter),
    ]);

    const ids = data.map((s) => s._id as Types.ObjectId);
    const grouped = await this.loadVehiclesGrouped(ids);
    const enriched = data.map((s) => ({
      ...s,
      vehicles: grouped.get(String(s._id)) ?? [],
    }));

    return new PaginatedResult(enriched, total, page, limit);
  }

  async findById(id: string): Promise<any> {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid seller id');
    const lead = await this.model
      .findOne({ _id: id, isDeleted: false })
      .populate('assignedTo', 'firstName lastName email')
      .lean();
    if (!lead) throw new NotFoundException('Seller lead not found');
    const vehicles = await this.loadVehiclesForSeller(id);
    return { ...lead, vehicles };
  }

  async update(id: string, dto: UpdateSellerLeadDto, userId?: string): Promise<any> {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid seller id');

    // Diff against the current doc so we can log a meaningful "Updated X" entry.
    const before = await this.model.findOne({ _id: id, isDeleted: false }).lean();
    if (!before) throw new NotFoundException('Seller lead not found');

    const lead = await this.model.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { $set: dto },
      { new: true },
    );
    if (!lead) throw new NotFoundException('Seller lead not found');

    const changedLabels: string[] = [];
    for (const [key, newValue] of Object.entries(dto)) {
      if (newValue === undefined) continue;
      const oldValue = (before as any)[key];
      // Loose equality is fine — both are JSON-able primitives or dates here.
      const changed = String(oldValue ?? '') !== String(newValue ?? '');
      if (!changed) continue;
      changedLabels.push(UPDATE_FIELD_LABELS[key] ?? key);
    }
    if (changedLabels.length) {
      await this.logActivity(id, {
        action: 'updated',
        label: `Edited ${changedLabels.join(', ')}`,
        by: userId,
      });
    }

    return this.findById(id);
  }

  async addVehicle(
    id: string,
    dto: SellerVehicleInputDto,
    userId: string,
  ): Promise<{ seller: any; vehicle: any }> {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid seller id');
    const seller = await this.model.findOne({ _id: id, isDeleted: false });
    if (!seller) throw new NotFoundException('Seller lead not found');

    const vehicle = await this.inventoryService.create(dto, userId, id);
    await this.logActivity(id, {
      action: 'vehicle_added',
      label: `Listed ${vehicle.title}`,
      by: userId,
      meta: { vehicleId: String(vehicle._id), title: vehicle.title },
    });

    const refreshed = await this.findById(id);
    return { seller: refreshed, vehicle };
  }

  async removeVehicle(id: string, vehicleId: string, userId?: string): Promise<any> {
    if (!isValidObjectId(id) || !isValidObjectId(vehicleId)) {
      throw new BadRequestException('Invalid id');
    }
    // Capture the vehicle title (if it still exists) for a readable log entry.
    const vehicle = await this.vehicleModel.findById(vehicleId).select('title');
    await this.vehicleModel.updateOne(
      { _id: new Types.ObjectId(vehicleId), seller: new Types.ObjectId(id) },
      { $unset: { seller: 1 } },
    );
    await this.logActivity(id, {
      action: 'vehicle_unlinked',
      label: vehicle?.title ? `Unlinked ${vehicle.title}` : 'Unlinked a vehicle',
      by: userId,
      meta: { vehicleId, title: vehicle?.title },
    });
    return this.findById(id);
  }

  async scheduleInspection(id: string, dto: ScheduleInspectionDto, userId: string): Promise<any> {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid seller id');
    const $set: Record<string, unknown> = {
      inspectionDate: new Date(dto.inspectionDate),
      stage: SellerLeadStage.INSPECTION,
    };
    if (dto.assignedTo && isValidObjectId(dto.assignedTo)) {
      $set.assignedTo = new Types.ObjectId(dto.assignedTo);
    }
    const lead = await this.model.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { $set },
      { new: true },
    );
    if (!lead) throw new NotFoundException('Seller lead not found');

    let vehicleTitle: string | undefined;
    if (dto.vehicleId && isValidObjectId(dto.vehicleId)) {
      const v = await this.vehicleModel.findById(dto.vehicleId).select('title');
      vehicleTitle = v?.title ?? undefined;
    }
    const when = new Date(dto.inspectionDate);
    const whenLabel = `${when.toISOString().slice(0, 10)} ${when
      .toISOString()
      .slice(11, 16)}`;
    await this.logActivity(id, {
      action: 'inspection_scheduled',
      label: vehicleTitle
        ? `Inspection scheduled for ${vehicleTitle} on ${whenLabel}`
        : `Inspection scheduled on ${whenLabel}`,
      by: userId,
      meta: { vehicleId: dto.vehicleId, when: when.toISOString() },
    });

    return this.findById(id);
  }

  async communicate(id: string, dto: CommunicateDto, userId: string): Promise<any> {
    const lead = await this.model.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { $push: { communications: { channel: dto.channel, message: dto.message, sentAt: new Date(), sentBy: userId } } },
      { new: true },
    );
    if (!lead) throw new NotFoundException('Seller lead not found');
    await this.logActivity(id, {
      action: 'communication',
      label: `Logged ${dto.channel}: ${dto.message.slice(0, 80)}${dto.message.length > 80 ? '…' : ''}`,
      by: userId,
      meta: { channel: dto.channel },
    });
    return this.findById(id);
  }

  async remove(id: string): Promise<void> {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid seller id');
    const lead = await this.model.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { isDeleted: true },
    );
    if (!lead) throw new NotFoundException('Seller lead not found');
  }

  async getPipelineStats(): Promise<any> {
    return this.model.aggregate([
      { $match: { isDeleted: false } },
      { $group: { _id: '$stage', count: { $sum: 1 }, totalValue: { $sum: '$askingPrice' } } },
    ]);
  }
}
