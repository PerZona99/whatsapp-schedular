const connectScreen = document.getElementById('connect-screen');
const app = document.getElementById('app');
const qrHolder = document.getElementById('qr-holder');
const connectError = document.getElementById('connect-error');
const accountName = document.getElementById('account-name');

const composeForm = document.getElementById('compose-form');
const toInput = document.getElementById('to-input');
const toLabel = document.getElementById('to-label');
const toHint = document.getElementById('to-hint');
const formError = document.getElementById('form-error');

const queueList = document.getElementById('queue-list');
const queueCount = document.getElementById('queue-count');

const showGroupsBtn = document.getElementById('show-groups');
const groupsOverlay = document.getElementById('groups-overlay');
const closeGroupsBtn = document.getElementById('close-groups');
const groupsListEl = document.getElementById('groups-list');

const toast = document.getElementById('toast');

let wasReady = false;

// ---- status polling: drives the connect screen <-> app switch ----

async function pollStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();

    if (data.ready) {
      connectScreen.classList.add('hidden');
      app.classList.remove('hidden');
      accountName.textContent = data.account ? data.account.name : 'Connected';
      if (!wasReady) refreshQueue();
      wasReady = true;
    } else {
      connectScreen.classList.remove('hidden');
      app.classList.add('hidden');
      wasReady = false;
      if (data.qr) {
        qrHolder.innerHTML = `<img src="${data.qr}" alt="WhatsApp login QR code">`;
      } else {
        qrHolder.innerHTML = `<p class="qr-waiting">Waking up WhatsApp Web…</p>`;
      }
    }

    connectError.textContent = data.lastError || '';
  } catch (err) {
    connectError.textContent = 'Lost contact with the server. Is it still running?';
  }
}

setInterval(pollStatus, 2500);
pollStatus();

// ---- target type toggle (person vs group changes the "to" field hint) ----

document.querySelectorAll('input[name="targetType"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    if (radio.value === 'group' && radio.checked) {
      toLabel.textContent = 'Group ID or invite link';
      toInput.placeholder = '120363xxxxxxxxx@g.us or https://chat.whatsapp.com/…';
      toHint.textContent = 'Paste a real group ID, or an invite link — it gets resolved automatically.';
    } else if (radio.checked) {
      toLabel.textContent = 'Phone number';
      toInput.placeholder = '94771234567';
      toHint.textContent = 'Country code + number, digits only, no plus sign.';
    }
  });
});

// ---- compose form submit ----

composeForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  formError.textContent = '';

  const formData = new FormData(composeForm);
  // Convert the <input type="datetime-local"> value into an ISO string.
  const localDatetime = formData.get('datetime');
  if (localDatetime) {
    formData.set('datetime', new Date(localDatetime).toISOString());
  }

  try {
    const res = await fetch('/api/messages', { method: 'POST', body: formData });
    const data = await res.json();

    if (!res.ok) {
      formError.textContent = data.error || 'Something went wrong.';
      return;
    }

    composeForm.reset();
    showToast('Added to the queue.');
    refreshQueue();
  } catch (err) {
    formError.textContent = 'Could not reach the server.';
  }
});

// ---- queue rendering ----

async function refreshQueue() {
  try {
    const res = await fetch('/api/messages');
    const messages = await res.json();
    renderQueue(messages);
  } catch (err) {
    // silent — the status poller will surface connectivity problems
  }
}

function statusOf(msg) {
  if (msg.lastError) return 'failed';
  if (msg.sent) return 'sent';
  return 'pending';
}

function renderQueue(messages) {
  queueCount.textContent = messages.length ? `${messages.length} message${messages.length === 1 ? '' : 's'}` : '';

  if (!messages.length) {
    queueList.innerHTML = '<p class="empty">Nothing scheduled yet — add a message on the left.</p>';
    return;
  }

  queueList.innerHTML = messages.map((msg) => {
    const status = statusOf(msg);
    const when = new Date(msg.datetime).toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });
    const label = status === 'sent' ? 'Sent' : status === 'failed' ? 'Failed' : 'Pending';
    const preview = msg.message || (msg.image ? '(image only)' : '');

    return `
      <div class="ticket">
        <div class="ticket-bar ${status}"></div>
        <div class="ticket-body">
          <div class="ticket-to">${escapeHtml(msg.to)}</div>
          <div class="ticket-message">${escapeHtml(preview)}</div>
          <div class="ticket-meta">
            <span class="badge ${status}">${label}</span>
            <span>${when}</span>
            ${msg.recurring ? `<span>repeats ${msg.recurring}</span>` : ''}
            ${msg.image ? '<span>with image</span>' : ''}
          </div>
        </div>
        <div class="ticket-actions">
          ${status !== 'sent' ? `<button data-action="send" data-id="${msg.id}">Send now</button>` : ''}
          <button data-action="delete" data-id="${msg.id}" class="danger">Remove</button>
        </div>
      </div>
    `;
  }).join('');
}

queueList.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const { action, id } = btn.dataset;

  if (action === 'delete') {
    await fetch(`/api/messages/${id}`, { method: 'DELETE' });
    showToast('Removed.');
    refreshQueue();
  }

  if (action === 'send') {
    btn.disabled = true;
    btn.textContent = 'Sending…';
    const res = await fetch(`/api/messages/${id}/send-now`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Failed to send.');
    } else {
      showToast('Sent.');
    }
    refreshQueue();
  }
});

// ---- groups overlay ----

showGroupsBtn.addEventListener('click', async () => {
  groupsOverlay.classList.remove('hidden');
  groupsListEl.innerHTML = '<p class="fog small">Loading your groups…</p>';

  try {
    const res = await fetch('/api/groups');
    const data = await res.json();

    if (!res.ok) {
      groupsListEl.innerHTML = `<p class="fog small">${escapeHtml(data.error)}</p>`;
      return;
    }

    if (!data.length) {
      groupsListEl.innerHTML = '<p class="fog small">No groups found on this account.</p>';
      return;
    }

    groupsListEl.innerHTML = data.map((g) => `
      <button class="group-row" data-id="${g.id}">
        ${escapeHtml(g.name)}
        <span class="g-id">${g.id}</span>
      </button>
    `).join('');
  } catch (err) {
    groupsListEl.innerHTML = '<p class="fog small">Could not reach the server.</p>';
  }
});

groupsListEl.addEventListener('click', (e) => {
  const row = e.target.closest('.group-row');
  if (!row) return;
  navigator.clipboard.writeText(row.dataset.id).catch(() => {});

  document.querySelector('input[name="targetType"][value="group"]').checked = true;
  document.querySelector('input[name="targetType"][value="group"]').dispatchEvent(new Event('change'));
  toInput.value = row.dataset.id;

  groupsOverlay.classList.add('hidden');
  showToast('Group ID copied and filled in.');
});

closeGroupsBtn.addEventListener('click', () => groupsOverlay.classList.add('hidden'));
groupsOverlay.addEventListener('click', (e) => {
  if (e.target === groupsOverlay) groupsOverlay.classList.add('hidden');
});

// ---- helpers ----

function showToast(text) {
  toast.textContent = text;
  toast.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add('hidden'), 2500);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
