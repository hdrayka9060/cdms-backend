import { Body, Controller, Get, Headers, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { PushService } from './push.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

/**
 * Per-user notifications. No `@RequirePermission` — every authenticated user
 * has a personal inbox and only ever sees their OWN rows (scoped by user id
 * from the JWT). The global PermissionsGuard is a no-op without the decorator.
 */
@ApiTags('Notifications')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller({ path: 'notifications', version: '1' })
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly push: PushService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List my notifications (newest first, cursor-paginated)' })
  @ApiResponse({ status: 200, description: '{ items, nextCursor, unreadCount }' })
  async list(
    @CurrentUser() user: any,
    @Query('unreadOnly') unreadOnly?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const data = await this.notifications.list(user._id.toString(), {
      unreadOnly: unreadOnly === 'true' || unreadOnly === '1',
      limit: limit ? parseInt(limit, 10) : undefined,
      cursor,
    });
    return { message: 'Notifications retrieved', data };
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'My unread notification count (bell badge)' })
  async unreadCount(@CurrentUser() user: any) {
    const total = await this.notifications.unreadCount(user._id.toString());
    return { message: 'Unread count', data: { total } };
  }

  @Patch('read')
  @ApiOperation({ summary: 'Mark notifications read — { ids: [...] } or { all: true }' })
  async markRead(@CurrentUser() user: any, @Body() body: { ids?: string[]; all?: boolean }) {
    const data = await this.notifications.markRead(user._id.toString(), {
      ids: body?.ids,
      all: !!body?.all,
    });
    return { message: 'Marked read', data };
  }

  @Get('prefs')
  @ApiOperation({ summary: 'My per-category notification preferences (in-app / email)' })
  async getPrefs(@CurrentUser() user: any) {
    const data = await this.notifications.getPrefs(user._id.toString());
    return { message: 'Preferences', data };
  }

  @Patch('prefs')
  @ApiOperation({ summary: 'Update my per-category notification preferences' })
  async setPrefs(
    @CurrentUser() user: any,
    @Body() body: Record<string, { inApp?: boolean; email?: boolean; push?: boolean }>,
  ) {
    const data = await this.notifications.setPrefs(user._id.toString(), body ?? {});
    return { message: 'Preferences updated', data };
  }

  // ── Web Push (OS notifications when the app is closed) ─────────────────────
  @Get('push/public-key')
  @ApiOperation({ summary: 'VAPID public key + whether push is enabled on this server' })
  async pushPublicKey() {
    return {
      message: 'Push config',
      data: { enabled: this.push.isEnabled(), publicKey: this.push.getPublicKey() },
    };
  }

  @Post('push/subscribe')
  @ApiOperation({ summary: 'Register this device for OS push notifications' })
  async pushSubscribe(
    @CurrentUser() user: any,
    @Body() sub: { endpoint: string; keys: { p256dh: string; auth: string } },
    @Headers('user-agent') userAgent?: string,
  ) {
    await this.push.saveSubscription(user._id.toString(), sub, userAgent ?? '');
    return { message: 'Subscribed', data: { ok: true } };
  }

  @Post('push/unsubscribe')
  @ApiOperation({ summary: 'Unregister this device from OS push notifications' })
  async pushUnsubscribe(@CurrentUser() user: any, @Body() body: { endpoint: string }) {
    await this.push.removeSubscription(user._id.toString(), body?.endpoint ?? '');
    return { message: 'Unsubscribed', data: { ok: true } };
  }
}
