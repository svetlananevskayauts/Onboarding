// Dashboard JavaScript
document.addEventListener('DOMContentLoaded', function() {
    // Initialize dashboard
    initializeOnboardingFlow();
    initializeTeamManagement();

    // Fetch and display header information
    fetchHeaderInfo();

    // Initialize action buttons
    initializeActionButtons();

    console.log('Dashboard initialized');
});

// Initialize action button event listeners
function initializeActionButtons() {
    // Add Another Team Member button
    const addTeamMemberBtn = document.querySelector('.add-team-member-btn');
    if (addTeamMemberBtn) {
        addTeamMemberBtn.addEventListener('click', addAnotherTeamMember);
        console.log('Add Team Member button event listener attached');
    }

    // Submission Confirmation button
    const submissionBtn = document.querySelector('.submission-confirmation-btn');
    if (submissionBtn) {
        submissionBtn.addEventListener('click', confirmSubmission);
        console.log('Submission Confirmation button event listener attached');
    }
}

// Fetch header information (EOI and Email)
async function fetchHeaderInfo() {
    try {
        const response = await fetch(`/get-header-info/${window.dashboardData.token}`);

        // Check if response is JSON
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            console.error('Failed to fetch header info: non-JSON response');
            return;
        }

        const data = await response.json();

        if (data.success) {
            // Update header display
            updateHeaderDisplay(data.eoiName, data.email);
        } else {
            console.error('Failed to fetch header info:', data.message);
        }

    } catch (error) {
        console.error('Error fetching header info:', error);
    }
}

// Update header display with fetched data
function updateHeaderDisplay(eoiName, email) {
    // Update the startup name in header with EOI name and email
    const startupInfoElement = document.querySelector('.startup-info h2');
    if (startupInfoElement) {
        startupInfoElement.textContent = `${eoiName} - ${email}`;
    }

    console.log('Header updated:', { eoiName, email });
}

// Global variables for onboarding flow
let onboardingSteps;
let currentStep = 0; // No step active initially

async function toggleStep(stepNumber) {
    const step = document.querySelector(`[data-step="${stepNumber}"]`);
    if (!step) return;

    const isCurrentlyActive = step.classList.contains('active');

    // If clicking on current active step, just collapse it
    if (isCurrentlyActive) {
        step.classList.remove('active');
        currentStep = 0;
        return;
    }

    // Close all other steps
    onboardingSteps.forEach(s => s.classList.remove('active'));

    // Show loading state
    const stepContent = step.querySelector('.step-content');
    stepContent.innerHTML = '<div class="loading-state"><i class="fas fa-spinner fa-spin"></i> Loading form...</div>';

    try {
        let apiEndpoint;
        let formType;

        // Determine which API endpoint to call based on step
        if (stepNumber === 1) {
            apiEndpoint = `/get-startup-form/${window.dashboardData.token}`;
            formType = 'startup';
        } else if (stepNumber === 2) {
            apiEndpoint = `/get-representative-form/${window.dashboardData.token}`;
            formType = 'representative';
        } else if (stepNumber === 3) {
            apiEndpoint = `/get-team-members-form/${window.dashboardData.token}`;
            formType = 'team-members';
        }

        // Make API call to get form URL
        const response = await fetch(apiEndpoint);

        // Check if response is JSON
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            throw new Error('Server returned non-JSON response. Check token validity.');
        }

        const data = await response.json();

        if (!data.success) {
            // Show error message instead of expanding
            stepContent.innerHTML = `<div class="error-state"><i class="fas fa-exclamation-triangle"></i> ${data.message}</div>`;
            step.classList.add('active'); // Show the error message
            return;
        }

        if (!data.formUrl) {
            stepContent.innerHTML = '<div class="error-state"><i class="fas fa-exclamation-triangle"></i> Form URL not found</div>';
            step.classList.add('active');
        return;
    }

        // Load the form with the fetched URL (augment representative form with prefill)
        const iframeSrc = augmentFormUrl(formType, data.formUrl);
        stepContent.innerHTML = `
            <div class="form-embed-container">
                <iframe 
                    src="${iframeSrc}"
                    class="airtable-embed ${formType}-form"
                    frameborder="0"
                    onmousewheel=""
                    width="100%"
                    height="100%"
                    style="background: transparent; border: 1px solid #ccc; border-radius: 12px; min-height: 600px;"
                    loading="lazy">
                </iframe>
            </div>
        `;

        // Expand the step
    currentStep = stepNumber;
    step.classList.add('active');

    // Smooth scroll to step
    step.scrollIntoView({ 
        behavior: 'smooth', 
        block: 'center' 
    });

    } catch (error) {
        console.error('Error fetching form:', error);
        stepContent.innerHTML = '<div class="error-state"><i class="fas fa-exclamation-triangle"></i> Failed to load form</div>';
        step.classList.add('active');
    }
}


