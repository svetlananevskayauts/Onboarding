// Dashboard JavaScript
document.addEventListener('DOMContentLoaded', function() {
    // Align derived state with window.dashboardData (script tag defined after this file)
    if (!window.dashboardData) {
      try {
        const dataEl = document.getElementById('dashboard-data');
        if (dataEl && dataEl.textContent) {
          window.dashboardData = JSON.parse(dataEl.textContent);
        }
      } catch (_) {
        window.dashboardData = {};
      }
    }
    firstPointOfContact =
      (window.dashboardData && window.dashboardData.firstPointOfContact) || null;

    // Remove any inline event handlers (CSP: script-src-attr 'none') and keep watching
    stripInlineHandlers(document.body);
    startInlineHandlerGuard();

    // Initialize dashboard
    initializeOnboardingFlow();
    initializeTeamManagement();
    initializeDashboardTabs();
    renderPrimaryContactCards();

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
        addTeamMemberBtn.addEventListener('click', () => {
            // Defer enforcement to server endpoints; no client-side lock here
            addAnotherTeamMember();
        });
        console.log('Add Team Member button event listener attached');
    }

    // Submission Confirmation button
    const submissionBtn = document.querySelector('.submission-confirmation-btn');
    if (submissionBtn) {
        submissionBtn.addEventListener('click', confirmSubmission);
        console.log('Submission Confirmation button event listener attached');
    }
}

function initializeDashboardTabs() {
    const tabs = document.querySelectorAll('.dashboard-tab');
    const panels = document.querySelectorAll('.tab-panel');
    if (!tabs.length || !panels.length) return;

    // Debug: initial tab/panel discovery
    try {
        console.debug('tabs:init', { tabs: tabs.length, panels: panels.length });
    } catch (_) {}

    let managementInitialized = false;
    let financialInitialized = false;

    function activateTab(targetId) {
        try { console.debug('tabs:activate', { targetId }); } catch (_) {}
        if (targetId === 'management-section' && !managementInitialized) {
            managementInitialized = true;
            Promise.resolve(initializeManagementDashboard()).catch((err) =>
                console.error('mgmt.init.error', err),
            );
            renderPrimaryContactCards();
        }
        if (targetId === 'financial-section' && !financialInitialized) {
            initializeFinancialSection();
            financialInitialized = true;
            renderPrimaryContactCards();
        }
        panels.forEach(panel => {
            if (panel.id === targetId) {
                panel.classList.add('active');
                panel.classList.remove('hidden');
            } else {
                panel.classList.remove('active');
                panel.classList.add('hidden');
            }
        });
        tabs.forEach(tab => {
            if (tab.dataset.tabTarget === targetId) {
                tab.classList.add('active');
            } else {
                tab.classList.remove('active');
            }
        });
    }

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            if (tab.disabled || tab.classList.contains('disabled')) {
                try { console.debug('tabs:click:disabled', { target: tab.dataset.tabTarget }); } catch (_) {}
                return;
            }
            const target = tab.dataset.tabTarget;
            try { console.debug('tabs:click', { target }); } catch (_) {}
            if (target) {
                activateTab(target);
            }
        });
    });

    // Honor deep-link query/hash to open a specific tab (e.g., ?tab=management)
    const params = new URLSearchParams(window.location.search || '');
    const tabParam = (params.get('tab') || '').toLowerCase();
    let initialTarget = null;
    const mapTab = {
        onboarding: 'onboarding-section',
        management: 'management-section',
        financial: 'financial-section',
    };
    if (mapTab[tabParam]) {
        initialTarget = mapTab[tabParam];
    } else if (window.location.hash) {
        const hash = window.location.hash.replace('#', '').toLowerCase();
        if (mapTab[hash]) {
            initialTarget = mapTab[hash];
        } else if (hash.endsWith('-section')) {
            initialTarget = `${hash}`;
        }
    }
    if (initialTarget) {
        activateTab(initialTarget);
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
let onboardingGate = {
  hasLinkedStartup: false,
  startupRecordId: null,
  representativeReady: false,
  teamMembersReady: false
};
let onboardingState = {
  step1Complete: false,
  step2Complete: false,
  step3Complete: false,
  signedAgreement: false,
};
let managementState = (window.dashboardData && window.dashboardData.management) || {
  enabled: false,
  members: [],
  summary: {},
  events: [],
  changeRequests: [],
  membershipTypes: [],
};
let startupInfo = (window.dashboardData && window.dashboardData.startup) || {};
let firstPointOfContact = null;
const financialState = {
  initialized: false,
  loading: false,
  entries: [],
  totals: { debits: 0, credits: 0 },
  filter: 'all'
};

async function fetchOnboardingState() {
  try {
    const res = await fetch(`/onboarding-state/${window.dashboardData.token}`);
    if (!res.ok) return null;
    const json = await res.json();
    if (!json || !json.success) return null;
    return json.data || null;
  } catch (_) { return null; }
}

function isStepLocked(stepNumber) {
  if (!onboardingState) return false;
  if (stepNumber === 1) return !!onboardingState.step1Complete;
  if (stepNumber === 2) return !!onboardingState.step2Complete;
  if (stepNumber === 3) return !!onboardingState.signedAgreement; // lock only when signed agreement is present
  return false;
}

function applyStepLocks() {
  if (!onboardingSteps) return;
  onboardingSteps.forEach((step, index) => {
    const stepNumber = index + 1;
    const locked = isStepLocked(stepNumber);
    step.classList.toggle('locked', !!locked);
    const header = step.querySelector('.step-header');
    if (header) header.setAttribute('aria-disabled', locked ? 'true' : 'false');
    // Mark completed for visual status (Step 1 & 2 when complete; Step 3 only when signed agreement exists)
    const completed = (stepNumber === 1 && onboardingState.step1Complete) ||
                      (stepNumber === 2 && onboardingState.step2Complete) ||
                      (stepNumber === 3 && onboardingState.signedAgreement);
    step.setAttribute('data-completed', completed ? 'true' : 'false');
    const statusEl = step.querySelector('.step-status');
    if (statusEl) {
      statusEl.innerHTML = completed ? '<i class="fas fa-check"></i> <span style="font-weight:600;color:#10b981;">COMPLETE</span>' : '';
    }
  });
}

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

  // Show loading state / or gated notice (fallback check; primary check happens on click)
  const stepContent = step.querySelector('.step-content');
  if (isStepLocked(stepNumber)) {
    stepContent.innerHTML = '<div class="error-state"><i class="fas fa-lock"></i> This step is marked COMPLETE and is no longer editable.</div>';
    step.classList.add('active');
    return;
  }
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

    // Hint-only completion detection: listen for Airtable postMessage
    try {
      const iframeEl = stepContent.querySelector('iframe');
      if (iframeEl) {
        setupFormCompletionDetection(iframeEl, formType);
      }
    } catch (_) {}

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

    // Step header click handlers (defer gating to server endpoints)
    onboardingSteps.forEach((step, index) => {
      const stepHeader = step.querySelector('.step-header');
      stepHeader.addEventListener('click', () => {
        toggleStep(index + 1);
      });
    });

    // Fetch state and apply locks
    fetchOnboardingState().then((state) => {
      if (state) onboardingState = state;
      applyStepLocks();
      // If agreement is already signed, default to Management tab on load
      if (onboardingState && onboardingState.signedAgreement) {
        try {
          const mgmtTab = document.querySelector('.dashboard-tab[data-tab-target="management-section"]');
          if (mgmtTab) {
            mgmtTab.click();
          }
          // Hide onboarding tab when agreement is signed
          const onboardingTab = document.querySelector('.dashboard-tab[data-tab-target="onboarding-section"]');
          const onboardingPanel = document.getElementById('onboarding-section');
          if (onboardingTab) onboardingTab.style.display = 'none';
          if (onboardingPanel) onboardingPanel.style.display = 'none';
        } catch (_) {}
      }
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

// Optional: we can fetch once on load to set initial visuals; not required for gating
// (Left disabled to minimize API calls)

// Team Member Management
function initializeTeamManagement() {
    const editButtons = document.querySelectorAll('.edit-member-btn');
    const token = window.dashboardData && window.dashboardData.token;
    editButtons.forEach(button => {
        button.addEventListener('click', () => {
            const card = button.closest('[data-member-id]');
            const memberId = (card && card.dataset.memberId) || button.dataset.memberId;
            if (!memberId) return;
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
            <button class="remove-form-btn" data-remove-team-member="true">
                <i class="fas fa-times"></i>
            </button>
        </div>
        <iframe 
            src="${window.dashboardData.formUrls.teamMember}"
            class="airtable-embed team-member-form"
            frameborder="0"
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

    // Wire remove handler (CSP-safe: avoid inline handler)
    const removeBtn = newFormContainer.querySelector('[data-remove-team-member="true"]');
    if (removeBtn) {
        removeBtn.addEventListener('click', () => removeTeamMemberForm(removeBtn));
    }

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

async function editTeamMember(memberId) {
    const member =
        (managementState.members || []).find((m) => m.primaryId === memberId) ||
        (window.dashboardData.teamMembers || []).find((m) => m.id === memberId);
    if (!member) return;
    openMembershipModal(memberId);
}

// Close Modal (defensive so any modal button works)
function closeModal(element) {
  let modal = null;
  if (element && element.classList && element.classList.contains('modal-overlay')) {
    modal = element;
  } else if (element && typeof element.closest === 'function') {
    modal = element.closest('.modal-overlay');
  } else {
    modal =
      document.querySelector('.modal-overlay.active') ||
      document.querySelector('.modal-overlay');
  }
  if (!modal) return;
  modal.classList.remove('active');
  const remove = () => {
    if (modal && modal.parentNode) modal.remove();
  };
  modal.addEventListener('transitionend', remove, { once: true });
  setTimeout(remove, 320);
}

function stripInlineHandlers(root, logger) {
  if (!root) return;
  const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
  const targets = [root, ...all];
  targets.forEach((el) => {
    if (!el || !el.attributes) return;
    Array.from(el.attributes).forEach((attr) => {
      if (/^on/i.test(attr.name)) {
        if (typeof logger === 'function') logger(el, attr.name);
        try { el.removeAttribute(attr.name); } catch (_) {}
      }
    });
  });
}

function startInlineHandlerGuard() {
  if (typeof MutationObserver === 'undefined') return;
  let inlineHandlerLogCount = 0;
  const logRemoval = (el, name) => {
    if (inlineHandlerLogCount >= 5) return;
    inlineHandlerLogCount += 1;
    try {
      console.warn('Removed inline handler:', name, el);
    } catch (_) {}
  };
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.type === 'attributes' && /^on/i.test(mutation.attributeName || '')) {
        logRemoval(mutation.target, mutation.attributeName);
        mutation.target.removeAttribute(mutation.attributeName);
      }
      if (mutation.type === 'childList') {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === 1) {
            stripInlineHandlers(node, logRemoval);
          }
        });
      }
    });
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeOldValue: false,
    childList: true,
    subtree: true,
  });
}

