# Website Features

## Landing Page (Home Route)

### Hero Section
- **Location**: `packages/website/app/routes/home.tsx:L97-117`
- **Description**: Main landing section with headline, tagline, and dual call-to-action buttons (Download and Guide)

### Features Section
- **Location**: `packages/website/app/routes/home.tsx:L119-171`
- **Description**: Grid of 6 feature cards highlighting app capabilities (Encryption, P2P, Local Discovery, Cross-Platform, File Sharing, No Account Required)

### Downloads Section
- **Location**: `packages/website/app/routes/home.tsx:L173-213`
- **Description**: Platform download cards with automatic device detection showing Android, iOS, Windows, macOS, and Linux with GitHub API integration for latest release assets

### App Store Badges Section
- **Location**: `packages/website/app/routes/home.tsx:L215-237`
- **Description**: Coming soon badges for Google Play, Apple App Store, and Microsoft Store

### Platform Detection Feature
- **Location**: `packages/website/app/routes/home.tsx:L51-96`
- **Description**: Client-side JavaScript that detects user's OS and highlights recommended download platform

### Dynamic Release Integration
- **Location**: `packages/website/app/routes/home.tsx:L24-95`
- **Description**: Fetches latest GitHub release data and maps platform-specific assets, showing version number

## User Guide Page

### Getting Started Section
- **Location**: `packages/website/app/routes/guide.tsx:L47-72`
- **Description**: Installation instructions for all supported platforms with download and build information

### Automatic Peer Discovery Documentation
- **Location**: `packages/website/app/routes/guide.tsx:L75-85`
- **Description**: Explains mDNS-based peer discovery mechanism and automatic network presence broadcasting

### Connecting to Peers Documentation
- **Location**: `packages/website/app/routes/guide.tsx:L86-111`
- **Description**: Step-by-step guide for peer connection with connection state indicators

### Sending Messages Documentation
- **Location**: `packages/website/app/routes/guide.tsx:L112-123`
- **Description**: Instructions for messaging with encryption details (X25519 and ChaCha20-Poly1305)

### File Sharing Documentation
- **Location**: `packages/website/app/routes/guide.tsx:L124-131`
- **Description**: File transfer process with chunking and encryption explanation

### Display Name Configuration
- **Location**: `packages/website/app/routes/guide.tsx:L133-141`
- **Description**: Guide for changing user profile display name visible to other peers

### User Blocking Documentation
- **Location**: `packages/website/app/routes/guide.tsx:L142-153`
- **Description**: Instructions for blocking users from settings menu

### Troubleshooting Section
- **Location**: `packages/website/app/routes/guide.tsx:L154-196`
- **Description**: Common issues and solutions for peer discovery, connection, and messaging problems

### Security Documentation
- **Location**: `packages/website/app/routes/guide.tsx:L197-229`
- **Description**: Technical security details including X25519 key exchange, ChaCha20-Poly1305 encryption, P2P architecture diagram

### FAQ Section
- **Location**: `packages/website/app/routes/guide.tsx:L230-263`
- **Description**: Answers to common questions about internet connectivity, data storage, offline usage, connection loss

### Table of Contents Navigation
- **Location**: `packages/website/app/routes/guide.tsx:L25-45`
- **Description**: Guide page navigation with anchor links to all major sections

## Navigation Component

### Logo and Navigation Bar
- **Location**: `packages/website/app/components/Nav.tsx:L1-23`
- **Description**: Sticky header with Zajel branding, internal route links (Guide), external links (GitHub, HamzaLabs)

## Footer Component

### Footer Links
- **Location**: `packages/website/app/components/Footer.tsx:L1-35`
- **Description**: Social links (GitHub), Privacy Policy, User Guide link, company website link, copyright with MIT License

## Styling and Theme System

### Color Theme and Design System
- **Location**: `packages/website/app/styles/global.css:L1-12`
- **Description**: CSS custom properties for dark theme with Indigo primary, Emerald secondary, and slate color palette

### Responsive Design
- **Location**: `packages/website/app/styles/global.css:L427-452`
- **Description**: Mobile breakpoints for hero text, navigation, and download grid layout adjustments

## Build and Deployment

### React Router Configuration
- **Location**: `packages/website/react-router.config.ts:L1-5`
- **Description**: SPA mode configuration for static Cloudflare Pages deployment

### Vite Build Configuration
- **Location**: `packages/website/vite.config.ts:L1-12`
- **Description**: Vite configuration with React Router plugin and path alias

### Cloudflare Pages Deployment
- **Location**: `packages/website/wrangler.jsonc:L1-24`
- **Description**: Wrangler configuration for static asset deployment with production and QA environments

### Development and Build Commands
- **Location**: `packages/website/package.json:L6-12`
- **Description**: npm scripts for dev server, production build, preview, and Cloudflare Pages deployment
