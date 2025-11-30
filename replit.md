# AppOmar WhatsApp Bot

## Overview

AppOmar is a WhatsApp bot application designed to download and distribute APK files from Google Play Store. The system consists of two main components:

1. **Node.js WhatsApp Bot** - Handles WhatsApp messaging, user interactions, and APK requests using the Baileys library
2. **Python FastAPI Server** - Manages APK downloads, web scraping, caching, and file delivery

The bot allows users to request Android applications through WhatsApp messages, which are then downloaded from APKPure and delivered back to the user. The system includes sophisticated caching, concurrent download management, and automated cleanup mechanisms.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Communication Pattern
- **Dual-Language Architecture**: The application uses both Node.js and Python in a complementary architecture
  - Node.js handles WhatsApp protocol integration and real-time messaging
  - Python handles web scraping, download management, and HTTP serving
  - Communication between components occurs through file system (downloads directory) and potentially HTTP calls

### WhatsApp Integration Layer (Node.js)
- **Technology**: @whiskeysockets/baileys library for WhatsApp Web API
- **Authentication**: Multi-file auth state with session persistence in `session/` directory
- **Connection Management**: Automatic reconnection with exponential backoff on disconnections
- **Message Processing**: Real-time message handling with command parsing and response generation

**Design Rationale**: Baileys was chosen as it provides a stable, actively maintained WhatsApp Web API implementation without requiring Selenium or browser automation. The multi-file auth state allows session persistence across restarts.

### Download Management Layer (Python)
- **Framework**: FastAPI for high-performance async HTTP server
- **Web Scraping**: cloudscraper and BeautifulSoup4 for bypassing anti-bot protection on APKPure
- **HTTP Client**: httpx for async HTTP requests with curl-cffi as fallback for cloudflare bypass
- **Concurrency Control**: 
  - Per-URL download locks to prevent duplicate downloads
  - User-based download tracking to manage multiple simultaneous user requests
  - Background task scheduling for file cleanup

**Design Rationale**: FastAPI provides native async support crucial for handling multiple concurrent downloads. The combination of cloudscraper and curl-cffi ensures reliable scraping even with aggressive anti-bot measures.

### Caching Strategy
- **Multi-Level Caching**:
  - URL cache with 30-minute TTL for APK download links
  - File cache for downloaded APK files
  - Metadata tracking for quick lookups
- **Cache Invalidation**: Time-based expiration with automatic cleanup
- **Storage**: Local filesystem in `app_cache/` and `downloads/` directories

**Design Rationale**: Multi-level caching minimizes redundant downloads and API calls. URL caching prevents re-scraping for popular apps, while file caching enables instant delivery for repeated requests.

### File Management
- **Download Location**: Separate directories for Python (`app_cache/`) and Node.js (`downloads/`)
- **Cleanup Strategy**: 
  - Automatic deletion of files older than 30 minutes
  - Periodic cleanup jobs (every 10 minutes for Node.js)
  - Pending deletion tracking to prevent premature removal
- **File Identification**: UUID-based naming with MD5 hashing for deduplication

**Design Rationale**: Time-based cleanup balances storage efficiency with user experience, ensuring files remain available for reasonable timeframes while preventing disk bloat.

### Media Processing
- **Image Processing**: Sharp library for image manipulation and optimization
- **Format Support**: Profile pictures, app icons, and media attachments
- **Optimization**: Automatic compression and resizing for WhatsApp delivery

### API Design
- **RESTful Endpoints**: Standard HTTP methods for download initiation and status checking
- **Error Handling**: Structured error responses with appropriate HTTP status codes
- **CORS**: Configured for cross-origin requests if needed
- **Response Types**: JSON for metadata, FileResponse for binary downloads

### Monitoring & Statistics
- **Metrics Tracking**:
  - Total requests counter
  - Cache hit rate
  - Active download count
  - Cached files count
- **Logging**: Pino (Node.js) for structured logging, Python stderr for scraper logs

**Design Rationale**: Lightweight metrics provide operational visibility without external dependencies, suitable for monitoring bot performance and cache efficiency.

### Developer Access Control
- **Privileged Numbers**: Hardcoded list of developer phone numbers for administrative commands
- **Authorization**: Simple phone number matching (no OAuth/JWT complexity)

**Design Rationale**: Simple authorization appropriate for a personal/small-scale bot without requiring complex authentication infrastructure.

## External Dependencies

### Third-Party Services
- **APKPure**: Primary source for APK downloads (web scraping, no official API)
- **Google Play Store**: Metadata scraping via google-play-scraper library
- **WhatsApp Web**: Real-time messaging protocol via Baileys library

### Database
- **PostgreSQL**: User data, download history, and application state persistence
- **Connection**: pg library with connection pooling
- **Schema Management**: SQL schema file in `database/schema.sql`
- **Environment-Based**: Falls back gracefully if DATABASE_URL not provided

**Note**: Database is optional for basic functionality; the bot can operate with in-memory state only.

### Key NPM Dependencies
- `@whiskeysockets/baileys` - WhatsApp Web API client
- `google-play-scraper` - Google Play Store metadata extraction
- `pg` - PostgreSQL client with connection pooling
- `sharp` - High-performance image processing
- `axios` - HTTP client for API calls
- `pino` - Fast JSON logging

### Key Python Dependencies
- `fastapi` - Modern async web framework
- `httpx` - Async HTTP client
- `cloudscraper` - Anti-bot bypass for web scraping
- `curl-cffi` - Cloudflare bypass with browser impersonation
- `beautifulsoup4` - HTML parsing
- `aiofiles` - Async file I/O
- `psycopg2-binary` - PostgreSQL adapter

### Infrastructure Requirements
- **Node.js Runtime**: ES modules support (type: "module")
- **Python Runtime**: 3.7+ with async/await support
- **Storage**: Local filesystem for file caching
- **Network**: Outbound HTTP/HTTPS for APK downloads and WhatsApp connectivity