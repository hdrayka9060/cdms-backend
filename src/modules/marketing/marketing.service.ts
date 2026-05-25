import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Campaign, CampaignDocument } from './schemas/campaign.schema';
import { PaginatedResult } from '../../common/dto/pagination.dto';

@Injectable()
export class MarketingService {
  constructor(@InjectModel(Campaign.name) private model: Model<CampaignDocument>) {}

  async create(dto: any): Promise<CampaignDocument> { return new this.model(dto).save(); }

  async findAll(query: any): Promise<PaginatedResult<CampaignDocument>> {
    const { page = 1, limit = 20, status, platform, sort = '-createdAt' } = query;
    const skip = (page - 1) * limit;
    const filter: any = { isDeleted: false };
    if (status) filter.status = status;
    if (platform) filter.platform = platform;
    const sortObj: any = sort.startsWith('-') ? { [sort.slice(1)]: -1 } : { [sort]: 1 };
    const [data, total] = await Promise.all([this.model.find(filter).sort(sortObj).skip(skip).limit(limit).lean(), this.model.countDocuments(filter)]);
    return new PaginatedResult(data as unknown as CampaignDocument[], total, page, limit);
  }

  async findById(id: string): Promise<CampaignDocument> {
    const campaign = await this.model.findOne({ _id: id, isDeleted: false });
    if (!campaign) throw new NotFoundException('Campaign not found');
    return campaign;
  }

  async update(id: string, dto: any): Promise<CampaignDocument> {
    const campaign = await this.model.findOneAndUpdate({ _id: id, isDeleted: false }, { $set: dto }, { new: true });
    if (!campaign) throw new NotFoundException('Campaign not found');
    return campaign;
  }

  async getMetrics(): Promise<any> {
    return this.model.aggregate([
      { $match: { isDeleted: false } },
      { $group: { _id: '$platform', totalLeads: { $sum: '$leads' }, totalConversions: { $sum: '$conversions' }, totalSpent: { $sum: '$spent' }, totalImpressions: { $sum: '$impressions' }, totalClicks: { $sum: '$clicks' }, campaignCount: { $sum: 1 } } },
    ]);
  }

  // Simulate metrics update (mock)
  async refreshMetrics(id: string): Promise<CampaignDocument> {
    const mock = { impressions: Math.floor(Math.random() * 50000) + 1000, clicks: Math.floor(Math.random() * 2000) + 100, leads: Math.floor(Math.random() * 200) + 10, conversions: Math.floor(Math.random() * 50) + 1, spent: Math.random() * 5000 + 100 };
    return this.model.findByIdAndUpdate(id, { $set: mock }, { new: true });
  }
}
