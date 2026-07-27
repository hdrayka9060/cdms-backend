import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards,
  UploadedFiles, UseInterceptors, UploadedFile, HttpCode, HttpStatus,
} from '@nestjs/common';
import { FilesInterceptor, FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import {
  ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam,
  ApiConsumes, ApiBody,
} from '@nestjs/swagger';
import { InventoryService } from './inventory.service';
import { VinDecodeService } from './vin-decode.service';
import { StorageService } from '../../common/storage/storage.service';
import { CreateVehicleDto, UpdateVehicleDto, VehicleQueryDto, CreateVehicleSpendDto, UpdateVehicleSpendDto } from './dto/vehicle.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AppModule, PermissionAction } from '../../common/permissions';

@ApiTags('Inventory')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller({ path: 'inventory', version: '1' })
export class InventoryController {
  constructor(
    private readonly inventoryService: InventoryService,
    private readonly vinDecode: VinDecodeService,
    private readonly storage: StorageService,
  ) {}

  /**
   * GET /api/v1/inventory/vin/:vin/decode
   *
   * Server-side NHTSA vPIC lookup that auto-fills the Add-Vehicle form. The
   * caller reviews/edits the returned specs before saving. Read-only (gated by
   * INVENTORY:view); the form's Save button enforces INVENTORY:edit separately.
   * Works for any US/Canada-market VIN.
   */
  @Get('vin/:vin/decode')
  @RequirePermission(AppModule.INVENTORY, PermissionAction.VIEW)
  @ApiOperation({
    summary: 'Decode a VIN via NHTSA vPIC',
    description:
      'Returns make, model, year, trim, engine, fuel, transmission, body type, ' +
      'country of origin and a suggested title. Pass an optional `?year=` hint to ' +
      'improve accuracy. 400 if the VIN is malformed/undecodable, 503 if NHTSA is down.',
  })
  @ApiParam({ name: 'vin', example: '5N1AT2MV8GC776183' })
  @ApiResponse({ status: 200, description: 'Decoded vehicle specs' })
  @ApiResponse({ status: 400, description: 'Invalid or undecodable VIN' })
  async decodeVin(@Param('vin') vin: string, @Query('year') year?: string) {
    const data = await this.vinDecode.decodeOne(vin, year ? parseInt(year, 10) : undefined);
    return { message: 'VIN decoded', data };
  }

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
  @UseInterceptors(
    FilesInterceptor('images', 10, {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({ description: 'Upload up to 10 vehicle images', schema: { type: 'object', properties: { images: { type: 'array', items: { type: 'string', format: 'binary' } } } } })
  @ApiOperation({ summary: 'Upload vehicle images', description: 'Uploads 1–10 images for a vehicle. Max 10MB each. Formats: jpg, jpeg, png, webp. Stored on Amazon S3 (public URL) when configured, else local /uploads.' })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId' })
  @ApiResponse({ status: 201, description: 'Images uploaded successfully' })
  async uploadImages(@Param('id') id: string, @UploadedFiles() files: Express.Multer.File[]) {
    if (!files?.length) throw new Error('No images uploaded');
    // Upload each buffer via StorageService → public S3 URL (or local path in
    // dev). The returned URLs are stored verbatim in vehicle.photos[]; the
    // frontend's fileUrl() passes absolute URLs through unchanged.
    const urls = await Promise.all(
      files.map((f) => this.storage.upload(f.buffer, f.originalname, f.mimetype, 'vehicles')),
    );
    const vehicle = await this.inventoryService.addImages(id, urls);
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
    description: 'Removes a photo from the vehicle\'s photos[] array and best-effort deletes the underlying object (S3 object or local file).',
  })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId' })
  @ApiBody({ description: 'Photo path to remove', schema: { type: 'object', properties: { photoPath: { type: 'string', example: '/uploads/vehicles/abc.jpg' } } } })
  async removeImage(@Param('id') id: string, @Body() body: { photoPath: string }) {
    const vehicle = await this.inventoryService.removeImage(id, body.photoPath);
    return { message: 'Image removed', data: vehicle };
  }

  /**
   * POST /api/v1/inventory/:id/spends
   */
  @Post(':id/spends')
  @RequirePermission(AppModule.INVENTORY, PermissionAction.EDIT)
  @ApiOperation({
    summary: 'Add a reconditioning spend to a vehicle',
    description: `Records money spent on the car (repairs, service, parts, transport, detailing, etc.).

Each spend is mirrored into the expense ledger as a category='reconditioning' row (counted toward Total Expenses exactly once, independent of sold status). Allowed even after the vehicle is sold — the Sale's spend snapshot re-syncs so the per-row margin stays accurate.`,
  })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId' })
  @ApiResponse({ status: 201, description: 'Spend added' })
  @ApiResponse({ status: 400, description: 'Invalid amount' })
  async addSpend(@Param('id') id: string, @Body() dto: CreateVehicleSpendDto, @CurrentUser() user: any) {
    const vehicle = await this.inventoryService.addSpend(id, dto, user);
    return { message: 'Spend added', data: vehicle };
  }

  /**
   * PATCH /api/v1/inventory/:id/spends/:spendId
   */
  @Patch(':id/spends/:spendId')
  @RequirePermission(AppModule.INVENTORY, PermissionAction.EDIT)
  @ApiOperation({
    summary: 'Edit a recorded spend',
    description: 'Updates amount/category/description/date. Allowed even after the vehicle is sold — the Sale\'s spend snapshot is re-synced so the P&L stays accurate.',
  })
  @ApiParam({ name: 'id', description: 'Vehicle MongoDB ObjectId' })
  @ApiParam({ name: 'spendId', description: 'Spend subdocument ObjectId' })
  @ApiResponse({ status: 200, description: 'Spend updated' })
  async updateSpend(
    @Param('id') id: string,
    @Param('spendId') spendId: string,
    @Body() dto: UpdateVehicleSpendDto,
    @CurrentUser() user: any,
  ) {
    const vehicle = await this.inventoryService.updateSpend(id, spendId, dto, user);
    return { message: 'Spend updated', data: vehicle };
  }

  /**
   * DELETE /api/v1/inventory/:id/spends/:spendId
   */
  @Delete(':id/spends/:spendId')
  @RequirePermission(AppModule.INVENTORY, PermissionAction.DELETE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a recorded spend',
    description: 'Removes a spend entry. Requires Inventory:delete. Allowed even after the vehicle is sold — the Sale\'s spend snapshot is re-synced so the P&L stays accurate.',
  })
  @ApiParam({ name: 'id', description: 'Vehicle MongoDB ObjectId' })
  @ApiParam({ name: 'spendId', description: 'Spend subdocument ObjectId' })
  @ApiResponse({ status: 200, description: 'Spend removed' })
  async removeSpend(@Param('id') id: string, @Param('spendId') spendId: string, @CurrentUser() user: any) {
    const vehicle = await this.inventoryService.removeSpend(id, spendId, user);
    return { message: 'Spend removed', data: vehicle };
  }

  /**
   * GET /api/v1/inventory/:id/activity
   */
  @Get(':id/activity')
  @RequirePermission(AppModule.INVENTORY, PermissionAction.VIEW)
  @ApiOperation({
    summary: 'Per-vehicle activity (views / inquiries / test drives + merged comms)',
    description: `Lifetime activity for the vehicle's Activity tab:
- \`views\`: storefront opens (traffic counter)
- \`inquiries\`: website-sourced leads for this vehicle
- \`testDrives\`: test-drive calendar events booked for this vehicle
- \`logs\`: merged, newest-first communication log from the communication_logs collection + lead / buyer / seller comms that reference this vehicle (each tagged with a \`source\`).`,
  })
  @ApiParam({ name: 'id', description: 'Vehicle MongoDB ObjectId' })
  @ApiResponse({ status: 200, description: 'Vehicle activity returned' })
  @ApiResponse({ status: 404, description: 'Vehicle not found' })
  async getVehicleActivity(@Param('id') id: string) {
    const data = await this.inventoryService.getVehicleActivity(id);
    return { message: 'Vehicle activity', data };
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
    summary: 'Bulk upload vehicles via CSV (with VIN auto-decode)',
    description: `Uploads a CSV file to create multiple vehicles at once.

**CSV Columns** (mirror the Add Vehicle form): title, company, model, trim, year, engine, fuelType, transmission, bodyType, vin, km, price, discount, owners, color, hosting, description (plus optional vehicleNumber — auto-generated if blank)

**VIN auto-decode:** every valid \`vin\` in the file is decoded up front via NHTSA's batch endpoint (≤50 VINs per request, chunked). Decoded specs (make/model/year/trim/engine/fuel/transmission/bodyType) **fill only the cells the CSV left blank** — an explicit CSV value always wins. So the minimal CSV is just \`vin,price\`. Decode is best-effort: if NHTSA is unreachable, those rows fall back to their CSV values.

**Required (after decode):** company, model, year, price. company/model/year may come from the VIN; price must be in the CSV. Rows still missing a required field are skipped and reported in \`errors\`.

**Enum columns (lowercase):** fuelType = petrol|diesel|electric|hybrid|cng · transmission = manual|automatic|cvt · hosting = self|platform. Blank enum cells fall back to schema defaults.

**Notes:**
- Duplicate VINs (already in inventory, or repeated within the file) are skipped and reported
- Returns \`{ created, decoded, errors[], totalRows }\``,
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