// Onboarding Flow Management
function initializeOnboardingFlow() {
    onboardingSteps = document.querySelectorAll('.onboarding-step');

    // Don't initialize step states - keep all folded

    // Step header click handlers
    onboardingSteps.forEach((step, index) => {
        const stepHeader = step.querySelector('.step-header');
        stepHeader.addEventListener('click', () => {
            toggleStep(index + 1);
        });
    });

    // All steps start folded - no auto-expansion

    // No auto-advance or progress tracking needed

    function updateStepStates() {
        // Only update visual states, don't automatically mark as completed
        onboardingSteps.forEach((step, index) => {
            const stepNumber = index + 1;
            const isCompleted = step.getAttribute('data-completed') === 'true';

            // Don't change completion status just by navigating
            if (isCompleted) {
                step.classList.add('completed');
            } else {
                step.classList.remove('completed');
            }

            // Only show active state for current step
            if (stepNumber === currentStep) {
                step.classList.add('active');
            } else {
                step.classList.remove('active');
            }
        });
    }



    function loadStepContent(stepNumber) {
        const step = document.querySelector(`[data-step="${stepNumber}"]`);
        if (!step) return;

        // Check if form is already loaded
        const existingIframe = step.querySelector('.airtable-embed');
        const placeholder = step.querySelector('.form-placeholder');

        if (placeholder && !existingIframe) {
            // Auto-load the form
            const loadBtn = placeholder.querySelector('.load-form-btn');
            if (loadBtn) {
                setTimeout(() => loadForm(loadBtn), 300);
            }
        }
    }

    // Form completion detection removed - no longer needed

    function showStepCompletionFeedback(stepNumber) {
        const step = document.querySelector(`[data-step="${stepNumber}"]`);
        const stepStatus = step.querySelector('.step-status i');

        // Update step status icon
        stepStatus.className = 'fas fa-check';
        stepStatus.style.color = '#10b981';

        // Show success message
        Swal.fire({
            icon: 'success',
            title: 'Step Completed!',
            text: `Step ${stepNumber} has been completed successfully.`,
            timer: 2000,
            timerProgressBar: true,
            showConfirmButton: false,
            background: '#1e293b',
            color: '#f8fafc',
            toast: true,
            position: 'top-end'
        });
    }
}

// Team Member Management
function initializeTeamManagement() {
    // Initialize edit buttons
    const editButtons = document.querySelectorAll('.edit-member-btn');
    editButtons.forEach(button => {
        button.addEventListener('click', (e) => {
            const memberId = e.target.closest('[data-member-id]').dataset.memberId;
            const token = button.onclick.toString().match(/'([^']+)'/)[1];
            editTeamMember(memberId, token);
        });
    });
}

