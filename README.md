# UTS Startup Interface

A world-class web-based dashboard system for UTS startups to manage their team information through Airtable integration, featuring secure email-based access and comprehensive onboarding flows.

## 🚀 Features

### Core Functionality
- **Secure Magic Link Authentication** - JWT-based temporary access without passwords
- **Multi-step Onboarding Flow** - Guided startup registration process
- **Team Management** - Add, edit, and manage team member information
- **Real-time Airtable Sync** - All changes automatically synchronized
- **Mobile Responsive Design** - Works perfectly on all devices
- **EOI Integration** - Supports approved Expression of Interest workflows

### Enhanced User Experience
- **World-class UI/UX** - Modern dark theme with smooth animations
- **Progressive Onboarding** - Step-by-step completion with visual feedback
- **Dynamic Form Management** - Add multiple team members with ease
- **Comprehensive Error Handling** - User-friendly error messages and validation
- **Accessibility Support** - WCAG compliant with keyboard navigation

## 🏗️ Architecture

### Technology Stack
- **Backend**: Node.js with Express
- **Database**: Airtable (cloud-based)
- **Authentication**: JWT tokens with 15-minute expiry
- **Frontend**: Vanilla HTML/CSS/JavaScript with modern ES6+
- **UI Framework**: Custom CSS with CSS Grid/Flexbox
- **Notifications**: SweetAlert2
- **Security**: Helmet.js, CORS, Rate limiting

### Database Structure
The system integrates with three Airtable tables:

1. **UTS EOI Table** - Expression of Interest submissions
2. **UTS Startups Table** - Approved startup information
3. **Team Members Table** - Individual team member details

## 📋 Prerequisites

- Node.js 16+ 
- Airtable account with API access
- GitHub account (for deployment)
- Replit account (for hosting)

## ⚙️ Setup Instructions

### 1. Environment Configuration

Create a `.env` file in the root directory:

```env
# Airtable Configuration
AIRTABLE_API_KEY=your_airtable_api_key_here
AIRTABLE_BASE_ID=your_base_id_here

# Table IDs
UTS_STARTUPS_TABLE_ID=your_startups_table_id
TEAM_MEMBERS_TABLE_ID=your_team_members_table_id
UTS_EOI_TABLE_ID=your_eoi_table_id

# JWT Configuration
JWT_SECRET=your_super_secure_jwt_secret_here

# Environment
NODE_ENV=production

# Airtable Form URLs (prefilled)
STARTUP_ONBOARDING_FORM_URL=https://airtable.com/your_startup_form_url
TEAM_MEMBER_FORM_URL=https://airtable.com/your_team_member_form_url

# Server Configuration
PORT=3000
```

### 2. Airtable Setup

#### Required Fields in UTS EOI Table:
- `Startup Name (or working title)` (Single line text)
- `Primary contact email` (Email)
- `Status` (Single select: Pending, Approved, Rejected)
- `Onboarding Submitted` (Number)
- `Magic Link` (Long text)
- `Token Expires At` (Date & time)

#### Required Fields in UTS Startups Table:
- `Startup Name (or working title)` (Single line text)
- `Primary contact email` (Email)
- `Record ID` (Single line text)
- `Startup status` (Single select)
- `Onboarding Submitted` (Number)
- `Magic Link` (Long text)
- `Token Expires At` (Date & time)

#### Required Fields in Team Members Table:
- `Team member ID` (Single line text)
- `Personal email*` (Email)
- `Mobile*` (Phone number)
- `Position at startup*` (Single line text)
- `Representative` (Checkbox or Number; set to `1` for representatives)
- `What is your association to UTS?*` (Single select)
- `Team Member Status` (Single select)
- `Startup*` (Link to UTS Startups table)

### 3. Local Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev
```

The application will be available at `http://localhost:3000`

### 4. GitHub Repository Setup

1. Create a new repository on GitHub
2. Push your code:

```bash
git init
git add .
git commit -m "Initial commit: UTS Startup Interface"
git branch -M main
git remote add origin https://github.com/SvetlanaNev/UTSS_Interface.git
git push -u origin main
```

### 5. Replit Deployment

1. Go to [Replit](https://replit.com)
2. Click "Create Repl"
3. Choose "Import from GitHub"
4. Enter your repository URL: `https://github.com/SvetlanaNev/UTSS_Interface`
5. Configure environment variables in Replit Secrets:
   - Add all variables from your `.env` file
6. Click "Run" to start the application

Your app will be available at `https://utss-interface.your-username.repl.co`

## 🔄 Application Flow

### 1. Landing Page Access
- User visits the homepage
- Enters registered email address
- System validates email in EOI or Startups tables
- Magic link generated and saved to Airtable

### 2. Dashboard Access
- User clicks magic link (15-minute expiry)
- JWT token verified and decoded
- Dashboard loads with startup and team information

### 3. Onboarding Process (for approved EOI)
- **Step 1**: Complete startup information form
- **Step 2**: Add startup representative details
- **Step 3**: Add team members (with ability to add multiple)
- **Completion**: Mark onboarding as submitted in Airtable

### 4. Team Management
- View all team members associated with startup
- Edit individual team member profiles
- Real-time updates to Airtable

## 🎨 Design Features

### Modern UI/UX
- **Dark Theme** - Professional appearance with excellent contrast
- **Smooth Animations** - CSS transitions and micro-interactions
- **Responsive Design** - Mobile-first approach
- **Glass Morphism** - Modern frosted glass effects
- **Progressive Enhancement** - Works without JavaScript

### Interactive Elements
- **Floating Shapes** - Animated background elements
- **Parallax Scrolling** - Depth and movement
- **Hover Effects** - Enhanced user feedback
- **Loading States** - Clear progress indicators
- **Form Validation** - Real-time feedback

## 🔒 Security Features

- **JWT Authentication** - Secure, stateless authentication
- **Rate Limiting** - Prevents abuse and spam
- **CORS Protection** - Controlled cross-origin requests
- **Input Sanitization** - Prevents injection attacks
- **HTTPS Enforcement** - Secure data transmission
- **Environment Variables** - Sensitive data protection

## 📱 Browser Support

- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+
- Mobile browsers (iOS Safari, Chrome Mobile)

## 🚀 Performance Optimizations

- **Lazy Loading** - Images and content loaded on demand
- **CSS Optimization** - Minified and compressed stylesheets
- **JavaScript Bundling** - Optimized script loading
- **Caching Headers** - Browser and CDN caching
- **Image Optimization** - WebP format with fallbacks

## 🛠️ Maintenance

### Regular Tasks
- Monitor Airtable API usage
- Update dependencies monthly
- Review security logs
- Backup environment configurations

### Troubleshooting
- Check Airtable API limits
- Verify JWT secret consistency
- Monitor error logs in Replit
- Test magic link generation

## 📊 Analytics & Monitoring

Consider integrating:
- Google Analytics for usage tracking
- Sentry for error monitoring
- Uptime monitoring for availability
- Performance monitoring with Lighthouse

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🆘 Support

For technical support or questions:
- Create an issue on GitHub
- Contact the UTS Startups team
- Check the troubleshooting section above

## 🔮 Future Enhancements

- Email notifications for magic links
- Advanced analytics dashboard
- Bulk team member import
- Custom branding options
- API webhooks for real-time updates
- Multi-language support

---

**Built with ❤️ for the UTS Startup Ecosystem** 


Uploads:
UTS Startups
Agreement (attachment), Agreement Created Date (date)
Signed Agreement (attachment), Signed Agreement Received Date (date)
