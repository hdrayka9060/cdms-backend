import { Controller, Get, Patch, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { SettingsService } from './settings.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { AppModule, PermissionAction } from '../../common/permissions';

@ApiTags('Settings')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller({ path: 'settings', version: '1' })
export class SettingsController {
  constructor(private readonly service: SettingsService) {}

  @Get()
  @RequirePermission(AppModule.SETTINGS, PermissionAction.VIEW)
  @ApiOperation({ summary: 'Get dealership settings', description: 'Returns current dealership configuration including contact info, business hours, and notification preferences.' })
  @ApiResponse({ status: 200, description: 'Settings returned' })
  async get() {
    const settings = await this.service.get();
    return { message: 'Settings retrieved', data: settings };
  }

  @Patch()
  @RequirePermission(AppModule.SETTINGS, PermissionAction.EDIT)
  @ApiOperation({
    summary: 'Update dealership settings',
    description: `Admin only. Update any dealership settings fields.

**Updatable fields:**
- dealershipName, logo, address, city, state, zipCode, country, phone, email, website
- taxId, licenseNumber, currency, language, primaryColor
- businessHours (object with day keys)`,
  })
  @ApiResponse({ status: 200, description: 'Settings updated' })
  async update(@Body() dto: any) {
    const settings = await this.service.update(dto);
    return { message: 'Settings updated', data: settings };
  }

  @Patch('notifications')
  @RequirePermission(AppModule.SETTINGS, PermissionAction.EDIT)
  @ApiOperation({
    summary: 'Update notification preferences',
    description: `Admin only. Toggle notification channels.

**Body:** \`{ emailNotifications, smsNotifications, leadAlerts, paymentAlerts, supportAlerts }\` (all boolean)`,
  })
  @ApiResponse({ status: 200, description: 'Notifications updated' })
  async updateNotifications(@Body() dto: Record<string, boolean>) {
    const settings = await this.service.updateNotifications(dto);
    return { message: 'Notifications updated', data: settings };
  }
}
