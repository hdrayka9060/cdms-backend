import { Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { CrmBuyersService } from './crm-buyers.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { BuyerLeadStage } from './schemas/buyer-lead.schema';

@ApiTags('CRM Buyers')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller({ path: 'crm/buyers', version: '1' })
export class CrmBuyersController {
  constructor(private readonly service: CrmBuyersService) {}

  @Post()
  @ApiOperation({ summary: 'Create buyer lead', description: 'Creates a new buyer CRM lead.' })
  @ApiResponse({ status: 201, description: 'Buyer lead created' })
  async create(@Body() dto: any) {
    const lead = await this.service.create(dto);
    return { message: 'Buyer lead created', data: lead };
  }

  @Get()
  @ApiOperation({ summary: 'List buyer leads', description: 'Paginated list with optional stage filter.' })
  @ApiQuery({ name: 'stage', enum: BuyerLeadStage, required: false })
  async findAll(@Query() query: any) {
    const result = await this.service.findAll(query);
    return { message: 'Buyer leads retrieved', data: result };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get buyer lead by ID' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId' })
  @ApiResponse({ status: 404, description: 'Lead not found' })
  async findOne(@Param('id') id: string) {
    const lead = await this.service.findById(id);
    return { message: 'Lead retrieved', data: lead };
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update buyer lead' })
  @ApiParam({ name: 'id' })
  async update(@Param('id') id: string, @Body() dto: any) {
    const lead = await this.service.update(id, dto);
    return { message: 'Lead updated', data: lead };
  }

  @Post(':id/test-drive')
  @ApiOperation({ summary: 'Book a test drive', description: 'Books a test drive and moves lead to TEST_DRIVE stage.' })
  @ApiParam({ name: 'id' })
  async bookTestDrive(@Param('id') id: string, @Body() dto: any) {
    const lead = await this.service.bookTestDrive(id, dto);
    return { message: 'Test drive booked', data: lead };
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
