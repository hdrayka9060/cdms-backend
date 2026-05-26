import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import { BuyerLead, BuyerLeadDocument, BuyerLeadStage } from './schemas/buyer-lead.schema';
import {
  BookTestDriveDto, BuyerCommunicationDto, CreateBuyerLeadDto, UpdateBuyerLeadDto,
} from './dto/buyer-lead.dto';
import { PaginationDto, PaginatedResult } from '../../common/dto/pagination.dto';
import { Vehicle, VehicleDocument } from '../inventory/schemas/vehicle.schema';
import { ActivityService } from '../activity/activity.service';

@Injectable()
export class CrmBuyersService {
  constructor(
    @InjectModel(BuyerLead.name) private model: Model<BuyerLeadDocument>,
    @InjectModel(Vehicle.name) private vehicleModel: Model<VehicleDocument>,
    private readonly activity: ActivityService,
  ) {}

  /**
   * Collect every Vehicle id referenced by a buyer doc — both the modern
   * `interestedVehicles[]` array and the legacy singular `interestedVehicle`.
   */
  private collectVehicleIds(lead: any): string[] {
    const ids = new Set<string>();
    for (const v of lead.interestedVehicles ?? []) {
      if (!v) continue;
      ids.add(String(v));
    }
    if (lead.interestedVehicle) ids.add(String(lead.interestedVehicle));
    return [...ids];
  }

