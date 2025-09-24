// app.js
// ВАЖНО (по ТЗ из промпта):
// - Вся логика в этом файле (UI/стили/структура — только в index.html).
// - Данные читаем ТОЛЬКО через Papa Parse (TSV, колонка 'text').
// - Анализ — через Hugging Face Inference API, модель: siebert/sentiment-roberta-large-english.
// - POST на https://api-inference.huggingface.co/models/siebert/sentiment-roberta-large-english
//   c JSON: { "inputs": "<reviewText>" } и опциональным заголовком Authorization: Bearer <token>.
// - Классификация строго по правилу промпта: 
//   если label === 'POSITIVE' и score > 0.5 → positive;
//   если label === 'NEGATIVE' и score > 0.5 → negative;
//   иначе → neutral.
// - Иконки: thumbs-up (positive), thumbs-down (negative), question mark (neutral).

const STATE = {
  reviews: [],
  loaded: false,
};

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
  // Отображение статуса загрузки TSV (ready/error) в UI.
  els.loadStatus.classList.remove('ready', 'error');
  if (mode) els.loadStatus.classList.add(mode);
  const label = els.loadStatus.querySelector('span:last-child');
  if (label) label.textContent = text;
}

function showError(msg) {
  // Единый вывод ошибок (сеть, API, парсинг).
  els.errorBox.textContent = msg;
  els.errorBox.style.display = 'block';
}

function clearError() {
  els.errorBox.textContent = '';
  els.errorBox.style.display = 'none';
}

function updateCountBadge() {
  // Плашка с количеством валидных отзывов из TSV.
  const n = STATE.reviews.length;
  els.countBadge.textContent = `${n} review${n === 1 ? '' : 's'} loaded`;
}

function chooseRandom(arr) {
  // Случайный выбор отзыва для анализа по клику.
  return arr[Math.floor(Math.random() * arr.length)];
}

function normalizeHfResponse(json) {
  // Ожидаемый по ТЗ формат ответа: [[{ label: 'POSITIVE'|'NEGATIVE', score: number }, ... ]]
  // Берём первый (единственный по ТЗ) внутренний список и выбираем элемент с максимальным score.
  // Далее применяем РОВНО правило из промпта (порог 0.5 для соответствующей метки).
  if (!json) return null;

  let candidates = null;
  if (Array.isArray(json) && Array.isArray(json[0])) {
    // Соответствует формату из ТЗ: берём первую внутреннюю коллекцию.
    candidates = json[0];
  } else if (Array.isArray(json)) {
    // Допустим минимальную «устойчивость» к вариациям ответа API (не меняя правило классификации).
    candidates = json;
  }

  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  // Выбираем запись с максимальным score (если вернулось несколько меток).
  candidates.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const top = candidates[0];
  if (!top || typeof top.label !== 'string') return null;

  const label = top.label.toUpperCase();
  const score = typeof top.score === 'number' ? top.score : 0;

  // Применяем строгое правило из промпта.
  let verdict = 'neutral';
  if (label === 'POSITIVE' && score > 0.5) verdict = 'positive';
  else if (label === 'NEGATIVE' && score > 0.5) verdict = 'negative';
  else verdict = 'neutral';

  return { label, score, verdict };
}

function renderSentiment(result) {
  // Отображение результата: 
  // positive → thumbs-up, negative → thumbs-down, neutral → question mark.
  const iconWrap = els.sentimentIcon;
  iconWrap.innerHTML = '';
  const i = document.createElement('i');

  if (!result) {
    i.className = 'fa-regular fa-circle-question neutral';
    els.sentimentLabel.textContent = 'Neutral (no result)';
    els.sentimentScore.textContent = 'Score: —';
  } else {
    if (result.verdict == 'positive') {
      i.className = 'fa-solid fa-thumbs-up positive';
      els.sentimentLabel.textContent = 'Positive';
    } else if (result.verdict == 'negative') {
      i.className = 'fa-solid fa-thumbs-down negative';
      els.sentimentLabel.textContent = 'Negative';
    } else {
      i.className = 'fa-regular fa-circle-question neutral';
      els.sentimentLabel.textContent = 'Neutral';
    }
    els.sentimentScore.textContent = `Score: ${Number(result.score).toFixed(3)}`;
  }

  iconWrap.appendChild(i);
}

async function loadTSV() {
  // ЗАГРУЗКА ДАННЫХ СТРОГО ЧЕРЕЗ PAPA PARSE (по ТЗ).
  // Файл: reviews_test.tsv (таб-разделитель, header: true, колонка 'text').
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
  // Основной сценарий по клику:
  // 1) выбрать случайный отзыв,
  // 2) отобразить его в UI,
  // 3) запросить Inference API с { "inputs": "<reviewText>" } и (если введён) Authorization,
  // 4) интерпретировать ответ по правилу промпта и показать иконку/метку/скор.
  clearError();
  if (!STATE.loaded || STATE.reviews.length === 0) {
    showError('Data not loaded. Click "Reload TSV" and ensure reviews_test.tsv is present with a "text" column.');
    return;
  }

  const text = chooseRandom(STATE.reviews);
  els.reviewDisplay.textContent = text || '(Empty review)';
  renderSentiment(null);

  const endpoint = 'https://api-inference.huggingface.co/models/siebert/sentiment-roberta-large-english';
  const headers = { 'Content-Type': 'application/json' };
  const token = (els.token.value || '').trim();
  if (token) headers['Authorization'] = `Bearer ${token}`; // Токен опционален (для лимитов/квот).

  let resp;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ inputs: text }), // РОВНО как в ТЗ.
    });
  } catch (e) {
    showError(`Network error: ${e?.message || e}`);
    return;
  }

  let data;
  if (!resp.ok) {
    // Грациозная обработка ошибок/лимитов согласно ТЗ.
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

  try {
    data = await resp.json();
  } catch (e) {
    showError(`Invalid JSON from API: ${e?.message || e}`);
    return;
  }

  const result = normalizeHfResponse(data);
  renderSentiment(result || null);
}

document.addEventListener('DOMContentLoaded', async () => {
  // Автозагрузка TSV при старте и биндинг кнопок «Reload TSV» / «Analyze Random Review».
  await loadTSV();
  els.reloadBtn.addEventListener('click', loadTSV);
  els.analyzeBtn.addEventListener('click', analyzeRandom);
});
