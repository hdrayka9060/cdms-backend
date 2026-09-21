import { Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { BhphService } from './bhph.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { AppModule, PermissionAction } from '../../common/permissions';
import { LoanStatus } from './schemas/loan.schema';
import { PaginationDto } from '../../common/dto/pagination.dto';
import {
  BulkMarkPaidDto, CloseLoanDto, CreateLoanDto, LoanQueryDto, PreviewEmiDto, RecordPaymentDto, UpdateLoanDto, UpdatePaymentDto,
} from './dto/loan.dto';

@ApiTags('BHPH')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller({ path: 'bhph', version: '1' })
export class BhphController {
  constructor(private readonly service: BhphService) {}

  @Post('loans')
  @RequirePermission(AppModule.BHPH, PermissionAction.EDIT)
  @ApiOperation({
    summary: 'Create a BHPH loan',
    description: `Creates a new dealer-financed loan with auto-calculated EMI.

**Required body fields:**
- borrowerName, borrowerEmail, borrowerPhone
- vehicleTitle, vehicle (vehicleId)
- principal (loan amount), interestRatePercent, termMonths, startDate`,
  })
  @ApiResponse({ status: 201, description: 'Loan created with EMI calculated' })
  async create(@Body() dto: CreateLoanDto) {
    const loan = await this.service.create(dto);
    return { message: 'Loan created', data: loan };
  }

  @Post('preview-emi')
  @RequirePermission(AppModule.BHPH, PermissionAction.VIEW)
  @ApiOperation({
    summary: 'Preview solved EMI',
    description: 'Given the principal (or salePrice − downPayment) and any TWO of {interestRatePercent, termMonths, emiAmount}, returns the full solved trio. Does not persist anything.',
  })
  async previewEmi(@Body() dto: PreviewEmiDto) {
    const data = this.service.previewEmi(dto);
    return { message: 'EMI preview', data };
  }

  @Get('loans')
  @RequirePermission(AppModule.BHPH, PermissionAction.VIEW)
  @ApiOperation({ summary: 'List all BHPH loans', description: 'Paginated loans. Filter by status: active | paid_off | defaulted | closed | archived.' })
  @ApiQuery({ name: 'status', enum: LoanStatus, required: false })
  async findAll(@Query() query: LoanQueryDto) {
    const result = await this.service.findAll(query);
    return { message: 'Loans retrieved', data: result };
  }

  @Get('summary')
  @RequirePermission(AppModule.BHPH, PermissionAction.VIEW)
  @ApiOperation({ summary: 'BHPH portfolio summary', description: 'Returns totals per loan status — active, paid off, defaulted.' })
  async getSummary() {
    const data = await this.service.getLoanSummary();
    return { message: 'BHPH summary', data };
  }

  @Get('loans/:id')
  @RequirePermission(AppModule.BHPH, PermissionAction.VIEW)
  @ApiOperation({ summary: 'Get loan detail + EMI schedule', description: 'Returns full loan details and the complete amortization schedule.' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Returns { loan, schedule }' })
  @ApiResponse({ status: 404, description: 'Loan not found' })
  async findOne(@Param('id') id: string) {
    const result = await this.service.findById(id);
    return { message: 'Loan retrieved', data: result };
  }

  @Post('loans/:id/payment')
  @RequirePermission(AppModule.BHPH, PermissionAction.EDIT)
  @ApiOperation({
    summary: 'Record EMI payment',
    description: `Records an installment payment against a loan.

**Body fields:**
- amount (number, required)
- method (cash | bank_transfer | cheque)
- notes (optional)
- receiptNumber (optional)`,
  })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 201, description: 'Payment recorded' })
  async recordPayment(@Param('id') id: string, @Body() dto: RecordPaymentDto) {
    const loan = await this.service.recordPayment(id, dto);
    return { message: 'Payment recorded', data: loan };
  }

  @Get('loans/:id/payments')
  @RequirePermission(AppModule.BHPH, PermissionAction.VIEW)
  @ApiOperation({ summary: 'Paginated payment history', description: 'Payments for a loan, newest first.' })
  @ApiParam({ name: 'id' })
  async getPayments(@Param('id') id: string, @Query() query: PaginationDto) {
    const data = await this.service.getPayments(id, query);
    return { message: 'Payments retrieved', data };
  }

  @Post('loans/:id/payments/bulk-pay')
  @RequirePermission(AppModule.BHPH, PermissionAction.EDIT)
  @ApiOperation({
    summary: 'Bulk-mark installments paid',
    description: 'Creates a payment for the outstanding amount on each listed installment (skips ones already paid).',
  })
  @ApiParam({ name: 'id' })
  async bulkMarkPaid(@Param('id') id: string, @Body() dto: BulkMarkPaidDto) {
    const loan = await this.service.bulkMarkPaid(id, dto);
    return { message: 'Installments marked paid', data: loan };
  }

  @Patch('loans/:id/payments/:paymentId')
  @RequirePermission(AppModule.BHPH, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Edit a recorded payment' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'paymentId' })
  async updatePayment(
    @Param('id') id: string,
    @Param('paymentId') paymentId: string,
    @Body() dto: UpdatePaymentDto,
  ) {
    const loan = await this.service.updatePayment(id, paymentId, dto);
    return { message: 'Payment updated', data: loan };
  }

  @Delete('loans/:id/payments/:paymentId')
  @RequirePermission(AppModule.BHPH, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Delete a recorded payment (undo)' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'paymentId' })
  async deletePayment(@Param('id') id: string, @Param('paymentId') paymentId: string) {
    const loan = await this.service.deletePayment(id, paymentId);
    return { message: 'Payment deleted', data: loan };
  }

  @Post('loans/:id/installments/:no/unpay')
  @RequirePermission(AppModule.BHPH, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Mark an installment unpaid', description: 'Removes every payment allocated to the installment.' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'no', description: 'Installment number (1-based)' })
  async unpayInstallment(@Param('id') id: string, @Param('no') no: string) {
    const loan = await this.service.unpayInstallment(id, Number(no));
    return { message: 'Installment marked unpaid', data: loan };
  }

  @Patch('loans/:id')
  @RequirePermission(AppModule.BHPH, PermissionAction.EDIT)
  @ApiOperation({
    summary: 'Update loan terms',
    description: 'Edit borrower, sale price, down payment, rate/term/EMI (re-solved), start date or notes. Re-syncs the linked sale + interest income.',
  })
  @ApiParam({ name: 'id' })
  async update(@Param('id') id: string, @Body() dto: UpdateLoanDto) {
    const loan = await this.service.update(id, dto);
    return { message: 'Loan updated', data: loan };
  }

  @Post('loans/:id/close')
  @RequirePermission(AppModule.BHPH, PermissionAction.EDIT)
  @ApiOperation({
    summary: 'Close a loan',
    description:
      "outcome 'payoff' → settle remaining principal (future interest waived) + optional earlyClosureFee, status paid_off; " +
      "outcome 'defaulted' → keep collected money, stop reminders, status defaulted; " +
      'otherwise → legacy close (sale + interest kept booked).',
  })
  @ApiParam({ name: 'id' })
  async close(@Param('id') id: string, @Body() dto: CloseLoanDto) {
    const loan = await this.service.close(id, dto);
    return { message: 'Loan closed', data: loan };
  }

  @Post('reminders/run')
  @RequirePermission(AppModule.BHPH, PermissionAction.EDIT)
  @ApiOperation({
    summary: 'Run BHPH due/overdue reminders now',
    description: 'Manually trigger the daily reminder scan. Optional query: loanId (scope one loan), dueWindowDays (default 3).',
  })
  @ApiQuery({ name: 'loanId', required: false })
  @ApiQuery({ name: 'dueWindowDays', required: false })
  async runReminders(@Query('loanId') loanId?: string, @Query('dueWindowDays') dueWindowDays?: string) {
    const data = await this.service.sendDuePaymentReminders({
      loanId,
      dueWindowDays: dueWindowDays !== undefined ? Number(dueWindowDays) : undefined,
    });
    return { message: 'BHPH reminders run', data };
  }

  @Post('loans/:id/archive')
  @RequirePermission(AppModule.BHPH, PermissionAction.DELETE)
  @ApiOperation({
    summary: 'Archive a loan (terminal)',
    description: 'Irreversible: un-sells the car, reverses the linked sale + buyer purchase, and removes the loan\'s interest income from all financials. Not recoverable.',
  })
  @ApiParam({ name: 'id' })
  async archive(@Param('id') id: string) {
    const loan = await this.service.archive(id);
    return { message: 'Loan archived', data: loan };
  }
}
