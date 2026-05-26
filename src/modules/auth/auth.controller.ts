import {
  Controller, Get, Post, Body, Param, HttpCode, HttpStatus, UseGuards, Req,
} from '@nestjs/common';
import {
  ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import {
  RegisterDto, LoginDto, RefreshTokenDto, ForgotPasswordDto, ResetPasswordDto,
  AcceptInviteDto,
} from './dto/auth.dto';
import { Public } from '../../common/decorators/public.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * POST /api/v1/auth/register
   * Register a new dealer/admin account
   */
  @Post('register')
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({
    summary: 'Register new dealer account',
    description: `Creates a new admin account for a dealership.
    
**Request Body:**
- \`firstName\` (string, required): First name
- \`lastName\` (string, required): Last name  
- \`email\` (string, required): Valid email address
- \`password\` (string, required): Min 8 chars, must contain uppercase, lowercase, and number/special char
- \`dealershipName\` (string, optional): Name of the dealership

**Response:** Access token + refresh token + user object`,
  })
  @ApiResponse({ status: 201, description: 'Account created — returns tokens + user object' })
  @ApiResponse({ status: 409, description: 'Email already registered' })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  async register(@Body() dto: RegisterDto) {
    const result = await this.authService.register(dto);
    return { message: 'Account created successfully', data: result };
  }

  /**
   * POST /api/v1/auth/login
   * Login with email and password
   */
  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary: 'Login',
    description: `Authenticates user and returns JWT tokens.

**Request Body:**
- \`email\` (string, required): Registered email
- \`password\` (string, required): Account password

**Response:** 
\`\`\`json
{
  "accessToken": "eyJ...",
  "refreshToken": "eyJ...",
  "user": { "id": "...", "email": "...", "role": "admin" }
}
\`\`\`

Use \`accessToken\` in the \`Authorization: Bearer <token>\` header for all protected routes.`,
  })
  @ApiResponse({ status: 200, description: 'Login successful — returns tokens' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  async login(@Body() dto: LoginDto) {
    const result = await this.authService.login(dto);
    return { message: 'Login successful', data: result };
  }

  /**
   * POST /api/v1/auth/refresh
   * Refresh access token using a valid refresh token
   */
  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Refresh access token',
    description: `Issues a new access token + refresh token pair using a valid refresh token.
    
**Request Body:**
- \`refreshToken\` (string, required): The refresh token received at login

**Note:** Each refresh rotates the refresh token (single-use).`,
  })
  @ApiResponse({ status: 200, description: 'Tokens refreshed' })
  @ApiResponse({ status: 401, description: 'Invalid or expired refresh token' })
  async refresh(@Body() dto: RefreshTokenDto) {
    const result = await this.authService.refreshTokens(dto);
    return { message: 'Tokens refreshed', data: result };
  }

  /**
   * POST /api/v1/auth/logout
   * Invalidate the current session
   */
  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Logout', description: 'Invalidates the refresh token, ending the session.' })
  @ApiResponse({ status: 200, description: 'Logged out successfully' })
  async logout(@CurrentUser() user: any) {
    await this.authService.logout(user._id.toString());
    return { message: 'Logged out successfully', data: null };
  }

  /**
   * POST /api/v1/auth/forgot-password
   * Send a password reset email
   */
  @Post('forgot-password')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @ApiOperation({
    summary: 'Forgot password',
    description: `Sends a password reset link to the given email address.

**Request Body:**
- \`email\` (string, required): Registered email

**Note:** Always returns 200 for security (even if email not found).`,
  })
  @ApiResponse({ status: 200, description: 'Reset link sent (if email exists)' })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    const result = await this.authService.forgotPassword(dto);
    return { ...result, data: null };
  }

  /**
   * POST /api/v1/auth/reset-password
   * Reset password using the token from email
   */
  @Post('reset-password')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reset password',
    description: `Resets the user password using a valid reset token.

**Request Body:**
- \`token\` (string, required): Token from the reset email link
- \`newPassword\` (string, required): New strong password`,
  })
  @ApiResponse({ status: 200, description: 'Password reset successful' })
  @ApiResponse({ status: 400, description: 'Invalid or expired token' })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    const result = await this.authService.resetPassword(dto);
    return { ...result, data: null };
  }

  /**
   * GET /api/v1/auth/invite/:token
   *
   * Public lookup so the frontend's /accept-invite page can render a
   * personalised welcome (name, email, role) before asking for a password.
   * Returns 404 if the token is invalid, expired, or already used —
   * frontend should redirect to /auth in that case.
   */
  @Get('invite/:token')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @ApiOperation({
    summary: 'Validate an invite token',
    description: `Returns the invitee's name, email, and role so the
accept-invite page can render a personalised set-password form. Token is the
raw string from the email link (NOT the hashed value stored in the DB).`,
  })
  @ApiParam({ name: 'token', description: 'Raw invite token from the email link' })
  @ApiResponse({ status: 200, description: 'Invite is valid' })
  @ApiResponse({ status: 404, description: 'Invite invalid, expired, or already used' })
  async getInvite(@Param('token') token: string) {
    const data = await this.authService.validateInvite(token);
    return { message: 'Invite valid', data };
  }

  /**
   * POST /api/v1/auth/accept-invite
   *
   * Consumes the invite: sets password, flips status to ACTIVE, clears the
   * invite token, and issues access + refresh tokens — same shape as
   * /auth/login. Frontend stores the tokens and routes to /.
   */
  @Post('accept-invite')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({
    summary: 'Accept an invite',
    description: `Activates an INVITED user. Sets their password, flips
status to ACTIVE, returns access + refresh tokens so the user is logged in
immediately — no separate sign-in step.`,
  })
  @ApiResponse({ status: 200, description: 'Account activated — returns tokens + user' })
  @ApiResponse({ status: 400, description: 'Invite invalid or expired' })
  async acceptInvite(@Body() dto: AcceptInviteDto) {
    const result = await this.authService.acceptInvite(dto);
    return { message: 'Account activated', data: result };
  }
}
