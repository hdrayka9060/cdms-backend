import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MulterModule } from '@nestjs/platform-express';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { VinDecodeService } from './vin-decode.service';
import { Vehicle, VehicleSchema } from './schemas/vehicle.schema';
import { SellerLead, SellerLeadSchema } from '../crm-sellers/schemas/seller-lead.schema';
import { AccountingModule } from '../accounting/accounting.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Vehicle.name, schema: VehicleSchema },
      // Needed by InventoryService to keep seller.vehicles[] in sync when a
      // vehicle is soft-deleted. Importing only the schema (not CrmSellersModule)
      // avoids a circular module dependency.
      { name: SellerLead.name, schema: SellerLeadSchema },
    ]),
    // forwardRef: AccountingModule itself imports the Vehicle schema, so this
    // would otherwise deadlock at module-resolution time.
    forwardRef(() => AccountingModule),
    MulterModule.register({ dest: './uploads/vehicles' }),
  ],
  controllers: [InventoryController],
  providers: [InventoryService, VinDecodeService],
  exports: [InventoryService],
})
export class InventoryModule {}
