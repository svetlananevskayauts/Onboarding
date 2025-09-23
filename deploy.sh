#!/bin/bash

# UTS Startup Interface - GitHub Deployment Script
# Run this script to push your project to GitHub

echo "🚀 UTS Startup Interface - GitHub Deployment"
echo "=============================================="

# Check if git is initialized
if [ ! -d ".git" ]; then
    echo "📁 Initializing Git repository..."
    git init
    echo "✅ Git repository initialized"
else
    echo "✅ Git repository already exists"
fi

# Add all files
echo "📦 Adding files to Git..."
git add .

# Check if there are changes to commit
if git diff --staged --quiet; then
    echo "ℹ️  No changes to commit"
else
    # Commit changes
    echo "💾 Committing changes..."
    git commit -m "feat: Enhanced UTS Startup Interface v2.0

- Added multi-step onboarding flow with embedded Airtable forms
- Implemented EOI integration for approved startups
- Created world-class UI/UX with dark theme and animations
- Added dynamic team member management
- Enhanced security with JWT tokens and rate limiting
- Implemented responsive design for all devices
- Added comprehensive error handling and validation"
    echo "✅ Changes committed"
fi

# Set main branch
echo "🌟 Setting main branch..."
git branch -M main

# Add remote origin (if not already added)
if git remote get-url origin > /dev/null 2>&1; then
    echo "✅ Remote origin already configured"
else
    echo "🔗 Adding remote origin..."
    git remote add origin https://github.com/SvetlanaNev/UTSS_Interface.git
    echo "✅ Remote origin added"
fi

# Push to GitHub
echo "⬆️  Pushing to GitHub..."
if git push -u origin main; then
    echo ""
    echo "🎉 SUCCESS! Your project has been pushed to GitHub!"
    echo ""
    echo "📋 Next Steps:"
    echo "1. Go to: https://github.com/SvetlanaNev/UTSS_Interface"
    echo "2. Verify your files are there"
    echo "3. Deploy to Replit:"
    echo "   - Go to https://replit.com"
    echo "   - Click 'Create Repl'"
    echo "   - Choose 'Import from GitHub'"
    echo "   - Enter: https://github.com/SvetlanaNev/UTSS_Interface"
    echo "   - Configure environment variables in Replit Secrets"
    echo "   - Click 'Run' to start your app"
    echo ""
    echo "🔧 Don't forget to:"
    echo "   - Create your .env file with Airtable credentials"
    echo "   - Set up your Airtable forms"
    echo "   - Test the magic link functionality"
    echo ""
    echo "📚 Check README.md and DEPLOYMENT.md for detailed instructions"
else
    echo ""
    echo "❌ Push failed. This might be because:"
    echo "1. Repository doesn't exist on GitHub yet"
    echo "2. You don't have write access"
    echo "3. Authentication issues"
    echo ""
    echo "💡 Manual steps:"
    echo "1. Create repository at: https://github.com/new"
    echo "2. Name it: UTSS_Interface"
    echo "3. Run: git remote set-url origin https://github.com/SvetlanaNev/UTSS_Interface.git"
    echo "4. Run: git push -u origin main"
fi

echo ""
echo "🚀 Deployment script completed!" 