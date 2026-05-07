import { Controller, Get, Post, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { AccountingService } from './accounting.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

@ApiTags('Accounting')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller({ path: 'accounting', version: '1' })
export class AccountingController {
  constructor(private readonly service: AccountingService) {}

  @Get('summary')
  @ApiOperation({ summary: 'Get financial summary', description: 'Returns total revenue, cost, expenses, profit, and outstanding payments. Optionally filter by date range.' })
  @ApiQuery({ name: 'startDate', required: false })
  @ApiQuery({ name: 'endDate', required: false })
  async getSummary(@Query('startDate') startDate?: string, @Query('endDate') endDate?: string) {
    const data = await this.service.getSummary(startDate, endDate);
    return { message: 'Financial summary', data };
  }

  @Get('sales')
  @ApiOperation({ summary: 'Get sales ledger', description: 'Paginated sales list. Filter by paymentStatus: paid | pending | partial.' })
  @ApiQuery({ name: 'paymentStatus', required: false, enum: ['paid', 'pending', 'partial'] })
  async getSales(@Query() query: any) {
    const data = await this.service.getSales(query);
    return { message: 'Sales ledger', data };
  }

  @Post('sales')
  @ApiOperation({ summary: 'Record a sale', description: 'Logs a completed vehicle sale transaction.' })
  @ApiResponse({ status: 201, description: 'Sale recorded' })
  async createSale(@Body() dto: any) {
    const sale = await this.service.createSale(dto);
    return { message: 'Sale recorded', data: sale };
  }

  @Get('expenses')
  @ApiOperation({ summary: 'Get expense list', description: 'Paginated expense list. Filter by category.' })
  @ApiQuery({ name: 'category', required: false, enum: ['general', 'marketing', 'maintenance', 'staff', 'utilities', 'other'] })
  async getExpenses(@Query() query: any) {
    const data = await this.service.getExpenses(query);
    return { message: 'Expenses', data };
  }

  @Post('expenses')
  @ApiOperation({ summary: 'Add an expense', description: 'Records a new dealership expense.' })
  @ApiResponse({ status: 201, description: 'Expense added' })
  async createExpense(@Body() dto: any) {
    const expense = await this.service.createExpense(dto);
    return { message: 'Expense added', data: expense };
  }

  @Get('profit-loss')
  @ApiOperation({ summary: 'Get P&L report', description: 'Monthly profit and loss breakdown for a date range.' })
  @ApiQuery({ name: 'startDate', required: true, description: 'ISO date e.g. 2024-01-01' })
  @ApiQuery({ name: 'endDate', required: true, description: 'ISO date e.g. 2024-12-31' })
  async getProfitLoss(@Query('startDate') startDate: string, @Query('endDate') endDate: string) {
    const data = await this.service.getProfitLoss(startDate, endDate);
    return { message: 'P&L report', data };
  }
}
