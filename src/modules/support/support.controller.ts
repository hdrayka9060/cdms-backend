import { Controller, Get, Post, Patch, Body, Param, Query, UseGuards, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { SupportService } from './support.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TicketStatus } from './schemas/ticket.schema';

@ApiTags('Support')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller({ path: 'support', version: '1' })
export class SupportController {
  constructor(private readonly service: SupportService) {}

  @Post('tickets')
  @ApiOperation({
    summary: 'Raise a support ticket',
    description: `Creates a new support ticket.

**Body fields:**
- subject (string, required)
- description (string, required)
- priority: low | medium | high | urgent
- category: technical | billing | vehicle | general | complaint
- raisedByName, raisedByEmail (string, required)`,
  })
  @ApiResponse({ status: 201, description: 'Ticket created' })
  async create(@Body() dto: any) {
    const ticket = await this.service.create(dto);
    return { message: 'Ticket created', data: ticket };
  }

  @Get('tickets')
  @ApiOperation({ summary: 'List all tickets', description: 'Filter by status, priority, category.' })
  async findAll(@Query() query: any) {
    const result = await this.service.findAll(query);
    return { message: 'Tickets retrieved', data: result };
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get ticket stats by status' })
  async getStats() {
    const data = await this.service.getStats();
    return { message: 'Ticket stats', data };
  }

  @Get('tickets/:id')
  @ApiOperation({ summary: 'Get ticket detail + communication thread' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 404, description: 'Ticket not found' })
  async findOne(@Param('id') id: string) {
    const ticket = await this.service.findById(id);
    return { message: 'Ticket retrieved', data: ticket };
  }

  @Post('tickets/:id/reply')
  @ApiOperation({ summary: 'Add reply to ticket thread', description: 'Appends a message to the ticket communication thread.' })
  @ApiParam({ name: 'id' })
  async reply(@Param('id') id: string, @Body() dto: any) {
    const ticket = await this.service.reply(id, dto);
    return { message: 'Reply added', data: ticket };
  }

  @Patch('tickets/:id/status')
  @ApiOperation({ summary: 'Update ticket status', description: 'Change ticket status. Setting to resolved records resolvedAt timestamp.' })
  @ApiParam({ name: 'id' })
  async updateStatus(@Param('id') id: string, @Body() dto: { status: TicketStatus; assignedTo?: string }) {
    const ticket = await this.service.updateStatus(id, dto.status, dto.assignedTo);
    return { message: 'Status updated', data: ticket };
  }

  @Post('tickets/:id/attachments')
  @UseInterceptors(FilesInterceptor('files', 5, { storage: diskStorage({ destination: './uploads/tickets', filename: (req, file, cb) => cb(null, `${uuidv4()}${extname(file.originalname)}`) }) }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ description: 'Upload up to 5 files', schema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string', format: 'binary' } } } } })
  @ApiOperation({ summary: 'Upload ticket attachments', description: 'Attach up to 5 files to a support ticket.' })
  @ApiParam({ name: 'id' })
  async addAttachments(@Param('id') id: string, @UploadedFiles() files: Express.Multer.File[]) {
    const paths = files.map((f) => `/uploads/tickets/${f.filename}`);
    const ticket = await this.service.addAttachments(id, paths);
    return { message: 'Attachments added', data: ticket };
  }
}
