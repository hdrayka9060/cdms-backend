import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiConsumes,
  ApiPropertyOptional,
  ApiProperty,
} from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { DocumentTemplatesService } from './document-templates.service';
import { SignatureAnchor } from './schemas/document-template.schema';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AppModule, PermissionAction } from '../../common/permissions';

// Multipart fields arrive as strings; parsed in the service/controller.
class CreateTemplateDto {
  @ApiProperty() @IsString() name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() category?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() signaturePage?: string;
  @ApiPropertyOptional({ enum: SignatureAnchor }) @IsOptional() @IsString() signatureAnchor?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() requireSignerName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() isActive?: string;
}
class UpdateTemplateDto {
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() category?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() signaturePage?: string;
  @ApiPropertyOptional({ enum: SignatureAnchor }) @IsOptional() @IsString() signatureAnchor?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() requireSignerName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() isActive?: string;
}

const toBool = (v?: string): boolean | undefined =>
  v === undefined ? undefined : v === 'true' || v === '1';
const toNum = (v?: string): number | undefined => {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const toAnchor = (v?: string): SignatureAnchor | undefined =>
  v && (Object.values(SignatureAnchor) as string[]).includes(v) ? (v as SignatureAnchor) : undefined;

@ApiTags('Documents')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller({ path: 'documents/templates', version: '1' })
export class DocumentTemplatesController {
  constructor(private readonly service: DocumentTemplatesService) {}

  @Post()
  @RequirePermission(AppModule.SETTINGS, PermissionAction.EDIT)
  @UseInterceptors(
    FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Create a signable document template (PDF or image).' })
  async create(@Body() dto: CreateTemplateDto, @UploadedFile() file: Express.Multer.File, @CurrentUser() user: any) {
    if (!file) throw new BadRequestException('A template file is required.');
    const data = await this.service.create({
      name: dto.name,
      description: dto.description,
      category: dto.category,
      signaturePage: toNum(dto.signaturePage),
      signatureAnchor: toAnchor(dto.signatureAnchor),
      requireSignerName: toBool(dto.requireSignerName),
      isActive: toBool(dto.isActive),
      createdById: user?._id ? String(user._id) : undefined,
      createdByName: user ? `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() : '',
      file: {
        buffer: file.buffer,
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
      },
    });
    return { message: 'Template created', data };
  }

  @Get()
  @RequirePermission(AppModule.SETTINGS, PermissionAction.VIEW)
  @ApiOperation({ summary: 'List document templates.' })
  async findAll(@Query('includeInactive') includeInactive?: string) {
    const data = await this.service.findAll({ includeInactive: includeInactive === 'true' });
    return { message: 'Templates retrieved', data };
  }

  @Get(':id')
  @RequirePermission(AppModule.SETTINGS, PermissionAction.VIEW)
  @ApiParam({ name: 'id' })
  async findOne(@Param('id') id: string) {
    const data = await this.service.findById(id);
    return { message: 'Template', data };
  }

  @Patch(':id')
  @RequirePermission(AppModule.SETTINGS, PermissionAction.EDIT)
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Update template metadata (not the file).' })
  async update(@Param('id') id: string, @Body() dto: UpdateTemplateDto) {
    const data = await this.service.update(id, {
      name: dto.name,
      description: dto.description,
      category: dto.category,
      signaturePage: toNum(dto.signaturePage),
      signatureAnchor: toAnchor(dto.signatureAnchor),
      requireSignerName: toBool(dto.requireSignerName),
      isActive: toBool(dto.isActive),
    });
    return { message: 'Template updated', data };
  }

  @Delete(':id')
  @RequirePermission(AppModule.SETTINGS, PermissionAction.DELETE)
  @ApiParam({ name: 'id' })
  async remove(@Param('id') id: string) {
    const data = await this.service.remove(id);
    return { message: 'Template deleted', data };
  }
}
