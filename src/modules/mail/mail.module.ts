import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';

/**
 * Mail is registered globally so any feature service (UsersService,
 * AuthService, etc.) can inject MailService without each module having to
 * import MailModule explicitly. Mirrors the ActivityModule pattern.
 */
@Global()
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
