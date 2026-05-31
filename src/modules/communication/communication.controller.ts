import { Controller, Get, Post, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { CommunicationService } from './communication.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { AppModule, PermissionAction } from '../../common/permissions';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CommChannel } from './schemas/communication-log.schema';

@ApiTags('Communication')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller({ path: 'communication', version: '1' })
export class CommunicationController {
  constructor(private readonly service: CommunicationService) {}

  @Get('logs')
  @RequirePermission(AppModule.COMMUNICATION, PermissionAction.VIEW)
  @ApiOperation({ summary: 'Get all communication logs', description: 'Paginated list of all communication events across channels.' })
  @ApiQuery({ name: 'channel', enum: CommChannel, required: false })
  @ApiQuery({ name: 'linkedVehicle', required: false, description: 'Filter by vehicle ID' })
  async findAll(@Query() query: any) {
    const result = await this.service.findAll(query);
    return { message: 'Communication logs', data: result };
  }

  @Get('stats')
  @RequirePermission(AppModule.COMMUNICATION, PermissionAction.VIEW)
  @ApiOperation({ summary: 'Channel statistics', description: 'Count of communications per channel with last sent timestamp.' })
  async getStats() {
    const data = await this.service.getChannelStats();
    return { message: 'Channel stats', data };
  }

  @Post('email')
  @RequirePermission(AppModule.COMMUNICATION, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Send email', description: 'Logs and (mock) sends an email. Required: recipientName, recipientContact (email), subject, message.' })
  @ApiResponse({ status: 201, description: 'Email sent and logged' })
  async sendEmail(@Body() dto: any, @CurrentUser() user: any) {
    const log = await this.service.logAndSend({ ...dto, channel: 'email' }, user._id);
    return { message: 'Email sent', data: log };
  }

  @Post('sms')
  @RequirePermission(AppModule.COMMUNICATION, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Send SMS', description: 'Logs and (mock) sends an SMS. Required: recipientName, recipientContact (phone), subject, message.' })
  @ApiResponse({ status: 201, description: 'SMS sent and logged' })
  async sendSms(@Body() dto: any, @CurrentUser() user: any) {
    const log = await this.service.logAndSend({ ...dto, channel: 'sms' }, user._id);
    return { message: 'SMS sent', data: log };
  }

  @Post('whatsapp')
  @RequirePermission(AppModule.COMMUNICATION, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Send WhatsApp message', description: 'Logs and (mock) sends a WhatsApp message.' })
  @ApiResponse({ status: 201, description: 'WhatsApp message sent and logged' })
  async sendWhatsApp(@Body() dto: any, @CurrentUser() user: any) {
    const log = await this.service.logAndSend({ ...dto, channel: 'whatsapp' }, user._id);
    return { message: 'WhatsApp message sent', data: log };
  }

  @Post('call')
  @RequirePermission(AppModule.COMMUNICATION, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Log a call', description: 'Logs a call interaction. Include callDurationSeconds in body.' })
  @ApiResponse({ status: 201, description: 'Call logged' })
  async logCall(@Body() dto: any, @CurrentUser() user: any) {
    const log = await this.service.logAndSend({ ...dto, channel: 'call' }, user._id);
    return { message: 'Call logged', data: log };
  }
}
