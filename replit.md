# UTS Startup Interface

## Overview

The UTS Startup Interface is a comprehensive web-based dashboard system designed to streamline startup onboarding and team management for the University of Technology Sydney (UTS). The platform provides secure, passwordless authentication through magic links and facilitates seamless integration with Airtable for data management. The system features a multi-step onboarding flow, real-time team member management, and a modern responsive design optimized for both desktop and mobile devices.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
The application uses vanilla HTML, CSS, and JavaScript with a modern ES6+ approach, avoiding complex frameworks to maintain simplicity and performance. The frontend implements a component-based structure with separate CSS and JavaScript modules for landing pages and dashboard functionality. The design system follows a dark theme with custom CSS variables for consistent styling across components.

### Backend Architecture
Built on Node.js with Express.js as the web framework, the backend follows a RESTful API pattern for handling authentication and data operations. The server implements JWT-based authentication with 15-minute token expiry for security, and includes comprehensive middleware for rate limiting, CORS, and security headers through Helmet.js.

### Authentication System
The platform uses a passwordless authentication system based on JWT tokens delivered via magic links. This approach eliminates password management overhead while maintaining security through short-lived tokens and email verification.

### Data Management
Instead of a traditional database, the system integrates directly with Airtable as the primary data store. This decision provides a user-friendly interface for administrators to manage data while maintaining programmatic access through the Airtable API. The system manages three core data entities: EOI submissions, startup information, and team member details.

### Security Implementation
Security is implemented through multiple layers including request rate limiting, CORS configuration, Content Security Policy headers, and JWT token validation. The system includes protection against common web vulnerabilities and implements proper input validation and sanitization.

### User Interface Design
The frontend architecture emphasizes progressive enhancement with smooth animations, responsive design, and accessibility compliance. The interface uses a step-by-step onboarding flow with visual progress indicators and dynamic form management for adding multiple team members.

## External Dependencies

### Core Technologies
- **Node.js Runtime** (>=16.0.0) - Server-side JavaScript execution environment
- **Express.js** (^4.18.2) - Web application framework for routing and middleware
- **Airtable API** (^0.12.2) - Cloud database integration for data storage and management

### Authentication & Security
- **JSON Web Tokens** (^9.0.2) - Stateless authentication token management
- **Helmet.js** (^7.1.0) - Security middleware for HTTP headers protection
- **Express Rate Limit** (^7.1.5) - Request rate limiting and DDoS protection
- **CORS** (^2.8.5) - Cross-origin resource sharing configuration

### Development & Utilities
- **dotenv** (^16.3.1) - Environment variable management
- **body-parser** (^1.20.2) - HTTP request body parsing middleware
- **crypto** (^1.0.1) - Cryptographic functionality for token generation
- **nodemon** (^3.0.1) - Development server with auto-restart functionality

### Frontend Libraries
- **SweetAlert2** - Enhanced user notification and dialog system
- **Font Awesome** (6.4.0) - Icon library for user interface elements
- **Google Fonts** (Inter) - Typography and font rendering

### Cloud Services
- **Airtable Base** - Primary database for storing startup and team information
- **Replit Hosting** - Application deployment and hosting platform
- **GitHub Integration** - Source code management and version control