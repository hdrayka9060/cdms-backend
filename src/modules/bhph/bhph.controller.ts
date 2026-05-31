import { Controller, Get, Post, Body, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { BhphService } from './bhph.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { AppModule, PermissionAction } from '../../common/permissions';
import { LoanStatus } from './schemas/loan.schema';

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
  async create(@Body() dto: any) {
    const loan = await this.service.create(dto);
    return { message: 'Loan created', data: loan };
  }

  @Get('loans')
  @RequirePermission(AppModule.BHPH, PermissionAction.VIEW)
  @ApiOperation({ summary: 'List all BHPH loans', description: 'Paginated loans. Filter by status: active | paid_off | defaulted.' })
  @ApiQuery({ name: 'status', enum: LoanStatus, required: false })
  async findAll(@Query() query: any) {
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
  async recordPayment(@Param('id') id: string, @Body() dto: any) {
    const loan = await this.service.recordPayment(id, dto);
    return { message: 'Payment recorded', data: loan };
  }
}
