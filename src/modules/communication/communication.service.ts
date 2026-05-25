import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CommunicationLog, CommunicationLogDocument, CommChannel } from './schemas/communication-log.schema';
import { PaginatedResult } from '../../common/dto/pagination.dto';

@Injectable()
export class CommunicationService {
  constructor(@InjectModel(CommunicationLog.name) private model: Model<CommunicationLogDocument>) {}

  async logAndSend(dto: any, userId: string): Promise<CommunicationLogDocument> {
    // In production: integrate with actual email/SMS/WhatsApp/call providers
    // Here we just log the intent
    return new this.model({ ...dto, sentBy: userId, deliveryStatus: 'sent' }).save();
  }

  async findAll(query: any): Promise<PaginatedResult<CommunicationLogDocument>> {
    const { page = 1, limit = 20, channel, sort = '-createdAt', linkedVehicle } = query;
    const skip = (page - 1) * limit;
    const filter: any = {};
    if (channel) filter.channel = channel;
    if (linkedVehicle) filter.linkedVehicle = linkedVehicle;
    const sortObj: any = sort.startsWith('-') ? { [sort.slice(1)]: -1 } : { [sort]: 1 };
    const [data, total] = await Promise.all([
      this.model.find(filter).sort(sortObj).skip(skip).limit(limit).populate('sentBy', 'firstName lastName').populate('linkedVehicle', 'title vehicleNumber').lean(),
      this.model.countDocuments(filter),
    ]);
    return new PaginatedResult(data as unknown as CommunicationLogDocument[], total, page, limit);
  }

  async getChannelStats(): Promise<any> {
    return this.model.aggregate([
      { $group: { _id: '$channel', count: { $sum: 1 }, lastSent: { $max: '$createdAt' } } },
    ]);
  }
}
