import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CommunicationController } from './communication.controller';
import { CommunicationService } from './communication.service';
import { CommunicationLog, CommunicationLogSchema } from './schemas/communication-log.schema';

@Module({
  imports: [MongooseModule.forFeature([{ name: CommunicationLog.name, schema: CommunicationLogSchema }])],
  controllers: [CommunicationController],
  providers: [CommunicationService],
  exports: [CommunicationService],
})
export class CommunicationModule {}