// Add Another Team Member
function addAnotherTeamMember() {
    const teamMembersContainer = document.querySelector('.team-members-container');
    const existingForms = teamMembersContainer.querySelectorAll('.team-member-form');

    // Create new form container
    const newFormContainer = document.createElement('div');
    newFormContainer.className = 'team-member-form-container';
    newFormContainer.innerHTML = `
        <div class="form-header">
            <h4>Team Member ${existingForms.length + 1}</h4>
            <button class="remove-form-btn" onclick="removeTeamMemberForm(this)">
                <i class="fas fa-times"></i>
            </button>
        </div>
        <iframe 
            src="${window.dashboardData.formUrls.teamMember}"
            class="airtable-embed team-member-form"
            frameborder="0"
            onmousewheel=""
            width="100%"
            height="100%"
            style="background: transparent; border: 1px solid #ccc; border-radius: 12px; min-height: 600px;">
        </iframe>
    `;

    // Add smooth entrance animation
    newFormContainer.style.opacity = '0';
    newFormContainer.style.transform = 'translateY(20px)';

    // Insert before the add button
    const addButtonContainer = document.querySelector('.add-member-actions');
    teamMembersContainer.insertBefore(newFormContainer, addButtonContainer);

    // Animate in
    setTimeout(() => {
        newFormContainer.style.transition = 'all 0.5s ease';
        newFormContainer.style.opacity = '1';
        newFormContainer.style.transform = 'translateY(0)';
    }, 10);

    // Scroll to new form
    setTimeout(() => {
        newFormContainer.scrollIntoView({ 
            behavior: 'smooth', 
            block: 'center' 
        });
    }, 100);

    // Show feedback
    Swal.fire({
        icon: 'success',
        title: 'New Team Member Form Added',
        text: 'Please fill out the form for the additional team member.',
        timer: 2000,
        timerProgressBar: true,
        showConfirmButton: false,
        background: '#1e293b',
        color: '#f8fafc',
        toast: true,
        position: 'top-end'
    });
}

// Remove Team Member Form
function removeTeamMemberForm(button) {
    const formContainer = button.closest('.team-member-form-container');

    // Animate out
    formContainer.style.transition = 'all 0.3s ease';
    formContainer.style.opacity = '0';
    formContainer.style.transform = 'translateY(-20px)';

    setTimeout(() => {
        formContainer.remove();
        updateFormNumbers();
    }, 300);
}

// Update form numbers after removal
function updateFormNumbers() {
    const formContainers = document.querySelectorAll('.team-member-form-container');
    formContainers.forEach((container, index) => {
        const header = container.querySelector('h4');
        if (header) {
            header.textContent = `Team Member ${index + 1}`;
        }
    });
}

// Complete Onboarding
async function completeOnboarding(token) {
    // Show confirmation dialog
    const result = await Swal.fire({
        title: 'Complete Onboarding?',
        text: 'Are you sure you have added all team members and completed all required information?',
        icon: 'question',
        showCancelButton: true,
        confirmButtonColor: '#10b981',
        cancelButtonColor: '#6b7280',
        confirmButtonText: 'Yes, Complete Onboarding',
        cancelButtonText: 'Not Yet',
        background: '#1e293b',
        color: '#f8fafc'
    });

    if (!result.isConfirmed) return;

    // Show loading
    Swal.fire({
        title: 'Completing Onboarding...',
        text: 'Please wait while we process your submission.',
        allowOutsideClick: false,
        allowEscapeKey: false,
        showConfirmButton: false,
        background: '#1e293b',
        color: '#f8fafc',
        didOpen: () => {
            Swal.showLoading();
        }
    });

    try {
        const response = await fetch('/complete-onboarding', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ token })
        });

        const data = await response.json();

        if (data.success) {
            // Success animation
            await Swal.fire({
                icon: 'success',
                title: 'Onboarding Completed!',
                text: 'Your startup onboarding has been successfully completed.',
                confirmButtonColor: '#10b981',
                background: '#1e293b',
                color: '#f8fafc',
                showClass: {
                    popup: 'animate__animated animate__bounceIn'
                }
            });

            // Hide onboarding section and refresh page
            const onboardingSection = document.querySelector('.onboarding-section');
            if (onboardingSection) {
                onboardingSection.style.transition = 'all 0.5s ease';
                onboardingSection.style.opacity = '0';
                onboardingSection.style.transform = 'translateY(-20px)';

                setTimeout(() => {
                    location.reload();
                }, 500);
            }

        } else {
            throw new Error(data.message);
        }

    } catch (error) {
        console.error('Complete onboarding error:', error);
        Swal.fire({
            icon: 'error',
            title: 'Completion Failed',
            text: error.message || 'Failed to complete onboarding. Please try again.',
            confirmButtonColor: '#ef4444',
            background: '#1e293b',
            color: '#f8fafc'
        });
    }
}

// Edit Team Member
async function editTeamMember(memberId, token) {
    // Find member data
    const member = window.dashboardData.teamMembers.find(m => m.id === memberId);
    if (!member) return;

    // Create edit modal
    const modal = createEditModal(member, token);
    document.body.appendChild(modal);

    // Show modal with animation
    setTimeout(() => {
        modal.classList.add('active');
    }, 10);
}

