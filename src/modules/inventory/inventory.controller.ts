import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards,
  UploadedFiles, UseInterceptors, UploadedFile, HttpCode, HttpStatus,
} from '@nestjs/common';
import { FilesInterceptor, FileInterceptor } from '@nestjs/platform-express';
import { diskStorage, memoryStorage } from 'multer';
import { extname } from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam,
  ApiConsumes, ApiBody,
} from '@nestjs/swagger';
import { InventoryService } from './inventory.service';
import { CreateVehicleDto, UpdateVehicleDto, VehicleQueryDto } from './dto/vehicle.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AppModule, PermissionAction } from '../../common/permissions';

const imageStorage = diskStorage({
  destination: './uploads/vehicles',
  filename: (req, file, cb) => cb(null, `${uuidv4()}${extname(file.originalname)}`),
});

@ApiTags('Inventory')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller({ path: 'inventory', version: '1' })
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  /**
   * POST /api/v1/inventory
   */
  @Post()
  @RequirePermission(AppModule.INVENTORY, PermissionAction.EDIT)
  @ApiOperation({
    summary: 'Add a new vehicle',
    description: `Creates a new vehicle listing in the inventory.

**Required Fields:** vehicleNumber, title, company, model, year, price

**Optional Fields:** vehicleNumber (auto-generated if omitted), description, km, discount, owners, fuelType, transmission, color, vin, bodyType, status, hosting, features`,
  })
  @ApiResponse({ status: 201, description: 'Vehicle created successfully' })
  @ApiResponse({ status: 409, description: 'Vehicle number already exists' })
  async create(@Body() dto: CreateVehicleDto, @CurrentUser() user: any) {
    const vehicle = await this.inventoryService.create(dto, user._id);
    return { message: 'Vehicle added successfully', data: vehicle };
  }

  /**
   * GET /api/v1/inventory
   */
  @Get()
  @RequirePermission(AppModule.INVENTORY, PermissionAction.VIEW)
  @ApiOperation({
    summary: 'List all vehicles',
    description: `Returns paginated, filtered, and sorted list of vehicles.

**Query Parameters:**
- \`page\` (number): Page number, default 1
- \`limit\` (number): Items per page, max 100, default 20
- \`search\` (string): Full-text search across title, company, model, vehicleNumber
- \`sort\` (string): Sort field, prefix \`-\` for descending (e.g. \`-price\`, \`year\`)
- \`status\` (enum): \`pending\` | \`unsold\` | \`sold\`
- \`company\` (string): Filter by company name (case-insensitive)
- \`model\` (string): Filter by model
- \`minPrice\` / \`maxPrice\` (number): Price range filter
- \`minYear\` / \`maxYear\` (number): Year range filter
- \`fuelType\` (enum): \`petrol\` | \`diesel\` | \`electric\` | \`hybrid\` | \`cng\`
- \`transmission\` (enum): \`manual\` | \`automatic\` | \`cvt\``,
  })
  @ApiResponse({ status: 200, description: 'Vehicles retrieved with pagination metadata' })
  async findAll(@Query() query: VehicleQueryDto) {
    const result = await this.inventoryService.findAll(query);
    return { message: 'Vehicles retrieved', data: result };
  }

  /**
   * GET /api/v1/inventory/stats
   */
  @Get('stats')
  @RequirePermission(AppModule.INVENTORY, PermissionAction.VIEW)
  @ApiOperation({ summary: 'Get inventory statistics', description: 'Returns counts by status and average price.' })
  @ApiResponse({ status: 200, description: 'Stats returned' })
  async getStats() {
    const stats = await this.inventoryService.getStats();
    return { message: 'Inventory stats', data: stats };
  }

  /**
   * GET /api/v1/inventory/:id
   */
  @Get(':id')
  @RequirePermission(AppModule.INVENTORY, PermissionAction.VIEW)
  @ApiOperation({ summary: 'Get vehicle by ID', description: 'Returns full vehicle details. Also increments view count.' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId' })
  @ApiResponse({ status: 200, description: 'Vehicle found' })
  @ApiResponse({ status: 404, description: 'Vehicle not found' })
  async findOne(@Param('id') id: string) {
    const vehicle = await this.inventoryService.findById(id);
    return { message: 'Vehicle retrieved', data: vehicle };
  }

  /**
   * PATCH /api/v1/inventory/:id
   */
  @Patch(':id')
  @RequirePermission(AppModule.INVENTORY, PermissionAction.EDIT)
  @ApiOperation({ summary: 'Update vehicle details', description: 'Partial update. All fields optional. Changes are tracked in vehicle history.' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId' })
  @ApiResponse({ status: 200, description: 'Vehicle updated' })
  async update(@Param('id') id: string, @Body() dto: UpdateVehicleDto, @CurrentUser() user: any) {
    const vehicle = await this.inventoryService.update(id, dto, user._id);
    return { message: 'Vehicle updated', data: vehicle };
  }

  /**
   * DELETE /api/v1/inventory/:id
   */
  @Delete(':id')
  @RequirePermission(AppModule.INVENTORY, PermissionAction.DELETE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete vehicle (soft)', description: 'Soft-deletes vehicle. Admin/Manager only.' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId' })
  @ApiResponse({ status: 200, description: 'Vehicle deleted' })
  async remove(@Param('id') id: string, @CurrentUser() user: any) {
    await this.inventoryService.softDelete(id, user?._id?.toString());
    return { message: 'Vehicle deleted', data: null };
  }

  /**
   * POST /api/v1/inventory/:id/images
   */
  @Post(':id/images')
  @RequirePermission(AppModule.INVENTORY, PermissionAction.EDIT)
  @UseInterceptors(FilesInterceptor('images', 10, { storage: imageStorage }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ description: 'Upload up to 10 vehicle images', schema: { type: 'object', properties: { images: { type: 'array', items: { type: 'string', format: 'binary' } } } } })
  @ApiOperation({ summary: 'Upload vehicle images', description: 'Uploads 1–10 images for a vehicle. Max 10MB each. Formats: jpg, jpeg, png, webp.' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId' })
  @ApiResponse({ status: 201, description: 'Images uploaded successfully' })
  async uploadImages(@Param('id') id: string, @UploadedFiles() files: Express.Multer.File[]) {
    if (!files?.length) throw new Error('No images uploaded');
    const paths = files.map((f) => `/uploads/vehicles/${f.filename}`);
    const vehicle = await this.inventoryService.addImages(id, paths);
    return { message: `${files.length} image(s) uploaded`, data: vehicle };
  }

  /**
   * DELETE /api/v1/inventory/:id/images
   * Body: { photoPath: "/uploads/vehicles/<filename>" }
   */
  @Delete(':id/images')
  @RequirePermission(AppModule.INVENTORY, PermissionAction.EDIT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a vehicle image',
    description: 'Removes a photo path from the vehicle\'s photos[] array. The file on disk is left untouched (cleanup is a separate concern).',
  })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId' })
  @ApiBody({ description: 'Photo path to remove', schema: { type: 'object', properties: { photoPath: { type: 'string', example: '/uploads/vehicles/abc.jpg' } } } })
  async removeImage(@Param('id') id: string, @Body() body: { photoPath: string }) {
    const vehicle = await this.inventoryService.removeImage(id, body.photoPath);
    return { message: 'Image removed', data: vehicle };
  }

  /**
   * POST /api/v1/inventory/bulk-upload
   */
  @Post('bulk-upload')
  @RequirePermission(AppModule.INVENTORY, PermissionAction.EDIT)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ description: 'CSV file with vehicle data', schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  @ApiOperation({
    summary: 'Bulk upload vehicles via CSV',
    description: `Uploads a CSV file to create multiple vehicles at once.

**CSV Columns** (mirror the Add Vehicle form): title, company, model, trim, year, engine, fuelType, transmission, bodyType, vin, km, price, discount, owners, color, hosting, description (plus optional vehicleNumber — auto-generated if blank)

**Required:** company, model, year, price. (title is optional — auto-built from year/company/model when blank.) Rows missing a required field are skipped and reported in \`errors\`.

**Enum columns (lowercase):** fuelType = petrol|diesel|electric|hybrid|cng · transmission = manual|automatic|cvt · hosting = self|platform. Blank enum cells fall back to schema defaults.

**Notes:**
- Skip existing vehicle numbers
- Returns count of created vehicles and per-row errors`,
  })
  @ApiResponse({ status: 201, description: 'Bulk upload completed with results' })
  async bulkUpload(@UploadedFile() file: Express.Multer.File, @CurrentUser() user: any) {
    const result = await this.inventoryService.bulkUpload(file.buffer, user._id);
    return { message: `Bulk upload complete: ${result.created} created`, data: result };
  }

  /**
   * GET /api/v1/inventory/:id/history
   */
  @Get(':id/history')
  @RequirePermission(AppModule.INVENTORY, PermissionAction.VIEW)
  @ApiOperation({ summary: 'Get vehicle change history', description: 'Returns log of all field changes with timestamps and who made the change.' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId' })
  @ApiResponse({ status: 200, description: 'History log returned' })
  async getHistory(@Param('id') id: string) {
    const history = await this.inventoryService.getHistory(id);
    return { message: 'Vehicle history retrieved', data: history };
  }

  /**
   * GET /api/v1/inventory/:id/traffic
   */
  @Get(':id/traffic')
  @RequirePermission(AppModule.INVENTORY, PermissionAction.VIEW)
  @ApiOperation({ summary: 'Get vehicle traffic/view stats', description: 'Returns views, clicks, inquiries, and last viewed timestamp.' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId' })
  @ApiResponse({ status: 200, description: 'Traffic data returned' })
  async getTraffic(@Param('id') id: string) {
    const traffic = await this.inventoryService.getTraffic(id);
    return { message: 'Traffic data retrieved', data: traffic };
  }
}
