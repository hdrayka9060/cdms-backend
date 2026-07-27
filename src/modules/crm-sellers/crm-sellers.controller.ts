import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam, ApiQuery, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { CrmSellersService } from './crm-sellers.service';
import {
  CreateSellerLeadDto, UpdateSellerLeadDto, CommunicateDto, UpdateCommunicateDto,
  ScheduleInspectionDto, SellerVehicleInputDto,
} from './dto/seller-lead.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { AppModule, PermissionAction } from '../../common/permissions';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { SellerLeadStage } from './schemas/seller-lead.schema';

class SellerLeadQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: SellerLeadStage }) @IsOptional() @IsEnum(SellerLeadStage) stage?: SellerLeadStage;
}

@ApiTags('CRM Sellers')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller({ path: 'crm/sellers', version: '1' })
export class CrmSellersController {
  constructor(private readonly service: CrmSellersService) {}

  @Post()
  @RequirePermission(AppModule.CRM_SELLERS, PermissionAction.EDIT)
  @ApiOperation({
    summary: 'Create seller lead',
    description:
      'Creates a new seller CRM lead. If `vehicles[]` is supplied, each entry is also created as a real Vehicle in the inventory and linked back on this seller.',
  })
  @ApiResponse({ status: 201, description: 'Lead created' })
  async create(@Body() dto: CreateSellerLeadDto, @CurrentUser() user: any) {
    const lead = await this.service.create(dto, user._id);
    return { message: 'Seller lead created', data: lead };
  }

  @Get()
  @RequirePermission(AppModule.CRM_SELLERS, PermissionAction.VIEW)
  @ApiOperation({ summary: 'List all seller leads', description: 'Paginated list with optional stage filter and search.' })
  @ApiQuery({ name: 'stage', enum: SellerLeadStage, required: false })
  @ApiResponse({ status: 200, description: 'Leads retrieved' })
  async findAll(@Query() query: SellerLeadQueryDto) {
    const result = await this.service.findAll(query);
    return { message: 'Seller leads retrieved', data: result };
  }

  @Get('pipeline-stats')
  @RequirePermission(AppModule.CRM_SELLERS, PermissionAction.VIEW)
  @ApiOperation({ summary: 'Get pipeline stats', description: 'Count and total value per stage.' })
  async getPipelineStats() {
    const stats = await this.service.getPipelineStats();
    return { message: 'Pipeline stats', data: stats };
  }

  @Get(':id')
  @RequirePermission(AppModule.CRM_SELLERS, PermissionAction.VIEW)
  @ApiOperation({ summary: 'Get seller lead by ID' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId' })
  @ApiResponse({ status: 200, description: 'Lead found' })
  @ApiResponse({ status: 404, description: 'Lead not found' })
  async findOne(@Param('id') id: string) {
    const lead = await this.service.findById(id);
    return { message: 'Lead retrieved', data: lead };
  }

  @Patch(':id')
  @RequirePermission(AppModule.CRM_SELLERS, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Update seller lead', description: 'Update contact, address, stage, notes, assignee, or inspection date.' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId' })
  async update(@Param('id') id: string, @Body() dto: UpdateSellerLeadDto, @CurrentUser() user: any) {
    const lead = await this.service.update(id, dto, user?._id);
    return { message: 'Lead updated', data: lead };
  }

  @Post(':id/vehicles')
  @RequirePermission(AppModule.CRM_SELLERS, PermissionAction.EDIT)
  @ApiOperation({
    summary: 'Attach a new vehicle to a seller',
    description:
      'Creates the vehicle in inventory and links it to the seller. The vehicle will appear in /inventory and on the seller detail page.',
  })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId' })
  @ApiResponse({ status: 201, description: 'Vehicle created and linked' })
  async addVehicle(
    @Param('id') id: string,
    @Body() dto: SellerVehicleInputDto,
    @CurrentUser() user: any,
  ) {
    const result = await this.service.addVehicle(id, dto, user._id);
    return { message: 'Vehicle added to seller', data: result };
  }

  @Delete(':id/vehicles/:vehicleId')
  @RequirePermission(AppModule.CRM_SELLERS, PermissionAction.EDIT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Detach a vehicle from a seller',
    description:
      'Removes the link only; the vehicle itself stays in inventory. To delete the vehicle entirely, use DELETE /inventory/:id.',
  })
  @ApiParam({ name: 'id', description: 'Seller lead ObjectId' })
  @ApiParam({ name: 'vehicleId', description: 'Vehicle ObjectId' })
  async removeVehicle(
    @Param('id') id: string,
    @Param('vehicleId') vehicleId: string,
    @CurrentUser() user: any,
  ) {
    const lead = await this.service.removeVehicle(id, vehicleId, user?._id);
    return { message: 'Vehicle removed from seller', data: lead };
  }

