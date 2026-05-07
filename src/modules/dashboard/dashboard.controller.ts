import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { DashboardService } from './dashboard.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

@ApiTags('Dashboard')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller({ path: 'dashboard', version: '1' })
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  /**
   * GET /api/v1/dashboard/stats
   * Returns summary cards data
   */
  @Get('stats')
  @ApiOperation({
    summary: 'Get dashboard summary statistics',
    description: `Returns key metrics for the dashboard summary cards:
- \`totalVehicles\`: Total vehicles in inventory
- \`vehiclesSold\`: Total sold vehicles
- \`pendingTestDrives\`: Upcoming test drive bookings
- \`totalLeads\`: All buyer leads
- \`monthlyRevenue\`: Revenue this calendar month
- \`monthlyProfit\`: Profit this calendar month
- \`totalRevenue\`: All-time total revenue`,
  })
  @ApiResponse({ status: 200, description: 'Stats returned successfully' })
  async getStats() {
    const stats = await this.dashboardService.getStats();
    return { message: 'Dashboard stats', data: stats };
  }

  /**
   * GET /api/v1/dashboard/charts
   * Returns chart data
   */
  @Get('charts')
  @ApiOperation({
    summary: 'Get dashboard chart data',
    description: `Returns data for all dashboard charts:
- \`monthlySales\`: Monthly revenue + count (last 6 months) — for line chart
- \`vehiclesByStatus\`: Vehicle counts by status — for pie chart
- \`leadsByStage\`: Buyer lead pipeline counts — for funnel chart`,
  })
  @ApiResponse({ status: 200, description: 'Chart data returned' })
  async getCharts() {
    const charts = await this.dashboardService.getCharts();
    return { message: 'Chart data', data: charts };
  }
}