// Create Edit Modal
function createEditModal(member, token) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3>Edit Team Member</h3>
                <p>Update ${member.name || 'team member'} information</p>
            </div>

            <form class="modal-form" id="editMemberForm">
                <div class="form-group">
                    <label class="form-label">Personal Email</label>
                    <input type="email" class="form-input" name="Personal email*" 
                           value="${member.email || ''}" required>
                </div>

                <div class="form-group">
                    <label class="form-label">Mobile Number</label>
                    <input type="tel" class="form-input" name="Mobile*" 
                           value="${member.mobile || ''}" required>
                </div>

                <div class="form-group">
                    <label class="form-label">Position at Startup</label>
                    <input type="text" class="form-input" name="Position at startup*" 
                           value="${member.position || ''}" required>
                </div>

                <div class="form-group">
                    <label class="form-label">UTS Association</label>
                    <select class="form-input" name="What is your association to UTS?*" required>
                        <option value="">Select association...</option>
                        <option value="Current Student" ${member.utsAssociation === 'Current Student' ? 'selected' : ''}>Current Student</option>
                        <option value="Alumni" ${member.utsAssociation === 'Alumni' ? 'selected' : ''}>Alumni</option>
                        <option value="Staff" ${member.utsAssociation === 'Staff' ? 'selected' : ''}>Staff</option>
                        <option value="External" ${member.utsAssociation === 'External' ? 'selected' : ''}>External</option>
                    </select>
                </div>

                <div class="modal-actions">
                    <button type="button" class="btn btn-outline" onclick="closeModal(this)">Cancel</button>
                    <button type="submit" class="btn btn-primary">
                        <i class="fas fa-save"></i> Save Changes
                    </button>
                </div>
            </form>
        </div>
    `;

    // Handle form submission
    const form = modal.querySelector('#editMemberForm');
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        await handleMemberUpdate(member.id, token, form, modal);
    });

    // Handle modal close
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeModal(modal);
        }
    });

    return modal;
}

// Handle Member Update
async function handleMemberUpdate(memberId, token, form, modal) {
    const formData = new FormData(form);
    const updates = {};

    for (let [key, value] of formData.entries()) {
        updates[key] = value;
    }

    // Show loading state
    const submitBtn = form.querySelector('button[type="submit"]');
    const originalText = submitBtn.innerHTML;
    submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
    submitBtn.disabled = true;

    try {
        const response = await fetch('/update-profile', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                token,
                memberId,
                updates
            })
        });

        const data = await response.json();

        if (data.success) {
            // Show success message
            await Swal.fire({
                icon: 'success',
                title: 'Profile Updated!',
                text: 'Team member information has been updated successfully.',
                timer: 2000,
                timerProgressBar: true,
                showConfirmButton: false,
                background: '#1e293b',
                color: '#f8fafc',
                toast: true,
                position: 'top-end'
            });

            // Close modal and refresh
            closeModal(modal);
            setTimeout(() => location.reload(), 1000);

        } else {
            throw new Error(data.message);
        }

    } catch (error) {
        console.error('Update error:', error);
        Swal.fire({
            icon: 'error',
            title: 'Update Failed',
            text: error.message || 'Failed to update profile. Please try again.',
            confirmButtonColor: '#ef4444',
            background: '#1e293b',
            color: '#f8fafc'
        });
    } finally {
        submitBtn.innerHTML = originalText;
        submitBtn.disabled = false;
    }
}

// Close Modal
function closeModal(element) {
    const modal = element.closest ? element.closest('.modal-overlay') : element;
    modal.classList.remove('active');

    setTimeout(() => {
        modal.remove();
    }, 300);
}

// Initialize Animations
function initializeAnimations() {
    // Animate team cards on load
    const teamCards = document.querySelectorAll('.team-member-card');
    teamCards.forEach((card, index) => {
        card.style.opacity = '0';
        card.style.transform = 'translateY(20px)';

        setTimeout(() => {
            card.style.transition = 'all 0.5s ease';
            card.style.opacity = '1';
            card.style.transform = 'translateY(0)';
        }, index * 100);
    });

    // Animate onboarding steps
    const onboardingSteps = document.querySelectorAll('.onboarding-step');
    onboardingSteps.forEach((step, index) => {
        step.style.opacity = '0';
        step.style.transform = 'translateX(-20px)';

        setTimeout(() => {
            step.style.transition = 'all 0.6s ease';
            step.style.opacity = '1';
            step.style.transform = 'translateX(0)';
        }, index * 200);
    });
}

// Lazy Load Forms Function
function loadForm(button) {
    const placeholder = button.closest('.form-placeholder');
    const formUrl = placeholder.dataset.formUrl;
    const formType = placeholder.dataset.formType;

    // Show loading state
    placeholder.classList.add('loading');
    const loadingSpinner = placeholder.querySelector('.loading-spinner');
    loadingSpinner.classList.add('active');

    // Create iframe
    const iframe = document.createElement('iframe');
    iframe.src = formUrl;
    iframe.className = 'airtable-embed';
    iframe.frameBorder = '0';
    iframe.width = '100%';
    iframe.height = '100%';
    iframe.style.cssText = 'background: transparent; border: 1px solid #ccc; border-radius: 12px; min-height: 600px;';
    iframe.loading = 'lazy';

    // Replace placeholder with iframe when loaded
    iframe.onload = () => {
        placeholder.parentNode.replaceChild(iframe, placeholder);
        showNotification('success', `${formType === 'representative' ? 'Representative' : 'Team member'} form loaded successfully!`);

        // Set up form completion detection
        setupFormCompletionDetection(iframe, formType);
    };

    iframe.onerror = () => {
        placeholder.classList.remove('loading');
        loadingSpinner.classList.remove('active');
        showNotification('error', 'Failed to load form. Please try again.');
    };
}

// Form completion detection
function setupFormCompletionDetection(iframe, formType) {
    // Listen for messages from iframe (if Airtable supports postMessage)
    window.addEventListener('message', function(event) {
        try {
            const originOk = /(^https?:\/\/([^\.]+\.)*airtable\.com$)/i.test(event.origin || '');
            const type = (event && event.data && (event.data.type || event.data.event || event.data.action)) || '';
            const raw = typeof event.data === 'string' ? event.data : '';
            const looksSubmitted = /submitted|form_submitted|form-submit|complete/i.test(String(type)) || /submitted|complete/i.test(raw);
            if (originOk && looksSubmitted) {
                markStepAsCompleted(formType);
                if (formType === 'representative') {
                    try { fetch(`/ensure-representative-position/${window.dashboardData.token}`, { method: 'POST' }); } catch (_) {}
                }
            }
        } catch (_) {}
    });

    // Fallback: Check for URL changes or form elements
    // This is a simplified approach - in production you might use Airtable webhooks
    // Fallback: ping server after a short delay in case postMessage doesn't arrive
    if (formType === 'representative') {
        setTimeout(() => {
            try { fetch(`/ensure-representative-position/${window.dashboardData.token}`, { method: 'POST' }); } catch (_) {}
        }, 10000);
        setTimeout(() => {
            try { fetch(`/ensure-representative-position/${window.dashboardData.token}`, { method: 'POST' }); } catch (_) {}
        }, 30000);
    }
}

function markStepAsCompleted(formType) {
    let stepNumber;
    if (formType === 'startup') stepNumber = 1;
    else if (formType === 'representative') stepNumber = 2;
    else if (formType === 'team-member') stepNumber = 3;

    const step = document.querySelector(`[data-step="${stepNumber}"]`);
    if (step) {
        step.setAttribute('data-completed', 'true');
        step.classList.add('completed');

        const stepStatus = step.querySelector('.step-status i');
        stepStatus.className = 'fas fa-check';
        stepStatus.style.color = '#10b981';

        // Update step number background to green
        const stepNumber_elem = step.querySelector('.step-number');
        stepNumber_elem.style.background = 'var(--gradient-success)';

        // Don't automatically activate next step - let user choose
        showNotification('success', `Step ${stepNumber} completed! You can now proceed to the next step.`);
    }
}

// Add function to manually mark step as incomplete (for re-editing)
function markStepAsIncomplete(stepNumber) {
    const step = document.querySelector(`[data-step="${stepNumber}"]`);
    if (step) {
        step.setAttribute('data-completed', 'false');
        step.classList.remove('completed');

        const stepStatus = step.querySelector('.step-status i');
        stepStatus.className = 'fas fa-clock';
        stepStatus.style.color = '';

        const stepNumber_elem = step.querySelector('.step-number');
        stepNumber_elem.style.background = '';

        showNotification('info', `Step ${stepNumber} reopened for editing.`);
    }
}

// Old initialization code removed - no longer needed

// Action Button Functions

// Add Another Team Member button functionality
function addAnotherTeamMember() {
    const teamMembersStep = document.querySelector('[data-step="3"]');
    const isCurrentlyActive = teamMembersStep.classList.contains('active');

    if (isCurrentlyActive) {
        // 1.1: Section is open - close it, wait 0.3s, then reopen
        teamMembersStep.classList.remove('active');

        setTimeout(() => {
            // Trigger the normal toggle logic to reopen
            toggleStep(3);
        }, 300);
    } else {
        // 1.2: Section is closed - open it
        toggleStep(3);
    }
}

// Submission Confirmation button functionality
async function confirmSubmission() {
    console.log('confirmSubmission function called');
    const button = document.querySelector('.submission-confirmation-btn');
    console.log('Button found:', button);
    const originalText = button.innerHTML;

    try {
        // Show loading state
        button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Confirming...';
        button.disabled = true;

        // Make API call to confirm submission
        console.log('Making PATCH request to confirm submission...');
        const response = await fetch(`/submission-confirmation/${window.dashboardData.token}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                "fields": {
                    "Submission Confirmation": "true"
                }
            })
        });

        // Check if response is JSON
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            throw new Error('Server returned non-JSON response');
        }

        const data = await response.json();

        if (data.success) {
            // Show success state
            button.innerHTML = '<i class="fas fa-check"></i> Confirmed!';
            button.style.background = 'var(--gradient-success)';

            // Show success notification
            showNotification('success', 'Submission confirmed successfully!');

            // Reconcile statuses on the server (promote representative + startup if conditions met)
            try {
                await fetch(`/reconcile-status/${window.dashboardData.token}`, { method: 'POST' });
            } catch (_) {}

            // Navigate to Validation & Agreement page
            window.location.href = `/agreement/${window.dashboardData.token}`;
            return;

            // Keep success state for 3 seconds, then restore
            setTimeout(() => {
                button.innerHTML = originalText;
                button.style.background = '';
                button.disabled = false;
            }, 3000);

        } else {
            throw new Error(data.message || 'Failed to confirm submission');
        }

    } catch (error) {
        console.error('Submission confirmation error:', error);

        // Show error state
        button.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Error';
        showNotification('error', error.message || 'Failed to confirm submission');

        // Restore button after 3 seconds
        setTimeout(() => {
            button.innerHTML = originalText;
            button.disabled = false;
        }, 3000);
    }
}

