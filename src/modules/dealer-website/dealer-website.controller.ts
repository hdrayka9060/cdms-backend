import { Controller, Get, Post, Param, Query, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { InventoryService } from '../inventory/inventory.service';
import { BuyerPortalService } from './buyer-portal.service';
import { WebsiteInquiryService } from './website-inquiry.service';
import { WebsiteInquiryDto } from './dto/website-inquiry.dto';

@ApiTags('Dealer Website')
@Controller({ path: 'website', version: '1' })
export class DealerWebsiteController {
  constructor(
    private readonly inventoryService: InventoryService,
    private readonly buyerPortalService: BuyerPortalService,
    private readonly inquiryService: WebsiteInquiryService,
  ) {}

  /**
   * GET /api/v1/website/portal/:id
   * Public, read-only Buyer Portal for a single lead. The lead id IS the
   * access key (the dealer emails the link), so the route is rate-limited and
   * returns a generic 404 for any missing/invalid lead (never leaks why).
   * ThrottlerGuard is attached explicitly because it is not a global guard.
   */
  @Get('portal/:id')
  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @ApiOperation({
    summary: 'Public buyer portal',
    description:
      'No auth — addressed by lead id. Returns the buyer greeting, journey status, the lead vehicle, sold-state (price only if sold to THIS buyer), appointments (lead-linked calendar events), communication history (channel + date only), dealer contact, and a browse-more URL.',
  })
  @ApiParam({ name: 'id', description: 'Lead MongoDB ObjectId' })
  @ApiResponse({ status: 200, description: 'Buyer portal payload' })
  @ApiResponse({ status: 404, description: 'Portal not found' })
  async getBuyerPortal(@Param('id') id: string) {
    const data = await this.buyerPortalService.getBuyerPortal(id);
    return { message: 'Buyer portal', data };
  }

  /**
   * GET /api/v1/website/inventory
   * Public vehicle listing
   */
  @Get('inventory')
  @Public()
  @ApiOperation({
    summary: 'Public vehicle listing',
    description: `No authentication required. Returns every vehicle the dealer has PUBLISHED to the website, regardless of status (new / available / sold). Soft-deleted vehicles are always excluded. A published sold car renders with a "Sold" badge.
Supports same query params as private inventory: page, limit, search, company, model, minPrice, maxPrice, fuelType, transmission.`,
  })
  @ApiResponse({ status: 200, description: 'Public vehicle list returned' })
  async getPublicInventory(@Query() query: any) {
    // Public storefront shows every vehicle the dealer PUBLISHED, whatever its
    // sale status. The only exclusion is soft-deleted vehicles, which
    // InventoryService.findAll already filters out (isDeleted: false). A
    // published sold car still renders with a "Sold" badge on the storefront.
    const result = await this.inventoryService.findAll({
      ...query,
      publishedToWebsite: true,
    } as any);
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
    // Pure read — NO side effect. The view counter is bumped by an explicit
    // POST /website/inventory/:id/view fired once per storefront detail-page
    // open, so React StrictMode double-mounts / refetches / prefetch / bots
    // hitting this GET can't inflate the count.
    const vehicle = await this.inventoryService.findById(id);
    return { message: 'Vehicle details', data: vehicle };
  }

  /**
   * POST /api/v1/website/inventory/:id/view
   * Records a single public view. Called once per storefront detail-page open
   * (decoupled from the GET above so reads stay side-effect-free). Rate-limited
   * to curb counter abuse.
   */
  @Post('inventory/:id/view')
  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @ApiOperation({
    summary: 'Record a public vehicle view',
    description: 'Increments the vehicle traffic view counter by one. No auth. Idempotent per page open on the client side; rate-limited server side.',
  })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId' })
  @ApiResponse({ status: 201, description: 'View recorded' })
  async recordVehicleView(@Param('id') id: string) {
    // Fire-and-forget semantics: a counter failure must never break the page.
    await this.inventoryService.incrementViews(id).catch(() => {});
    return { message: 'View recorded', data: { counted: true } };
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
   * POST /api/v1/website/inquiry
   * Public website form submission (financing, service, car-finder,
   * appointment, contact). Rate-limited to curb spam.
   */
  @Post('inquiry')
  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary: 'Submit a website inquiry (public)',
    description:
      'No auth required. Creates/updates a CRM buyer from the contact details and opens a website-sourced lead when a vehicleId is supplied. Backs the financing, service, car-finder, appointment and contact forms.',
  })
  @ApiResponse({ status: 201, description: 'Inquiry received' })
  async submitInquiry(@Body() dto: WebsiteInquiryDto) {
    const data = await this.inquiryService.submit(dto);
    return {
      message: 'Thank you! We have received your request and will be in touch shortly.',
      data,
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
