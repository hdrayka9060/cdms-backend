import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { DealerSettings, DealerSettingsSchema } from './schemas/dealer-settings.schema';

@Module({
  imports: [MongooseModule.forFeature([{ name: DealerSettings.name, schema: DealerSettingsSchema }])],
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
