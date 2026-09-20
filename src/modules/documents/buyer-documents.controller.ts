import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  Req,
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
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import { IsArray, IsOptional, IsString } from 'class-validator';
import { BuyerDocumentsService } from './buyer-documents.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AppModule, PermissionAction } from '../../common/permissions';

class UploadDocDto {
  @ApiProperty() @IsString() buyerLeadId: string;
  @ApiPropertyOptional() @IsOptional() @IsString() title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() docType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() leadId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() vehicleId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}
class FromTemplateDto {
  @ApiProperty() @IsString() buyerLeadId: string;
  @ApiProperty() @IsString() templateId: string;
  @ApiPropertyOptional() @IsOptional() @IsString() title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() leadId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() vehicleId?: string;
}
class UploadSignableDto {
  @ApiProperty() @IsString() buyerLeadId: string;
  @ApiPropertyOptional() @IsOptional() @IsString() title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() leadId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() vehicleId?: string;
  @ApiPropertyOptional({ description: "'true' to also save the file as a reusable template." })
  @IsOptional() @IsString() saveAsTemplate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() templateName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() category?: string;
}
class SignDto {
  @ApiPropertyOptional({ description: 'Legacy single signature PNG (base64). Prefer `placements`.' })
  @IsOptional()
  @IsString()
  signatureImage?: string;
  @ApiPropertyOptional({
    description: 'Signatures the signer placed: [{ page, x, y, width, signatureImage }] with normalized (0..1) center coords.',
    isArray: true,
  })
  @IsOptional()
  @IsArray()
  placements?: { page?: number; x?: number; y?: number; width?: number; signatureImage: string }[];
  @ApiPropertyOptional() @IsOptional() @IsString() signerName?: string;
}

const actorName = (user: any): string =>
  user ? `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() : '';

@ApiTags('Documents')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller({ path: 'documents', version: '1' })
export class BuyerDocumentsController {
  constructor(private readonly service: BuyerDocumentsService) {}

  @Get()
  @RequirePermission(AppModule.CRM_BUYERS, PermissionAction.VIEW)
  @ApiOperation({ summary: 'List buyer documents (filter by buyerLeadId and/or leadId).' })
  async findAll(@Query() query: { buyerLeadId?: string; leadId?: string; status?: string }) {
    const data = await this.service.findAll(query || {});
    return { message: 'Documents retrieved', data };
  }

  @Post('upload')
  @RequirePermission(AppModule.CRM_BUYERS, PermissionAction.EDIT)
  @UseInterceptors(
    FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a plain buyer document (license, insurance, etc.).' })
  async upload(@Body() dto: UploadDocDto, @UploadedFile() file: Express.Multer.File, @CurrentUser() user: any) {
    if (!file) throw new BadRequestException('A file is required.');
    const data = await this.service.uploadPlain({
      buyerLeadId: dto.buyerLeadId,
      title: dto.title || file.originalname,
      docType: dto.docType,
      leadId: dto.leadId,
      vehicleId: dto.vehicleId,
      notes: dto.notes,
      uploadedById: user?._id ? String(user._id) : undefined,
      uploadedByName: actorName(user),
      file: {
        buffer: file.buffer,
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
      },
    });
    return { message: 'Document uploaded', data };
  }

  @Post('from-template')
  @RequirePermission(AppModule.CRM_BUYERS, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Create a pending signable document for a buyer from a template.' })
  async fromTemplate(@Body() dto: FromTemplateDto, @CurrentUser() user: any) {
    const data = await this.service.createFromTemplate({
      buyerLeadId: dto.buyerLeadId,
      templateId: dto.templateId,
      title: dto.title,
      leadId: dto.leadId,
      vehicleId: dto.vehicleId,
      uploadedById: user?._id ? String(user._id) : undefined,
      uploadedByName: actorName(user),
    });
    return { message: 'Signable document created', data };
  }

  @Post('upload-signable')
  @RequirePermission(AppModule.CRM_BUYERS, PermissionAction.EDIT)
  @UseInterceptors(
    FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a NEW document to sign (one-off, or saveAsTemplate=true to also make it reusable).' })
  async uploadSignable(@Body() dto: UploadSignableDto, @UploadedFile() file: Express.Multer.File, @CurrentUser() user: any) {
    if (!file) throw new BadRequestException('A file is required.');
    const data = await this.service.uploadSignable({
      buyerLeadId: dto.buyerLeadId,
      title: dto.title,
      leadId: dto.leadId,
      vehicleId: dto.vehicleId,
      saveAsTemplate: dto.saveAsTemplate === 'true',
      templateName: dto.templateName,
      category: dto.category,
      uploadedById: user?._id ? String(user._id) : undefined,
      uploadedByName: actorName(user),
      file: { buffer: file.buffer, originalname: file.originalname, mimetype: file.mimetype, size: file.size },
    });
    return { message: 'Signable document created', data };
  }

  @Post(':id/sign')
  @RequirePermission(AppModule.CRM_BUYERS, PermissionAction.EDIT)
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Sign a document (stamps the signature into the file).' })
  async sign(@Param('id') id: string, @Body() dto: SignDto, @Req() req: any, @CurrentUser() user: any) {
    const data = await this.service.sign(id, {
      placements: dto.placements,
      signatureImage: dto.signatureImage,
      signerName: dto.signerName,
      staffId: user?._id ? String(user._id) : undefined,
      staffName: actorName(user),
      ipAddress: (req.headers['x-forwarded-for'] as string) || req.ip || '',
      userAgent: (req.headers['user-agent'] as string) || '',
    });
    return { message: 'Document signed', data };
  }

  @Post(':id/void')
  @RequirePermission(AppModule.CRM_BUYERS, PermissionAction.EDIT)
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Void a signable document.' })
  async voidDoc(@Param('id') id: string) {
    const data = await this.service.voidDoc(id);
    return { message: 'Document voided', data };
  }

  @Get(':id')
  @RequirePermission(AppModule.CRM_BUYERS, PermissionAction.VIEW)
  @ApiParam({ name: 'id' })
  async findOne(@Param('id') id: string) {
    const data = await this.service.findById(id);
    return { message: 'Document', data };
  }

  @Delete(':id')
  @RequirePermission(AppModule.CRM_BUYERS, PermissionAction.DELETE)
  @ApiParam({ name: 'id' })
  async remove(@Param('id') id: string) {
    const data = await this.service.remove(id);
    return { message: 'Document deleted', data };
  }
}
