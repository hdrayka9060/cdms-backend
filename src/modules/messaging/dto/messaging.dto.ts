import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty, IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsMongoId, IsNotEmpty,
  IsOptional, IsString, MaxLength, Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ConversationType } from '../schemas/conversation.schema';

export class CreateConversationDto {
  @ApiProperty({ enum: ConversationType }) @IsEnum(ConversationType) type: ConversationType;

  /**
   * Other participants (the creator is added automatically).
   * direct → exactly one id; group → one or more.
   */
  @ApiProperty({ type: [String] })
  @IsArray() @ArrayNotEmpty() @IsMongoId({ each: true }) participantIds: string[];

  @ApiPropertyOptional({ description: 'Group name (required for groups).' })
  @IsOptional() @IsString() @MaxLength(120) name?: string;

  @ApiPropertyOptional({ description: 'Group description.' })
  @IsOptional() @IsString() @MaxLength(2000) description?: string;

  @ApiPropertyOptional({ description: 'Whether members added later see prior history (default true).' })
  @IsOptional() @IsBoolean() shareHistoryWithNewMembers?: boolean;
}

export class UpdateGroupDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @ApiPropertyOptional({ description: 'Toggle whether NEWLY-added members see prior history (existing members unaffected).' })
  @IsOptional() @IsBoolean() shareHistoryWithNewMembers?: boolean;
}

export class AddParticipantsDto {
  @ApiProperty({ type: [String] })
  @IsArray() @ArrayNotEmpty() @IsMongoId({ each: true }) userIds: string[];
}

export class SetParticipantRoleDto {
  @ApiProperty({ enum: ['admin', 'member'] })
  @IsIn(['admin', 'member']) role: 'admin' | 'member';
}

export class SendMessageDto {
  // Optional because a message may be attachments-only. The service rejects a
  // message that has neither body nor files.
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(8000) body?: string;
}

export class EditMessageDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(8000) body: string;
}

export class ListMessagesDto {
  @ApiPropertyOptional({ description: 'ISO timestamp; returns messages older than this (keyset pagination).' })
  @IsOptional() @IsString() before?: string;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit?: number;
}
