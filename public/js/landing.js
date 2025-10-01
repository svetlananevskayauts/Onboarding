// Landing Page JavaScript
document.addEventListener('DOMContentLoaded', function() {
    // Initialize page
    initializeAnimations();
    initializeForm();
    initializeScrollEffects();
    
    // Smooth scroll for navigation links
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();
            const target = document.querySelector(this.getAttribute('href'));
            if (target) {
                target.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                });
            }
        });
    });
});

// Initialize animations
function initializeAnimations() {
    // Animate elements on scroll
    const observerOptions = {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    };

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('animate-in');
            }
        });
    }, observerOptions);

    // Observe elements for animation
    document.querySelectorAll('.feature-card, .about-content, .stat-item').forEach(el => {
        observer.observe(el);
    });

    // Stagger animation for feature cards
    const featureCards = document.querySelectorAll('.feature-card');
    featureCards.forEach((card, index) => {
        card.style.animationDelay = `${index * 0.1}s`;
    });
}

// Initialize form handling
function initializeForm() {
    const form = document.getElementById('emailForm');
    const emailInput = document.getElementById('email');
    const submitBtn = document.getElementById('accessBtn');
    
    if (!form || !emailInput || !submitBtn) return;

    // Form submission
    form.addEventListener('submit', async function(e) {
        e.preventDefault();
        
        const email = emailInput.value.trim();
        
        if (!email) {
            showAlert('error', 'Please enter your email address');
            return;
        }

        if (!isValidEmail(email)) {
            showAlert('error', 'Please enter a valid email address');
            return;
        }

        // Show loading state
        setButtonLoading(submitBtn, true);
        
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000);
            const response = await fetch('/lookup-email', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ email }),
                signal: controller.signal
            });
            clearTimeout(timeout);

            // Try JSON; if server returns text, surface it and stop spinning
            let data;
            const ct = response.headers.get('content-type') || '';
            if (ct.includes('application/json')) {
                data = await response.json();
            } else {
                const text = await response.text();
                throw new Error(text || 'Unexpected non-JSON response');
            }

            if (data.success) {
                showAlert('success', 'Magic link generated successfully!', 
                    'Please check your email for the access link.');
                
                // In development, show the magic link
                if (data.magicLink && (window.location.hostname === 'localhost' || data.devMode === true)) {
                    setTimeout(() => {
                        showMagicLinkModal(data.magicLink);
                    }, 2000);
                }
                
                // Reset form
                form.reset();
            } else {
                showAlert('error', 'Access Denied', data.message);
            }
        } catch (error) {
            console.error('Error:', error);
            showAlert('error', 'Request Error', 
                (error && error.message) ? String(error.message).slice(0, 300) : 'Unable to connect to the server. Please try again.');
        } finally {
            setButtonLoading(submitBtn, false);
        }
    });

    // Real-time validation
    emailInput.addEventListener('input', function() {
        const email = this.value.trim();
        const inputContainer = this.closest('.input-container');
        
        if (email && !isValidEmail(email)) {
            inputContainer.classList.add('error');
        } else {
            inputContainer.classList.remove('error');
        }
    });

    // Enhanced input focus effects
    emailInput.addEventListener('focus', function() {
        this.closest('.input-container').classList.add('focused');
    });

    emailInput.addEventListener('blur', function() {
        this.closest('.input-container').classList.remove('focused');
    });
}

// Initialize scroll effects
function initializeScrollEffects() {
    const navbar = document.querySelector('.navbar');
    let lastScrollY = window.scrollY;

    window.addEventListener('scroll', () => {
        const currentScrollY = window.scrollY;
        
        // Navbar background opacity
        if (currentScrollY > 50) {
            navbar.classList.add('scrolled');
        } else {
            navbar.classList.remove('scrolled');
        }
        
        // Hide/show navbar on scroll
        if (currentScrollY > lastScrollY && currentScrollY > 100) {
            navbar.style.transform = 'translateY(-100%)';
        } else {
            navbar.style.transform = 'translateY(0)';
        }
        
        lastScrollY = currentScrollY;
    });

    // Parallax effect for floating shapes
    window.addEventListener('scroll', () => {
        const scrolled = window.pageYOffset;
        const shapes = document.querySelectorAll('.floating-shape');
        
        shapes.forEach((shape, index) => {
            const rate = scrolled * -0.5 * (index + 1) * 0.1;
            shape.style.transform = `translateY(${rate}px)`;
        });
    });
}

// Utility functions
function isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

function setButtonLoading(button, loading) {
    if (loading) {
        button.classList.add('loading');
        button.disabled = true;
    } else {
        button.classList.remove('loading');
        button.disabled = false;
    }
}

