import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards,
  UseInterceptors, UploadedFiles,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam, ApiConsumes, ApiBody,
} from '@nestjs/swagger';
import { MessagingService, Actor } from './messaging.service';
import {
  CreateConversationDto, UpdateGroupDto, AddParticipantsDto, SendMessageDto,
  EditMessageDto, ListMessagesDto, SetParticipantRoleDto,
} from './dto/messaging.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AppModule, PermissionAction } from '../../common/permissions';

const messageStorage = diskStorage({
  destination: './uploads/messages',
  filename: (req, file, cb) => cb(null, `${uuidv4()}${extname(file.originalname)}`),
});

const actorOf = (user: any): Actor => ({
  id: user._id.toString(),
  name: `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.email,
});

@ApiTags('Messaging')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller({ path: 'messaging', version: '1' })
export class MessagingController {
  constructor(private readonly messaging: MessagingService) {}

  /**
   * Staff-to-staff chat. Gated by the `Communication` module permission for tab
   * access; actual data access is enforced per-conversation by participant
   * membership in the service (a user only ever sees their own chats). Chat
   * actions (send / edit-own / delete-own / manage your groups) are `edit`;
   * reading is `view`.
   */

  @Get('conversations')
  @RequirePermission(AppModule.COMMUNICATION, PermissionAction.VIEW)
  @ApiOperation({ summary: 'List my conversations (DMs + groups) with unread counts' })
  async list(@CurrentUser() user: any) {
    const data = await this.messaging.listConversations(user._id.toString());
    return { message: 'Conversations retrieved', data };
  }

  @Get('unread-count')
  @RequirePermission(AppModule.COMMUNICATION, PermissionAction.VIEW)
  @ApiOperation({ summary: 'Total unread messages across my conversations (nav badge)' })
  async unread(@CurrentUser() user: any) {
    const total = await this.messaging.unreadTotal(user._id.toString());
    return { message: 'Unread total', data: { total } };
  }

  @Get('directory')
  @RequirePermission(AppModule.COMMUNICATION, PermissionAction.VIEW)
  @ApiOperation({ summary: 'Active staff for the chat people-picker (Communication-gated, not Staff)' })
  async directory() {
    return { message: 'Directory', data: await this.messaging.directory() };
  }

  @Post('conversations')
  @RequirePermission(AppModule.COMMUNICATION, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Start a DM or create a group', description: 'type=direct → one participantId; type=group → name + member ids. DMs are idempotent (re-opening returns the existing thread).' })
  @ApiResponse({ status: 201, description: 'Conversation created (or existing DM returned)' })
  async create(@Body() dto: CreateConversationDto, @CurrentUser() user: any) {
    const data = await this.messaging.createConversation(dto, actorOf(user));
    return { message: 'Conversation ready', data };
  }

  @Get('conversations/:id')
  @RequirePermission(AppModule.COMMUNICATION, PermissionAction.VIEW)
  @ApiParam({ name: 'id' })
  async get(@Param('id') id: string, @CurrentUser() user: any) {
    const data = await this.messaging.getConversation(id, user._id.toString());
    return { message: 'Conversation retrieved', data };
  }

  @Patch('conversations/:id')
  @RequirePermission(AppModule.COMMUNICATION, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Edit group name/description (admin)' })
  async updateGroup(@Param('id') id: string, @Body() dto: UpdateGroupDto, @CurrentUser() user: any) {
    const data = await this.messaging.updateGroup(id, dto, actorOf(user));
    return { message: 'Group updated', data };
  }

  @Delete('conversations/:id')
  @RequirePermission(AppModule.COMMUNICATION, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Delete a group (admin)' })
  async deleteGroup(@Param('id') id: string, @CurrentUser() user: any) {
    const data = await this.messaging.deleteGroup(id, actorOf(user));
    return { message: 'Group deleted', data };
  }

  @Post('conversations/:id/participants')
  @RequirePermission(AppModule.COMMUNICATION, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Add members to a group (admin)' })
  async addParticipants(@Param('id') id: string, @Body() dto: AddParticipantsDto, @CurrentUser() user: any) {
    const data = await this.messaging.addParticipants(id, dto, actorOf(user));
    return { message: 'Members added', data };
  }

  @Delete('conversations/:id/participants/:userId')
  @RequirePermission(AppModule.COMMUNICATION, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Remove a member (admin) — or leave the group (target = yourself). Last member leaving deletes the group; the sole admin must hand off admin first.' })
  async removeParticipant(@Param('id') id: string, @Param('userId') userId: string, @CurrentUser() user: any) {
    const data = await this.messaging.removeParticipant(id, userId, actorOf(user));
    return { message: 'Member removed', data };
  }

  @Patch('conversations/:id/participants/:userId/role')
  @RequirePermission(AppModule.COMMUNICATION, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Promote/demote a group member (admin only)' })
  async setRole(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body() dto: SetParticipantRoleDto,
    @CurrentUser() user: any,
  ) {
    const data = await this.messaging.setParticipantRole(id, userId, dto.role, actorOf(user));
    return { message: 'Role updated', data };
  }

  @Patch('conversations/:id/read')
  @RequirePermission(AppModule.COMMUNICATION, PermissionAction.VIEW)
  @ApiOperation({ summary: 'Mark a conversation read (advances my unread cursor)' })
  async markRead(@Param('id') id: string, @CurrentUser() user: any) {
    const data = await this.messaging.markRead(id, user._id.toString());
    return { message: 'Marked read', data };
  }

  @Get('conversations/:id/messages')
  @RequirePermission(AppModule.COMMUNICATION, PermissionAction.VIEW)
  @ApiOperation({ summary: 'List messages (chronological page; pass ?before=ISO for older)' })
  async messages(@Param('id') id: string, @Query() query: ListMessagesDto, @CurrentUser() user: any) {
    const data = await this.messaging.listMessages(id, user._id.toString(), query);
    return { message: 'Messages retrieved', data };
  }

  @Post('conversations/:id/messages')
  @RequirePermission(AppModule.COMMUNICATION, PermissionAction.EDIT)
  @UseInterceptors(FilesInterceptor('files', 10, { storage: messageStorage }))
  @ApiConsumes('multipart/form-data', 'application/json')
  @ApiBody({ description: 'Message body (+ up to 10 files of any type)', schema: { type: 'object', properties: { body: { type: 'string' }, files: { type: 'array', items: { type: 'string', format: 'binary' } } } } })
  @ApiOperation({ summary: 'Send a message (text and/or file attachments)' })
  async send(
    @Param('id') id: string,
    @Body() dto: SendMessageDto,
    @UploadedFiles() files: Express.Multer.File[],
    @CurrentUser() user: any,
  ) {
    const data = await this.messaging.sendMessage(id, dto, files ?? [], actorOf(user));
    return { message: 'Message sent', data };
  }

  @Patch('conversations/:id/messages/:messageId')
  @RequirePermission(AppModule.COMMUNICATION, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Edit your own message (within 6 hours)' })
  @ApiResponse({ status: 403, description: 'Not your message, or the 6-hour window has expired' })
  async edit(
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @Body() dto: EditMessageDto,
    @CurrentUser() user: any,
  ) {
    const data = await this.messaging.editMessage(id, messageId, dto, actorOf(user));
    return { message: 'Message updated', data };
  }

  @Delete('conversations/:id/messages/:messageId')
  @RequirePermission(AppModule.COMMUNICATION, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Delete your own message (within 6 hours)' })
  @ApiResponse({ status: 403, description: 'Not your message, or the 6-hour window has expired' })
  async remove(
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @CurrentUser() user: any,
  ) {
    const data = await this.messaging.deleteMessage(id, messageId, actorOf(user));
    return { message: 'Message deleted', data };
  }
}
