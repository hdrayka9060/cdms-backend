import {
  Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AccountingService } from './accounting.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { AppModule, PermissionAction } from '../../common/permissions';

@ApiTags('Accounting')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller({ path: 'accounting', version: '1' })
export class AccountingController {
  constructor(private readonly service: AccountingService) {}

  @Get('summary')
  @RequirePermission(AppModule.ACCOUNTING, PermissionAction.VIEW)
  @ApiOperation({ summary: 'Get financial summary', description: 'Returns total revenue, cost, expenses, profit, and outstanding payments. Optionally filter by date range.' })
  @ApiQuery({ name: 'startDate', required: false })
  @ApiQuery({ name: 'endDate', required: false })
  async getSummary(@Query('startDate') startDate?: string, @Query('endDate') endDate?: string) {
    const data = await this.service.getSummary(startDate, endDate);
    return { message: 'Financial summary', data };
  }

  @Get('sales')
  @RequirePermission(AppModule.ACCOUNTING, PermissionAction.VIEW)
  @ApiOperation({ summary: 'Get sales ledger', description: 'Paginated sales list. Filter by paymentStatus: paid | pending | partial.' })
  @ApiQuery({ name: 'paymentStatus', required: false, enum: ['paid', 'pending', 'partial'] })
  async getSales(@Query() query: any) {
    const data = await this.service.getSales(query);
    return { message: 'Sales ledger', data };
  }

  @Post('sales')
  @RequirePermission(AppModule.ACCOUNTING, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Record a sale', description: 'Logs a completed vehicle sale transaction.' })
  @ApiResponse({ status: 201, description: 'Sale recorded' })
  async createSale(@Body() dto: any) {
    const sale = await this.service.createSale(dto);
    return { message: 'Sale recorded', data: sale };
  }

  @Patch('sales/:id')
  @RequirePermission(AppModule.ACCOUNTING, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Edit a sale', description: 'Updates buyer, vehicle ref, prices, payment, etc.' })
  @ApiParam({ name: 'id', description: 'Sale ObjectId' })
  async updateSale(@Param('id') id: string, @Body() dto: any) {
    const sale = await this.service.updateSale(id, dto);
    return { message: 'Sale updated', data: sale };
  }

  @Delete('sales/:id')
  @RequirePermission(AppModule.ACCOUNTING, PermissionAction.DELETE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a sale (soft)' })
  @ApiParam({ name: 'id', description: 'Sale ObjectId' })
  async removeSale(@Param('id') id: string) {
    await this.service.removeSale(id);
    return { message: 'Sale deleted', data: null };
  }

  @Get('expenses')
  @RequirePermission(AppModule.ACCOUNTING, PermissionAction.VIEW)
  @ApiOperation({ summary: 'Get expense list', description: 'Paginated expense list. Filter by category.' })
  @ApiQuery({ name: 'category', required: false, enum: ['general', 'marketing', 'maintenance', 'staff', 'utilities', 'other'] })
  async getExpenses(@Query() query: any) {
    const data = await this.service.getExpenses(query);
    return { message: 'Expenses', data };
  }

  @Post('expenses')
  @RequirePermission(AppModule.ACCOUNTING, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Add an expense', description: 'Records a new dealership expense.' })
  @ApiResponse({ status: 201, description: 'Expense added' })
  async createExpense(@Body() dto: any) {
    const expense = await this.service.createExpense(dto);
    return { message: 'Expense added', data: expense };
  }

  @Patch('expenses/:id')
  @RequirePermission(AppModule.ACCOUNTING, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Edit an expense', description: 'Updates title, amount, date, category, vendor, or notes.' })
  @ApiParam({ name: 'id', description: 'Expense ObjectId' })
  async updateExpense(@Param('id') id: string, @Body() dto: any) {
    const expense = await this.service.updateExpense(id, dto);
    return { message: 'Expense updated', data: expense };
  }

  @Delete('expenses/:id')
  @RequirePermission(AppModule.ACCOUNTING, PermissionAction.DELETE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete an expense (soft)' })
  @ApiParam({ name: 'id', description: 'Expense ObjectId' })
  async removeExpense(@Param('id') id: string) {
    await this.service.removeExpense(id);
    return { message: 'Expense deleted', data: null };
  }

  @Get('reconditioning-spends')
  @RequirePermission(AppModule.ACCOUNTING, PermissionAction.VIEW)
  @ApiOperation({
    summary: 'List vehicle reconditioning spends (cost-of-goods)',
    description:
      'Read-only, flattened list of every vehicle spend (repairs/service/parts/etc). ' +
      'These are cost-of-goods already folded into gross margin at sale time — surfaced ' +
      'here for visibility only, never written to the operating-expense ledger, so they ' +
      'are not double-counted against profit. Optional startDate/endDate filter on the spend date.',
  })
  @ApiQuery({ name: 'startDate', required: false })
  @ApiQuery({ name: 'endDate', required: false })
  async getReconditioningSpends(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const data = await this.service.getReconditioningSpends(startDate, endDate);
    return { message: 'Reconditioning spends', data };
  }

  @Get('profit-loss')
  @RequirePermission(AppModule.ACCOUNTING, PermissionAction.VIEW)
  @ApiOperation({ summary: 'Get P&L report', description: 'Monthly profit and loss breakdown for a date range.' })
  @ApiQuery({ name: 'startDate', required: true, description: 'ISO date e.g. 2024-01-01' })
  @ApiQuery({ name: 'endDate', required: true, description: 'ISO date e.g. 2024-12-31' })
  async getProfitLoss(@Query('startDate') startDate: string, @Query('endDate') endDate: string) {
    const data = await this.service.getProfitLoss(startDate, endDate);
    return { message: 'P&L report', data };
  }
}
