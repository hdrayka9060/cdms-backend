import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  RawBodyRequest,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import { FacebookService } from './facebook.service';
import { FacebookApiService } from '../facebook-api/facebook-api.service';
import {
  CompleteConnectDto,
  CreateGroupTargetDto,
  CreateListingDto,
  CreateTemplateDto,
  MarkPostedDto,
  PromoteLeadDto,
  ReplyCommentDto,
  SendMessageDto,
  UpdateConnectionDto,
  UpdateConversationDto,
  UpdateListingDto,
} from './dto/facebook.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AppModule, PermissionAction } from '../../common/permissions';

@ApiTags('Facebook')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller({ path: 'facebook', version: '1' })
export class FacebookController {
  constructor(
    private readonly service: FacebookService,
    private readonly fb: FacebookApiService,
  ) {}

  @Get('connections')
  @RequirePermission(AppModule.FACEBOOK_LISTINGS, PermissionAction.VIEW)
  @ApiOperation({ summary: 'List connected Facebook Pages' })
  async listConnections() {
    const data = await this.service.listConnections();
    return { message: 'Connections retrieved', data };
  }

  @Post('connect/start')
  @RequirePermission(AppModule.FACEBOOK_LISTINGS, PermissionAction.EDIT)
  @ApiOperation({
    summary: 'Begin connecting a Facebook account',
    description:
      'Returns the Facebook login URL to redirect to (real-mode) or `devMode: true` (the UI then simulates the connect via /connect/callback). `state` is a CSRF nonce.',
  })
  @ApiResponse({ status: 201, description: 'Connect started' })
  async startConnect() {
    const data = this.service.startConnect();
    return { message: 'Connect started', data };
  }

  @Post('connect/callback')
  @RequirePermission(AppModule.FACEBOOK_LISTINGS, PermissionAction.EDIT)
  @ApiOperation({
    summary: 'Complete connecting a Facebook account',
    description:
      'Exchanges the OAuth code for the dealer Page(s) and stores each connection (token encrypted at rest). In dev-mode the code is ignored and a mock Page is created.',
  })
  async completeConnect(@Body() dto: CompleteConnectDto, @CurrentUser() actor: any) {
    const data = await this.service.completeConnect(dto, actor?._id?.toString());
    return { message: 'Facebook account connected', data };
  }

  @Delete('connections/:id')
  @RequirePermission(AppModule.FACEBOOK_LISTINGS, PermissionAction.DELETE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Disconnect a Facebook Page (soft delete)' })
  @ApiParam({ name: 'id' })
  async disconnect(@Param('id') id: string, @CurrentUser() actor: any) {
    await this.service.disconnect(id, actor?._id?.toString());
    return { message: 'Facebook account disconnected', data: null };
  }

  @Patch('connections/:id')
  @RequirePermission(AppModule.FACEBOOK_LISTINGS, PermissionAction.EDIT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Set a connection's Marketplace product-catalog id (enables catalog sync)",
    description:
      'The catalog id (from Meta Commerce Manager) turns on the Marketplace (catalog) destination + the Item API sync for this Page. Pass an empty string to clear it.',
  })
  @ApiParam({ name: 'id' })
  async updateConnection(@Param('id') id: string, @Body() dto: UpdateConnectionDto) {
    const data = await this.service.setConnectionCatalog(id, {
      catalogId: dto.catalogId,
      catalogToken: dto.catalogToken,
    });
    return { message: 'Connection updated', data };
  }

  // ── Listings ───────────────────────────────────────────────────────────────

  @Get('listings')
  @RequirePermission(AppModule.FACEBOOK_LISTINGS, PermissionAction.VIEW)
  @ApiOperation({ summary: 'List Facebook listings (filter by status / vehicle / connection)' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'vehicleId', required: false })
  @ApiQuery({ name: 'connectionId', required: false })
  async listListings(@Query() q: Record<string, string>) {
    const data = await this.service.listListings({
      status: q.status,
      vehicleId: q.vehicleId,
      connectionId: q.connectionId,
    });
    return { message: 'Listings retrieved', data };
  }

  @Get('analytics')
  @RequirePermission(AppModule.FACEBOOK_LISTINGS, PermissionAction.VIEW)
  @ApiOperation({
    summary: 'Engagement analytics — summary KPIs, best-performing, 30-day trend, follow-up queue',
  })
  async getAnalytics() {
    const data = await this.service.getAnalytics();
    return { message: 'Analytics retrieved', data };
  }

