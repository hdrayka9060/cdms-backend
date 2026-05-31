import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query,
  UseGuards, UploadedFile, UseInterceptors, HttpCode, HttpStatus,
  ForbiddenException, BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import {
  ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam,
  ApiConsumes, ApiBody,
} from '@nestjs/swagger';
import { UsersService } from './users.service';
import {
  CreateUserDto, UpdateUserDto, ChangePasswordDto, InviteUserDto,
} from './dto/user.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AppModule, PermissionAction } from '../../common/permissions';

@ApiTags('Users')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller({ path: 'users', version: '1' })
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /**
   * POST /api/v1/users
   * Create a new user (admin only)
   */
  @Post()
  @RequirePermission(AppModule.STAFF, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Create a new system user', description: 'Requires Staff:edit. Creates a new user with a specified roleId.' })
  @ApiResponse({ status: 201, description: 'User created successfully' })
  @ApiResponse({ status: 409, description: 'Email already registered' })
  async create(@Body() dto: CreateUserDto) {
    const user = await this.usersService.create(dto);
    const { password, ...result } = (user as any).toObject();
    return { message: 'User created successfully', data: result };
  }

  /**
   * POST /api/v1/users/invite
   * Invite a new user — creates an INVITED row + sends an invite link email.
   * The invitee sets their password via POST /auth/accept-invite.
   */
  @Post('invite')
  @RequirePermission(AppModule.STAFF, PermissionAction.EDIT)
  @ApiOperation({
    summary: 'Invite a new staff member',
    description: `Creates an INVITED user (no password) and emails an
acceptance link. The invitee clicks the link to set a password and is
auto-logged-in — no signup form involved.

**Body fields:**
- firstName (required)
- lastName (required)
- email (required, must be unique)
- roleId (required, must be a valid Role _id)
- phone (optional)
- department (optional)

Token expires in 7 days.`,
  })
  @ApiResponse({ status: 201, description: 'Invite sent (or queued if mail is in dev mode)' })
  @ApiResponse({ status: 409, description: 'Email already registered' })
  async invite(@Body() dto: InviteUserDto, @CurrentUser() actor: any) {
    const inviterName = actor
      ? `${actor.firstName ?? ''} ${actor.lastName ?? ''}`.trim() || actor.email
      : undefined;
    const { user } = await this.usersService.invite(dto, {
      id: actor?._id?.toString(),
      name: inviterName,
    });
    const { inviteToken, inviteTokenExpires, password, ...safe } = (user as any).toObject();
    return { message: 'Invitation sent', data: safe };
  }

  /**
   * POST /api/v1/users/bulk-upload
   * Bulk-invite users via CSV.
   */
  @Post('bulk-upload')
  @RequirePermission(AppModule.STAFF, PermissionAction.EDIT)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'CSV file with columns: firstName, lastName, email, phone, department, role (role = role NAME, e.g. "Sales Staff"; phone + department are optional)',
    schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } },
  })
  @ApiOperation({
    summary: 'Bulk-invite users via CSV',
    description: `Each row creates an INVITED user and dispatches an invite
email. \`role\` column should match a Role's \`name\` exactly (case-insensitive).

Returns counts + per-row error messages so the UI can show which rows
failed and why.`,
  })
  @ApiResponse({ status: 201, description: 'Bulk upload complete with results' })
  async bulkUpload(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() actor: any,
  ) {
    if (!file?.buffer) throw new BadRequestException('No CSV file uploaded');
    const inviterName = actor
      ? `${actor.firstName ?? ''} ${actor.lastName ?? ''}`.trim() || actor.email
      : undefined;
    const result = await this.usersService.bulkInvite(file.buffer, {
      id: actor?._id?.toString(),
      name: inviterName,
    });
    return {
      message: `Bulk invite complete: ${result.created} sent, ${result.errors.length} skipped`,
      data: result,
    };
  }

  /**
   * GET /api/v1/users
   * List all users with pagination
   */
  @Get()
  @RequirePermission(AppModule.STAFF, PermissionAction.VIEW)
  @ApiOperation({ summary: 'List all users', description: 'Returns paginated list of all users. Requires Staff:view.' })
  @ApiResponse({ status: 200, description: 'Users retrieved successfully' })
  async findAll(@Query() query: PaginationDto) {
    const result = await this.usersService.findAll(query);
    return { message: 'Users retrieved successfully', data: result };
  }

  /**
   * GET /api/v1/users/me
   * Get current authenticated user profile
   */
  @Get('me')
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({ status: 200, description: 'Profile retrieved successfully' })
  async getProfile(@CurrentUser() user: any) {
    const profile = await this.usersService.findById(user._id);
    return { message: 'Profile retrieved', data: profile };
  }

  /**
   * GET /api/v1/users/:id
   * Get a user by ID
   */
  @Get(':id')
  @RequirePermission(AppModule.STAFF, PermissionAction.VIEW)
  @ApiOperation({ summary: 'Get user by ID' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId of the user' })
  @ApiResponse({ status: 200, description: 'User found' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async findOne(@Param('id') id: string) {
    const user = await this.usersService.findById(id);
    return { message: 'User retrieved', data: user };
  }

  /**
   * PATCH /api/v1/users/:id
   * Update a user
   */
  @Patch(':id')
  @ApiOperation({ summary: 'Update user details' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId of the user' })
  @ApiResponse({ status: 200, description: 'User updated successfully' })
  async update(@Param('id') id: string, @Body() dto: UpdateUserDto, @CurrentUser() currentUser: any) {
    // Non-admins can only update themselves AND cannot change their own role
    // (role changes are an admin-only action).
    // (currentUser.roleId is the populated Role doc when JwtStrategy.validate ran.)
    const isAdmin = currentUser.roleId?.name === 'Admin';
    if (!isAdmin && currentUser._id.toString() !== id) {
      throw new ForbiddenException('You can only update your own profile');
    }
    if (!isAdmin && dto.roleId) {
      throw new ForbiddenException('Only admins can change roles');
    }
    const user = await this.usersService.update(id, dto, currentUser._id?.toString());
    return { message: 'User updated successfully', data: user };
  }

  /**
   * PATCH /api/v1/users/me/change-password
   * Change current user's password
   */
  @Patch('me/change-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change current user password' })
  @ApiResponse({ status: 200, description: 'Password changed successfully' })
  @ApiResponse({ status: 400, description: 'Current password incorrect' })
  async changePassword(@CurrentUser() user: any, @Body() dto: ChangePasswordDto) {
    await this.usersService.changePassword(user._id, dto);
    return { message: 'Password changed successfully', data: null };
  }

  /**
   * DELETE /api/v1/users/:id
   * Soft delete a user (admin only)
   */
  @Delete(':id')
  @RequirePermission(AppModule.STAFF, PermissionAction.DELETE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft delete a user', description: 'Requires Staff:delete. Marks user as deleted without removing from DB. Cannot delete yourself.' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId of the user' })
  @ApiResponse({ status: 200, description: 'User deleted successfully' })
  @ApiResponse({ status: 400, description: 'Cannot delete your own account' })
  async remove(@Param('id') id: string, @CurrentUser() currentUser: any) {
    await this.usersService.softDelete(id, currentUser._id?.toString());
    return { message: 'User deleted successfully', data: null };
  }
}
