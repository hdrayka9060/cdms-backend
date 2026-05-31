import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { DashboardService } from './dashboard.service';
import { ActivityService } from '../activity/activity.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { AppModule, PermissionAction } from '../../common/permissions';

@ApiTags('Dashboard')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller({ path: 'dashboard', version: '1' })
export class DashboardController {
  constructor(
    private readonly dashboardService: DashboardService,
    private readonly activity: ActivityService,
  ) {}

  /**
   * GET /api/v1/dashboard/stats[?startDate&endDate]
   * Returns six KPIs for the current period plus the previous-period block
   * for trend-delta computation. Omit both query params for an all-time
   * snapshot (the previous block will be null, hasPrevious=false).
   */
  @Get('stats')
  @RequirePermission(AppModule.DASHBOARD, PermissionAction.VIEW)
  @ApiOperation({
    summary: 'Dashboard KPIs with trend deltas',
    description: `Six metrics for the current window + the equal-length prior window. KPIs:
- \`totalVehicles\`: vehicles added in window (or all-time)
- \`vehiclesSold\`: sales recorded in window
- \`totalRevenue\`: sum(salePrice − discount) in window
- \`totalProfit\`: revenue − costPrice in window
- \`activeLeads\`: leads created in window not closed/archived
- \`pendingTestDrives\`: scheduled test-drive events in window

Pass startDate + endDate (YYYY-MM-DD). Omit both for all-time.`,
  })
  @ApiQuery({ name: 'startDate', required: false, type: String })
  @ApiQuery({ name: 'endDate', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Stats returned successfully' })
  async getStats(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const stats = await this.dashboardService.getStats(startDate, endDate);
    return { message: 'Dashboard stats', data: stats };
  }

  /**
   * GET /api/v1/dashboard/charts
   * Returns chart data — always last 12 months for trend visibility.
   */
  @Get('charts')
  @RequirePermission(AppModule.DASHBOARD, PermissionAction.VIEW)
  @ApiOperation({
    summary: 'Dashboard chart datasets',
    description: `Returns:
- \`revenueAndProfit\`: monthly { revenue, profit } over the last 12 months
- \`vehiclesByType\`: counts grouped by Vehicle.bodyType (top buckets first)
- \`monthlyExpenses\`: monthly Expense.amount totals over the last 12 months

These charts use a fixed 12-month window deliberately — the user's
period selector drives the KPIs above, but the trend charts always
show seasonality so dealers can spot patterns.`,
  })
  @ApiResponse({ status: 200, description: 'Chart data returned' })
  async getCharts() {
    const charts = await this.dashboardService.getCharts();
    return { message: 'Chart data', data: charts };
  }

  /**
   * GET /api/v1/dashboard/activity[?limit&module]
   * Unified, server-built activity feed — replaces the earlier client-side
   * merge of /sales + /leads + /calendar + /support that only saw "creates".
   * Now sourced from the `activities` collection which captures every
   * mutation (create/update/delete/close/etc.) across the app.
   */
  @Get('activity')
  @RequirePermission(AppModule.DASHBOARD, PermissionAction.VIEW)
  @ApiOperation({
    summary: 'Recent activity feed',
    description:
      'Most-recent-first list of mutations across all feature modules. Optional `module` filter for "show me only inventory changes" surfaces.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Default 20, max 200' })
  @ApiQuery({ name: 'module', required: false, type: String, description: 'Filter to one module (e.g. inventory, leads)' })
  async getActivity(
    @Query('limit') limit?: string,
    @Query('module') moduleFilter?: string,
  ) {
    const items = await this.activity.listRecent({
      limit: limit ? parseInt(limit, 10) : 20,
      module: moduleFilter,
    });
    return { message: 'Activity feed', data: items };
  }
}