function wireModalCloseButtons(modal) {
  if (!modal) return;
  const targetModal =
    modal.classList && modal.classList.contains('modal-overlay')
      ? modal
      : modal.closest && modal.closest('.modal-overlay');
  if (!targetModal) return;
  stripInlineHandlers(targetModal);
  targetModal.querySelectorAll('[data-close-modal]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      closeModal(targetModal);
    });
  });
}

// Delegate close buttons and Esc key
document.addEventListener('click', (event) => {
  const trigger = event.target && event.target.closest('[data-close-modal]');
  if (!trigger) return;
  event.preventDefault();
  closeModal(trigger);
});

// Capture clicks early to strip any inline handlers before they execute (CSP-friendly)
document.addEventListener('click', (event) => {
  const path = event.composedPath ? event.composedPath() : [];
  const nodes = Array.isArray(path) && path.length ? path : getAncestors(event.target);
  nodes.forEach((el) => {
    if (!el || !el.attributes) return;
    Array.from(el.attributes).forEach((attr) => {
      if (/^on/i.test(attr.name)) {
        try { el.removeAttribute(attr.name); } catch (_) {}
      }
    });
  });
}, true);

function getAncestors(node) {
  const list = [];
  let n = node;
  while (n) {
    list.push(n);
    n = n.parentNode;
  }
  return list;
}

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const modal =
    document.querySelector('.modal-overlay.active') ||
    document.querySelector('.modal-overlay');
  if (!modal) return;
  event.preventDefault();
  closeModal(modal);
});

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
    const handleLoad = () => {
        placeholder.parentNode.replaceChild(iframe, placeholder);
        showNotification('success', `${formType === 'representative' ? 'Representative' : 'Team member'} form loaded successfully!`);

        // Set up form completion detection
        setupFormCompletionDetection(iframe, formType);
    };
    const handleError = () => {
        placeholder.classList.remove('loading');
        loadingSpinner.classList.remove('active');
        showNotification('error', 'Failed to load form. Please try again.');
    };
    iframe.addEventListener('load', handleLoad, { once: true });
    iframe.addEventListener('error', handleError, { once: true });
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

