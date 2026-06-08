import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service';

/**
 * Global media-storage module. Exposes StorageService app-wide (Amazon S3 in
 * production, local disk in dev) without each feature module importing it —
 * same convention as ActivityModule / MailModule / GoogleMeetModule /
 * FacebookApiModule. ConfigService is available because ConfigModule is global.
 */
@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
