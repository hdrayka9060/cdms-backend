import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BuyerLead, BuyerLeadDocument, BuyerLeadStage } from './schemas/buyer-lead.schema';
import { PaginationDto, PaginatedResult } from '../../common/dto/pagination.dto';

@Injectable()
export class CrmBuyersService {
  constructor(@InjectModel(BuyerLead.name) private model: Model<BuyerLeadDocument>) {}

  async create(dto: any): Promise<BuyerLeadDocument> {
    return new this.model(dto).save();
  }

  async findAll(query: PaginationDto & { stage?: BuyerLeadStage }): Promise<PaginatedResult<BuyerLeadDocument>> {
    const { page = 1, limit = 20, search, sort = '-createdAt', stage } = query;
    const skip = (page - 1) * limit;
    const filter: any = { isDeleted: false };
    if (stage) filter.stage = stage;
    if (search) filter.$or = [{ buyerName: { $regex: search, $options: 'i' } }, { buyerEmail: { $regex: search, $options: 'i' } }];
    const sortObj: any = sort.startsWith('-') ? { [sort.slice(1)]: -1 } : { [sort]: 1 };
    const [data, total] = await Promise.all([
      this.model.find(filter).sort(sortObj).skip(skip).limit(limit).populate('interestedVehicle', 'title vehicleNumber').lean(),
      this.model.countDocuments(filter),
    ]);
    return new PaginatedResult(data as BuyerLeadDocument[], total, page, limit);
  }

  async findById(id: string): Promise<BuyerLeadDocument> {
    const lead = await this.model.findOne({ _id: id, isDeleted: false }).populate('interestedVehicle');
    if (!lead) throw new NotFoundException('Buyer lead not found');
    return lead;
  }

  async update(id: string, dto: any): Promise<BuyerLeadDocument> {
    const lead = await this.model.findOneAndUpdate({ _id: id, isDeleted: false }, { $set: dto }, { new: true });
    if (!lead) throw new NotFoundException('Buyer lead not found');
    return lead;
  }

  async bookTestDrive(id: string, dto: any): Promise<BuyerLeadDocument> {
    const lead = await this.model.findOneAndUpdate(
      { _id: id, isDeleted: false },
      {
        $set: { stage: BuyerLeadStage.TEST_DRIVE },
        $push: { history: { vehicleId: dto.vehicleId, vehicleTitle: dto.vehicleTitle, action: 'test_drive_booked', date: new Date() } },
      },
      { new: true },
    );
    if (!lead) throw new NotFoundException('Buyer lead not found');
    return lead;
  }

  async getHistory(id: string): Promise<any[]> {
    const lead = await this.model.findOne({ _id: id, isDeleted: false }).select('history');
    if (!lead) throw new NotFoundException('Buyer lead not found');
    return lead.history;
  }

  async remove(id: string): Promise<void> {
    const lead = await this.model.findOneAndUpdate({ _id: id, isDeleted: false }, { isDeleted: true });
    if (!lead) throw new NotFoundException('Buyer lead not found');
  }
}
