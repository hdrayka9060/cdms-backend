import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { RecipientsService } from './recipients.service';
import { PushService } from './push.service';
import { NotificationsListener } from './notifications.listener';
import { Notification, NotificationSchema } from './schemas/notification.schema';
import { PushSubscription, PushSubscriptionSchema } from './schemas/push-subscription.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { Role, RoleSchema } from '../roles/schemas/role.schema';
import { MessagingModule } from '../messaging/messaging.module';

/**
 * Persistent per-user notifications. Reuses the Socket.io push channel from
 * MessagingModule (which now exports MessagingGateway) rather than standing up
 * a second WebSocket layer. Delivery is driven by the global EventEmitter2 bus
 * via NotificationsListener; MailModule is @Global so MailService injects freely.
 *
 * User + Role schemas are re-registered for-feature (Mongoose dedupes by name)
 * so the recipient resolver can query "users whose role grants module:action"
 * without importing UsersModule/RolesModule (avoids their auth-bound graphs).
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Notification.name, schema: NotificationSchema },
      { name: PushSubscription.name, schema: PushSubscriptionSchema },
      { name: User.name, schema: UserSchema },
      { name: Role.name, schema: RoleSchema },
    ]),
    MessagingModule,
  ],
  controllers: [NotificationsController],
  providers: [NotificationsService, RecipientsService, PushService, NotificationsListener],
  exports: [NotificationsService],
})
export class NotificationsModule {}