  @Post(':id/inspection')
  @RequirePermission(AppModule.CRM_SELLERS, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Schedule inspection', description: 'Sets an inspection date and moves lead to Inspection stage.' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId' })
  @ApiResponse({ status: 201, description: 'Inspection scheduled' })
  async scheduleInspection(@Param('id') id: string, @Body() dto: ScheduleInspectionDto, @CurrentUser() user: any) {
    const lead = await this.service.scheduleInspection(id, dto, user._id);
    return { message: 'Inspection scheduled', data: lead };
  }

  @Post(':id/communicate')
  @RequirePermission(AppModule.CRM_SELLERS, PermissionAction.EDIT)
  @ApiOperation({
    summary: 'Log communication',
    description: `Logs a communication event on the lead.

**Channels:** \`email\` | \`sms\` | \`whatsapp\` | \`call\`

Message is stored in the communications log with timestamp and sender.`,
  })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId' })
  @ApiResponse({ status: 201, description: 'Communication logged' })
  async communicate(@Param('id') id: string, @Body() dto: CommunicateDto, @CurrentUser() user: any) {
    const lead = await this.service.communicate(id, dto, user._id);
    return { message: 'Communication logged', data: lead };
  }

  @Patch(':id/communicate/:commId')
  @RequirePermission(AppModule.CRM_SELLERS, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Edit a logged communication', description: 'Updates the message and/or channel of an existing communication entry.' })
  @ApiParam({ name: 'id', description: 'Seller lead ObjectId' })
  @ApiParam({ name: 'commId', description: 'Communication subdocument ObjectId' })
  async updateCommunication(
    @Param('id') id: string,
    @Param('commId') commId: string,
    @Body() dto: UpdateCommunicateDto,
    @CurrentUser() user: any,
  ) {
    const lead = await this.service.updateCommunication(id, commId, dto, user?._id);
    return { message: 'Communication updated', data: lead };
  }

  @Delete(':id/communicate/:commId')
  @RequirePermission(AppModule.CRM_SELLERS, PermissionAction.DELETE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a logged communication', description: 'Removes a single communication entry from the seller.' })
  @ApiParam({ name: 'id', description: 'Seller lead ObjectId' })
  @ApiParam({ name: 'commId', description: 'Communication subdocument ObjectId' })
  async deleteCommunication(
    @Param('id') id: string,
    @Param('commId') commId: string,
    @CurrentUser() user: any,
  ) {
    const lead = await this.service.deleteCommunication(id, commId, user?._id);
    return { message: 'Communication deleted', data: lead };
  }

  @Delete(':id')
  @RequirePermission(AppModule.CRM_SELLERS, PermissionAction.DELETE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete seller lead (soft delete)',
    description: 'Soft-deletes the seller. Linked inventory vehicles are NOT deleted — they remain in inventory.',
  })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId' })
  async remove(@Param('id') id: string) {
    await this.service.remove(id);
    return { message: 'Lead deleted', data: null };
  }
}
