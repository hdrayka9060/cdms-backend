import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';
import { RolesSeeder } from './roles.seeder';
import { Role, RoleSchema } from './schemas/role.schema';
import { User, UserSchema } from '../users/schemas/user.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Role.name, schema: RoleSchema },
      // Register User here too so the seeder can update existing users on boot.
      { name: User.name, schema: UserSchema },
    ]),
  ],
  controllers: [RolesController],
  providers: [RolesService, RolesSeeder],
  exports: [RolesService],
})
export class RolesModule {}
