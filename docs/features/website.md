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

## Security Hardening

### DOMPurify SVG Sanitization
- **Location**: `packages/website/app/components/wiki/MermaidDiagram.tsx`
- **Description**: Mermaid diagram SVG output sanitized with DOMPurify before DOM insertion to prevent XSS via injected SVG content

### Mermaid Security Level
- **Location**: `packages/website/app/components/wiki/MermaidDiagram.tsx`
- **Description**: Mermaid `securityLevel` set to `strict` to disable inline event handlers and script execution in diagrams

### Content Security Policy Headers
- **Location**: `packages/website/public/_headers`
- **Description**: CSP headers configured with script-src, style-src, img-src, and connect-src directives to restrict resource loading

### Security Headers
- **Location**: `packages/website/public/_headers`
- **Description**: X-Content-Type-Options, X-Frame-Options, Referrer-Policy, and Permissions-Policy headers added to all responses

### Self-Hosted Fonts
- **Location**: `packages/website/app/styles/global.css`
- **Description**: Google Fonts replaced with locally hosted font files to eliminate third-party tracking and external resource dependencies

### Download URL Domain Allowlist
- **Location**: `packages/website/app/routes/home.tsx`
- **Description**: GitHub release download URLs validated against an explicit domain allowlist before rendering as download links

### GitHub API Response Validation
- **Location**: `packages/website/app/routes/home.tsx`
- **Description**: GitHub API responses validated for expected structure before extracting release data

### Language Parameter Validation
- **Location**: `packages/website/app/routes/wiki.tsx`
- **Description**: Wiki language parameter validated against a known set of supported locales; invalid values fall back to English

### Slug Parameter Sanitization
- **Location**: `packages/website/app/routes/wiki.tsx`
- **Description**: Wiki slug parameter sanitized before rendering in error messages to prevent reflected content injection

### Error Boundary for Wiki Rendering
- **Location**: `packages/website/app/routes/wiki.tsx`
- **Description**: React error boundary wraps wiki and diagram rendering to catch runtime errors and prevent full-page crashes

### Mermaid Module State Isolation
- **Location**: `packages/website/app/components/wiki/MermaidDiagram.tsx`
- **Description**: Module-level mutable state replaced with component-scoped state to prevent cross-render contamination

### ARIA Accessibility Attributes
- **Location**: `packages/website/app/components/Nav.tsx`, `packages/website/app/components/wiki/WikiSidebar.tsx`
- **Description**: Navigation, sidebar, and interactive elements annotated with proper ARIA roles, labels, and landmarks

### OG and Twitter Meta Tags
- **Location**: `packages/website/app/root.tsx`
- **Description**: Open Graph and Twitter Card meta tags added for proper link preview rendering in social media and chat apps

### Sidebar Focus Management
- **Location**: `packages/website/app/components/wiki/WikiSidebar.tsx`
- **Description**: Sidebar focus trap and Escape key handler added for keyboard-accessible navigation

### Rel Attributes on Download Links
- **Location**: `packages/website/app/routes/home.tsx`
- **Description**: External download links include `rel="noopener noreferrer"` to prevent window.opener access

### HTML Lang Attribute
- **Location**: `packages/website/app/root.tsx`
- **Description**: HTML `lang` attribute set dynamically based on resolved locale instead of hardcoded "en"

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
