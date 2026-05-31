import { Controller, Get, Post, Patch, Body, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { MarketingService } from './marketing.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { AppModule, PermissionAction } from '../../common/permissions';
import { CampaignPlatform, CampaignStatus } from './schemas/campaign.schema';

@ApiTags('Marketing')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller({ path: 'marketing', version: '1' })
export class MarketingController {
  constructor(private readonly service: MarketingService) {}

  @Post('campaigns')
  @RequirePermission(AppModule.MARKETING, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Create campaign', description: 'Creates a Google/Meta/Instagram/Email marketing campaign.' })
  @ApiResponse({ status: 201, description: 'Campaign created' })
  async create(@Body() dto: any) {
    const campaign = await this.service.create(dto);
    return { message: 'Campaign created', data: campaign };
  }

  @Get('campaigns')
  @RequirePermission(AppModule.MARKETING, PermissionAction.VIEW)
  @ApiOperation({ summary: 'List campaigns', description: 'Filter by platform and status.' })
  @ApiQuery({ name: 'platform', enum: CampaignPlatform, required: false })
  @ApiQuery({ name: 'status', enum: CampaignStatus, required: false })
  async findAll(@Query() query: any) {
    const result = await this.service.findAll(query);
    return { message: 'Campaigns retrieved', data: result };
  }

  @Get('metrics')
  @RequirePermission(AppModule.MARKETING, PermissionAction.VIEW)
  @ApiOperation({ summary: 'Get aggregated campaign metrics', description: 'Returns total impressions, clicks, leads, conversions and cost per lead per platform.' })
  async getMetrics() {
    const data = await this.service.getMetrics();
    return { message: 'Campaign metrics', data };
  }

  @Get('campaigns/:id')
  @RequirePermission(AppModule.MARKETING, PermissionAction.VIEW)
  @ApiOperation({ summary: 'Get campaign by ID' })
  @ApiParam({ name: 'id' })
  async findOne(@Param('id') id: string) {
    const campaign = await this.service.findById(id);
    return { message: 'Campaign retrieved', data: campaign };
  }

  @Patch('campaigns/:id')
  @RequirePermission(AppModule.MARKETING, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Update campaign' })
  @ApiParam({ name: 'id' })
  async update(@Param('id') id: string, @Body() dto: any) {
    const campaign = await this.service.update(id, dto);
    return { message: 'Campaign updated', data: campaign };
  }

  @Post('campaigns/:id/refresh-metrics')
  @RequirePermission(AppModule.MARKETING, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Refresh campaign metrics (mock)', description: 'Simulates pulling fresh metrics from Google/Meta APIs.' })
  @ApiParam({ name: 'id' })
  async refreshMetrics(@Param('id') id: string) {
    const campaign = await this.service.refreshMetrics(id);
    return { message: 'Metrics refreshed', data: campaign };
  }
}
