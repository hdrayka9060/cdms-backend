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
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { LeadsService } from './leads.service';
import {
  AddLogEntryDto,
  AddTimelineEntryDto,
  AssignBuyerDto,
  CloseLeadDto,
  CreateLeadDto,
  LeadBookTestDriveDto,
  LeadQueryDto,
  UpdateLeadDto,
  UpdateLogEntryDto,
} from './dto/lead.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { AppModule, PermissionAction } from '../../common/permissions';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Leads')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller({ path: 'leads', version: '1' })
export class LeadsController {
  constructor(private readonly service: LeadsService) {}

  @Post()
  @RequirePermission(AppModule.LEADS, PermissionAction.EDIT)
  @ApiOperation({
    summary: 'Create a lead',
    description: 'Creates a sales lead linking a buyer to a vehicle. Auto-adds a "Lead created" timeline entry.',
  })
  @ApiResponse({ status: 201, description: 'Lead created' })
  async create(@Body() dto: CreateLeadDto, @CurrentUser() user: any) {
    const actorName = formatActor(user);
    const lead = await this.service.create(dto, actorName, user?._id ? String(user._id) : undefined);
    return { message: 'Lead created', data: lead };
  }

  @Get()
  @RequirePermission(AppModule.LEADS, PermissionAction.VIEW)
  @ApiOperation({
    summary: 'List leads',
    description: 'Paginated list with filters: status, source, assignedTo, buyer, vehicle, search (notes).',
  })
  @ApiResponse({ status: 200, description: 'Leads retrieved' })
  async findAll(@Query() query: LeadQueryDto) {
    const result = await this.service.findAll(query);
    return { message: 'Leads retrieved', data: result };
  }

  @Get('pipeline-stats')
  @RequirePermission(AppModule.LEADS, PermissionAction.VIEW)
  @ApiOperation({ summary: 'Get pipeline stats', description: 'Count per status.' })
  async getPipelineStats() {
    const stats = await this.service.getPipelineStats();
    return { message: 'Pipeline stats', data: stats };
  }

