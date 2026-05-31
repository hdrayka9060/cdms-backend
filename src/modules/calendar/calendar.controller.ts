import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CalendarService } from './calendar.service';
import {
  CreateCalendarEventDto,
  ParticipantInputDto,
  UpdateCalendarEventDto,
} from './dto/calendar-event.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AppModule, PermissionAction } from '../../common/permissions';
import { EventType, ParticipantType } from './schemas/calendar-event.schema';

@ApiTags('Calendar')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller({ path: 'calendar', version: '1' })
export class CalendarController {
  constructor(private readonly service: CalendarService) {}

  @Post('events')
  @RequirePermission(AppModule.CALENDAR, PermissionAction.EDIT)
  @ApiOperation({
    summary: 'Create calendar event',
    description: `Creates a new event. Event types: test_drive, inspection, meeting, other.

If \`meetingType === 'virtual'\` and \`createMeetLink: true\`, a Google Meet
link is auto-generated. Pass \`participants[]\` to attach Staff / Buyer /
Seller attendees up-front; participants can also be managed individually
via the /events/:id/participants endpoints below.`,
  })
  @ApiResponse({ status: 201, description: 'Event created' })
  async create(@Body() dto: CreateCalendarEventDto, @CurrentUser() actor: any) {
    // Pass req.user._id as the actor — service stores it on `createdBy`
    // so the creator shows up in their own multi-user calendar view.
    const event = await this.service.create(dto, actor?._id?.toString());
    return { message: 'Event created', data: event };
  }

  @Get('events')
  @RequirePermission(AppModule.CALENDAR, PermissionAction.VIEW)
  @ApiOperation({
    summary: 'List calendar events',
    description: `Filter by eventType + date range. Optional \`userId\`
filter matches events where the user is either \`assignedTo\` (staff) or
listed in \`participants[]\` (any role) — used by the multi-user calendar
view. Pair \`userId\` with \`userType\` to skip the assignedTo branch for
buyers/sellers (purely an optimisation; results are correct either way).`,
  })
  @ApiQuery({ name: 'eventType', enum: EventType, required: false })
  @ApiQuery({ name: 'startDate', required: false, description: 'ISO date string' })
  @ApiQuery({ name: 'endDate', required: false, description: 'ISO date string' })
  @ApiQuery({ name: 'userId', required: false, description: 'Filter by attendee MongoDB ObjectId' })
  @ApiQuery({ name: 'userType', enum: ParticipantType, required: false })
  async findAll(@Query() query: any) {
    const result = await this.service.findAll(query);
    return { message: 'Events retrieved', data: result };
  }

  @Get('events/upcoming')
  @RequirePermission(AppModule.CALENDAR, PermissionAction.VIEW)
  @ApiOperation({ summary: 'Get upcoming events (next 7 days)' })
  async getUpcoming() {
    const events = await this.service.getUpcoming(7);
    return { message: 'Upcoming events', data: events };
  }

  @Get('events/:id')
  @RequirePermission(AppModule.CALENDAR, PermissionAction.VIEW)
  @ApiOperation({ summary: 'Get event by ID' })
  @ApiParam({ name: 'id' })
  async findOne(@Param('id') id: string) {
    const event = await this.service.findById(id);
    return { message: 'Event retrieved', data: event };
  }

  @Patch('events/:id')
  @RequirePermission(AppModule.CALENDAR, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Update calendar event' })
  @ApiParam({ name: 'id' })
  async update(@Param('id') id: string, @Body() dto: UpdateCalendarEventDto) {
    const event = await this.service.update(id, dto);
    return { message: 'Event updated', data: event };
  }

  @Delete('events/:id')
  @RequirePermission(AppModule.CALENDAR, PermissionAction.DELETE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete event (soft)' })
  @ApiParam({ name: 'id' })
  async remove(@Param('id') id: string) {
    await this.service.remove(id);
    return { message: 'Event deleted', data: null };
  }

  // ── Participant management ─────────────────────────────────────────────
  // Discrete add/remove endpoints so the UI can manage attendees without
  // round-tripping the full event payload. Both gated by CALENDAR:edit.

  @Post('events/:id/participants')
  @RequirePermission(AppModule.CALENDAR, PermissionAction.EDIT)
  @ApiOperation({
    summary: 'Add a participant to an event',
    description:
      'Attach a Staff / Buyer / Seller to the event. `userId` is optional — supply only `name`+`email` for ad-hoc invitees.',
  })
  @ApiParam({ name: 'id' })
  async addParticipant(@Param('id') id: string, @Body() dto: ParticipantInputDto) {
    const event = await this.service.addParticipant(id, dto);
    return { message: 'Participant added', data: event };
  }

  @Delete('events/:id/participants/:participantId')
  @RequirePermission(AppModule.CALENDAR, PermissionAction.EDIT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a participant from an event' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'participantId' })
  async removeParticipant(
    @Param('id') id: string,
    @Param('participantId') participantId: string,
  ) {
    const event = await this.service.removeParticipant(id, participantId);
    return { message: 'Participant removed', data: event };
  }
}
