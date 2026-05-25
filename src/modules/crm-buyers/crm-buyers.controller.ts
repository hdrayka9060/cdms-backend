import {
  Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CrmBuyersService } from './crm-buyers.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  AddInterestedVehicleDto, BookTestDriveDto, BuyerCommunicationDto,
  CreateBuyerLeadDto, UpdateBuyerLeadDto,
} from './dto/buyer-lead.dto';
import { BuyerLeadStage } from './schemas/buyer-lead.schema';

@ApiTags('CRM Buyers')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller({ path: 'crm/buyers', version: '1' })
export class CrmBuyersController {
  constructor(private readonly service: CrmBuyersService) {}

  @Post()
  @ApiOperation({ summary: 'Create buyer lead' })
  @ApiResponse({ status: 201, description: 'Buyer lead created' })
  async create(@Body() dto: CreateBuyerLeadDto) {
    const lead = await this.service.create(dto);
    return { message: 'Buyer lead created', data: lead };
  }

  @Get()
  @ApiOperation({ summary: 'List buyer leads' })
  @ApiQuery({ name: 'stage', enum: BuyerLeadStage, required: false })
  async findAll(@Query() query: any) {
    const result = await this.service.findAll(query);
    return { message: 'Buyer leads retrieved', data: result };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get buyer lead by ID' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 404, description: 'Lead not found' })
  async findOne(@Param('id') id: string) {
    const lead = await this.service.findById(id);
    return { message: 'Lead retrieved', data: lead };
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update buyer lead (name, email, phone, status, notes, etc.)' })
  @ApiParam({ name: 'id' })
  async update(@Param('id') id: string, @Body() dto: UpdateBuyerLeadDto) {
    const lead = await this.service.update(id, dto);
    return { message: 'Lead updated', data: lead };
  }

  @Post(':id/interested-vehicles')
  @ApiOperation({ summary: 'Add a vehicle to the buyer\'s interested list' })
  @ApiParam({ name: 'id' })
  async addInterestedVehicle(@Param('id') id: string, @Body() dto: AddInterestedVehicleDto) {
    const lead = await this.service.addInterestedVehicle(id, dto.vehicleId);
    return { message: 'Vehicle added to interests', data: lead };
  }

  @Delete(':id/interested-vehicles/:vehicleId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a vehicle from the buyer\'s interested list' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'vehicleId' })
  async removeInterestedVehicle(@Param('id') id: string, @Param('vehicleId') vehicleId: string) {
    const lead = await this.service.removeInterestedVehicle(id, vehicleId);
    return { message: 'Vehicle removed from interests', data: lead };
  }

  @Post(':id/test-drive')
  @ApiOperation({
    summary: 'Book a test drive',
    description: 'Moves the buyer to the Test Drive stage and appends a history entry. Accepts scheduledAt (ISO), assignedTo (User ObjectId), and notes.',
  })
  @ApiParam({ name: 'id' })
  async bookTestDrive(@Param('id') id: string, @Body() dto: BookTestDriveDto) {
    const lead = await this.service.bookTestDrive(id, dto);
    return { message: 'Test drive booked', data: lead };
  }

  @Post(':id/communications')
  @ApiOperation({ summary: 'Log a new communication entry' })
  @ApiParam({ name: 'id' })
  async addCommunication(
    @Param('id') id: string,
    @Body() dto: BuyerCommunicationDto,
    @CurrentUser() user: any,
  ) {
    const lead = await this.service.addCommunication(id, dto, user?._id);
    return { message: 'Communication logged', data: lead };
  }

  @Patch(':id/communications/:commId')
  @ApiOperation({ summary: 'Edit a communication entry' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'commId' })
  async updateCommunication(
    @Param('id') id: string,
    @Param('commId') commId: string,
    @Body() dto: BuyerCommunicationDto,
  ) {
    const lead = await this.service.updateCommunication(id, commId, dto);
    return { message: 'Communication updated', data: lead };
  }

  @Delete(':id/communications/:commId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a communication entry' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'commId' })
  async removeCommunication(@Param('id') id: string, @Param('commId') commId: string) {
    const lead = await this.service.removeCommunication(id, commId);
    return { message: 'Communication deleted', data: lead };
  }

  @Get(':id/history')
  @ApiOperation({ summary: 'Get buyer purchase/booking history' })
  @ApiParam({ name: 'id' })
  async getHistory(@Param('id') id: string) {
    const history = await this.service.getHistory(id);
    return { message: 'History retrieved', data: history };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete buyer lead (soft)' })
  @ApiParam({ name: 'id' })
  async remove(@Param('id') id: string) {
    await this.service.remove(id);
    return { message: 'Lead deleted', data: null };
  }
}
