import { Module } from '@nestjs/common';
import { DealerWebsiteController } from './dealer-website.controller';
import { InventoryModule } from '../inventory/inventory.module';

@Module({
  imports: [InventoryModule],
  controllers: [DealerWebsiteController],
})
export class DealerWebsiteModule {}