  @Post('listings')
  @RequirePermission(AppModule.FACEBOOK_LISTINGS, PermissionAction.EDIT)
  @ApiOperation({
    summary: 'Create (and optionally publish) Page listings',
    description:
      'Creates one listing per `connectionIds[]` entry. Publishes immediately unless `publishNow: false`. Dev-mode mints a mock post id; real-mode posts via Graph.',
  })
  @ApiResponse({ status: 201, description: 'Listings created' })
  async createListings(@Body() dto: CreateListingDto, @CurrentUser() actor: any) {
    const data = await this.service.createListings(dto, actor?._id?.toString());
    return { message: 'Listings created', data };
  }

  @Post('listings/:id/publish')
  @RequirePermission(AppModule.FACEBOOK_LISTINGS, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Publish a draft / retry a failed listing' })
  @ApiParam({ name: 'id' })
  async publishListing(@Param('id') id: string, @CurrentUser() actor: any) {
    const data = await this.service.publishListing(id, actor?._id?.toString());
    return { message: 'Listing published', data };
  }

  @Post('listings/:id/mark-posted')
  @RequirePermission(AppModule.FACEBOOK_LISTINGS, PermissionAction.EDIT)
  @ApiOperation({
    summary: 'Mark a group-manual listing as posted (after pasting it into the group)',
  })
  @ApiParam({ name: 'id' })
  async markPosted(
    @Param('id') id: string,
    @Body() dto: MarkPostedDto,
    @CurrentUser() actor: any,
  ) {
    const data = await this.service.markPosted(id, dto.permalink, actor?._id?.toString());
    return { message: 'Listing marked posted', data };
  }

  @Patch('listings/:id')
  @RequirePermission(AppModule.FACEBOOK_LISTINGS, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Edit a listing (syncs the FB post text if already active)' })
  @ApiParam({ name: 'id' })
  async updateListing(
    @Param('id') id: string,
    @Body() dto: UpdateListingDto,
    @CurrentUser() actor: any,
  ) {
    const data = await this.service.updateListing(id, dto, actor?._id?.toString());
    return { message: 'Listing updated', data };
  }

  @Post('listings/:id/duplicate')
  @RequirePermission(AppModule.FACEBOOK_LISTINGS, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Duplicate a listing into a fresh draft' })
  @ApiParam({ name: 'id' })
  async duplicateListing(@Param('id') id: string, @CurrentUser() actor: any) {
    const data = await this.service.duplicateListing(id, actor?._id?.toString());
    return { message: 'Listing duplicated', data };
  }

  @Post('listings/:id/sync')
  @RequirePermission(AppModule.FACEBOOK_LISTINGS, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Refresh engagement + comments for a listing from Facebook' })
  @ApiParam({ name: 'id' })
  async syncListing(@Param('id') id: string) {
    await this.service.syncEngagement(id);
    return { message: 'Listing synced', data: null };
  }

  @Delete('listings/:id')
  @RequirePermission(AppModule.FACEBOOK_LISTINGS, PermissionAction.DELETE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove / unpublish a listing (deletes the FB post, soft-deletes the row)' })
  @ApiParam({ name: 'id' })
  async removeListing(@Param('id') id: string, @CurrentUser() actor: any) {
    await this.service.removeListing(id, actor?._id?.toString());
    return { message: 'Listing removed', data: null };
  }

  // ── Templates ────────────────────────────────────────────────────────────

  @Get('templates')
  @RequirePermission(AppModule.FACEBOOK_LISTINGS, PermissionAction.VIEW)
  @ApiOperation({ summary: 'List saved listing templates' })
  async listTemplates() {
    const data = await this.service.listTemplates();
    return { message: 'Templates retrieved', data };
  }

  @Post('templates')
  @RequirePermission(AppModule.FACEBOOK_LISTINGS, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Save a listing template' })
  async createTemplate(@Body() dto: CreateTemplateDto, @CurrentUser() actor: any) {
    const data = await this.service.createTemplate(dto, actor?._id?.toString());
    return { message: 'Template saved', data };
  }

  @Delete('templates/:id')
  @RequirePermission(AppModule.FACEBOOK_LISTINGS, PermissionAction.DELETE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a listing template' })
  @ApiParam({ name: 'id' })
  async deleteTemplate(@Param('id') id: string) {
    await this.service.deleteTemplate(id);
    return { message: 'Template deleted', data: null };
  }

  // ── Group targets (Phase 5 — assisted-manual registry) ─────────────────────

  @Get('groups')
  @RequirePermission(AppModule.FACEBOOK_LISTINGS, PermissionAction.VIEW)
  @ApiOperation({ summary: 'List Facebook group targets (posting registry)' })
  async listGroups() {
    const data = await this.service.listGroupTargets();
    return { message: 'Groups retrieved', data };
  }

  @Post('groups')
  @RequirePermission(AppModule.FACEBOOK_LISTINGS, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Register a Facebook group as a posting target' })
  async createGroup(@Body() dto: CreateGroupTargetDto, @CurrentUser() actor: any) {
    const data = await this.service.createGroupTarget(dto, actor?._id?.toString());
    return { message: 'Group added', data };
  }

  @Delete('groups/:id')
  @RequirePermission(AppModule.FACEBOOK_LISTINGS, PermissionAction.DELETE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a group target' })
  @ApiParam({ name: 'id' })
  async deleteGroup(@Param('id') id: string) {
    await this.service.deleteGroupTarget(id);
    return { message: 'Group removed', data: null };
  }

  // ── Comments (Phase 2) ───────────────────────────────────────────────────

  @Get('comments')
  @RequirePermission(AppModule.FACEBOOK_LISTINGS, PermissionAction.VIEW)
  @ApiOperation({ summary: 'List comments received on Page posts' })
  @ApiQuery({ name: 'listingId', required: false })
  @ApiQuery({ name: 'status', required: false })
  async listComments(@Query() q: Record<string, string>) {
    const data = await this.service.listComments({ listingId: q.listingId, status: q.status });
    return { message: 'Comments retrieved', data };
  }

  @Post('comments/:id/reply')
  @RequirePermission(AppModule.FACEBOOK_LISTINGS, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Reply to a comment' })
  @ApiParam({ name: 'id' })
  async replyComment(
    @Param('id') id: string,
    @Body() dto: ReplyCommentDto,
    @CurrentUser() actor: any,
  ) {
    const data = await this.service.replyComment(id, dto.message, actor?._id?.toString());
    return { message: 'Reply sent', data };
  }

  @Post('comments/:id/resolve')
  @RequirePermission(AppModule.FACEBOOK_LISTINGS, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Mark a comment resolved' })
  @ApiParam({ name: 'id' })
  async resolveComment(@Param('id') id: string, @CurrentUser() actor: any) {
    const data = await this.service.resolveComment(id, actor?._id?.toString());
    return { message: 'Comment resolved', data };
  }

  @Post('listings/:id/comments/read')
  @RequirePermission(AppModule.FACEBOOK_LISTINGS, PermissionAction.VIEW)
  @ApiOperation({ summary: "Mark all of a listing's comments as read (seen)" })
  @ApiParam({ name: 'id' })
  async markCommentsRead(@Param('id') id: string) {
    await this.service.markCommentsRead(id);
    return { message: 'Comments marked read', data: null };
  }

  // ── Messenger conversations (Phase 3) ──────────────────────────────────────

  @Get('conversations')
  @RequirePermission(AppModule.FACEBOOK_LISTINGS, PermissionAction.VIEW)
  @ApiOperation({ summary: 'List Messenger conversations (filter by leadStatus / assignee)' })
  @ApiQuery({ name: 'leadStatus', required: false })
  @ApiQuery({ name: 'assignedTo', required: false })
  async listConversations(@Query() q: Record<string, string>) {
    const data = await this.service.listConversations({
      leadStatus: q.leadStatus,
      assignedTo: q.assignedTo,
    });
    return { message: 'Conversations retrieved', data };
  }

  @Get('conversations/:id/messages')
  @RequirePermission(AppModule.FACEBOOK_LISTINGS, PermissionAction.VIEW)
  @ApiOperation({ summary: "Get a conversation's messages (marks it read)" })
  @ApiParam({ name: 'id' })
  async getConversationMessages(@Param('id') id: string) {
    const data = await this.service.getConversationMessages(id);
    return { message: 'Messages retrieved', data };
  }

  @Post('conversations/:id/reply')
  @RequirePermission(AppModule.FACEBOOK_LISTINGS, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Send a Messenger reply (subject to the 24h window)' })
  @ApiParam({ name: 'id' })
  async replyConversation(
    @Param('id') id: string,
    @Body() dto: SendMessageDto,
    @CurrentUser() actor: any,
  ) {
    const actorName =
      [actor?.firstName, actor?.lastName].filter(Boolean).join(' ') || actor?.email;
    const data = await this.service.sendReply(id, dto.message, actor?._id?.toString(), actorName);
    return { message: 'Reply sent', data };
  }

  @Patch('conversations/:id')
  @RequirePermission(AppModule.FACEBOOK_LISTINGS, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Assign a conversation / set its lead-pipeline status' })
  @ApiParam({ name: 'id' })
  async updateConversation(
    @Param('id') id: string,
    @Body() dto: UpdateConversationDto,
    @CurrentUser() actor: any,
  ) {
    const data = await this.service.updateConversation(id, dto, actor?._id?.toString());
    return { message: 'Conversation updated', data };
  }

  @Post('conversations/:id/promote-lead')
  @RequirePermission(AppModule.FACEBOOK_LISTINGS, PermissionAction.EDIT)
  @ApiOperation({
    summary: 'Promote a conversation into a CDMS Lead (creates a CRM buyer + lead)',
    description:
      'Creates a BuyerLead from the supplied contact details + a Lead (buyer × vehicle) via LeadsService — Guard 1 (sold vehicle) / Guard 2 (duplicate) apply and surface as 409.',
  })
  @ApiParam({ name: 'id' })
  async promoteLead(
    @Param('id') id: string,
    @Body() dto: PromoteLeadDto,
    @CurrentUser() actor: any,
  ) {
    const data = await this.service.promoteToLead(id, dto, actor?._id?.toString());
    return { message: 'Conversation promoted to lead', data };
  }

  @Post('sync-conversations')
  @RequirePermission(AppModule.FACEBOOK_LISTINGS, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Refresh Messenger conversations from Facebook' })
  async syncConversations() {
    await this.service.syncConversations();
    return { message: 'Conversations synced', data: null };
  }

  @Post('sync-engagement')
  @RequirePermission(AppModule.FACEBOOK_LISTINGS, PermissionAction.EDIT)
  @ApiOperation({
    summary: 'Refresh engagement (reactions/comments/shares) + comments for ALL active listings',
  })
  async syncEngagement() {
    await this.service.syncEngagement();
    return { message: 'Engagement synced', data: null };
  }

  @Get('unread-count')
  @RequirePermission(AppModule.FACEBOOK_LISTINGS, PermissionAction.VIEW)
  @ApiOperation({ summary: 'Total unread Facebook messages + comments (for the nav badge)' })
  async unreadCount() {
    const data = await this.service.getUnreadCount();
    return { message: 'Unread count', data };
  }

  // ── Webhooks (public — authenticated by Facebook's verify token / signature) ──

  @Get('webhook')
  @Public()
  @ApiOperation({
    summary: 'Facebook webhook verification handshake',
    description:
      'Facebook calls this once when subscribing the webhook. Echoes `hub.challenge` iff `hub.verify_token` matches FACEBOOK_VERIFY_TOKEN. Raw response (not the standard envelope).',
  })
  verifyWebhook(@Query() q: Record<string, string>, @Res() res: Response) {
    const mode = q['hub.mode'];
    const token = q['hub.verify_token'];
    const challenge = q['hub.challenge'];
    if (this.fb.verifyWebhookChallenge(mode, token)) {
      res.status(HttpStatus.OK).send(String(challenge ?? ''));
    } else {
      res.status(HttpStatus.FORBIDDEN).send('Forbidden');
    }
  }

  @Post('webhook')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Facebook webhook event receiver',
    description:
      'Receives comment/message events. Verifies the X-Hub-Signature-256 HMAC against the raw body before processing. Phase 0b: verifies + acks + logs; ingestion lands in later phases.',
  })
  handleWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature: string,
    @Body() body: any,
  ) {
    const raw = req.rawBody?.toString('utf8') ?? '';
    if (!this.fb.verifyWebhookSignature(raw, signature)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }
    void this.service.handleWebhookEvent(body);
    return 'EVENT_RECEIVED';
  }
}
