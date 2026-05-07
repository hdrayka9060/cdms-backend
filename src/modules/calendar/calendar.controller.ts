import { Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { CalendarService } from './calendar.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { EventType } from './schemas/calendar-event.schema';

@ApiTags('Calendar')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller({ path: 'calendar', version: '1' })
export class CalendarController {
  constructor(private readonly service: CalendarService) {}

  @Post('events')
  @ApiOperation({
    summary: 'Create calendar event',
    description: `Creates a new event. Event types: test_drive, inspection, meeting, blocked.
For meetings, a mock Google Meet link is auto-generated.

**Body fields:** title, description, startDateTime (ISO), endDateTime (ISO), eventType, assignedTo (userId), customerName, customerPhone, customerEmail, vehicle (vehicleId), location, notes`,
  })
  @ApiResponse({ status: 201, description: 'Event created' })
  async create(@Body() dto: any) {
    const event = await this.service.create(dto);
    return { message: 'Event created', data: event };
  }

  @Get('events')
  @ApiOperation({ summary: 'List calendar events', description: 'Filter by eventType, date range. Returns paginated events.' })
  @ApiQuery({ name: 'eventType', enum: EventType, required: false })
  @ApiQuery({ name: 'startDate', required: false, description: 'ISO date string' })
  @ApiQuery({ name: 'endDate', required: false, description: 'ISO date string' })
  async findAll(@Query() query: any) {
    const result = await this.service.findAll(query);
    return { message: 'Events retrieved', data: result };
  }

  @Get('events/upcoming')
  @ApiOperation({ summary: 'Get upcoming events (next 7 days)' })
  async getUpcoming() {
    const events = await this.service.getUpcoming(7);
    return { message: 'Upcoming events', data: events };
  }

  @Get('events/:id')
  @ApiOperation({ summary: 'Get event by ID' })
  @ApiParam({ name: 'id' })
  async findOne(@Param('id') id: string) {
    const event = await this.service.findById(id);
    return { message: 'Event retrieved', data: event };
  }

  @Patch('events/:id')
  @ApiOperation({ summary: 'Update calendar event' })
  @ApiParam({ name: 'id' })
  async update(@Param('id') id: string, @Body() dto: any) {
    const event = await this.service.update(id, dto);
    return { message: 'Event updated', data: event };
  }

  @Delete('events/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete event (soft)' })
  @ApiParam({ name: 'id' })
  async remove(@Param('id') id: string) {
    await this.service.remove(id);
    return { message: 'Event deleted', data: null };
  }

  @Post('block')
  @ApiOperation({ summary: 'Block a time slot', description: 'Marks a time range as unavailable for bookings.' })
  async blockSlot(@Body() dto: any) {
    const event = await this.service.blockSlot(dto);
    return { message: 'Slot blocked', data: event };
  }
}
