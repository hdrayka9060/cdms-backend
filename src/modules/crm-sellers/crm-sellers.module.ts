import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CrmSellersController } from './crm-sellers.controller';
import { CrmSellersService } from './crm-sellers.service';
import { SellerLead, SellerLeadSchema } from './schemas/seller-lead.schema';
import { Vehicle, VehicleSchema } from '../inventory/schemas/vehicle.schema';
import { InventoryModule } from '../inventory/inventory.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SellerLead.name, schema: SellerLeadSchema },
      // Read-only Vehicle access for the reverse-lookup
      // (CrmSellersService.loadVehiclesForSeller queries Vehicle.find({seller})).
      // Writes still go through InventoryService.
      { name: Vehicle.name, schema: VehicleSchema },
    ]),
    InventoryModule,
  ],
  controllers: [CrmSellersController],
  providers: [CrmSellersService],
  exports: [CrmSellersService],
})
export class CrmSellersModule {}
