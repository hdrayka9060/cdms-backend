import {
  Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
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

  @Patch('sales/:id')
  @ApiOperation({ summary: 'Edit a sale', description: 'Updates buyer, vehicle ref, prices, payment, etc.' })
  @ApiParam({ name: 'id', description: 'Sale ObjectId' })
  async updateSale(@Param('id') id: string, @Body() dto: any) {
    const sale = await this.service.updateSale(id, dto);
    return { message: 'Sale updated', data: sale };
  }

  @Delete('sales/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a sale (soft)' })
  @ApiParam({ name: 'id', description: 'Sale ObjectId' })
  async removeSale(@Param('id') id: string) {
    await this.service.removeSale(id);
    return { message: 'Sale deleted', data: null };
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

  @Patch('expenses/:id')
  @ApiOperation({ summary: 'Edit an expense', description: 'Updates title, amount, date, category, vendor, or notes.' })
  @ApiParam({ name: 'id', description: 'Expense ObjectId' })
  async updateExpense(@Param('id') id: string, @Body() dto: any) {
    const expense = await this.service.updateExpense(id, dto);
    return { message: 'Expense updated', data: expense };
  }

  @Delete('expenses/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete an expense (soft)' })
  @ApiParam({ name: 'id', description: 'Expense ObjectId' })
  async removeExpense(@Param('id') id: string) {
    await this.service.removeExpense(id);
    return { message: 'Expense deleted', data: null };
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