function showAlert(type, title, text = '') {
    const config = {
        title: title,
        text: text,
        icon: type,
        confirmButtonColor: '#6366f1',
        background: '#1e293b',
        color: '#f8fafc',
        showClass: {
            popup: 'animate__animated animate__fadeInDown'
        },
        hideClass: {
            popup: 'animate__animated animate__fadeOutUp'
        }
    };

    if (type === 'success') {
        config.timer = 30000;
        config.timerProgressBar = true;
        config.showConfirmButton = false;
    }
    else{
            config.timer = 10000;
        }

    Swal.fire(config);
}

function showMagicLinkModal(magicLink) {
    // Always present a local dashboard link in dev popup
    let localLink = magicLink;
    try {
        const u = new URL(magicLink, window.location.origin);
        const parts = (u.pathname || '').split('/').filter(Boolean);
        const token = parts[parts.length - 1] || '';
        localLink = `${window.location.origin.replace(/\/$/, '')}/dashboard/${token}`;
    } catch (e) {
        // Fallback to origin if parsing fails
        localLink = `${window.location.origin.replace(/\/$/, '')}/dashboard/${String(magicLink).split('/').pop()}`;
    }
    Swal.fire({
        title: 'Development Mode',
        html: `
            <p style="margin-bottom: 20px;">In production, this link would be sent to your email.</p>
            <p style="margin-bottom: 20px;">For development, you can access your dashboard directly:</p>
            <a href="${localLink}" 
               style="display: inline-block; background: linear-gradient(135deg, #f59e0b 0%, #ef4444 100%); 
                      color: white; padding: 12px 24px; border-radius: 12px; text-decoration: none; 
                      font-weight: 600; transition: transform 0.2s;"
               onmouseover="this.style.transform='translateY(-2px)'"
               onmouseout="this.style.transform='translateY(0)'"
               target="_blank">
                Access Dashboard
            </a>
        `,
        icon: 'info',
        confirmButtonColor: '#6366f1',
        background: '#1e293b',
        color: '#f8fafc',
        showClass: {
            popup: 'animate__animated animate__zoomIn'
        }
    });
}

// Add CSS for animations
const style = document.createElement('style');
style.textContent = `
    .navbar {
        transition: transform 0.3s ease, background-color 0.3s ease;
    }
    
    .navbar.scrolled {
        background: rgba(30, 41, 59, 0.95);
    }
    
    .input-container {
        position: relative;
        transition: all 0.3s ease;
    }
    
    .input-container.focused {
        transform: translateY(-2px);
    }
    
    .input-container.error .email-input {
        border-color: #ef4444;
        box-shadow: 0 0 0 4px rgba(239, 68, 68, 0.1);
    }
    
    .animate-in {
        animation: slideInUp 0.6s ease-out forwards;
    }
    
    @keyframes slideInUp {
        from {
            opacity: 0;
            transform: translateY(30px);
        }
        to {
            opacity: 1;
            transform: translateY(0);
        }
    }
    
    .feature-card,
    .stat-item {
        opacity: 0;
        transform: translateY(30px);
        transition: all 0.6s ease-out;
    }
    
    .feature-card.animate-in,
    .stat-item.animate-in {
        opacity: 1;
        transform: translateY(0);
    }
    
    .floating-shape {
        will-change: transform;
    }
    
    /* Enhanced button hover effects */
    .access-btn {
        position: relative;
        overflow: hidden;
    }
    
    .access-btn::before {
        content: '';
        position: absolute;
        top: 0;
        left: -100%;
        width: 100%;
        height: 100%;
        background: linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent);
        transition: left 0.5s;
    }
    
    .access-btn:hover::before {
        left: 100%;
    }
    
    /* Preview card hover effects */
    .preview-card {
        transition: all 0.3s ease;
    }
    
    .preview-card:hover {
        transform: translateX(8px) scale(1.02);
        background: rgba(255, 255, 255, 0.15);
    }
    
    /* Smooth transitions for all interactive elements */
    .nav-link,
    .feature-card,
    .preview-card,
    .btn,
    .email-input {
        transition: all 0.3s ease;
    }
    
    /* Loading animation */
    .loading .btn-text,
    .loading .btn-icon {
        opacity: 0;
        transition: opacity 0.3s ease;
    }
    
    .loading .btn-loading {
        opacity: 1;
        transition: opacity 0.3s ease;
    }
    
    @keyframes pulse {
        0%, 100% {
            opacity: 1;
        }
        50% {
            opacity: 0.5;
        }
    }
    
    .loading {
        animation: pulse 2s infinite;
    }
`;

document.head.appendChild(style); 
