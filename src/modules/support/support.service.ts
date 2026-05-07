import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Ticket, TicketDocument, TicketStatus } from './schemas/ticket.schema';
import { PaginatedResult } from '../../common/dto/pagination.dto';

@Injectable()
export class SupportService {
  constructor(@InjectModel(Ticket.name) private model: Model<TicketDocument>) {}

  async create(dto: any): Promise<TicketDocument> {
    return new this.model(dto).save();
  }

  async findAll(query: any): Promise<PaginatedResult<TicketDocument>> {
    const { page = 1, limit = 20, status, priority, category, search, sort = '-createdAt' } = query;
    const skip = (page - 1) * limit;
    const filter: any = { isDeleted: false };
    if (status) filter.status = status;
    if (priority) filter.priority = priority;
    if (category) filter.category = category;
    if (search) {
      filter.$or = [
        { subject: { $regex: search, $options: 'i' } },
        { raisedByEmail: { $regex: search, $options: 'i' } },
      ];
    }
    const sortObj: any = sort.startsWith('-') ? { [sort.slice(1)]: -1 } : { [sort]: 1 };
    const [data, total] = await Promise.all([
      this.model.find(filter).sort(sortObj).skip(skip).limit(limit).populate('assignedTo', 'firstName lastName').lean(),
      this.model.countDocuments(filter),
    ]);
    return new PaginatedResult(data as TicketDocument[], total, page, limit);
  }

  async findById(id: string): Promise<TicketDocument> {
    const ticket = await this.model.findOne({ _id: id, isDeleted: false }).populate('assignedTo', 'firstName lastName email');
    if (!ticket) throw new NotFoundException('Ticket not found');
    return ticket;
  }

  async reply(id: string, dto: any): Promise<TicketDocument> {
    const ticket = await this.model.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { $push: { thread: { ...dto, sentAt: new Date() } } },
      { new: true },
    );
    if (!ticket) throw new NotFoundException('Ticket not found');
    return ticket;
  }

  async updateStatus(id: string, status: TicketStatus, assignedTo?: string): Promise<TicketDocument> {
    const update: any = { status };
    if (assignedTo) update.assignedTo = assignedTo;
    if (status === TicketStatus.RESOLVED) update.resolvedAt = new Date();
    const ticket = await this.model.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { $set: update },
      { new: true },
    );
    if (!ticket) throw new NotFoundException('Ticket not found');
    return ticket;
  }

  async addAttachments(id: string, filePaths: string[]): Promise<TicketDocument> {
    const ticket = await this.model.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { $push: { attachments: { $each: filePaths } } },
      { new: true },
    );
    if (!ticket) throw new NotFoundException('Ticket not found');
    return ticket;
  }

  async getStats(): Promise<any> {
    return this.model.aggregate([
      { $match: { isDeleted: false } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
  }
}
