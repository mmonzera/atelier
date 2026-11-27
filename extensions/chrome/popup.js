const dotEl = document.getElementById('dot');
const badgeEl = document.getElementById('badge');
const portInput = document.getElementById('port');
const codeInput = document.getElementById('code');
const codeWrap = document.getElementById('code-wrap');
const feedbackEl = document.getElementById('feedback');
const pairBtn = document.getElementById('pair-btn');
const disconnectBtn = document.getElementById('disconnect-btn');

function showFeedback(text, kind) {
  if (!text) {
    feedbackEl.className = 'feedback hidden';
    feedbackEl.textContent = '';
    return;
  }
  feedbackEl.className = `feedback ${kind}`;
  feedbackEl.textContent = text;
}

function renderState(state) {
  if (!state) return;
  if (state.port && !portInput.value) {
    portInput.value = String(state.port);
  }

  dotEl.className = 'dot';
  badgeEl.className = 'badge';

  if (state.connected) {
    dotEl.classList.add('connected');
    badgeEl.classList.add('connected');
    badgeEl.textContent = 'Connected';
    codeWrap.classList.add('hidden');
    pairBtn.classList.add('hidden');
    disconnectBtn.classList.remove('hidden');
  } else if (state.paired) {
    dotEl.classList.add('waiting');
    badgeEl.textContent = 'Reconnecting…';
    codeWrap.classList.remove('hidden');
    pairBtn.classList.remove('hidden');
    disconnectBtn.classList.remove('hidden');
  } else {
    badgeEl.textContent = 'Disconnected';
    codeWrap.classList.remove('hidden');
    pairBtn.classList.remove('hidden');
    disconnectBtn.classList.add('hidden');
  }

  if (state.lastError && !state.connected) {
    showFeedback(state.lastError, 'error');
  }
}

async function refreshState() {
  const state = await chrome.runtime.sendMessage({ type: 'get_state' });
  renderState(state);
}

pairBtn.addEventListener('click', async () => {
  showFeedback('', '');
  pairBtn.disabled = true;
  pairBtn.textContent = 'Connecting…';
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'pair',
      port: Number(portInput.value),
      code: codeInput.value.trim(),
    });
    if (res?.state) renderState(res.state);
    if (res?.ok) {
      codeInput.value = '';
      showFeedback('Paired and connected to Atelier.', 'success');
    } else {
      showFeedback(res?.error || 'Failed to pair.', 'error');
    }
  } catch (err) {
    showFeedback(err instanceof Error ? err.message : String(err), 'error');
  } finally {
    pairBtn.disabled = false;
    pairBtn.textContent = 'Pair & Connect';
  }
});

disconnectBtn.addEventListener('click', async () => {
  showFeedback('', '');
  const res = await chrome.runtime.sendMessage({ type: 'disconnect' });
  if (res?.state) renderState(res.state);
  showFeedback('Disconnected from Atelier.', 'success');
});

void refreshState();
