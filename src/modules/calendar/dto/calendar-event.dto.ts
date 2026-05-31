import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import {
  EventStatus,
  EventType,
  MeetingType,
  ParticipantStatus,
  ParticipantType,
} from '../schemas/calendar-event.schema';

/**
 * Typed DTOs for the calendar module. The previous version used `dto: any`
 * which bypassed ValidationPipe entirely; this hard-types the wire shape and
 * matches the schema enums.
 */

export class ParticipantInputDto {
  @ApiProperty({ enum: ParticipantType, example: ParticipantType.STAFF })
  @IsEnum(ParticipantType)
  userType: ParticipantType;

  /** Optional — empty for ad-hoc email-only invitees. */
  @ApiPropertyOptional({ description: 'MongoDB ObjectId of the linked CRM record' })
  @IsOptional()
  @IsMongoId()
  userId?: string;

  @ApiProperty({ example: 'Jane Doe' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({ example: 'jane@example.com' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ enum: ParticipantStatus })
  @IsOptional()
  @IsEnum(ParticipantStatus)
  status?: ParticipantStatus;
}

export class CreateCalendarEventDto {
  @ApiProperty() @IsString() @IsNotEmpty() title: string;

  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;

  @ApiProperty({ description: 'ISO datetime' })
  @IsDateString()
  startDateTime: string;

  @ApiProperty({ description: 'ISO datetime' })
  @IsDateString()
  endDateTime: string;

  @ApiProperty({ enum: EventType })
  @IsEnum(EventType)
  eventType: EventType;

  @ApiPropertyOptional({ enum: EventStatus })
  @IsOptional()
  @IsEnum(EventStatus)
  status?: EventStatus;

  /** Defaults to PHYSICAL on the schema if omitted. */
  @ApiPropertyOptional({ enum: MeetingType })
  @IsOptional()
  @IsEnum(MeetingType)
  meetingType?: MeetingType;

  /**
   * When `true`, the service auto-generates a Google Meet link and stores
   * it on the event. Ignored if `meetingType !== VIRTUAL`.
   */
  @ApiPropertyOptional({ description: 'Generate a Google Meet link' })
  @IsOptional()
  @IsBoolean()
  createMeetLink?: boolean;

  @ApiPropertyOptional() @IsOptional() @IsMongoId() assignedTo?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() customerName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() customerPhone?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() customerEmail?: string;

  @ApiPropertyOptional() @IsOptional() @IsMongoId() vehicle?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() location?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() meetLink?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;

  @ApiPropertyOptional({ type: [ParticipantInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ParticipantInputDto)
  participants?: ParticipantInputDto[];
}

/**
 * Update DTO mirrors create but every field is optional. We deliberately
 * don't extend via `PartialType` because Swagger's PartialType helper has
 * caused subtle decorator-stripping issues in this project before.
 */
export class UpdateCalendarEventDto {
  @ApiPropertyOptional() @IsOptional() @IsString() title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() startDateTime?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() endDateTime?: string;
  @ApiPropertyOptional({ enum: EventType }) @IsOptional() @IsEnum(EventType) eventType?: EventType;
  @ApiPropertyOptional({ enum: EventStatus }) @IsOptional() @IsEnum(EventStatus) status?: EventStatus;
  @ApiPropertyOptional({ enum: MeetingType }) @IsOptional() @IsEnum(MeetingType) meetingType?: MeetingType;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() createMeetLink?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsMongoId() assignedTo?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() customerName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() customerPhone?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() customerEmail?: string;
  @ApiPropertyOptional() @IsOptional() @IsMongoId() vehicle?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() location?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() meetLink?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;

  @ApiPropertyOptional({ type: [ParticipantInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ParticipantInputDto)
  participants?: ParticipantInputDto[];
}
