import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { FacebookController } from './facebook.controller';
import { FacebookService } from './facebook.service';
import { LeadsModule } from '../leads/leads.module';
import { CrmBuyersModule } from '../crm-buyers/crm-buyers.module';
import {
  FacebookConnection,
  FacebookConnectionSchema,
} from './schemas/facebook-connection.schema';
import {
  FacebookListing,
  FacebookListingSchema,
} from './schemas/facebook-listing.schema';
import {
  FacebookListingTemplate,
  FacebookListingTemplateSchema,
} from './schemas/facebook-listing-template.schema';
import {
  FacebookComment,
  FacebookCommentSchema,
} from './schemas/facebook-comment.schema';
import {
  FacebookConversation,
  FacebookConversationSchema,
} from './schemas/facebook-conversation.schema';
import {
  FacebookMessage,
  FacebookMessageSchema,
} from './schemas/facebook-message.schema';
import { Vehicle, VehicleSchema } from '../inventory/schemas/vehicle.schema';
import {
  FacebookGroupTarget,
  FacebookGroupTargetSchema,
} from './schemas/facebook-group-target.schema';
import {
  FacebookEngagement,
  FacebookEngagementSchema,
} from './schemas/facebook-engagement.schema';
import {
  DealerSettings,
  DealerSettingsSchema,
} from '../settings/schemas/dealer-settings.schema';

/**
 * Facebook Listings feature module: connections, listings + templates, comments,
 * Messenger conversations + messages. FacebookApiService (Graph wrapper) and
 * ActivityService are `@Global()`. LeadsModule + CrmBuyersModule are imported so
 * the promote-to-Lead bridge can create a real BuyerLead + Lead through their
 * services (guards stay in LeadsService). Neither imports FacebookModule, so no
 * forwardRef is needed.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: FacebookConnection.name, schema: FacebookConnectionSchema },
      { name: FacebookListing.name, schema: FacebookListingSchema },
      { name: FacebookListingTemplate.name, schema: FacebookListingTemplateSchema },
      { name: FacebookComment.name, schema: FacebookCommentSchema },
      { name: FacebookConversation.name, schema: FacebookConversationSchema },
      { name: FacebookMessage.name, schema: FacebookMessageSchema },
      { name: FacebookGroupTarget.name, schema: FacebookGroupTargetSchema },
      { name: FacebookEngagement.name, schema: FacebookEngagementSchema },
      // Re-registered (schema-only) so doSyncCatalog can enrich catalog items
      // with make/model/year/mileage from the real vehicle. No module cycle.
      { name: Vehicle.name, schema: VehicleSchema },
      // Dealer settings (schema-only) for the dealership address + currency that
      // a Vehicles catalog item requires.
      { name: DealerSettings.name, schema: DealerSettingsSchema },
    ]),
    LeadsModule,
    CrmBuyersModule,
  ],
  controllers: [FacebookController],
  providers: [FacebookService],
  exports: [FacebookService],
})
export class FacebookModule {}
