import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { RolesModule } from './modules/roles/roles.module';
import { ActivityModule } from './modules/activity/activity.module';
import { MailModule } from './modules/mail/mail.module';
import { GoogleMeetModule } from './modules/google-meet/google-meet.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { CrmSellersModule } from './modules/crm-sellers/crm-sellers.module';
import { CrmBuyersModule } from './modules/crm-buyers/crm-buyers.module';
import { LeadsModule } from './modules/leads/leads.module';
import { CalendarModule } from './modules/calendar/calendar.module';
import { AccountingModule } from './modules/accounting/accounting.module';
import { BhphModule } from './modules/bhph/bhph.module';
import { MarketingModule } from './modules/marketing/marketing.module';
import { DealerWebsiteModule } from './modules/dealer-website/dealer-website.module';
import { SupportModule } from './modules/support/support.module';
import { CommunicationModule } from './modules/communication/communication.module';
import { MessagingModule } from './modules/messaging/messaging.module';
import { SettingsModule } from './modules/settings/settings.module';
import { FacebookApiModule } from './modules/facebook-api/facebook-api.module';
import { FacebookModule } from './modules/facebook/facebook.module';
import { StorageModule } from './common/storage/storage.module';
import { AdsApiModule } from './modules/ads-api/ads-api.module';
import { AdsAnalyticsModule } from './modules/ads-analytics/ads-analytics.module';

@Module({
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  imports: [
    // Config
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

    // Database
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>('MONGODB_URI'),
        // Atlas SRV resolution + auth can take 5-10s. The defaults wait far
        // longer; this short timeout makes failures noisy fast instead of
        // hanging the boot.
        serverSelectionTimeoutMS: 10_000,
        connectionFactory: (connection) => {
          // Mongoose can fire `connected` BEFORE this factory runs (the
          // event happens during `createConnection`, the factory wraps the
          // already-built connection). Without this synchronous check the
          // success log silently never appears even when the connection is
          // perfectly healthy — which looks identical to "can't connect".
          // readyState 1 = connected, 2 = connecting, 3 = disconnecting.
          if (connection.readyState === 1) {
            console.log('✅ MongoDB connected successfully (already open)');
          }
          connection.on('connected', () =>
            console.log('✅ MongoDB connected successfully'),
          );
          connection.on('reconnected', () =>
            console.log('✅ MongoDB reconnected'),
          );
          connection.on('disconnected', () =>
            console.warn('⚠️  MongoDB disconnected — operations will queue'),
          );
          connection.on('error', (err) =>
            console.error('❌ MongoDB connection error:', err.message ?? err),
          );
          return connection;
        },
      }),
    }),

    // Rate Limiting
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        {
          ttl: config.get<number>('THROTTLE_TTL', 60) * 1000,
          limit: config.get<number>('THROTTLE_LIMIT', 100),
        },
      ],
    }),

    // Scheduling
    ScheduleModule.forRoot(),

    // Feature Modules
    AuthModule,
    UsersModule,
    RolesModule,
    // ActivityModule is registered with @Global() so every feature service
    // can inject ActivityService without each module importing it.
    ActivityModule,
    // MailModule is @Global() too — UsersService + AuthService need to send
    // mail and we don't want every feature module to import MailModule.
    MailModule,
    // GoogleMeetModule is @Global() — CalendarService injects GoogleMeetService
    // to provision real Meet links via the Google Calendar API.
    GoogleMeetModule,
    // FacebookApiModule is @Global() — Facebook feature services inject the
    // Graph wrapper (FacebookApiService) without importing the module.
    FacebookApiModule,
    // StorageModule is @Global() — feature services inject StorageService to
    // store media on Amazon S3 (public URLs Facebook can fetch), with a
    // local-disk fallback when S3_* is unset.
    StorageModule,
    // AdsApiModule is @Global() — the ads-analytics feature service injects the
    // read-only Google Ads + Meta Ads API wrappers without importing the module.
    AdsApiModule,
    DashboardModule,
    InventoryModule,
    CrmSellersModule,
    CrmBuyersModule,
    LeadsModule,
    CalendarModule,
    AccountingModule,
    BhphModule,
    MarketingModule,
    AdsAnalyticsModule,
    DealerWebsiteModule,
    SupportModule,
    CommunicationModule,
    MessagingModule,
    SettingsModule,
    FacebookModule,
  ],
})
export class AppModule {}