  /**
   * Hydrate `interestedVehicles[]` by direct query on the Vehicle collection.
   * Avoids Mongoose populate quirks (which were silently returning empty
   * arrays on freshly-pushed refs in this codebase). Single source of truth:
   * whatever's in the buyer doc maps to a Vehicle.find({_id: {$in: ...}}).
   */
  private async hydrateVehicles(lead: any): Promise<any> {
    const ids = this.collectVehicleIds(lead);
    let vehicles: any[] = [];
    if (ids.length) {
      const docs = await this.vehicleModel
        .find({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) }, isDeleted: false })
        .lean();
      // Preserve the order the buyer doc references them in (so newly-added
      // entries appear at the end of the list, in insertion order).
      const byId = new Map(docs.map((d: any) => [String(d._id), d]));
      vehicles = ids.map((id) => byId.get(id)).filter(Boolean);
    }
    // Hydrate communications.vehicle inline too (much simpler than populate).
    const comms = (lead.communications ?? []).map((c: any) => {
      if (!c.vehicle) return c;
      const v = vehicles.find((x) => String(x._id) === String(c.vehicle));
      return { ...c, vehicle: v ?? c.vehicle };
    });
    return { ...lead, interestedVehicles: vehicles, communications: comms };
  }

  /** Populate the optional `communications[].byStaff` ref on a hydrated lead. */
  private async hydrateStaff(lead: any): Promise<any> {
    // Unpopulated ObjectId refs are `typeof === 'object'` (Mongoose ObjectId
    // instances), so we identify the unpopulated case by absence of the
    // populated-shape marker (`firstName`) rather than typeof.
    const isPopulatedUser = (u: any) => u && typeof u === 'object' && 'firstName' in u;

    const staffIds = new Set<string>();
    for (const c of lead.communications ?? []) {
      if (c?.byStaff && !isPopulatedUser(c.byStaff)) staffIds.add(String(c.byStaff));
    }
    if (!staffIds.size) return lead;
    const users = await this.model.db
      .collection('users')
      .find(
        { _id: { $in: [...staffIds].map((id) => new Types.ObjectId(id)) } },
        { projection: { firstName: 1, lastName: 1, email: 1 } },
      )
      .toArray();
    const byId = new Map(users.map((u) => [String(u._id), u]));
    const comms = (lead.communications ?? []).map((c: any) => {
      if (!c?.byStaff || isPopulatedUser(c.byStaff)) return c;
      const u = byId.get(String(c.byStaff));
      return u ? { ...c, byStaff: u } : c;
    });
    return { ...lead, communications: comms };
  }

  async create(dto: CreateBuyerLeadDto): Promise<any> {
    const ids = new Set<string>();
    for (const v of dto.interestedVehicles ?? []) {
      if (isValidObjectId(v)) ids.add(v);
    }
    if (dto.interestedVehicle && isValidObjectId(dto.interestedVehicle)) {
      ids.add(dto.interestedVehicle);
    }

    const doc = await new this.model({
      buyerName: dto.buyerName,
      buyerEmail: dto.buyerEmail,
      buyerPhone: dto.buyerPhone,
      notes: dto.notes ?? '',
      budget: dto.budget,
      stage: dto.stage ?? BuyerLeadStage.NEW,
      interestedVehicles: [...ids].map((id) => new Types.ObjectId(id)),
    }).save();
    await this.activity.log({
      module: 'crm-buyers',
      action: 'created',
      entity: 'Buyer',
      entityId: doc._id,
      label: `${doc.buyerName} (${doc.buyerEmail ?? 'no email'})`,
      meta: { stage: doc.stage },
    });
    return this.findById(String(doc._id));
  }

  async findAll(query: PaginationDto & { stage?: BuyerLeadStage }): Promise<PaginatedResult<any>> {
    const { page = 1, limit = 20, search, sort = '-createdAt', stage } = query;
    const skip = (page - 1) * limit;
    const filter: any = { isDeleted: false };
    if (stage) filter.stage = stage;
    if (search) {
      filter.$or = [
        { buyerName: { $regex: search, $options: 'i' } },
        { buyerEmail: { $regex: search, $options: 'i' } },
      ];
    }
    const sortObj: any = sort.startsWith('-') ? { [sort.slice(1)]: -1 } : { [sort]: 1 };
    const [data, total] = await Promise.all([
      this.model.find(filter).sort(sortObj).skip(skip).limit(limit).lean(),
      this.model.countDocuments(filter),
    ]);

    // Hydrate per-buyer. N small queries; acceptable for current scale.
    const enriched = await Promise.all(data.map((d: any) => this.hydrateVehicles(d)));
    return new PaginatedResult(enriched, total, page, limit);
  }

  async findById(id: string): Promise<any> {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid buyer id');
    const lead = await this.model.findOne({ _id: id, isDeleted: false }).lean();
    if (!lead) throw new NotFoundException('Buyer lead not found');
    const withVehicles = await this.hydrateVehicles(lead);
    return this.hydrateStaff(withVehicles);
  }

  async update(id: string, dto: UpdateBuyerLeadDto): Promise<any> {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid buyer id');
    const lead = await this.model.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { $set: dto },
      { new: true },
    );
    if (!lead) throw new NotFoundException('Buyer lead not found');
    await this.activity.log({
      module: 'crm-buyers',
      action: 'updated',
      entity: 'Buyer',
      entityId: lead._id,
      label: `${lead.buyerName} updated`,
      meta: { fields: Object.keys(dto) },
    });
    return this.findById(id);
  }

  async addInterestedVehicle(id: string, vehicleId: string): Promise<any> {
    if (!isValidObjectId(id) || !isValidObjectId(vehicleId)) {
      throw new BadRequestException('Invalid id');
    }
    const lead = await this.model.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { $addToSet: { interestedVehicles: new Types.ObjectId(vehicleId) } },
      { new: true },
    );
    if (!lead) throw new NotFoundException('Buyer lead not found');
    return this.findById(id);
  }

  async removeInterestedVehicle(id: string, vehicleId: string): Promise<any> {
    if (!isValidObjectId(id) || !isValidObjectId(vehicleId)) {
      throw new BadRequestException('Invalid id');
    }
    const vObj = new Types.ObjectId(vehicleId);
    const lead = await this.model.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { $pull: { interestedVehicles: vObj } },
      { new: true },
    );
    if (!lead) throw new NotFoundException('Buyer lead not found');
    await this.model.updateOne(
      { _id: id, interestedVehicle: vObj },
      { $unset: { interestedVehicle: '' } },
    );
    return this.findById(id);
  }

  async bookTestDrive(id: string, dto: BookTestDriveDto): Promise<any> {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid buyer id');
    const update: any = {
      $set: { stage: BuyerLeadStage.TEST_DRIVE },
      $push: {
        history: {
          vehicleId: dto.vehicleId,
          vehicleTitle: dto.vehicleTitle ?? '',
          action: 'test_drive_booked',
          date: dto.scheduledAt ? new Date(dto.scheduledAt) : new Date(),
        },
      },
    };
    if (dto.assignedTo && isValidObjectId(dto.assignedTo)) {
      update.$set.assignedTo = new Types.ObjectId(dto.assignedTo);
    }
    const lead = await this.model.findOneAndUpdate(
      { _id: id, isDeleted: false },
      update,
      { new: true },
    );
    if (!lead) throw new NotFoundException('Buyer lead not found');
    await this.activity.log({
      module: 'crm-buyers',
      action: 'test-drive-booked',
      entity: 'Buyer',
      entityId: lead._id,
      label: `${lead.buyerName} · test drive on ${dto.vehicleTitle ?? 'a vehicle'}`,
      meta: { vehicleId: dto.vehicleId, scheduledAt: dto.scheduledAt },
    });
    return this.findById(id);
  }

  async addCommunication(id: string, dto: BuyerCommunicationDto, userId?: string): Promise<any> {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid buyer id');
    const entry: any = {
      _id: new Types.ObjectId(),
      at: dto.at ? new Date(dto.at) : new Date(),
      channel: dto.channel,
      summary: dto.summary,
      by: userId,
    };
    if (dto.vehicleId && isValidObjectId(dto.vehicleId)) {
      entry.vehicle = new Types.ObjectId(dto.vehicleId);
    }
    if (dto.byStaffId && isValidObjectId(dto.byStaffId)) {
      entry.byStaff = new Types.ObjectId(dto.byStaffId);
    } else if (userId && isValidObjectId(userId)) {
      entry.byStaff = new Types.ObjectId(userId);
    }
    const lead = await this.model.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { $push: { communications: entry } },
      { new: true },
    );
    if (!lead) throw new NotFoundException('Buyer lead not found');
    await this.activity.log({
      module: 'communication',
      action: 'logged',
      entity: 'Buyer',
      entityId: lead._id,
      label: `${dto.channel} with ${lead.buyerName}${dto.summary ? ` — "${dto.summary.slice(0, 40)}"` : ''}`,
      byId: userId,
      meta: { channel: dto.channel },
    });
    return this.findById(id);
  }

  async updateCommunication(id: string, commId: string, dto: BuyerCommunicationDto): Promise<any> {
    if (!isValidObjectId(id) || !isValidObjectId(commId)) throw new BadRequestException('Invalid id');
    const $set: any = {
      'communications.$.channel': dto.channel,
      'communications.$.summary': dto.summary,
    };
    if (dto.at) $set['communications.$.at'] = new Date(dto.at);
    if (dto.vehicleId && isValidObjectId(dto.vehicleId)) {
      $set['communications.$.vehicle'] = new Types.ObjectId(dto.vehicleId);
    } else if (dto.vehicleId === '' || dto.vehicleId === null) {
      $set['communications.$.vehicle'] = null;
    }
    if (dto.byStaffId && isValidObjectId(dto.byStaffId)) {
      $set['communications.$.byStaff'] = new Types.ObjectId(dto.byStaffId);
    } else if (dto.byStaffId === '' || dto.byStaffId === null) {
      $set['communications.$.byStaff'] = null;
    }
    const lead = await this.model.findOneAndUpdate(
      { _id: id, isDeleted: false, 'communications._id': new Types.ObjectId(commId) },
      { $set },
      { new: true },
    );
    if (!lead) throw new NotFoundException('Communication entry not found');
    return this.findById(id);
  }

  async removeCommunication(id: string, commId: string): Promise<any> {
    if (!isValidObjectId(id) || !isValidObjectId(commId)) throw new BadRequestException('Invalid id');
    const lead = await this.model.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { $pull: { communications: { _id: new Types.ObjectId(commId) } } },
      { new: true },
    );
    if (!lead) throw new NotFoundException('Buyer lead not found');
    return this.findById(id);
  }

  async getHistory(id: string): Promise<any[]> {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid buyer id');
    const lead = await this.model.findOne({ _id: id, isDeleted: false }).select('history');
    if (!lead) throw new NotFoundException('Buyer lead not found');
    return lead.history;
  }

  async remove(id: string): Promise<void> {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid buyer id');
    const lead = await this.model.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { isDeleted: true },
      { new: false },
    );
    if (!lead) throw new NotFoundException('Buyer lead not found');
    await this.activity.log({
      module: 'crm-buyers',
      action: 'deleted',
      entity: 'Buyer',
      entityId: lead._id,
      label: `${lead.buyerName} removed`,
    });
  }
}
