import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { RolesModule } from './modules/roles/roles.module';
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
import { SettingsModule } from './modules/settings/settings.module';

@Module({
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
        connectionFactory: (connection) => {
          connection.on('connected', () =>
            console.log('✅ MongoDB connected successfully'),
          );
          connection.on('error', (err) =>
            console.error('❌ MongoDB connection error:', err),
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
    DashboardModule,
    InventoryModule,
    CrmSellersModule,
    CrmBuyersModule,
    LeadsModule,
    CalendarModule,
    AccountingModule,
    BhphModule,
    MarketingModule,
    DealerWebsiteModule,
    SupportModule,
    CommunicationModule,
    SettingsModule,
  ],
})
export class AppModule {}