// Management Dashboard
async function initializeManagementDashboard() {
    const management = window.dashboardData && window.dashboardData.management;
    if (management) {
        managementState = management;
    }
    try { console.debug('mgmt:init', { enabled: !!managementState.enabled, members: (managementState.members||[]).length }); } catch (_) {}
    if (!managementState.enabled) {
        const membersGrid = document.getElementById('management-members-grid');
        if (membersGrid) {
            membersGrid.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-lock"></i>
                    <h4>Management data unavailable</h4>
                    <p>This environment is not connected to the membership tracking base.</p>
                </div>`;
        }
        return;
    }
    renderStartupInfo();
    renderPrimaryContactCards();
    renderManagementSummary();
    // Ensure Add Member control exists (fallback if server-rendered button missing)
    try {
        ensureAddMemberControl();
    } catch (_) {}
    // Attach Add Member handler (management page)
    try {
        const addBtn = document.querySelector('.add-member-btn');
        if (addBtn) {
            addBtn.addEventListener('click', openAddMemberForm);
        }
    } catch (_) {}
    renderManagementMembers();
    renderManagementEvents();
    renderManagementRequests();
    await refreshStartupInfo({ silent: true });
}

function renderManagementSummary() {
    const container = document.getElementById('management-summary-grid');
    if (!container) return;
    const summary = managementState.summary || {};
    const cards = [
        { label: 'Team Members', value: summary.totalMembers || 0, icon: 'users', accent: 'info' },
        { label: 'Assigned Memberships', value: summary.membershipsAssigned || 0, icon: 'id-card', accent: 'success' },
        { label: 'Pending Requests', value: summary.pendingRequests || 0, icon: 'hourglass-half', accent: 'warning' },
        { label: 'Recent Events', value: summary.recentEvents || 0, icon: 'history', accent: 'alert' },
    ];
    container.innerHTML = cards.map(card => `
        <div class="summary-card ${card.accent}">
            <div class="summary-icon"><i class="fas fa-${card.icon}"></i></div>
            <div>
                <p>${card.label}</p>
                <h3>${card.value}</h3>
            </div>
        </div>
    `).join('');
}

function renderStartupInfo() {
    const container = document.getElementById('management-startup-info');
    if (!container) return;
    const startup = startupInfo || window.dashboardData.startup || {};
    const fields = [
        { key: 'Startup Name (or working title)', label: 'Startup Name', value: startup.name || startup.registeredBusinessName || '', type: 'text' },
        { key: 'Description*', label: 'Description', value: startup.description || '', type: 'textarea' },
        { key: 'ABN', label: 'ABN', value: startup.abn || '', type: 'text' },
        { key: 'Registered Business Name', label: 'Registered Business Name', value: startup.registeredBusinessName || '', type: 'text' },
    ];
    container.innerHTML = `
        <div class="startup-info-grid">
            ${fields.map(field => `
                <div class="startup-info-card" data-field="${field.key}">
                    <p class="label">${field.label}</p>
                    ${renderStartupFieldValue(field)}
                </div>
            `).join('')}
        </div>
    `;

    container.querySelectorAll('.startup-info-card .value.editable').forEach(el => {
        el.addEventListener('click', () => beginStartupFieldEdit(el));
    });
}

async function refreshStartupInfo(options = {}) {
    const token = window.dashboardData && window.dashboardData.token;
    if (!token) return;
    try {
        const resp = await fetch(`/startup-info/${token}`);
        const data = await resp.json().catch(() => ({ success: false }));
        if (!resp.ok || !data.success || !data.data) throw new Error(data.message || 'Unable to load startup info');
        startupInfo = data.data || {};
        window.dashboardData.startup = startupInfo;
        renderStartupInfo();
    } catch (error) {
        console.error('startup.info.refresh.error', error);
        if (!options.silent && typeof showNotification === 'function') {
            showNotification('error', error.message || 'Failed to refresh startup info');
        }
    }
}

function renderPrimaryContactCards() {
    renderPrimaryContactInto('management-primary-contact');
    renderPrimaryContactInto('financial-primary-contact');
}

function renderPrimaryContactInto(elementId) {
    const container = document.getElementById(elementId);
    if (!container) return;
    const contact = firstPointOfContact || {};
    if (!contact.email) {
        container.innerHTML = `
            <div class="primary-contact empty">
                <div>
                    <p class="label">Primary contact</p>
                    <p class="value muted-text">No representative assigned yet.</p>
                </div>
            </div>`;
        return;
    }
    container.innerHTML = `
        <div class="primary-contact">
            <div>
                <p class="label">Primary contact${contact.source ? ` · <span class="contact-source">${contact.source.replace('-', ' ')}</span>` : ''}</p>
                <h4>${contact.name || 'Representative'}</h4>
                <p class="muted-text">${contact.role || 'Role not set'}</p>
                <p class="muted-text">Email: ${contact.email || 'Not provided'}</p>
            </div>
            <div class="contact-actions">
                <button type="button" class="btn btn-outline btn-small change-primary-contact-btn">
                    <i class="fas fa-user-edit"></i> Change Primary Contact
                </button>
            </div>
        </div>`;
    const changeBtn = container.querySelector('.change-primary-contact-btn');
    if (changeBtn) changeBtn.addEventListener('click', openChangePrimaryContactModal);
}

function collectPrimaryContactCandidates() {
    const candidates = [];
    const seen = new Set();
    const add = (obj) => {
        const key = obj.id || obj.email;
        if (!key || seen.has(key)) return;
        seen.add(key);
        candidates.push(obj);
    };
    const managementMembers = (managementState && Array.isArray(managementState.members))
        ? managementState.members
        : [];
    managementMembers.forEach((m) => add({
        id: m.primaryId || m.id || m.email,
        name: m.name || '',
        firstName: m.firstName || '',
        email: m.email || '',
        role: m.position || m.membershipType || '',
        source: 'management',
    }));
    const baseMembers = (window.dashboardData && Array.isArray(window.dashboardData.teamMembers))
        ? window.dashboardData.teamMembers
        : [];
    baseMembers.forEach((m) => add({
        id: m.id || m.email,
        name: m.name || '',
        firstName: m.firstName || '',
        email: m.email || '',
        role: m.position || '',
        source: 'team',
    }));
    return candidates;
}

function openChangePrimaryContactModal() {
    const candidates = collectPrimaryContactCandidates();
    if (!candidates.length) {
        showNotification('error', 'No team members available to select.');
        return;
    }
    const modal = document.createElement('div');
    modal.className = 'modal-overlay active';
    const optionsHtml = candidates.map((c, idx) => {
        const selected =
            (firstPointOfContact &&
                (firstPointOfContact.memberId === c.id ||
                 firstPointOfContact.email === c.email)) ||
            (!firstPointOfContact && idx === 0);
        const emailText = c.email || 'Email not provided';
        const roleText = c.role || 'Role not set';
        return `
            <label class="radio-option" style="display:flex;gap:12px;align-items:center;padding:8px 0;border-bottom:1px solid var(--dark-border);">
                <input type="radio" name="primaryContact" value="${c.id}" ${selected ? 'checked' : ''} data-email="${c.email || ''}" data-name="${c.name || ''}" data-role="${c.role || ''}" data-first-name="${c.firstName || ''}">
                <div>
                    <strong>${c.name || 'Unnamed member'}</strong>
                    <p class="muted-text">${roleText} · ${emailText}</p>
                </div>
            </label>`;
    }).join('');

  modal.innerHTML = `
        <div class="modal-content" style="max-width: 520px;">
            <div class="modal-header">
                <h3>Change Primary Contact</h3>
                <p>Select a team member to use as the primary contact.</p>
            </div>
            <form class="modal-form" id="primaryContactForm">
                <div class="form-group" style="max-height:320px;overflow:auto;padding:4px 0;">
                    ${optionsHtml}
                </div>
                <div class="modal-actions">
                    <button type="button" class="btn btn-outline" data-close-modal="true">Cancel</button>
                    <button type="submit" class="btn btn-primary">
                        <i class="fas fa-save"></i> Save
                    </button>
                </div>
            </form>
        </div>
    `;
    document.body.appendChild(modal);
    wireModalCloseButtons(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(modal); });
    const form = modal.querySelector('#primaryContactForm');
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const selected = form.querySelector('input[name="primaryContact"]:checked');
        if (!selected) {
            showNotification('error', 'Please select a member.');
            return;
        }
        setPrimaryContactFromSelection({
            id: selected.value,
            name: selected.dataset.name || '',
            email: selected.dataset.email || '',
            role: selected.dataset.role || '',
            firstName: selected.dataset.firstName || '',
        });
        closeModal(modal);
    });
}

async function setPrimaryContactFromSelection(candidate) {
    if (!candidate) return;
    firstPointOfContact = {
        memberId: candidate.id || null,
        name: candidate.name || 'Primary contact',
        role: candidate.role || null,
        email: candidate.email || '',
        source: 'user-selected',
    };
    renderPrimaryContactCards();
    try {
        // 1) Always update startup primary contact email
        const emailResp = await fetch('/startups/update-field', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                token: window.dashboardData.token,
                field: 'Primary contact email',
                value: candidate.email || '',
            }),
        });
        const emailBody = await emailResp.json().catch(() => ({ success: false }));
        if (!emailResp.ok || !emailBody.success) {
            throw new Error(emailBody.message || 'Failed to update primary contact email');
        }

        // 2) Best-effort: update first name, but do not fail the flow if the field is missing
        const inferredFirst = candidate.firstName || (candidate.name || '').split(/\s+/)[0] || '';
        if (inferredFirst) {
            try {
                const firstResp = await fetch('/startups/update-field', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        token: window.dashboardData.token,
                        field: 'Primary contact first name',
                        value: inferredFirst,
                    }),
                });
                const firstBody = await firstResp.json().catch(() => ({ success: false }));
                if (!firstResp.ok || !firstBody.success) {
                    console.warn('primary-contact:first-name skipped', firstBody.message || 'Update failed');
                }
            } catch (err) {
                try { console.warn('primary-contact:first-name error', err?.message || err); } catch (_) {}
            }
        }

        showNotification('success', 'Primary contact updated');
    } catch (e) {
        showNotification('error', e.message || 'Failed to update primary contact');
    }
}

function renderStartupFieldValue(field) {
    const display = field.value || 'Not provided';
    const isEditable = true;
    if (!isEditable) return `<p class="value">${display}</p>`;
    return `<p class="value editable" data-key="${field.key}" data-type="${field.type}" data-placeholder="${field.label}">
        ${display || '<span class="muted-text">Click to edit</span>'}
        <span class="edit-hint"><i class="fas fa-pen"></i></span>
    </p>`;
}

function beginStartupFieldEdit(element) {
    const key = element.getAttribute('data-key');
    const type = element.getAttribute('data-type') || 'text';
    const placeholder = element.getAttribute('data-placeholder') || '';
    const initial = element.dataset.value || element.textContent.trim();
    const numericOnly = key === 'ABN';
    const modal = document.createElement('div');
    modal.className = 'modal-overlay active';
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 520px;">
            <div class="modal-header">
                <h3>Edit ${placeholder}</h3>
            </div>
            <form class="modal-form" id="startupFieldForm">
                <div class="form-group">
                    ${type === 'textarea'
                        ? `<textarea class="form-input" name="value" rows="4">${initial || ''}</textarea>`
                        : `<input class="form-input" type="${numericOnly ? 'tel' : 'text'}" inputmode="${numericOnly ? 'numeric' : 'text'}" pattern="${numericOnly ? '[0-9]+' : '.*'}" aria-label="${numericOnly ? 'Enter digits only' : ''}" title="${numericOnly ? 'Digits only' : ''}" name="value" value="${initial || ''}">`
                    }
                </div>
                <div class="modal-actions">
                    <button type="button" class="btn btn-outline" data-close-modal="true">Cancel</button>
                    <button type="submit" class="btn btn-primary">
                        <i class="fas fa-save"></i> Save
                    </button>
                </div>
            </form>
        </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(modal); });
    const form = modal.querySelector('#startupFieldForm');
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
            const newValue = form.querySelector('[name="value"]').value.trim();
            if (key === 'ABN') {
                if (!/^[0-9]+$/.test(newValue)) {
                    showNotification('error', 'Please enter digits only for ABN (no spaces or letters).');
                    return;
                }
            }
            try {
                const resp = await fetch('/startups/update-field', {
                        method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    token: window.dashboardData.token,
                    field: key,
                    value: newValue,
                }),
            });
            const data = await resp.json().catch(() => ({ success: false }));
            if (!resp.ok || !data.success) throw new Error(data.message || 'Update failed');
            showNotification('success', `${placeholder} updated`);
            closeModal(modal);
            // Update local state and re-render
            const keyMap = {
                'Startup Name (or working title)': 'name',
                'Description*': 'description',
                'Description': 'description',
                'ABN': 'abn',
                'Registered Business Name': 'registeredBusinessName',
            };
            const prop = keyMap[key];
            if (prop) {
                startupInfo = startupInfo || {};
                startupInfo[prop] = newValue;
                window.dashboardData.startup = startupInfo;
            }
            renderStartupInfo();
            refreshStartupInfo({ silent: true });
        } catch (err) {
            showNotification('error', err.message || 'Failed to update');
        }
    });
}

function renderManagementMembers() {
    const container = document.getElementById('management-members-grid');
    if (!container) return;
    const members = managementState.members || [];
    if (!members.length) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-user-plus"></i>
                <h4>No members found</h4>
                <p>Once team members complete onboarding, their memberships will appear here.</p>
            </div>`;
        return;
    }
    // Partition by status/type: treat offboarded/inactive separately
    const isInactive = (m) =>
        /offboard/i.test(String(m.membershipType || '')) ||
        /inactive/i.test(String(m.status || ''));
    const offboarded = members.filter(isInactive);
    const active = members.filter(m => !isInactive(m));

    const fmtType = (t) => {
        const s = (t || '').toString();
        if (!s) return 'Unassigned';
        if (/full/i.test(s)) return 'FULL';
        if (/casual/i.test(s)) return 'CASUAL';
        if (/day/i.test(s)) return 'DAY';
        // strip the word 'membership' if present and uppercase remainder
        return s.replace(/\bmembership\b/ig, '').trim().toUpperCase() || 'UNASSIGNED';
    };

    const renderCard = (member) => `
        <div class="management-member-card" data-member-id="${member.primaryId}">
            <div class="card-header">
                <div>
                    <h4>${member.name || 'Unknown Member'}</h4>
                    <p class="muted-text">${member.email || 'No email listed'}</p>
                </div>
                <span class="badge">${fmtType(member.membershipType || member.membershipTypeOld || '')}</span>
            </div>
            <div class="card-body">
                <div class="card-stat">
                    <span>Role</span>
                    <strong class="role-row">
                        <span class="member-role-text">${member.position || '—'}</span>
                        <button type="button" class="icon-button role-edit-btn" data-member-id="${member.primaryId}" aria-label="Edit role" title="Edit role">
                            <i class="fas fa-pen"></i>
                        </button>
                    </strong>
                </div>
                <div class="card-stat">
                    <span>Mobile</span>
                    <strong>${member.mobile || '—'}</strong>
                </div>
                <div class="card-stat">
                    <span>Date of birth</span>
                    <strong>${formatDate(member.dateOfBirth)}</strong>
                </div>
                <div class="card-stat">
                    <span>Status</span>
                    <strong>${member.status || '—'}</strong>
                </div>
            </div>
            <div class="card-actions">
                <button class="btn btn-small membership-edit-btn" data-member-id="${member.primaryId}">
                    <i class="fas fa-edit"></i> Edit Member
                </button>
            </div>
        </div>
    `;

    const sections = [];
    // Active members section
    sections.push(`
        <div class="members-section">
            <div class="section-header">
                <h4 style="display:flex;align-items:center;gap:8px;"><i class="fas fa-user-check"></i> Active Members</h4>
            </div>
            ${active.length ? active.map(renderCard).join('') : `<p class="muted-text">No active members.</p>`}
        </div>
    `);
    // Offboarded section
    sections.push(`
        <div class="members-section offboarded-section">
            <div class="section-header">
                <h4 style="display:flex;align-items:center;gap:8px;"><i class="fas fa-user-slash"></i> Inactive / Offboarded</h4>
            </div>
            ${offboarded.length ? offboarded.map(renderCard).join('') : `<p class="muted-text">No inactive members.</p>`}
        </div>
    `);
    container.innerHTML = sections.join('');

    container.querySelectorAll('.membership-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => openMembershipModal(btn.dataset.memberId));
    });
    container.querySelectorAll('.role-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => handleRoleEdit(btn.dataset.memberId));
    });
}

