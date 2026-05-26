import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CalendarEvent, CalendarEventDocument } from './schemas/calendar-event.schema';
import { PaginationDto, PaginatedResult } from '../../common/dto/pagination.dto';
import { ActivityService } from '../activity/activity.service';

@Injectable()
export class CalendarService {
  constructor(
    @InjectModel(CalendarEvent.name) private model: Model<CalendarEventDocument>,
    private readonly activity: ActivityService,
  ) {}

  async create(dto: any): Promise<CalendarEventDocument> {
    // Generate mock Google Meet link for meetings
    if (dto.eventType === 'meeting') dto.meetLink = `https://meet.google.com/${Math.random().toString(36).slice(2, 10)}`;
    const saved = await new this.model(dto).save();
    await this.activity.log({
      module: 'calendar',
      action: 'created',
      entity: 'Calendar Event',
      entityId: saved._id,
      label: `${labelFor(saved.eventType)} · ${saved.title || saved.customerName || 'event'} · ${new Date(saved.startDateTime).toLocaleString()}`,
      meta: { eventType: saved.eventType, startDateTime: saved.startDateTime },
    });
    return saved;
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
    await this.activity.log({
      module: 'calendar',
      action: 'updated',
      entity: 'Calendar Event',
      entityId: event._id,
      label: `${labelFor(event.eventType)} updated · ${event.title || event.customerName || 'event'}`,
      meta: { fields: Object.keys(dto) },
    });
    return event;
  }

  async remove(id: string): Promise<void> {
    const event = await this.model.findOneAndUpdate(
      { _id: id, isDeleted: false },
      { isDeleted: true },
      { new: false },
    );
    if (!event) throw new NotFoundException('Event not found');
    await this.activity.log({
      module: 'calendar',
      action: 'deleted',
      entity: 'Calendar Event',
      entityId: event._id,
      label: `${labelFor(event.eventType)} cancelled · ${event.title || event.customerName || 'event'}`,
    });
  }

  async blockSlot(dto: any): Promise<CalendarEventDocument> {
    const saved = await new this.model({ ...dto, eventType: 'blocked', title: dto.title || 'Blocked' }).save();
    await this.activity.log({
      module: 'calendar',
      action: 'blocked',
      entity: 'Calendar Event',
      entityId: saved._id,
      label: `Slot blocked · ${new Date(saved.startDateTime).toLocaleString()}`,
    });
    return saved;
  }

  async getUpcoming(days = 7): Promise<CalendarEventDocument[]> {
    const now = new Date();
    const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    return this.model.find({ isDeleted: false, startDateTime: { $gte: now, $lte: future } }).sort({ startDateTime: 1 }).populate('assignedTo', 'firstName lastName').lean() as any;
  }
}

/** Render the eventType enum slug as a human-readable verb. */
function labelFor(type: string): string {
  switch (type) {
    case 'test_drive': return 'Test drive';
    case 'inspection': return 'Inspection';
    case 'meeting':    return 'Meeting';
    case 'blocked':    return 'Blocked slot';
    default:           return 'Event';
  }
}
