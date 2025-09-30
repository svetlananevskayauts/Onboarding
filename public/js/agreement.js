// Agreement Validation Page Script
document.addEventListener('DOMContentLoaded', () => {
  const token = window.agreementData?.token;
  const statusEl = document.getElementById('job-status');
  const tableBody = document.getElementById('members-body');
  const pdfBtn = document.getElementById('download-pdf-btn');
  const pdfLink = document.getElementById('download-pdf-link');
  const fileInput = document.getElementById('signed-file');
  const uploadBtn = document.getElementById('upload-signed-btn');
  const uploadStatus = document.getElementById('upload-signed-status');

  if (!token || !statusEl || !tableBody) return;

  // Start or attach to the job
  fetch(`/validate-and-generate/${token}`, { method: 'POST' }).catch(() => {});

  // Poll for status
  const interval = setInterval(async () => {
    try {
      const res = await fetch(`/job-status/${token}?ts=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const json = await res.json();
      if (!json.success) return;
      const job = json.job || {};

      // Update overall status
      statusEl.textContent = renderOverall(job);

      // Render members checklist
      renderMembers(tableBody, job.members || []);

      // Enable PDF button when ready
      if (job.state === 'done' && job.result && job.result.pdf && job.result.pdf.url) {
        pdfBtn.disabled = false;
        pdfLink.href = job.result.pdf.url;
        statusEl.textContent = 'Completed';
      }

      if (job.state === 'done' || job.state === 'error' || job.state === 'blocked') {
        clearInterval(interval);
      }
    } catch (_) {}
  }, 1500);

  // File upload path
  if (fileInput && uploadBtn) {
    const validateFile = () => {
      const f = fileInput.files && fileInput.files[0];
      uploadBtn.disabled = !f;
      if (uploadStatus) uploadStatus.textContent = '';
    };
    fileInput.addEventListener('change', validateFile);
    validateFile();

    uploadBtn.addEventListener('click', async () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      if (f.type !== 'application/pdf' && !/\.pdf$/i.test(f.name || '')) {
        uploadStatus.textContent = 'Please select a PDF file.';
        return;
      }
      uploadBtn.disabled = true;
      const original = uploadBtn.innerHTML;
      uploadBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading...';
      try {
        const fd = new FormData();
        fd.append('file', f);
        const resp = await fetch(`/agreement/upload-signed/${token}`, { method: 'POST', body: fd });
        const json = await resp.json().catch(() => ({ success: false }));
        if (!resp.ok || !json.success) throw new Error(json.message || 'Upload failed');
        uploadStatus.textContent = 'Signed agreement uploaded.';
        uploadStatus.style.color = '#10b981';
      } catch (e) {
        uploadStatus.textContent = e.message || 'Failed to upload';
        uploadStatus.style.color = '#ef4444';
      } finally {
        uploadBtn.innerHTML = original;
        uploadBtn.disabled = false;
      }
    });
  }
});

function renderOverall(job) {
  if (!job || !job.state) return 'Unknown';
  const p = job.progress || { validated: 0, total: 0 };
  if (job.state === 'running') return `Validating ${p.validated}/${p.total}...`;
  if (job.state === 'blocked') return 'Blocked (eligibility)';
  if (job.state === 'error') return 'Error';
  if (job.state === 'done') return 'Completed';
  return job.state;
}

function renderMembers(tbody, members) {
  // members: [{ id, name, type, expected_bucket, status, primary_bucket, reason }]
  tbody.innerHTML = '';
  members.forEach(m => {
    const tr = document.createElement('tr');
    const nameTd = document.createElement('td');
    nameTd.textContent = m.name || m.id || 'â€”';
    const typeTd = document.createElement('td');
    typeTd.textContent = m.type || 'â€”';
    const discTd = document.createElement('td');
    discTd.textContent = m.expected_bucket || 'â€”';
    const statusTd = document.createElement('td');
    statusTd.className = 'status-cell';
    statusTd.innerHTML = statusIcon(m);
    const reasonTd = document.createElement('td');
    reasonTd.textContent = renderReason(m);
    tr.appendChild(nameTd);
    tr.appendChild(typeTd);
    tr.appendChild(discTd);
    tr.appendChild(statusTd);
    tr.appendChild(reasonTd);
    tbody.appendChild(tr);
  });
}

function statusIcon(m) {
  const s = (m.status || "queued").toLowerCase();
  if (s === "valid") return "<i class=\"fas fa-check ok\"></i>";
  if (s === "invalid" || s === "error") return "<i class=\"fas fa-times bad\"></i>";
  if (s === "ambiguous") return "<i class=\"fas fa-exclamation-triangle warn\"></i>";
  return "<i class=\"fas fa-spinner fa-spin pending\"></i>";
}

function renderReason(m) {
  if (m && m.reason_message) return m.reason_message;
  const s = (m.status || '').toLowerCase();
  if (s === 'invalid') return 'Not eligible';
  if (s === 'ambiguous') return 'Multiple candidates match';
  if (s === 'error') return 'Validation error';
  if (s === 'valid') return 'Validated';
  return '';
}