async function handleRoleEdit(memberId) {
    const member =
        (managementState.members || []).find((m) => m.primaryId === memberId) ||
        (window.dashboardData.teamMembers || []).find((m) => m.id === memberId);
    if (!member) return;
    const initial = member.position || '';
    const result = await Swal.fire({
        title: 'Update role',
        input: 'text',
        inputValue: initial,
        inputPlaceholder: 'e.g. CEO, Operations Lead',
        showCancelButton: true,
        confirmButtonColor: '#10b981',
        cancelButtonColor: '#475569',
        confirmButtonText: 'Save role',
    });
    if (result.isDismissed) return;
    const newRole = (result.value || '').trim();
    await persistMemberRole(memberId, newRole);
}

async function persistMemberRole(memberId, roleValue) {
    try {
        const resp = await fetch(`/team-members/${memberId}/role`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: window.dashboardData.token, role: roleValue }),
        });
        const data = await resp.json().catch(() => ({ success: false }));
        if (!resp.ok || !data.success) throw new Error(data.message || 'Failed to update role');
        const normalized = data?.data?.role ?? roleValue ?? '';
        const target = (managementState.members || []).find((m) => m.primaryId === memberId);
        if (target) target.position = normalized;
        const baseMember = (window.dashboardData.teamMembers || []).find((m) => m.id === memberId || m.primaryId === memberId);
        if (baseMember) baseMember.position = normalized;
        if (firstPointOfContact && firstPointOfContact.memberId === memberId) {
            firstPointOfContact.role = normalized;
            renderPrimaryContactCards();
        }
        renderManagementMembers();
        showNotification('success', 'Role updated');
    } catch (error) {
        console.error('role.update.error', error);
        showNotification('error', error.message || 'Unable to update role');
    }
}

