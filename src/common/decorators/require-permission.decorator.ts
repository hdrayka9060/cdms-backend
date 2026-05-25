import { SetMetadata } from '@nestjs/common';
import { AppModule, PermissionAction } from '../permissions';

export const PERMISSION_KEY = 'permission';

/**
 * Marks a route as requiring a specific (module, action) permission.
 *
 * Used in conjunction with `PermissionsGuard` (applied globally or per-controller).
 *
 * @example
 *   @RequirePermission(AppModule.INVENTORY, PermissionAction.EDIT)
 *   @Patch(':id')
 *   updateVehicle(...) {}
 */
export const RequirePermission = (module: AppModule, action: PermissionAction) =>
  SetMetadata(PERMISSION_KEY, { module, action });
