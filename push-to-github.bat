@echo off
echo.
echo ========================================
echo   UTS Startup Interface - GitHub Push
echo ========================================
echo.

REM Check if Git is installed
git --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Git is not installed or not in PATH
    echo.
    echo Please install Git first:
    echo 1. Go to https://git-scm.com/download/win
    echo 2. Download and install Git for Windows
    echo 3. Restart this terminal and run this script again
    echo.
    pause
    exit /b 1
)

echo ✅ Git is installed
echo.

REM Initialize repository if not already done
if not exist ".git" (
    echo 📁 Initializing Git repository...
    git init
    echo ✅ Git repository initialized
) else (
    echo ✅ Git repository already exists
)

REM Add all files
echo 📦 Adding files to Git...
git add .

REM Check if there are changes to commit
git diff --staged --quiet
if %errorlevel% equ 0 (
    echo ℹ️  No changes to commit
) else (
    echo 💾 Committing changes...
    git commit -m "feat: Enhanced UTS Startup Interface v2.0 - Added multi-step onboarding flow with embedded Airtable forms - Implemented EOI integration for approved startups - Created world-class UI/UX with dark theme and animations - Added dynamic team member management - Enhanced security with JWT tokens and rate limiting"
    echo ✅ Changes committed
)

REM Set main branch
echo 🌟 Setting main branch...
git branch -M main

REM Add remote origin
git remote get-url origin >nul 2>&1
if %errorlevel% neq 0 (
    echo 🔗 Adding remote origin...
    git remote add origin https://github.com/SvetlanaNev/UTSS_Interface.git
    echo ✅ Remote origin added
) else (
    echo ✅ Remote origin already configured
)

REM Push to GitHub
echo ⬆️  Pushing to GitHub...
git push -u origin main
if %errorlevel% equ 0 (
    echo.
    echo 🎉 SUCCESS! Your project has been pushed to GitHub!
    echo.
    echo 📋 Next Steps:
    echo 1. Go to: https://github.com/SvetlanaNev/UTSS_Interface
    echo 2. Verify your files are there
    echo 3. Deploy to Replit:
    echo    - Go to https://replit.com
    echo    - Click 'Create Repl'
    echo    - Choose 'Import from GitHub'
    echo    - Enter: https://github.com/SvetlanaNev/UTSS_Interface
    echo    - Configure environment variables in Replit Secrets
    echo    - Click 'Run' to start your app
    echo.
    echo 🔧 Don't forget to set up your Airtable credentials!
    echo 📚 Check README.md for detailed instructions
) else (
    echo.
    echo ❌ Push failed. Please check:
    echo 1. Your GitHub credentials
    echo 2. Repository permissions
    echo 3. Internet connection
    echo.
    echo 💡 You can also upload files manually at:
    echo https://github.com/SvetlanaNev/UTSS_Interface
)

echo.
echo 🚀 Deployment script completed!
pause 