function renderManagementEvents() {
    const container = document.getElementById('management-events-list');
    if (!container) return;
    const events = managementState.events || [];
    if (!events.length) {
        container.innerHTML = '<p class="muted-text">No recorded membership events.</p>';
        return;
    }
    const attrMap = {
        membership_type: 'Membership Type',
        discount_declared: 'Discount Declared',
        status: 'Status',
        membership_start_date: 'Membership Start Date',
        membership_end_date: 'Membership End Date',
        graduation_date: 'Graduation Date',
        redundancy_date: 'Redundancy Date',
    };
    container.innerHTML = events.map(event => {
        const attrKey = (event.attribute || '').toLowerCase();
        const label = attrMap[attrKey] || event.attribute || 'Membership';
        return `
        <div class="history-item">
            <div>
                <strong>Member: ${event.memberName || 'Member'}</strong>
                <p>${label}: ${event.fromValue || 'None'} → ${event.toValue || 'None'}</p>
            </div>
            <div class="history-meta">
                <span>${formatDateTime(event.effectiveAt)}</span>
                <span class="muted-text">${event.source || ''}</span>
            </div>
        </div>
    `;
    }).join('');
}

function renderManagementRequests() {
    const container = document.getElementById('management-requests-list');
    if (!container) return;
    const requests = managementState.changeRequests || [];
    if (!requests.length) {
        container.innerHTML = '<p class="muted-text">No pending change requests.</p>';
        return;
    }
    container.innerHTML = requests.map(req => `
        <div class="history-item">
            <div>
                <strong>${req.memberName || 'Member'}</strong>
                <p>${req.attribute || 'Membership'} → ${req.requestedValue || 'Requested'}</p>
            </div>
            <div class="history-meta">
                <span>${formatDateTime(req.requestedAt)}</span>
                <span class="badge ${req.decision ? 'status-' + req.decision.toLowerCase() : 'pending'}">${req.decision || 'Pending'}</span>
            </div>
        </div>
    `).join('');
}

function initializeFinancialSection() {
    if (financialState.initialized) return;
    financialState.initialized = true;
    renderFinancialFilters();
    loadFinancialTransactions();
}