// Utility Functions
function showNotification(type, message) {
    Swal.fire({
        icon: type,
        title: message,
        toast: true,
        position: 'top-end',
        showConfirmButton: false,
        timer: 3000,
        timerProgressBar: true,
        background: '#1e293b',
        color: '#f8fafc'
    });
}

// Background job polling for agreement generation
let agreementPoller = null;
let agreementToastShown = false;

function showGeneratingAgreementToast() {
    if (agreementToastShown) return;
    agreementToastShown = true;
    Swal.fire({
        icon: 'info',
        title: 'Generating agreementâ€¦',
        text: 'Running member validation and building your PDF.',
        toast: true,
        position: 'top-end',
        showConfirmButton: false,
        timer: 4000,
        timerProgressBar: true,
        background: '#1e293b',
        color: '#f8fafc'
    });
}

function showAgreementReady(url, filename) {
    Swal.fire({
        icon: 'success',
        title: 'Agreement Ready',
        html: `<p>Your agreement has been generated.</p>
               <a href="${url}" target="_blank" style="display:inline-block;padding:10px 16px;border-radius:8px;background:var(--gradient-success);color:#fff;text-decoration:none;font-weight:600;">Download ${filename || 'Agreement'}</a>`,
        confirmButtonColor: '#6366f1',
        background: '#1e293b',
        color: '#f8fafc'
    });
}

