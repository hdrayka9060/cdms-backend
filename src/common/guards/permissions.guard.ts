import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSION_KEY } from '../decorators/require-permission.decorator';
import { AppModule, PermissionAction, RolePermission } from '../permissions';

interface RequiredPermission {
  module: AppModule;
  action: PermissionAction;
}

/**
 * Reads the `@RequirePermission(module, action)` metadata off the handler and
 * confirms the authenticated user's role grants that action on that module.
 *
 * Expects `req.user.roleId` to be populated (a Role document, not an ObjectId).
 * JwtStrategy.validate() handles the populate.
 *
 * If no `@RequirePermission` decorator is set on the handler, the guard is a no-op.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<RequiredPermission>(
      PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;

    const { user } = context.switchToHttp().getRequest();
    if (!user) throw new ForbiddenException('User not authenticated');

    const role = user.roleId;
    if (!role || !Array.isArray(role.permissions)) {
      throw new ForbiddenException('User has no role assigned');
    }

    const modulePerm = (role.permissions as RolePermission[]).find(
      (p) => p.module === required.module,
    );
    const ok = modulePerm?.actions?.includes(required.action) ?? false;
    if (!ok) {
      throw new ForbiddenException(
        `Permission denied: requires ${required.action} on ${required.module}`,
      );
    }
    return true;
  }
}