function renderFinancialFilters() {
    const container = document.getElementById('financial-filters');
    if (!container) return;
    const filters = [
        { key: 'all', label: 'All' },
        { key: 'meeting', label: 'Meeting Rooms' },
        { key: 'giveback', label: 'Givebacks' },
        { key: 'membership', label: 'Membership' },
        { key: 'locker', label: 'Lockers' },
        { key: 'other', label: 'Other' },
    ];
    container.innerHTML = filters.map((filter) => `
        <button type="button" class="filter-pill ${financialState.filter === filter.key ? 'active' : ''}" data-filter="${filter.key}">
            ${filter.label}
        </button>
    `).join('');
    container.querySelectorAll('[data-filter]').forEach((btn) => {
        btn.addEventListener('click', () => setFinancialFilter(btn.dataset.filter));
    });
}

function setFinancialFilter(key) {
    financialState.filter = key;
    const container = document.getElementById('financial-filters');
    if (container) {
        container.querySelectorAll('[data-filter]').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.filter === key);
        });
    }
    renderFinancialTransactions();
}

async function loadFinancialTransactions() {
    const list = document.getElementById('financial-transactions-list');
    if (!list) return;
    financialState.loading = true;
    renderFinancialTransactions();
    try {
        const resp = await fetch(`/financial-transactions/${window.dashboardData.token}`);
        const data = await resp.json().catch(() => ({ success: false }));
        if (!resp.ok || !data.success) throw new Error(data.message || 'Unable to load financial data');
        financialState.entries = data?.data?.entries || [];
        financialState.totals = data?.data?.totals || { debits: 0, credits: 0 };
    } catch (error) {
        console.error('financial.load.error', error);
        list.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-info-circle"></i>
                <h4>Unable to load financial entries</h4>
                <p>${error.message || 'Please try again later.'}</p>
            </div>`;
    } finally {
        financialState.loading = false;
        renderFinancialTransactions();
    }
}

function renderFinancialTransactions() {
    const container = document.getElementById('financial-transactions-list');
    if (!container) return;
    if (financialState.loading) {
        container.innerHTML = `
            <div class="skeleton-list">
                <div class="skeleton-card"></div>
                <div class="skeleton-card"></div>
                <div class="skeleton-card"></div>
            </div>`;
        return;
    }
    const entries = (financialState.entries || []).filter((entry) => {
        const type = (entry.type || '').toLowerCase();
        switch (financialState.filter) {
            case 'meeting':
                return type.includes('meeting room');
            case 'giveback':
                return type.includes('giveback');
            case 'membership':
                return type.includes('membership');
            case 'locker':
                return type.includes('locker');
            case 'other':
                return !/(meeting room|giveback|membership|locker)/i.test(type);
            default:
                return true;
        }
    });
    if (!entries.length) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-receipt"></i>
                <h4>No transactions found</h4>
                <p>Charges and credits will appear here once they are posted.</p>
            </div>`;
        return;
    }
    const rows = entries.map((entry) => {
        const debit = entry.debitAmount ? `<span class="amount debit">-${formatCurrencyValue(entry.debitAmount)}</span>` : '';
        const credit = entry.creditAmount ? `<span class="amount credit">+${formatCurrencyValue(entry.creditAmount)}</span>` : '';
        const tags = [];
        if (entry.related?.bookings?.length) tags.push('Meeting room');
        if (entry.related?.givebacks?.length) tags.push('Giveback');
        if (entry.related?.lockerAssignments?.length) tags.push('Locker');
        if (entry.related?.membershipStaging?.length) tags.push('Membership');
        return `
            <article class="transaction-card">
                <div class="transaction-head">
                    <div>
                        <p class="transaction-type">${entry.type || 'Entry'}</p>
                        <p class="transaction-date">${formatDateTime(entry.timestamp) || formatDate(entry.date)}</p>
                    </div>
                    <div class="transaction-amounts">
                        ${debit || ''}
                        ${credit || ''}
                    </div>
                </div>
                <p class="transaction-description">${entry.description || 'No description provided.'}</p>
                ${(entry.billingPeriod || entry.notes)
                    ? `<div class="transaction-meta">
                           ${entry.billingPeriod ? `<span>Billing period: ${entry.billingPeriod}</span>` : ''}
                           ${entry.notes ? `<span>Notes: ${entry.notes}</span>` : ''}
                       </div>` : ''}
                ${tags.length
                    ? `<div class="transaction-tags">
                           ${tags.map(t => `<span class="tag">${t}</span>`).join('')}
                       </div>` : ''}
            </article>`;
    }).join('');
    container.innerHTML = rows;
}

