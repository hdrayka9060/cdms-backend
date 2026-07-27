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
  ApiTags,
} from '@nestjs/swagger';
import { AdsAnalyticsService } from './ads-analytics.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AppModule, PermissionAction } from '../../common/permissions';
import {
  AdsAnalyticsQueryDto,
  ConnectCallbackDto,
  ConnectStartDto,
  SyncAdsDto,
  UpdateAdsConnectionDto,
} from './dto/ads.dto';

/**
 * Read-only Google Ads + Meta Ads analytics, surfaced on the Marketing tab.
 * Gated by the existing `Digital Marketing` permission module (reads = view,
 * connect/sync = edit, disconnect = delete). No campaign-create routes by
 * design — analytics only.
 */
@ApiTags('Marketing Ads')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller({ path: 'marketing/ads', version: '1' })
export class AdsAnalyticsController {
  constructor(private readonly service: AdsAnalyticsService) {}

  @Get('connections')
  @RequirePermission(AppModule.MARKETING, PermissionAction.VIEW)
  @ApiOperation({ summary: 'List connected ad accounts (Google / Meta)' })
  async listConnections() {
    const data = await this.service.listConnections();
    return { message: 'Ad connections retrieved', data };
  }

  @Post('connect/start')
  @RequirePermission(AppModule.MARKETING, PermissionAction.EDIT)
  @ApiOperation({
    summary: 'Begin connecting an ad account',
    description:
      'Returns the provider login URL to redirect to (real-mode) or `devMode: true` (the UI then completes via /connect/callback). `state` is a CSRF nonce.',
  })
  async startConnect(@Body() dto: ConnectStartDto) {
    const data = this.service.startConnect(dto.provider);
    return { message: 'Connect started', data };
  }

  @Post('connect/callback')
  @RequirePermission(AppModule.MARKETING, PermissionAction.EDIT)
  @ApiOperation({
    summary: 'Complete connecting an ad account',
    description:
      'Exchanges the OAuth code for tokens (stored encrypted), binds the configured/first ad account, and runs an initial sync. In dev-mode the code is ignored and mock data is used.',
  })
  async completeConnect(@Body() dto: ConnectCallbackDto, @CurrentUser() actor: any) {
    const data = await this.service.completeConnect(dto, actor?._id?.toString());
    return { message: 'Ad account connected', data };
  }

  @Get('connections/:id/accounts')
  @RequirePermission(AppModule.MARKETING, PermissionAction.VIEW)
  @ApiOperation({ summary: 'List ad accounts this connection can report on' })
  @ApiParam({ name: 'id' })
  async listAccounts(@Param('id') id: string) {
    const data = await this.service.listAccountsForConnection(id);
    return { message: 'Ad accounts retrieved', data };
  }

  @Patch('connections/:id')
  @RequirePermission(AppModule.MARKETING, PermissionAction.EDIT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bind / switch the reported ad account (no re-auth)' })
  @ApiParam({ name: 'id' })
  async updateConnection(
    @Param('id') id: string,
    @Body() dto: UpdateAdsConnectionDto,
    @CurrentUser() actor: any,
  ) {
    const data = await this.service.updateConnection(id, dto, actor?._id?.toString());
    return { message: 'Connection updated', data };
  }

  @Delete('connections/:id')
  @RequirePermission(AppModule.MARKETING, PermissionAction.DELETE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Disconnect an ad account (soft delete)' })
  @ApiParam({ name: 'id' })
  async disconnect(@Param('id') id: string, @CurrentUser() actor: any) {
    await this.service.disconnect(id, actor?._id?.toString());
    return { message: 'Ad account disconnected', data: null };
  }

  @Post('sync')
  @RequirePermission(AppModule.MARKETING, PermissionAction.EDIT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh ad insights now (one provider or all)' })
  async sync(@Body() dto: SyncAdsDto, @CurrentUser() actor: any) {
    const rows = await this.service.sync(dto.provider, actor?._id?.toString());
    return { message: 'Ad insights synced', data: { rows } };
  }

  @Get('analytics')
  @RequirePermission(AppModule.MARKETING, PermissionAction.VIEW)
  @ApiOperation({
    summary: 'Aggregated ad analytics (KPIs + per-platform + campaigns + daily trend)',
  })
  @ApiQuery({ name: 'startDate', required: false })
  @ApiQuery({ name: 'endDate', required: false })
  @ApiQuery({ name: 'provider', required: false })
  async getAnalytics(@Query() q: AdsAnalyticsQueryDto) {
    const data = await this.service.getAnalytics(q);
    return { message: 'Ad analytics retrieved', data };
  }
}