async function checkAgreementJobOnce() {
    try {
        const resp = await fetch(`/job-status/${window.dashboardData.token}`);
        const data = await resp.json();
        if (!data || !data.success) return false;
        const job = data.job || {};
        if (job.state === 'done' && job.result && job.result.pdf && job.result.pdf.url) {
            clearInterval(agreementPoller);
            agreementPoller = null;
            showAgreementReady(job.result.pdf.url, job.result.pdf.filename);
            return true;
        }
        if (job.state === 'error' || job.state === 'blocked') {
            clearInterval(agreementPoller);
            agreementPoller = null;
            const reason = job?.result?.reason || job?.result?.message || 'Validation/generation failed';
            showNotification('error', reason);
            return true;
        }
    } catch (e) {
        // ignore
    }
    return false;
}

function startAgreementPoller() {
    if (agreementPoller) return;
    // quick first check, then every 3s up to 3 minutes
    let attempts = 0;
    const maxAttempts = 60; // 60 * 3s = 180s
    checkAgreementJobOnce();
    agreementPoller = setInterval(async () => {
        attempts += 1;
        const done = await checkAgreementJobOnce();
        if (done || attempts >= maxAttempts) {
            clearInterval(agreementPoller);
            agreementPoller = null;
        }
    }, 3000);
}

