import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray, IsDateString, IsEnum, IsInt, IsNumber, IsOptional, IsString, Min, Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { LoanStatus } from '../schemas/loan.schema';

/**
 * Create a BHPH loan. Deliberately permissive so it stays a superset of what
 * the current frontend already sends (borrower* + vehicle + principal + rate +
 * term) while also accepting the richer model (lead/buyer resolution, down
 * payment, and any-2-of-3 EMI inputs). Cross-field rules (exactly 2 of
 * rate/term/emi, buyer resolution) are enforced in the service.
 */
export class CreateLoanDto {
  // ── Borrower (optional here: may be resolved from a lead/buyer instead) ──
  @ApiPropertyOptional() @IsOptional() @IsString() borrowerName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() borrowerEmail?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() borrowerPhone?: string;

  // ── Resolution sources ──
  @ApiPropertyOptional({ description: 'Originating lead id — auto-fills buyer + vehicle.' })
  @IsOptional() @IsString() leadId?: string;
  @ApiPropertyOptional({ description: 'CRM buyer id to attach the loan to.' })
  @IsOptional() @IsString() buyerLeadId?: string;
  @ApiPropertyOptional({ description: 'Create a new CRM buyer inline (with newBuyerEmail/Phone).' })
  @IsOptional() @IsString() newBuyerName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() newBuyerEmail?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() newBuyerPhone?: string;

  // ── Vehicle (accept both `vehicle` and `vehicleId` spellings) ──
  @ApiPropertyOptional({ description: 'Vehicle ObjectId (current frontend key).' })
  @IsOptional() @IsString() vehicle?: string;
  @ApiPropertyOptional({ description: 'Vehicle ObjectId (alias of `vehicle`).' })
  @IsOptional() @IsString() vehicleId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() vehicleTitle?: string;

  // ── Money ──
  @ApiPropertyOptional({ description: 'Agreed car price. When set, principal = salePrice − downPayment.' })
  @IsOptional() @IsNumber() @Min(0) salePrice?: number;
  @ApiPropertyOptional({ description: 'Down payment (paid upfront); the rest is financed.' })
  @IsOptional() @IsNumber() @Min(0) downPayment?: number;
  @ApiPropertyOptional({ description: 'Financed amount. Optional when salePrice/downPayment are given.' })
  @IsOptional() @IsNumber() @Min(0) principal?: number;

  // ── EMI trio (supply any two) ──
  @ApiPropertyOptional({ description: 'Annual interest rate %.' })
  @IsOptional() @IsNumber() @Min(0) @Max(100) interestRatePercent?: number;
  @ApiPropertyOptional({ description: 'Term in months.' })
  @IsOptional() @IsInt() @Min(1) termMonths?: number;
  @ApiPropertyOptional({ description: 'Monthly EMI amount.' })
  @IsOptional() @IsNumber() @Min(0) emiAmount?: number;

  @ApiPropertyOptional({ description: 'ISO start date; defaults to today.' })
  @IsOptional() @IsDateString() startDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

/** Preview the solved EMI trio without persisting. */
export class PreviewEmiDto {
  @ApiPropertyOptional({ description: 'Financed amount. Falls back to salePrice − downPayment.' })
  @IsOptional() @IsNumber() @Min(0) principal?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) salePrice?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) downPayment?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) @Max(100) interestRatePercent?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) termMonths?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) emiAmount?: number;
}

export class RecordPaymentDto {
  @ApiProperty({ description: 'Payment amount.' })
  @IsNumber() @Min(0) amount: number;
  @ApiPropertyOptional({ description: 'cash | bank_transfer | cheque | …' })
  @IsOptional() @IsString() method?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() receiptNumber?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  @ApiPropertyOptional({ description: 'ISO date; defaults to now.' })
  @IsOptional() @IsDateString() date?: string;
  @ApiPropertyOptional({ description: 'Installment month this payment pays toward (1-based).' })
  @IsOptional() @IsInt() @Min(1) installmentNo?: number;
}

export class UpdatePaymentDto {
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) amount?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() method?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() receiptNumber?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() date?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) installmentNo?: number;
}

export class BulkMarkPaidDto {
  @ApiProperty({ type: [Number], description: 'Installment numbers to mark paid.' })
  @IsArray() @IsInt({ each: true }) @Min(1, { each: true }) installmentNos: number[];
  @ApiPropertyOptional({ description: 'cash | bank_transfer | cheque | …' })
  @IsOptional() @IsString() method?: string;
  @ApiPropertyOptional({ description: 'ISO date; defaults to now.' })
  @IsOptional() @IsDateString() date?: string;
}

/** Edit loan terms. Re-solves EMI + re-syncs the linked sale/income (Phase 5). */
export class UpdateLoanDto {
  @ApiPropertyOptional() @IsOptional() @IsString() borrowerName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() borrowerEmail?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() borrowerPhone?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) salePrice?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) downPayment?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) principal?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) @Max(100) interestRatePercent?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) termMonths?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) emiAmount?: number;
  @ApiPropertyOptional() @IsOptional() @IsDateString() startDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class LoanQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: LoanStatus })
  @IsOptional() @IsEnum(LoanStatus) status?: LoanStatus;
}
