import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ActivityService } from './activity.service';
import { Activity, ActivitySchema } from './schemas/activity.schema';

/**
 * Activity log lives behind a @Global module so every feature service can
 * just `constructor(private activity: ActivityService) {}` without each
 * module needing to import ActivityModule. The service is intentionally
 * tiny (one collection, one write method, one read method) so a global
 * export doesn't bloat anyone's dependency graph.
 */
@Global()
@Module({
  imports: [
    MongooseModule.forFeature([{ name: Activity.name, schema: ActivitySchema }]),
  ],
  providers: [ActivityService],
  exports: [ActivityService],
})
export class ActivityModule {}