  @Get(':id')
  @RequirePermission(AppModule.LEADS, PermissionAction.VIEW)
  @ApiOperation({ summary: 'Get lead by ID' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId' })
  @ApiResponse({ status: 200, description: 'Lead found' })
  @ApiResponse({ status: 404, description: 'Lead not found' })
  async findOne(@Param('id') id: string) {
    const lead = await this.service.findById(id);
    return { message: 'Lead retrieved', data: lead };
  }

  @Patch(':id')
  @RequirePermission(AppModule.LEADS, PermissionAction.EDIT)
  @ApiOperation({
    summary: 'Update lead',
    description: 'Update status, assignment, or notes. Status/assignment changes auto-append a timeline entry.',
  })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId' })
  async update(@Param('id') id: string, @Body() dto: UpdateLeadDto, @CurrentUser() user: any) {
    const actorName = formatActor(user);
    const lead = await this.service.update(id, dto, actorName);
    return { message: 'Lead updated', data: lead };
  }

  @Post(':id/assign-buyer')
  @RequirePermission(AppModule.LEADS, PermissionAction.EDIT)
  @ApiOperation({
    summary: 'Assign a buyer to a walk-in lead',
    description:
      'Links an existing CRM buyer (buyerLeadId) or creates a new one inline ' +
      '(newBuyer* — deduped by email, 409 if it exists) to a buyer-less lead. ' +
      'If the lead is already closed (a completed walk-in sale) the Sale row + the ' +
      "buyer's purchases[] are updated too. 409 if the lead already has a buyer.",
  })
  @ApiParam({ name: 'id', description: 'Lead ObjectId' })
  @ApiResponse({ status: 201, description: 'Buyer assigned' })
  @ApiResponse({ status: 409, description: 'Lead already has a buyer, or duplicate buyer email' })
  async assignBuyer(@Param('id') id: string, @Body() dto: AssignBuyerDto, @CurrentUser() user: any) {
    const actorName = formatActor(user);
    const lead = await this.service.assignBuyer(id, dto, actorName);
    return { message: 'Buyer assigned', data: lead };
  }

  @Post(':id/timeline')
  @RequirePermission(AppModule.LEADS, PermissionAction.EDIT)
  @ApiOperation({
    summary: 'Append a timeline entry',
    description: 'Records a human-readable action (e.g. "Reservation taken") onto the lead timeline.',
  })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId' })
  async addTimelineEntry(
    @Param('id') id: string,
    @Body() dto: AddTimelineEntryDto,
    @CurrentUser() user: any,
  ) {
    const actorName = formatActor(user);
    const lead = await this.service.addTimelineEntry(id, dto, actorName);
    return { message: 'Timeline entry added', data: lead };
  }

  @Post(':id/log')
  @RequirePermission(AppModule.LEADS, PermissionAction.EDIT)
  @ApiOperation({
    summary: 'Append a communication log entry',
    description: `Logs a communication for this lead.

**Channels:** \`call\` | \`email\` | \`whatsapp\` | \`sms\` | \`offline\`

Optional: \`vehicleId\` to attach which vehicle the comm was about, \`byStaffId\` to attribute to a specific staff member (defaults to the current user).`,
  })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId' })
  async addLogEntry(
    @Param('id') id: string,
    @Body() dto: AddLogEntryDto,
    @CurrentUser() user: any,
  ) {
    const lead = await this.service.addLogEntry(id, dto, user?._id);
    return { message: 'Log entry added', data: lead };
  }

  @Patch(':id/log/:logId')
  @RequirePermission(AppModule.LEADS, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Edit a communication log entry' })
  @ApiParam({ name: 'id', description: 'Lead ObjectId' })
  @ApiParam({ name: 'logId', description: 'Log entry ObjectId' })
  async updateLogEntry(
    @Param('id') id: string,
    @Param('logId') logId: string,
    @Body() dto: UpdateLogEntryDto,
  ) {
    const lead = await this.service.updateLogEntry(id, logId, dto);
    return { message: 'Log entry updated', data: lead };
  }

  @Delete(':id/log/:logId')
  @RequirePermission(AppModule.LEADS, PermissionAction.EDIT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a communication log entry' })
  @ApiParam({ name: 'id', description: 'Lead ObjectId' })
  @ApiParam({ name: 'logId', description: 'Log entry ObjectId' })
  async removeLogEntry(@Param('id') id: string, @Param('logId') logId: string) {
    const lead = await this.service.removeLogEntry(id, logId);
    return { message: 'Log entry deleted', data: lead };
  }

  @Post(':id/book-test-drive')
  @RequirePermission(AppModule.LEADS, PermissionAction.EDIT)
  @ApiOperation({
    summary: 'Book a test drive for this lead',
    description: 'Auto-advances the pipeline to test_drive (if not already past) and appends a timeline entry. The calendar event itself is created by the frontend.',
  })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId' })
  async bookTestDrive(
    @Param('id') id: string,
    @Body() dto: LeadBookTestDriveDto,
    @CurrentUser() user: any,
  ) {
    const actorName = formatActor(user);
    const lead = await this.service.bookTestDrive(id, dto, actorName);
    return { message: 'Test drive booked', data: lead };
  }

  @Post(':id/close')
  @RequirePermission(AppModule.LEADS, PermissionAction.EDIT)
  @ApiOperation({
    summary: 'Close (mark as won) a lead',
    description:
      'Single endpoint that flips the lead to Closed, records a Sale in Accounting, marks the linked Vehicle as sold (with realised soldAt + soldDate), and pushes a purchase entry onto the buyer.',
  })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId' })
  async close(@Param('id') id: string, @Body() dto: CloseLeadDto, @CurrentUser() user: any) {
    const actorName = formatActor(user);
    const lead = await this.service.closeLead(id, dto, actorName);
    return { message: 'Lead closed', data: lead };
  }

  @Delete(':id')
  @RequirePermission(AppModule.LEADS, PermissionAction.DELETE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft-delete a lead' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId' })
  async remove(@Param('id') id: string) {
    await this.service.remove(id);
    return { message: 'Lead deleted', data: null };
  }
}

/** Render a user document as a friendly "First Last" string for timeline `by` fields. */
function formatActor(user: any): string {
  if (!user) return 'System';
  const first = user.firstName ?? '';
  const last = user.lastName ?? '';
  const full = `${first} ${last}`.trim();
  return full || user.email || 'System';
}
