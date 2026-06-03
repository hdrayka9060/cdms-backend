import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { MessagingController } from './messaging.controller';
import { MessagingService } from './messaging.service';
import { MessagingGateway } from './messaging.gateway';
import { Conversation, ConversationSchema } from './schemas/conversation.schema';
import { Message, MessageSchema } from './schemas/message.schema';
import { User, UserSchema } from '../users/schemas/user.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Conversation.name, schema: ConversationSchema },
      { name: Message.name, schema: MessageSchema },
      // Schema-only re-registration (Mongoose dedupes by name) so the service
      // can snapshot names + resolve participant status. No module cycle.
      { name: User.name, schema: UserSchema },
    ]),
    // For the gateway's handshake-token verification. Secret is passed at
    // verify time (JWT_ACCESS_SECRET via ConfigService), so no global config here.
    JwtModule.register({}),
  ],
  controllers: [MessagingController],
  providers: [MessagingService, MessagingGateway],
  // Exported so UsersService can fire the staff-removal cascade (onUserRemoved).
  exports: [MessagingService],
})
export class MessagingModule {}
