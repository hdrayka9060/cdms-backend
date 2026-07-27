import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString, IsEnum, IsMongoId, IsNotEmpty, IsNumber, IsOptional, IsString, Min,
} from 'class-validator';
import { LeadChannel, LeadSource, LeadStatus } from '../schemas/lead.schema';
import { PaginationDto } from '../../../common/dto/pagination.dto';

const PAYMENT_METHODS = ['cash', 'finance', 'bhph', 'trade_in'] as const;
const PAYMENT_STATUSES = ['paid', 'partial', 'pending'] as const;

export class CreateLeadDto {
  @ApiProperty({ description: 'BuyerLead ObjectId' })
  @IsNotEmpty() @IsMongoId() buyer: string;

  @ApiProperty({ description: 'Vehicle ObjectId' })
  @IsNotEmpty() @IsMongoId() vehicle: string;

  @ApiProperty({ enum: LeadSource, example: LeadSource.WEBSITE })
  @IsEnum(LeadSource) source: LeadSource;

  @ApiPropertyOptional({ enum: LeadStatus, default: LeadStatus.NEW })
  @IsOptional() @IsEnum(LeadStatus) status?: LeadStatus;

  @ApiPropertyOptional({ description: 'Assigned staff User ObjectId' })
  @IsOptional() @IsMongoId() assignedTo?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;

  // ── Sale details (required only when creating a lead directly as CLOSED) ──
  // A lead can only be "closed" if the car is actually sold, so these capture
  // the sale the same way the /close endpoint does. Ignored for any other
  // initial status.
  @ApiPropertyOptional({ description: 'Realised sale price. Required when status=closed.' })
  @IsOptional() @IsNumber() @Min(0) soldAt?: number;

  @ApiPropertyOptional({ description: 'Amount paid. Required when paymentStatus=partial.' })
  @IsOptional() @IsNumber() @Min(0) amountPaid?: number;

  @ApiPropertyOptional({ enum: PAYMENT_METHODS })
  @IsOptional() @IsEnum(PAYMENT_METHODS) paymentMethod?: (typeof PAYMENT_METHODS)[number];

  @ApiPropertyOptional({ enum: PAYMENT_STATUSES })
  @IsOptional() @IsEnum(PAYMENT_STATUSES) paymentStatus?: (typeof PAYMENT_STATUSES)[number];

  @ApiPropertyOptional({ description: 'ISO sale date; defaults to today.' })
  @IsOptional() @IsDateString() saleDate?: string;
}

export class UpdateLeadDto {
  @ApiPropertyOptional({ enum: LeadStatus })
  @IsOptional() @IsEnum(LeadStatus) status?: LeadStatus;

  @ApiPropertyOptional({ description: 'Assigned staff User ObjectId' })
  @IsOptional() @IsMongoId() assignedTo?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;

  @ApiPropertyOptional({ description: 'Asked / negotiation price. Setting it auto-bumps status to negotiation.' })
  @IsOptional() @IsNumber() @Min(0) askedPrice?: number;

  @ApiPropertyOptional({ enum: LeadSource })
  @IsOptional() @IsEnum(LeadSource) source?: LeadSource;
}

export class LeadBookTestDriveDto {
  @ApiProperty({ description: 'ISO date-time for the test drive.' })
  @IsDateString() scheduledAt: string;

  @ApiPropertyOptional({ description: 'Staff member (User ObjectId) assigned.' })
  @IsOptional() @IsString() assignedTo?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class AddTimelineEntryDto {
  @ApiProperty({ example: 'Test drive scheduled' })
  @IsNotEmpty() @IsString() action: string;

  @ApiPropertyOptional({ description: 'Override the actor name (defaults to current user)' })
  @IsOptional() @IsString() by?: string;
}

export class AddLogEntryDto {
  @ApiProperty({ enum: LeadChannel })
  @IsEnum(LeadChannel) channel: LeadChannel;

  @ApiProperty({ example: 'Sent vehicle brochure' })
  @IsNotEmpty() @IsString() summary: string;

  @ApiPropertyOptional({ description: 'Vehicle ObjectId this interaction was about.' })
  @IsOptional() @IsString() vehicleId?: string;

  @ApiPropertyOptional({ description: 'User ObjectId of the staff member who performed the interaction.' })
  @IsOptional() @IsString() byStaffId?: string;

  @ApiPropertyOptional({ description: 'ISO timestamp; defaults to now.' })
  @IsOptional() @IsDateString() at?: string;
}

export class UpdateLogEntryDto {
  @ApiPropertyOptional({ enum: LeadChannel })
  @IsOptional() @IsEnum(LeadChannel) channel?: LeadChannel;

  @ApiPropertyOptional() @IsOptional() @IsString() summary?: string;

  @ApiPropertyOptional({ description: 'Vehicle ObjectId, or empty string / null to clear.' })
  @IsOptional() @IsString() vehicleId?: string | null;

  @ApiPropertyOptional({ description: 'User ObjectId of the staff member, or empty / null to clear.' })
  @IsOptional() @IsString() byStaffId?: string | null;

  @ApiPropertyOptional({ description: 'ISO timestamp.' })
  @IsOptional() @IsDateString() at?: string;
}

export class CloseLeadDto {
  @ApiProperty({ description: 'Realised sale price (after discount).' })
  @IsNumber() @Min(0) soldAt: number;

  @ApiPropertyOptional({ description: 'Required when paymentStatus is partial.' })
  @IsOptional() @IsNumber() @Min(0) amountPaid?: number;

  @ApiProperty({ enum: PAYMENT_METHODS })
  @IsEnum(PAYMENT_METHODS) paymentMethod: (typeof PAYMENT_METHODS)[number];

  @ApiProperty({ enum: PAYMENT_STATUSES })
  @IsEnum(PAYMENT_STATUSES) paymentStatus: (typeof PAYMENT_STATUSES)[number];

  @ApiPropertyOptional({ description: 'ISO date; defaults to today.' })
  @IsOptional() @IsDateString() saleDate?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class LeadQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: LeadStatus })
  @IsOptional() @IsEnum(LeadStatus) status?: LeadStatus;

  @ApiPropertyOptional({ enum: LeadSource })
  @IsOptional() @IsEnum(LeadSource) source?: LeadSource;

  @ApiPropertyOptional({ description: 'Filter by assigned staff User ObjectId' })
  @IsOptional() @IsMongoId() assignedTo?: string;

  @ApiPropertyOptional({ description: 'Filter by BuyerLead ObjectId' })
  @IsOptional() @IsMongoId() buyer?: string;

  @ApiPropertyOptional({ description: 'Filter by Vehicle ObjectId' })
  @IsOptional() @IsMongoId() vehicle?: string;
}