// Add dynamic CSS for enhanced interactions
const style = document.createElement('style');
style.textContent = `
    .form-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 1rem;
        padding: 1rem;
        background: rgba(99, 102, 241, 0.1);
        border-radius: 12px;
        border: 1px solid var(--primary-color);
    }

    .form-header h4 {
        margin: 0;
        color: var(--primary-color);
        font-weight: 600;
    }

    .remove-form-btn {
        background: rgba(239, 68, 68, 0.1);
        border: 1px solid #ef4444;
        color: #ef4444;
        border-radius: 8px;
        padding: 0.5rem;
        cursor: pointer;
        transition: all 0.3s ease;
        width: 32px;
        height: 32px;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .remove-form-btn:hover {
        background: rgba(239, 68, 68, 0.2);
        transform: scale(1.1);
    }

    .team-member-form-container {
        margin-bottom: 1.5rem;
        padding: 1rem;
        background: var(--dark-surface);
        border-radius: 16px;
        border: 1px solid var(--dark-border);
    }

    /* Enhanced modal animations */
    .modal-overlay {
        backdrop-filter: blur(10px);
    }

    .modal-overlay.active .modal-content {
        animation: modalSlideIn 0.3s ease-out;
    }

    @keyframes modalSlideIn {
        from {
            opacity: 0;
            transform: translateY(-50px) scale(0.9);
        }
        to {
            opacity: 1;
            transform: translateY(0) scale(1);
        }
    }

    /* Form input focus effects */
    .form-input:focus {
        transform: translateY(-2px);
        box-shadow: 0 8px 25px rgba(99, 102, 241, 0.15);
    }

    /* Button hover effects */
    .btn:hover {
        box-shadow: 0 8px 25px rgba(0, 0, 0, 0.15);
    }

    /* Card hover effects */
    .team-member-card:hover .member-avatar {
        transform: scale(1.1);
        box-shadow: 0 8px 25px rgba(99, 102, 241, 0.3);
    }

    .member-avatar {
        transition: all 0.3s ease;
    }
`;

document.head.appendChild(style); 

// Ensure critical prefill parameters are present for the representative form
function augmentFormUrl(formType, url) {
  try {
    if (!url) return url;
    if (formType !== 'representative') return url;

    const u = new URL(url);
    const p = u.searchParams;

    // Airtable form prefill uses keys like `prefill_Field Name`.
    // Canonical representative indicator: `Representative` (checkbox/number)
    const prefillPairs = [
      ['prefill_Representative', '1']
    ];

    for (const [k, v] of prefillPairs) {
      if (!p.has(k)) p.set(k, v);
    }

    const out = u.toString();
    try { console.debug('Representative form URL (augmented):', out); } catch (_) {}
    return out;
  } catch (e) {
    try { console.warn('augmentFormUrl failed; using original URL', e?.message || e); } catch (_) {}
    return url;
  }
}



