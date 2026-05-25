import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CalendarEvent, CalendarEventDocument } from './schemas/calendar-event.schema';
import { PaginationDto, PaginatedResult } from '../../common/dto/pagination.dto';

@Injectable()
export class CalendarService {
  constructor(@InjectModel(CalendarEvent.name) private model: Model<CalendarEventDocument>) {}

  async create(dto: any): Promise<CalendarEventDocument> {
    // Generate mock Google Meet link for meetings
    if (dto.eventType === 'meeting') dto.meetLink = `https://meet.google.com/${Math.random().toString(36).slice(2, 10)}`;
    return new this.model(dto).save();
  }

  async findAll(query: any): Promise<PaginatedResult<CalendarEventDocument>> {
    const { page = 1, limit = 50, sort = 'startDateTime', eventType, startDate, endDate } = query;
    const skip = (page - 1) * limit;
    const filter: any = { isDeleted: false };
    if (eventType) filter.eventType = eventType;
    if (startDate || endDate) {
      filter.startDateTime = {};
      if (startDate) filter.startDateTime.$gte = new Date(startDate);
      if (endDate) filter.startDateTime.$lte = new Date(endDate);
    }
    const sortObj: any = sort.startsWith('-') ? { [sort.slice(1)]: -1 } : { [sort]: 1 };
    const [data, total] = await Promise.all([
      this.model.find(filter).sort(sortObj).skip(skip).limit(limit).populate('assignedTo', 'firstName lastName').populate('vehicle', 'title vehicleNumber').lean(),
      this.model.countDocuments(filter),
    ]);
    return new PaginatedResult(data as unknown as CalendarEventDocument[], total, page, limit);
  }

  async findById(id: string): Promise<CalendarEventDocument> {
    const event = await this.model.findOne({ _id: id, isDeleted: false });
    if (!event) throw new NotFoundException('Event not found');
    return event;
  }

  async update(id: string, dto: any): Promise<CalendarEventDocument> {
    const event = await this.model.findOneAndUpdate({ _id: id, isDeleted: false }, { $set: dto }, { new: true });
    if (!event) throw new NotFoundException('Event not found');
    return event;
  }

  async remove(id: string): Promise<void> {
    const event = await this.model.findOneAndUpdate({ _id: id, isDeleted: false }, { isDeleted: true });
    if (!event) throw new NotFoundException('Event not found');
  }

  async blockSlot(dto: any): Promise<CalendarEventDocument> {
    return new this.model({ ...dto, eventType: 'blocked', title: dto.title || 'Blocked' }).save();
  }

  async getUpcoming(days = 7): Promise<CalendarEventDocument[]> {
    const now = new Date();
    const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    return this.model.find({ isDeleted: false, startDateTime: { $gte: now, $lte: future } }).sort({ startDateTime: 1 }).populate('assignedTo', 'firstName lastName').lean() as any;
  }
}
