// app.js
// UX-focused: keyboard-friendly, aria-live updates, and glass UI from index.html kept intact.

const STATE = { reviews: [], loaded: false };
const $ = (id) => document.getElementById(id);

const els = {
  token: $('tokenInput'),
  reloadBtn: $('reloadBtn'),
  loadStatus: $('loadStatus'),
  countBadge: $('countBadge'),
  analyzeBtn: $('analyzeBtn'),
  reviewDisplay: $('reviewDisplay'),
  sentimentIcon: $('sentimentIcon'),
  sentimentLabel: $('sentimentLabel'),
  sentimentScore: $('sentimentScore'),
  errorBox: $('errorBox'),
};

function setStatus(mode, text) {
  els.loadStatus.classList.remove('ready', 'error');
  if (mode) els.loadStatus.classList.add(mode);
  const label = els.loadStatus.querySelector('span:last-child');
  if (label) label.textContent = text;
}

function showError(msg) {
  els.errorBox.textContent = msg;
  els.errorBox.style.display = 'block';
  // Move focus to error for screen readers
  els.errorBox.setAttribute('tabindex', '-1');
  els.errorBox.focus({ preventScroll: false });
}

function clearError() {
  els.errorBox.textContent = '';
  els.errorBox.style.display = 'none';
  els.errorBox.removeAttribute('tabindex');
}

function updateCountBadge() {
  const n = STATE.reviews.length;
  els.countBadge.textContent = `${n} review${n === 1 ? '' : 's'} loaded`;
}

function chooseRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function normalizeHfResponse(json) {
  // Expected by spec: [[{ label: 'POSITIVE'|'NEGATIVE', score: number }, ...]]
  if (!json) return null;
  let candidates = null;
  if (Array.isArray(json) && Array.isArray(json[0])) {
    candidates = json[0];
  } else if (Array.isArray(json)) {
    candidates = json;
  }
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  candidates.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const top = candidates[0];
  if (!top || typeof top.label !== 'string') return null;

  const label = top.label.toUpperCase();
  const score = typeof top.score === 'number' ? top.score : 0;

  // Strict rule: POSITIVE && score>0.5 -> positive; NEGATIVE && score>0.5 -> negative; else neutral.
  let verdict = 'neutral';
  if (label === 'POSITIVE' && score > 0.5) verdict = 'positive';
  else if (label === 'NEGATIVE' && score > 0.5) verdict = 'negative';

  return { label, score, verdict };
}

function renderSentiment(result) {
  const iconWrap = els.sentimentIcon;
  iconWrap.innerHTML = '';
  const i = document.createElement('i');

  if (!result) {
    i.className = 'fa-regular fa-circle-question neutral';
    els.sentimentLabel.textContent = 'Neutral (no result)';
    els.sentimentScore.textContent = 'Score: —';
  } else {
    if (result.verdict === 'positive') {
      i.className = 'fa-solid fa-thumbs-up positive';
      els.sentimentLabel.textContent = 'Positive';
    } else if (result.verdict === 'negative') {
      i.className = 'fa-solid fa-thumbs-down negative';
      els.sentimentLabel.textContent = 'Negative';
    } else {
      i.className = 'fa-regular fa-circle-question neutral';
      els.sentimentLabel.textContent = 'Neutral';
    }
    els.sentimentScore.textContent = `Score: ${Number(result.score).toFixed(3)}`;
  }

  iconWrap.appendChild(i);

  // Announce for SR and move focus
  els.sentimentLabel.setAttribute('tabindex', '-1');
  els.sentimentLabel.focus({ preventScroll: true });
  setTimeout(() => els.sentimentLabel.removeAttribute('tabindex'), 200);
}

async function loadTSV() {
  setStatus('', 'Loading TSV…');
  clearError();
  STATE.reviews = [];
  STATE.loaded = false;
  updateCountBadge();

  return new Promise((resolve) => {
    Papa.parse('reviews_test.tsv', {
      download: true,
      header: true,
      delimiter: '\t',
      skipEmptyLines: true,
      complete: (results) => {
        try {
          const rows = results?.data || [];
          const texts = rows
            .map(r => (r && typeof r.text === 'string') ? r.text.trim() : '')
            .filter(t => t.length > 0);
          STATE.reviews = texts;
          STATE.loaded = texts.length > 0;
          updateCountBadge();
          if (STATE.loaded) {
            setStatus('ready', 'TSV loaded');
            els.reloadBtn.setAttribute('aria-busy', 'false');
          } else {
            setStatus('error', 'No reviews found in TSV');
            showError('No valid "text" column values found in reviews_test.tsv.');
          }
          resolve();
        } catch (e) {
          setStatus('error', 'Parse error');
          showError(`Failed to parse TSV: ${e?.message || e}`);
          resolve();
        }
      },
      error: (err) => {
        setStatus('error', 'Load failed');
        showError(`Failed to load TSV: ${err?.message || err}`);
        resolve();
      }
    });
  });
}

async function analyzeRandom() {
  clearError();
  if (!STATE.loaded || STATE.reviews.length === 0) {
    showError('Data not loaded. Click "Reload TSV" and ensure reviews_test.tsv is present with a "text" column.');
    return;
  }

  els.analyzeBtn.setAttribute('aria-busy', 'true');

  const text = chooseRandom(STATE.reviews);
  els.reviewDisplay.textContent = text || '(Empty review)';
  // Move focus to review for keyboard users
  els.reviewDisplay.focus({ preventScroll: false });
  renderSentiment(null);

  const endpoint = 'https://api-inference.huggingface.co/models/siebert/sentiment-roberta-large-english';
  const headers = { 'Content-Type': 'application/json' };
  const token = (els.token.value || '').trim();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let resp;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ inputs: text }),
    });
  } catch (e) {
    els.analyzeBtn.setAttribute('aria-busy', 'false');
    showError(`Network error: ${e?.message || e}`);
    return;
  }

  if (!resp.ok) {
    els.analyzeBtn.setAttribute('aria-busy', 'false');
    let detail = '';
    try {
      const maybe = await resp.json();
      detail = typeof maybe?.error === 'string' ? ` — ${maybe.error}` : '';
    } catch (_) {}
    if (resp.status === 401) {
      showError(`Unauthorized (401). Invalid or missing token${detail}. You can try without a token or provide a valid one.`);
    } else if (resp.status === 429) {
      showError(`Rate limited (429). Please wait and try again${detail}. Supplying your token may help.`);
    } else if (resp.status === 503) {
      showError(`Model loading (503). The model is warming up. Please retry in a moment${detail}.`);
    } else {
      showError(`API error (${resp.status}).${detail}`);
    }
    return;
  }

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    els.analyzeBtn.setAttribute('aria-busy', 'false');
    showError(`Invalid JSON from API: ${e?.message || e}`);
    return;
  }

  const result = normalizeHfResponse(data);
  renderSentiment(result || null);
  els.analyzeBtn.setAttribute('aria-busy', 'false');
}

document.addEventListener('DOMContentLoaded', async () => {
  els.reloadBtn.setAttribute('aria-busy', 'true');
  await loadTSV();
  els.reloadBtn.setAttribute('aria-busy', 'false');

  els.reloadBtn.addEventListener('click', async () => {
    els.reloadBtn.setAttribute('aria-busy', 'true');
    await loadTSV();
    els.reloadBtn.setAttribute('aria-busy', 'false');
  });
  els.analyzeBtn.addEventListener('click', analyzeRandom);

  // Keyboard: Enter on token triggers analyze for convenience
  els.token.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') els.analyzeBtn.click();
  });
});
