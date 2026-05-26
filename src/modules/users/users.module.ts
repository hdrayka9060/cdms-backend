import { forwardRef, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { UsersMigrator } from './users.migrator';
import { User, UserSchema } from './schemas/user.schema';
import { RolesModule } from '../roles/roles.module';

/**
 * UsersModule imports RolesModule so UsersService can:
 *   1. Validate roleId on invite/update against the roles collection.
 *   2. Look up a role's display name when emitting role-change activity rows.
 *
 * RolesModule already imports UsersModule's schema indirectly (the roles
 * seeder migrates legacy users), but it does NOT import UsersService — so
 * there's no circular service dependency. We use `forwardRef` defensively in
 * case future code adds one.
 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]),
    forwardRef(() => RolesModule),
  ],
  controllers: [UsersController],
  providers: [UsersService, UsersMigrator],
  exports: [UsersService],
})
export class UsersModule {}
