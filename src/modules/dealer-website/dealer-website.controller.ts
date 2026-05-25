import { Controller, Get, Post, Param, Query, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { InventoryService } from '../inventory/inventory.service';

@ApiTags('Dealer Website')
@Controller({ path: 'website', version: '1' })
export class DealerWebsiteController {
  constructor(private readonly inventoryService: InventoryService) {}

  /**
   * GET /api/v1/website/inventory
   * Public vehicle listing
   */
  @Get('inventory')
  @Public()
  @ApiOperation({
    summary: 'Public vehicle listing',
    description: `No authentication required. Returns vehicles with status=unsold for public display.
Supports same query params as private inventory: page, limit, search, company, model, minPrice, maxPrice, fuelType, transmission.`,
  })
  @ApiResponse({ status: 200, description: 'Public vehicle list returned' })
  async getPublicInventory(@Query() query: any) {
    const result = await this.inventoryService.findAll({ ...query, status: 'unsold' });
    return { message: 'Available vehicles', data: result };
  }

  /**
   * GET /api/v1/website/inventory/:id
   * Public vehicle detail page
   */
  @Get('inventory/:id')
  @Public()
  @ApiOperation({
    summary: 'Public vehicle detail',
    description: 'No auth required. Returns full vehicle details + increments the public view counter (used as a marketing signal). Internal admin views do NOT count.',
  })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId' })
  @ApiResponse({ status: 200, description: 'Vehicle details returned' })
  @ApiResponse({ status: 404, description: 'Vehicle not found' })
  async getPublicVehicle(@Param('id') id: string) {
    const vehicle = await this.inventoryService.findById(id);
    // Public traffic counts; fire and forget so a counter failure doesn't 500 the page.
    this.inventoryService.incrementViews(id).catch(() => {});
    return { message: 'Vehicle details', data: vehicle };
  }

  /**
   * POST /api/v1/website/test-drive
   * Public test drive booking form
   */
  @Post('test-drive')
  @Public()
  @ApiOperation({
    summary: 'Book a test drive (public)',
    description: `No authentication required — for the public dealer website.

**Body fields:**
- vehicleId (string, required)
- vehicleTitle (string, required)  
- customerName (string, required)
- customerEmail (string, required)
- customerPhone (string, required)
- preferredDate (ISO date, required)
- notes (string, optional)`,
  })
  @ApiResponse({ status: 201, description: 'Test drive request received' })
  async bookTestDrive(@Body() dto: any) {
    // In production: this would create a calendar event + buyer lead
    return {
      message: 'Test drive request received! We will confirm within 24 hours.',
      data: { requestId: `TD-${Date.now()}`, ...dto, status: 'pending_confirmation' },
    };
  }

  /**
   * GET /api/v1/website/pages
   * CMS pages data
   */
  @Get('pages')
  @Public()
  @ApiOperation({ summary: 'Get website CMS pages', description: 'Returns static content pages: about, contact, services.' })
  async getPages() {
    return {
      message: 'Website pages',
      data: {
        about: { title: 'About Us', content: 'Welcome to our dealership.' },
        contact: { phone: '', email: '', address: '', hours: {} },
        services: ['Vehicle Sales', 'Trade-In', 'Financing', 'Test Drives', 'Inspection'],
      },
    };
  }
}