// Open Team Members form (same as onboarding step 3) in an embedded modal
async function openAddMemberForm() {
    try {
        let url = null;
        // Prefer startup-provided Team Member form URL (from Startups record)
        try {
            const fromStartup = (window.dashboardData.startup && window.dashboardData.startup.teamMemberFormUrl) || '';
            if (fromStartup) url = fromStartup;
        } catch (_) {}
        try {
            const resp = await fetch(`/get-team-members-form/${window.dashboardData.token}`);
            const ct = resp.headers.get('content-type') || '';
            if (ct.includes('application/json')) {
                const data = await resp.json();
                if (data && data.success && data.formUrl) url = data.formUrl;
            }
        } catch (_) { /* ignore */ }
        // Fallback: derive from generic form URL + startup prefill
        if (!url) {
            const baseUrl = (window.dashboardData.formUrls && window.dashboardData.formUrls.teamMember) || '';
            const sid = (window.dashboardData.startup && window.dashboardData.startup.startupRecordId) || '';
            if (!baseUrl || !sid) throw new Error('Form unavailable');
            try {
                const u = new URL(baseUrl);
                const p = u.searchParams;
                const pairs = [
                    ['prefill_Startup', sid],
                    ['hide_Startup', 'true'],
                    ['prefill_Startup*', sid],
                    ['hide_Startup*', 'true'],
                ];
                for (const [k,v] of pairs) { if (!p.has(k)) p.set(k, v); }
                url = u.toString();
            } catch (_) {
                url = `${baseUrl}`; // last resort
            }
        }

        const modal = document.createElement('div');
        modal.className = 'modal-overlay active';
        modal.innerHTML = `
            <div class="modal-content has-iframe">
                <div class="modal-header">
                    <h3>Add Team Member</h3>
                    <p>Fill out the form to add a new team member to your startup.</p>
                </div>
                <div class="modal-form">
                    <iframe 
                        src="${url}"
                        class="airtable-embed team-member-form"
                        frameborder="0"
                        width="100%"
                        height="100%"
                        style="background: transparent; border: 1px solid var(--dark-border); border-radius: 12px; height: 100%;"
                        loading="lazy">
                    </iframe>
                </div>
                <div class="modal-actions" style="justify-content: space-between; gap: 12px;">
                    <button type="button" class="btn btn-outline" data-close-modal="true">Close</button>
                    <div style="display:flex; gap:8px; align-items:center;">
                        <a class="btn btn-secondary" href="${url}" target="_blank" rel="noopener">Open in new tab</a>
                        <button type="button" class="btn btn-primary" id="refresh-members-btn">
                            <i class="fas fa-rotate"></i> Refresh Form
                        </button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        wireModalCloseButtons(modal);
        // Close when clicking outside content
        modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(modal); });
        // Optional: refresh button
        const refreshBtn = modal.querySelector('#refresh-members-btn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', async () => {
                // Reload the Airtable form iframe to pick up any auto-prefill updates
                const frame = modal.querySelector('iframe.airtable-embed');
                if (frame && frame.src) {
                    frame.src = frame.src;
                }
            });
        }
    } catch (e) {
        showNotification('error', e.message || 'Failed to open form');
    }
}

function openMembershipModal(memberId) {
    const member = (managementState.members || []).find((m) => m.primaryId === memberId);
    if (!member) return;
    const baseMember = (window.dashboardData.teamMembers || []).find((m) => m.id === memberId) || {};
    const merged = {
        name: member.name || baseMember.name || '',
        email: member.email || baseMember.email || '',
        mobile: member.mobile || baseMember.mobile || '',
        dateOfBirth: member.dateOfBirth || baseMember.dateOfBirth || '',
        photoUrl: member.photoUrl || baseMember.photoUrl || '',
        membershipType: member.membershipType || '',
        agentRecordId: member.agentRecordId,
        primaryId: member.primaryId,
    };
    // Restrict membership selection to Day, Casual, Full (values mapped to base names)
    const allowedMembershipValues = [
        { value: 'Day Membership', label: 'Day' },
        { value: 'Casual Membership', label: 'Casual' },
        { value: 'Full Membership', label: 'Full' },
    ];
    const membershipDisabled = '';
    const membershipNotice = '';

    const modal = document.createElement('div');
    modal.className = 'modal-overlay active';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3>Edit Member</h3>
                <p>Update contact and membership details for ${merged.name || 'member'}.</p>
            </div>
            <form class="modal-form" id="membershipForm" novalidate>
                <div class="form-section">
                    <h4>Personal Information</h4>
                    <div class="form-group photo-group">
                        <label class="form-label">Photo</label>
                        <div class="photo-preview">
                            <img src="${merged.photoUrl || 'https://via.placeholder.com/72?text=Photo'}" alt="Member photo" class="member-photo-preview">
                            <button type="button" class="btn btn-outline photo-edit-btn" data-role="photo-edit">
                                <i class="fas fa-pen"></i>
                            </button>
                        </div>
                        <input type="file" class="form-input photo-input" name="memberPhotoFile" accept="image/*" hidden>
                    </div>
                    <div class="form-group">
                        <label class="form-label">First Name</label>
                        <input type="text" class="form-input" name="memberFirstName" value="${baseMember.firstName || ''}">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Last Name</label>
                        <input type="text" class="form-input" name="memberLastName" value="${baseMember.lastName || ''}">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Personal Email</label>
                        <input type="email" class="form-input" name="memberEmail" value="${merged.email || ''}">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Mobile Number</label>
                        <input type="tel" class="form-input" name="memberMobile" value="${merged.mobile || ''}">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Date of Birth</label>
                        <input type="date" class="form-input" name="memberDob" value="${merged.dateOfBirth ? merged.dateOfBirth.slice(0,10) : ''}">
                    </div>
                </div>
                <div class="form-section">
                    <h4>Membership</h4>
                    <div class="form-group">
                        <label class="form-label">Membership Type</label>
                        <select name="membershipType" class="form-input" ${membershipDisabled}>
                            ${allowedMembershipValues
                                .map(opt => `<option value="${opt.value}" ${opt.value === (member.membershipType || '') ? 'selected' : ''}>${opt.label}</option>`)
                                .join('')}
                        </select>
                        ${membershipNotice}
                    </div>
                </div>
                <div class="modal-actions" style="justify-content: space-between; gap: 12px;">
                    <div>
                        <button type="button" class="btn btn-outline" data-close-modal="true">Cancel</button>
                    </div>
                    <div style="display:flex; gap:8px; align-items:center;">
                        <button type="button" class="btn" style="background: var(--error-color); border: none; color: white;" id="offboard-btn">
                            <i class="fas fa-user-slash"></i> Offboard
                        </button>
                        <button type="submit" class="btn btn-primary" id="save-member-btn">
                            <i class="fas fa-save"></i> Save Changes
                        </button>
                    </div>
                </div>
            </form>
        </div>
    `;

    modal.dataset.memberId = member.primaryId;
    document.body.appendChild(modal);
    const form = modal.querySelector('#membershipForm');
    wireModalCloseButtons(modal);
    setupPhotoEditor(modal, merged);
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        try { console.debug('membership:submit'); } catch (_) {}
        await submitMemberEdits(member, merged, new FormData(form), modal);
    });
    // Fallback: explicitly wire the Save button to requestSubmit (ensures HTML5 validation)
    const saveBtn = modal.querySelector('#save-member-btn');
    if (saveBtn) {
        saveBtn.addEventListener('click', (ev) => {
            try { console.debug('membership:save_click'); } catch (_) {}
            // Let the form submission handler drive the update
            if (form && form.requestSubmit) form.requestSubmit();
        });
    }
    const offboardBtn = modal.querySelector('#offboard-btn');
    if (offboardBtn) {
        const isOffboarded = /inactive|offboard/i.test(String(member.status || ''));
        offboardBtn.innerHTML = isOffboarded
            ? '<i class="fas fa-user-check"></i> Onboard'
            : '<i class="fas fa-user-slash"></i> Offboard';
        offboardBtn.style.background = isOffboarded ? 'var(--primary-color)' : 'var(--error-color)';
        offboardBtn.addEventListener('click', async () => {
            try {
                const action = isOffboarded ? 'onboard' : 'offboard';
                const confirmed = await Swal.fire({
                    icon: action === 'offboard' ? 'warning' : 'question',
                    title: action === 'offboard' ? 'Offboard member?' : 'Onboard member?',
                    text: action === 'offboard'
                        ? `This will record an offboard date for ${merged.name || 'the member'}.`
                        : `This will clear the offboard date for ${merged.name || 'the member'}.`,
                    showCancelButton: true,
                    confirmButtonText: action === 'offboard' ? 'Yes, offboard' : 'Yes, onboard',
                    cancelButtonText: 'Cancel',
                    confirmButtonColor: action === 'offboard' ? '#ef4444' : 'var(--primary-color)',
                }).then(r => r.isConfirmed);
                if (!confirmed) return;
                offboardBtn.disabled = true;
                offboardBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${action === 'offboard' ? 'Offboarding' : 'Onboarding'}...`;
                const resp = await fetch(`/team-members/${action}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        token: window.dashboardData.token,
                        memberId: member.primaryId,
                        agentMemberId: member.agentRecordId || null,
                        membershipType: member.membershipType || '',
                    }),
                });
                const data = await resp.json().catch(() => ({ success: false }));
                if (!resp.ok || !data.success) throw new Error(data.message || `Failed to ${action}`);
                showNotification('success', `Member ${action === 'offboard' ? 'offboarded' : 'onboarded'}`);
                await refreshManagementData();
                closeModal(modal);
            } catch (e) {
                showNotification('error', e.message || 'Action failed');
                offboardBtn.disabled = false;
                offboardBtn.innerHTML = isOffboarded
                    ? '<i class="fas fa-user-check"></i> Onboard'
                    : '<i class="fas fa-user-slash"></i> Offboard';
                offboardBtn.style.background = isOffboarded ? 'var(--primary-color)' : 'var(--error-color)';
            }
        });
    }
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeModal(modal);
        }
    });
}

