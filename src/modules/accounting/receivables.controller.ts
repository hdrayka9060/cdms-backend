import { Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiParam } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, IsDateString, Min } from 'class-validator';
import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { ReceivablesService } from './receivables.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { AppModule, PermissionAction } from '../../common/permissions';

class ReceivablePaymentDto {
  @ApiProperty() @IsNumber() @Min(0) amount: number;
  @ApiPropertyOptional() @IsOptional() @IsString() method?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() receiptNumber?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() date?: string;
}
class UpdateReceivablePaymentDto {
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) amount?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() method?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() receiptNumber?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() date?: string;
}

@ApiTags('BHPH')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller({ path: 'receivables', version: '1' })
export class ReceivablesController {
  constructor(private readonly service: ReceivablesService) {}

  @Get()
  @RequirePermission(AppModule.BHPH, PermissionAction.VIEW)
  @ApiOperation({ summary: 'List open-balance receivables', description: 'Partial/unpaid non-BHPH sales tracked as receivables. Filter by status: open | settled | archived.' })
  async findAll(@Query() query: any) {
    const data = await this.service.findAll(query);
    return { message: 'Receivables retrieved', data };
  }

  @Get('by-sale/:saleId')
  @RequirePermission(AppModule.BHPH, PermissionAction.VIEW)
  @ApiParam({ name: 'saleId' })
  @ApiOperation({ summary: 'Get the live receivable for a sale (Vehicle/Lead detail).' })
  async findBySale(@Param('saleId') saleId: string) {
    const data = await this.service.findBySale(saleId);
    return { message: 'Receivable', data };
  }

  @Get(':id')
  @RequirePermission(AppModule.BHPH, PermissionAction.VIEW)
  @ApiParam({ name: 'id' })
  async findOne(@Param('id') id: string) {
    const data = await this.service.findById(id);
    return { message: 'Receivable', data };
  }

  @Post(':id/payment')
  @RequirePermission(AppModule.BHPH, PermissionAction.EDIT)
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Record a payment against a receivable (bumps the linked sale).' })
  async recordPayment(@Param('id') id: string, @Body() dto: ReceivablePaymentDto) {
    const data = await this.service.recordPayment(id, dto);
    return { message: 'Payment recorded', data };
  }

  @Patch(':id/payments/:paymentId')
  @RequirePermission(AppModule.BHPH, PermissionAction.EDIT)
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'paymentId' })
  async updatePayment(@Param('id') id: string, @Param('paymentId') paymentId: string, @Body() dto: UpdateReceivablePaymentDto) {
    const data = await this.service.updatePayment(id, paymentId, dto);
    return { message: 'Payment updated', data };
  }

  @Delete(':id/payments/:paymentId')
  @RequirePermission(AppModule.BHPH, PermissionAction.EDIT)
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'paymentId' })
  async deletePayment(@Param('id') id: string, @Param('paymentId') paymentId: string) {
    const data = await this.service.deletePayment(id, paymentId);
    return { message: 'Payment deleted', data };
  }
}
