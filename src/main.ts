import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'error', 'warn', 'debug'],
  });

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3000);
  const apiPrefix = configService.get<string>('API_PREFIX', 'api');
  const allowedOrigins = configService
    .get<string>('ALLOWED_ORIGINS', 'http://localhost:3000')
    .split(',');

  // ── Security ──────────────────────────────────────────────────────────────
  app.use(helmet());
  app.enableCors({
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });

  // ── Global prefix ─────────────────────────────────────────────────────────
  app.setGlobalPrefix(apiPrefix);

  // ── Versioning ────────────────────────────────────────────────────────────
  app.enableVersioning({ type: VersioningType.URI });

  // ── Global pipes / filters / interceptors ─────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new LoggingInterceptor(), new ResponseInterceptor());

  // ── Swagger ───────────────────────────────────────────────────────────────
  const swaggerConfig = new DocumentBuilder()
    .setTitle('CDMS API')
    .setDescription(
      `## Car Dealer Management System — REST API

### Authentication
All protected endpoints require a **Bearer token** in the \`Authorization\` header.

\`\`\`
Authorization: Bearer <access_token>
\`\`\`

Get your token from \`POST /api/v1/auth/login\`.

### Rate Limiting
- 100 requests per 60 seconds per IP (default)
- Auth endpoints: 10 requests per 60 seconds

### Response Format
All responses follow the standard envelope:
\`\`\`json
{
  "success": true,
  "statusCode": 200,
  "message": "Operation successful",
  "data": { ... },
  "timestamp": "2024-01-01T00:00:00.000Z"
}
\`\`\`
`,
    )
    .setVersion('1.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', in: 'header' },
      'access-token',
    )
    .addTag('Auth', 'Authentication & authorization endpoints')
    .addTag('Users', 'User management & RBAC')
    .addTag('Dashboard', 'Summary stats and chart data')
    .addTag('Inventory', 'Vehicle inventory management')
    .addTag('CRM Sellers', 'Seller lead pipeline management')
    .addTag('CRM Buyers', 'Buyer lead & test-drive management')
    .addTag('Calendar', 'Scheduling & event management')
    .addTag('Accounting', 'Sales ledger, expenses & P&L')
    .addTag('BHPH', 'Buy Here Pay Here — dealer financing')
    .addTag('Marketing', 'Digital marketing campaign metrics')
    .addTag('Dealer Website', 'Public-facing website APIs')
    .addTag('Support', 'Support ticket system')
    .addTag('Communication', 'Unified communication logs')
    .addTag('Settings', 'Dealership configuration')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup(`${apiPrefix}/docs`, app, document, {
    swaggerOptions: {
      persistAuthorization: true,
      tagsSorter: 'alpha',
      operationsSorter: 'method',
    },
    customSiteTitle: 'CDMS API Documentation',
  });

  await app.listen(port);
  console.log(`\n🚀 CDMS Backend is running on: http://localhost:${port}`);
  console.log(`📚 API Documentation: http://localhost:${port}/${apiPrefix}/docs`);
  console.log(`🌍 Environment: ${configService.get('NODE_ENV', 'development')}\n`);
}
bootstrap();
