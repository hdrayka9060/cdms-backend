# 🚗 CDMS Backend — Car Dealer Management System

> **NestJS + MongoDB REST API** — Robust, Scalable, Secure

[![NestJS](https://img.shields.io/badge/NestJS-10.x-E0234E?style=flat-square&logo=nestjs)](https://nestjs.com)
[![MongoDB](https://img.shields.io/badge/MongoDB-8.x-47A248?style=flat-square&logo=mongodb)](https://mongodb.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript)](https://typescriptlang.org)
[![Swagger](https://img.shields.io/badge/Swagger-OpenAPI_3.0-85EA2D?style=flat-square&logo=swagger)](http://localhost:3000/api/docs)

---

## 📋 Table of Contents

- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Quick Start](#quick-start)
- [API Documentation](#api-documentation)
- [Security](#security)
- [Modules & Endpoints](#modules--endpoints)

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 LTS |
| Framework | NestJS 10 |
| Database | MongoDB via Mongoose ODM |
| Auth | JWT (Access 15m + Refresh 7d) |
| File Storage | Multer (local) |
| API Docs | Swagger UI at `/api/docs` |
| Validation | class-validator + class-transformer |
| Security | Helmet, CORS, Rate Limiting, bcrypt |

---

## Project Structure

```
cdms-backend/
├── src/
│   ├── main.ts                        # Bootstrap + Swagger
│   ├── app.module.ts                  # Root module
│   ├── common/
│   │   ├── decorators/                # @Roles, @CurrentUser, @Public
│   │   ├── guards/                    # JwtAuthGuard, RolesGuard
│   │   ├── filters/                   # HttpExceptionFilter
│   │   ├── interceptors/              # ResponseInterceptor, LoggingInterceptor
│   │   └── dto/                       # PaginationDto, PaginatedResult
│   └── modules/
│       ├── auth/                      # Register, Login, Refresh, Reset
│       ├── users/                     # User management + RBAC
│       ├── dashboard/                 # Stats + chart aggregations
│       ├── inventory/                 # Vehicles CRUD + CSV + images
│       ├── crm-sellers/               # Seller pipeline
│       ├── crm-buyers/                # Buyer pipeline + test drives
│       ├── calendar/                  # Events + scheduling
│       ├── accounting/                # Sales, expenses, P&L
│       ├── bhph/                      # Loans + EMI
│       ├── marketing/                 # Campaign metrics
│       ├── dealer-website/            # Public APIs
│       ├── support/                   # Tickets + threads
│       ├── communication/             # Email/SMS/WhatsApp/Call logs
│       └── settings/                  # Dealership config
├── uploads/                           # Local file storage
├── .env.example                       # Environment template
├── package.json
└── README.md
```

---

## Quick Start

### 1. Install dependencies
```bash
cd cdms-backend
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env and set MONGODB_URI to your MongoDB Atlas connection string
```

### 3. Start development server
```bash
npm run start:dev
```

### 4. Open API Documentation
```
http://localhost:3000/api/docs
```

---

## API Documentation

Interactive Swagger UI available at: **`http://localhost:3000/api/docs`**

### Response Envelope
All API responses follow this format:
```json
{
  "success": true,
  "statusCode": 200,
  "message": "Operation successful",
  "data": { ... },
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### Error Envelope
```json
{
  "success": false,
  "statusCode": 400,
  "message": ["Validation error 1", "Validation error 2"],
  "error": "BadRequestException",
  "path": "/api/v1/inventory",
  "method": "POST",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

---

## Security

| Feature | Implementation |
|---|---|
| Authentication | JWT Access Token (15min) + Refresh Token (7d, rotated) |
| Password Hashing | bcrypt with 12 salt rounds |
| HTTP Headers | Helmet (XSS, clickjacking, etc.) |
| CORS | Configured for allowed origins only |
| Rate Limiting | 100 req/min global, 5 req/min on register, 10 req/min on login |
| Input Validation | class-validator with whitelist + forbidNonWhitelisted |
| RBAC | Role-based guards: admin, manager, sales_agent, support |
| Soft Deletes | No hard deletes — data preserved with isDeleted flag |

---

## Modules & Endpoints

### 🔐 Auth — `/api/v1/auth`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/register` | ❌ Public | Register new dealer admin account |
| `POST` | `/login` | ❌ Public | Login, get access + refresh tokens |
| `POST` | `/refresh` | ❌ Public | Refresh access token |
| `POST` | `/logout` | ✅ JWT | Invalidate refresh token |
| `POST` | `/forgot-password` | ❌ Public | Send password reset email |
| `POST` | `/reset-password` | ❌ Public | Reset password with token |

**Login request:**
```json
{ "email": "admin@cdms.com", "password": "P@ssw0rd!" }
```
**Login response:**
```json
{
  "accessToken": "eyJ...",
  "refreshToken": "eyJ...",
  "user": { "_id": "...", "email": "...", "role": "admin" }
}
```

---

### 👥 Users — `/api/v1/users`

| Method | Endpoint | Auth | Roles | Description |
|--------|----------|------|-------|-------------|
| `POST` | `/` | ✅ JWT | admin | Create user |
| `GET` | `/` | ✅ JWT | admin, manager | List all users (paginated) |
| `GET` | `/me` | ✅ JWT | Any | Get own profile |
| `GET` | `/:id` | ✅ JWT | admin, manager | Get user by ID |
| `PATCH` | `/:id` | ✅ JWT | admin or self | Update user |
| `PATCH` | `/me/change-password` | ✅ JWT | Self | Change own password |
| `DELETE` | `/:id` | ✅ JWT | admin | Soft delete user |

**User roles:** `admin` · `manager` · `sales_agent` · `support`

---

### 📊 Dashboard — `/api/v1/dashboard`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/stats` | ✅ JWT | Summary cards: vehicles, revenue, leads, test drives |
| `GET` | `/charts` | ✅ JWT | Line chart (monthly sales), pie chart (vehicle status), funnel (leads) |

---

### 🚗 Inventory — `/api/v1/inventory`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/` | ✅ JWT | Add vehicle |
| `GET` | `/` | ✅ JWT | List vehicles (paginated + filtered) |
| `GET` | `/stats` | ✅ JWT | Count by status + avg price |
| `GET` | `/:id` | ✅ JWT | Vehicle detail (increments view count) |
| `PATCH` | `/:id` | ✅ JWT | Update vehicle (changes tracked in history) |
| `DELETE` | `/:id` | ✅ JWT | admin/manager | Soft delete |
| `POST` | `/:id/images` | ✅ JWT | Upload vehicle images (max 10) |
| `POST` | `/bulk-upload` | ✅ JWT | admin/manager | CSV bulk import |
| `GET` | `/:id/history` | ✅ JWT | Field change history log |
| `GET` | `/:id/traffic` | ✅ JWT | Views, clicks, inquiries stats |

**Query parameters for `GET /inventory`:**
```
page, limit, search, sort, status, company, model, minPrice, maxPrice, minYear, maxYear, fuelType, transmission
```

**Vehicle statuses:** `pending` · `unsold` · `sold`

**CSV bulk upload columns:**
```
vehicleNumber, title, company, model, year, price, kmDriven, discountPercent, ownerCount, fuelType, transmission, color, description, vin
```

---

### 👤 CRM Sellers — `/api/v1/crm/sellers`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/` | ✅ JWT | Create seller lead |
| `GET` | `/` | ✅ JWT | List leads (filter by stage) |
| `GET` | `/pipeline-stats` | ✅ JWT | Count + value per pipeline stage |
| `GET` | `/:id` | ✅ JWT | Seller lead detail |
| `PATCH` | `/:id` | ✅ JWT | Update stage, notes, assignee |
| `POST` | `/:id/inspection` | ✅ JWT | Schedule inspection |
| `POST` | `/:id/communicate` | ✅ JWT | Log communication |
| `DELETE` | `/:id` | ✅ JWT | Soft delete |

**Lead stages:** `new` → `contacted` → `inspection` → `negotiation` → `sold` / `rejected`

**Communication channels:** `email` · `sms` · `whatsapp` · `call`

---

### 👤 CRM Buyers — `/api/v1/crm/buyers`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/` | ✅ JWT | Create buyer lead |
| `GET` | `/` | ✅ JWT | List leads (filter by stage) |
| `GET` | `/:id` | ✅ JWT | Buyer lead detail |
| `PATCH` | `/:id` | ✅ JWT | Update lead |
| `POST` | `/:id/test-drive` | ✅ JWT | Book test drive → stage: test_drive |
| `GET` | `/:id/history` | ✅ JWT | Booking and purchase history |
| `DELETE` | `/:id` | ✅ JWT | Soft delete |

**Buyer stages:** `new` → `contacted` → `test_drive` → `negotiation` → `purchased` / `lost`

---

### 📅 Calendar — `/api/v1/calendar`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/events` | ✅ JWT | Create event (auto-generates Meet link for meetings) |
| `GET` | `/events` | ✅ JWT | List events (filter by type, date range) |
| `GET` | `/events/upcoming` | ✅ JWT | Next 7 days events |
| `GET` | `/events/:id` | ✅ JWT | Event detail |
| `PATCH` | `/events/:id` | ✅ JWT | Update event |
| `DELETE` | `/events/:id` | ✅ JWT | Delete event |
| `POST` | `/block` | ✅ JWT | Block unavailable time slot |

**Event types:** `test_drive` · `inspection` · `meeting` · `blocked`

---

### 💰 Accounting — `/api/v1/accounting`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/summary` | ✅ JWT | Revenue, profit, expenses, outstanding (with date filter) |
| `GET` | `/sales` | ✅ JWT | Sales ledger (paginated) |
| `POST` | `/sales` | ✅ JWT | Record a sale |
| `GET` | `/expenses` | ✅ JWT | Expense list |
| `POST` | `/expenses` | ✅ JWT | Add expense |
| `GET` | `/profit-loss` | ✅ JWT | Monthly P&L for date range |

---

### 🏦 BHPH — `/api/v1/bhph`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/loans` | ✅ JWT | Create loan (EMI auto-calculated) |
| `GET` | `/loans` | ✅ JWT | List loans (filter by status) |
| `GET` | `/summary` | ✅ JWT | Portfolio totals by status |
| `GET` | `/loans/:id` | ✅ JWT | Loan detail + full amortization schedule |
| `POST` | `/loans/:id/payment` | ✅ JWT | Record installment payment |

**EMI Formula:** `EMI = P × r × (1+r)^n / ((1+r)^n - 1)`

---

### 📣 Marketing — `/api/v1/marketing`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/campaigns` | ✅ JWT | Create campaign |
| `GET` | `/campaigns` | ✅ JWT | List campaigns (filter by platform, status) |
| `GET` | `/metrics` | ✅ JWT | Aggregated metrics per platform |
| `GET` | `/campaigns/:id` | ✅ JWT | Campaign detail |
| `PATCH` | `/campaigns/:id` | ✅ JWT | Update campaign |
| `POST` | `/campaigns/:id/refresh-metrics` | ✅ JWT | Refresh mock metrics |

**Platforms:** `google` · `meta` · `instagram` · `email`

---

### 🌐 Dealer Website (Public) — `/api/v1/website`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/inventory` | ❌ Public | Public vehicle listing (status=unsold) |
| `GET` | `/inventory/:id` | ❌ Public | Public vehicle detail |
| `POST` | `/test-drive` | ❌ Public | Public test drive booking form |
| `GET` | `/pages` | ❌ Public | CMS pages (about, contact, services) |

---

### 🎫 Support — `/api/v1/support`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/tickets` | ✅ JWT | Raise a support ticket |
| `GET` | `/tickets` | ✅ JWT | List tickets (filter by status, priority, category) |
| `GET` | `/stats` | ✅ JWT | Ticket counts by status |
| `GET` | `/tickets/:id` | ✅ JWT | Ticket detail + communication thread |
| `POST` | `/tickets/:id/reply` | ✅ JWT | Add message to thread |
| `PATCH` | `/tickets/:id/status` | ✅ JWT | Update ticket status |
| `POST` | `/tickets/:id/attachments` | ✅ JWT | Upload up to 5 files |

**Statuses:** `open` · `in_progress` · `resolved` · `closed`
**Priorities:** `low` · `medium` · `high` · `urgent`

---

### 📬 Communication — `/api/v1/communication`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/logs` | ✅ JWT | All communication logs (filter by channel, vehicle) |
| `GET` | `/stats` | ✅ JWT | Per-channel statistics |
| `POST` | `/email` | ✅ JWT | Send email (logged) |
| `POST` | `/sms` | ✅ JWT | Send SMS (mock + logged) |
| `POST` | `/whatsapp` | ✅ JWT | Send WhatsApp (mock + logged) |
| `POST` | `/call` | ✅ JWT | Log call interaction |

---

### ⚙️ Settings — `/api/v1/settings`

| Method | Endpoint | Auth | Roles | Description |
|--------|----------|------|-------|-------------|
| `GET` | `/` | ✅ JWT | Any | Get dealership settings |
| `PATCH` | `/` | ✅ JWT | admin | Update settings |
| `PATCH` | `/notifications` | ✅ JWT | admin | Update notification preferences |

---

## File Upload Limits

| Type | Location | Max Files | Max Size |
|------|----------|-----------|----------|
| Vehicle images | `/uploads/vehicles/` | 10 per request | 10 MB each |
| Support attachments | `/uploads/tickets/` | 5 per request | 10 MB each |
| CSV bulk import | `/uploads/temp/` | 1 | 10 MB |

---

## Environment Variables

See `.env.example` for the full list. Key variables:

```env
PORT=3000
MONGODB_URI=<your-mongodb-atlas-uri>
JWT_ACCESS_SECRET=<strong-secret>
JWT_REFRESH_SECRET=<strong-secret>
```