async function submitMemberEdits(member, original, formData, modal) {
    const button = modal.querySelector('button[type="submit"]');
    const originalText = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';

    const personalUpdates = {};
    const first = formData.get('memberFirstName')?.trim();
    const last = formData.get('memberLastName')?.trim();
    if (typeof first === 'string' && first !== (original.firstName || '')) personalUpdates['First Name*'] = first;
    if (typeof last === 'string' && last !== (original.lastName || '')) personalUpdates['Last Name*'] = last;
    const email = formData.get('memberEmail')?.trim();
    if (email && email !== original.email) personalUpdates['Personal email*'] = email;
    const mobile = formData.get('memberMobile')?.trim();
    if (mobile && mobile !== original.mobile) personalUpdates['Mobile*'] = mobile;
    const dob = formData.get('memberDob')?.trim();
    if (dob && dob !== (original.dateOfBirth || '')) personalUpdates['Date of birth*'] = dob;
    const photoUpload = formData.get('memberPhotoFile');
    if (photoUpload && photoUpload.name) {
        try {
            const url = await uploadMemberPhoto(photoUpload);
            if (url) personalUpdates['Photo*'] = [{ url }];
        } catch (e) {
            console.error('photo upload failed', e);
            showNotification('error', e.message || 'Photo upload failed');
            button.disabled = false;
            button.innerHTML = originalText;
            return;
        }
    }

    const membershipType = formData.get('membershipType') || null;
    const membershipChanged = member.agentRecordId && membershipType !== member.membershipType;

    try {
        const tasks = [];
        if (Object.keys(personalUpdates).length) {
            tasks.push(
                fetch('/update-profile', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        token: window.dashboardData.token,
                        memberId: member.primaryId,
                        updates: personalUpdates,
                    }),
                }),
            );
        }
        if (membershipChanged) {
            tasks.push(
                fetch('/membership/update', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        token: window.dashboardData.token,
                        memberId: member.primaryId,
                        agentMemberId: member.agentRecordId,
                        updates: { membershipType },
                    }),
                }),
            );
        }
        if (!tasks.length) {
            showNotification('info', 'No changes detected.');
            button.disabled = false;
            button.innerHTML = originalText;
            return;
        }
        const responses = await Promise.all(tasks);
        const bodies = await Promise.all(responses.map((res) => res.json()));
        const failed = bodies.findIndex((body, idx) => !responses[idx].ok || !body.success);
        if (failed !== -1) {
            throw new Error(bodies[failed].message || 'Failed to update member');
        }
        showNotification('success', 'Member updated successfully');
        closeModal(modal);
        await refreshManagementData();
    } catch (error) {
        console.error('membership update error', error);
        showNotification('error', error.message || 'Failed to update member');
    } finally {
        button.disabled = false;
        button.innerHTML = originalText;
    }
}

function setupPhotoEditor(modal, member) {
    const fileInput = modal.querySelector('input[name="memberPhotoFile"]');
    const editBtn = modal.querySelector('[data-role="photo-edit"]');
    const previewImg = modal.querySelector('.photo-preview img');
    if (previewImg) {
        previewImg.addEventListener('error', () => {
            previewImg.src = 'https://via.placeholder.com/72?text=Photo';
        });
    }
    if (editBtn && fileInput) {
        editBtn.addEventListener('click', () => fileInput.click());
    }
    if (fileInput) {
        fileInput.addEventListener('change', () => {
            const file = fileInput.files && fileInput.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.addEventListener('load', () => {
                if (previewImg) previewImg.src = reader.result;
            }, { once: true });
            reader.readAsDataURL(file);
        });
    }
}

async function uploadMemberPhoto(file) {
    const formData = new FormData();
    formData.append('token', window.dashboardData.token);
    formData.append('file', file);
    const resp = await fetch(`/upload-photo/${window.dashboardData.token}`, {
        method: 'POST',
        body: formData,
    });
    const data = await resp.json().catch(() => ({ success: false }));
    if (!resp.ok || !data.success || !data.url) {
        throw new Error(data.message || 'Photo upload failed');
    }
    return data.url;
}

async function submitMembershipUpdate(member, formData, modal) {
    // legacy fallthrough if old modal invoked
    return submitMemberEdits(member, member, formData, modal);
}

async function refreshManagementData() {
    try {
        const response = await fetch(`/management-data/${window.dashboardData.token}`);
        const result = await response.json().catch(() => ({ success: false }));
        if (!response.ok || !result.success || !result.data) {
            throw new Error(result?.message || 'Unable to refresh management data');
        }
        managementState = result.data;
        await refreshStartupInfo({ silent: true });
        renderManagementSummary();
        renderManagementMembers();
        renderManagementEvents();
        renderManagementRequests();
    } catch (error) {
        console.error('Failed to refresh management data', error);
        if (typeof showNotification === 'function') {
            showNotification('error', error.message || 'Failed to refresh management data');
        }
    }
}

function formatDateTime(value) {
    if (!value) return 'Unknown';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString();
}

function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleDateString();
}

function formatCurrencyValue(amount) {
    if (amount == null) return '';
    const number = Number(amount);
    if (!Number.isFinite(number)) return '';
    return new Intl.NumberFormat('en-AU', {
        style: 'currency',
        currency: 'AUD',
        minimumFractionDigits: 2,
    }).format(number);
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
    .onboarding-step.locked .step-header { opacity: 0.6; cursor: not-allowed; }
    .onboarding-step.locked .step-toggle { pointer-events: none; }
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



function ensureAddMemberControl() {
    if (document.querySelector('.add-member-btn')) return;
    const membersGrid = document.getElementById('management-members-grid');
    if (!membersGrid || !membersGrid.parentNode) return;
    const bar = document.createElement('div');
    bar.className = 'management-actions';
    bar.style.display = 'flex';
    bar.style.justifyContent = 'flex-end';
    bar.style.margin = '12px 0';
    bar.innerHTML = `
        <button type="button" class="btn btn-primary add-member-btn">
            <i class="fas fa-user-plus"></i> Add Member
        </button>
    `;
    membersGrid.parentNode.insertBefore(bar, membersGrid);
}
