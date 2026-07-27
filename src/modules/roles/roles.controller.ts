import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RolesService } from './roles.service';
import { CreateRoleDto, UpdateRoleDto } from './dto/role.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AppModule, PermissionAction } from '../../common/permissions';

@ApiTags('Roles')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller({ path: 'roles', version: '1' })
export class RolesController {
  constructor(private readonly service: RolesService) {}

  @Post()
  @RequirePermission(AppModule.ROLES, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Create a role', description: 'Define a new role with a per-module permissions matrix.' })
  @ApiResponse({ status: 201, description: 'Role created' })
  @ApiResponse({ status: 409, description: 'Role name already exists' })
  async create(@Body() dto: CreateRoleDto) {
    const role = await this.service.create(dto);
    return { message: 'Role created', data: role };
  }

  @Get()
  @RequirePermission(AppModule.ROLES, PermissionAction.VIEW)
  @ApiOperation({ summary: 'List all roles' })
  async findAll() {
    const roles = await this.service.findAll();
    return { message: 'Roles retrieved', data: roles };
  }

  @Get(':id')
  @RequirePermission(AppModule.ROLES, PermissionAction.VIEW)
  @ApiOperation({ summary: 'Get role by ID' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId' })
  async findOne(@Param('id') id: string) {
    const role = await this.service.findById(id);
    return { message: 'Role retrieved', data: role };
  }

  @Patch(':id')
  @RequirePermission(AppModule.ROLES, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Update a role', description: 'Rename, redescribe, or change the permissions matrix.' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId' })
  async update(@Param('id') id: string, @Body() dto: UpdateRoleDto) {
    const role = await this.service.update(id, dto);
    return { message: 'Role updated', data: role };
  }

  @Delete(':id')
  @RequirePermission(AppModule.ROLES, PermissionAction.DELETE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a role (soft delete)',
    description:
      'Any role (including system roles) can be deleted with Roles:delete. Blocked if the role is your own, or if any staff are still assigned to it (reassign them first).',
  })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId' })
  async remove(@Param('id') id: string, @CurrentUser() user: any) {
    const actorRoleId = user?.roleId?._id ?? user?.roleId;
    await this.service.remove(id, actorRoleId ? String(actorRoleId) : undefined);
    return { message: 'Role deleted', data: null };
  }
}
