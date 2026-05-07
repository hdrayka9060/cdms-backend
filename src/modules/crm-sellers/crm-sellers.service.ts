import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery } from 'mongoose';
import { SellerLead, SellerLeadDocument, SellerLeadStage } from './schemas/seller-lead.schema';
import { CreateSellerLeadDto, UpdateSellerLeadDto, CommunicateDto, ScheduleInspectionDto } from './dto/seller-lead.dto';
import { PaginationDto, PaginatedResult } from '../../common/dto/pagination.dto';

@Injectable()
export class CrmSellersService {
  constructor(@InjectModel(SellerLead.name) private model: Model<SellerLeadDocument>) {}

  async create(dto: CreateSellerLeadDto): Promise<SellerLeadDocument> {
    return new this.model(dto).save();
  }

  async findAll(query: PaginationDto & { stage?: SellerLeadStage }): Promise<PaginatedResult<SellerLeadDocument>> {
    const { page = 1, limit = 20, search, sort = '-createdAt', stage } = query;
    const skip = (page - 1) * limit;
    const filter: FilterQuery<SellerLeadDocument> = { isDeleted: false };
    if (stage) filter.stage = stage;
    if (search) {
      filter.$or = [
        { sellerName: { $regex: search, $options: 'i' } },
        { sellerEmail: { $regex: search, $options: 'i' } },
        { vehicleTitle: { $regex: search, $options: 'i' } },
      ];
    }
    const sortObj: any = sort.startsWith('-') ? { [sort.slice(1)]: -1 } : { [sort]: 1 };
    const [data, total] = await Promise.all([
      this.model.find(filter).sort(sortObj).skip(skip).limit(limit).populate('assignedTo', 'firstName lastName').lean(),
      this.model.countDocuments(filter),
    ]);
    return new PaginatedResult(data as SellerLeadDocument[], total, page, limit);
  }

  async findById(id: string): Promise<SellerLeadDocument> {
    const lead = await this.model.findOne({ _id: id, isDeleted: false }).populate('assignedTo', 'firstName lastName email');
    if (!lead) throw new NotFoundException('Seller lead not found');
    return lead;
  }

  async update(id: string, dto: UpdateSellerLeadDto): Promise<SellerLeadDocument> {
    const lead = await this.model.findOneAndUpdate({ _id: id, isDeleted: false }, { $set: dto }, { new: true });
    if (!lead) throw new NotFoundException('Seller lead not found');
    return lead;
  }

  async scheduleInspection(id: string, dto: ScheduleInspectionDto, userId: string): Promise<SellerLeadDocument> {
    const lead = await this.model.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { $set: { inspectionDate: new Date(dto.inspectionDate), stage: SellerLeadStage.INSPECTION }, $push: { communications: { type: 'note', channel: 'internal', message: dto.notes || 'Inspection scheduled', sentAt: new Date(), sentBy: userId } } },
      { new: true },
    );
    if (!lead) throw new NotFoundException('Seller lead not found');
    return lead;
  }

  async communicate(id: string, dto: CommunicateDto, userId: string): Promise<SellerLeadDocument> {
    const lead = await this.model.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { $push: { communications: { channel: dto.channel, message: dto.message, sentAt: new Date(), sentBy: userId } } },
      { new: true },
    );
    if (!lead) throw new NotFoundException('Seller lead not found');
    return lead;
  }

  async remove(id: string): Promise<void> {
    const lead = await this.model.findOneAndUpdate({ _id: id, isDeleted: false }, { isDeleted: true });
    if (!lead) throw new NotFoundException('Seller lead not found');
  }

  async getPipelineStats(): Promise<any> {
    return this.model.aggregate([
      { $match: { isDeleted: false } },
      { $group: { _id: '$stage', count: { $sum: 1 }, totalValue: { $sum: '$askingPrice' } } },
    ]);
  }
}
