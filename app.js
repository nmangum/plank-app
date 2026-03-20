/* ============================================================
   Plank Tracker — app.js
   ============================================================ */

'use strict';

// ── Supabase ──────────────────────────────────────────────

const SUPABASE_URL = 'https://xlscjphnoarzqzpfgxkq.supabase.co';
const SUPABASE_KEY = 'sb_publishable_OiFhR8vy0lGJRmvNfGO0Aw_dE1xkqh5';
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Constants ────────────────────────────────────────────

const THEME_KEY = 'plank_theme';

// ── State ─────────────────────────────────────────────────

let currentUser  = null;
let sessions     = [];          // Array of { id, date, sets: [seconds, ...] }
let pendingDeleteId = null;
let chartTotal   = null;
let chartBest    = null;
let activeChart  = 'total';
let activePeriod = 'daily';

// ── Persistence (Supabase) ────────────────────────────────

async function loadSessions() {
  const { data, error } = await db
    .from('sessions')
    .select('id, date, sets')
    .order('date', { ascending: true });
  if (error) { console.error('Load error:', error); return; }
  sessions = data.map(r => ({ id: r.id, date: r.date, sets: r.sets }));
}

async function insertSession(session) {
  const { error } = await db.from('sessions').insert({
    id:      session.id,
    user_id: currentUser.id,
    date:    session.date,
    sets:    session.sets,
  });
  if (error) throw error;
}

async function deleteSession(id) {
  const { error } = await db.from('sessions').delete().eq('id', id);
  if (error) throw error;
}

// ── Helpers ───────────────────────────────────────────────

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function formatSeconds(totalSecs) {
  if (totalSecs < 60) return `${totalSecs}s`;
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function formatDate(dateStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const date = new Date(y, mo - 1, d);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function todayStr() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

function sessionTotal(session) {
  return session.sets.reduce((a, b) => a + b, 0);
}

function sessionBest(session) {
  return Math.max(...session.sets);
}

function globalBest() {
  if (sessions.length === 0) return 0;
  return Math.max(...sessions.map(sessionBest));
}

function currentStreak() {
  if (sessions.length === 0) return 0;
  const days = [...new Set(sessions.map(s => s.date))].sort();
  let streak = 1;
  const today = todayStr();
  const last = days[days.length - 1];
  const [ly, lm, ld] = last.split('-').map(Number);
  const lastDate = new Date(ly, lm - 1, ld);
  const [ty, tm, td] = today.split('-').map(Number);
  const todayDate = new Date(ty, tm - 1, td);
  const diffDays = Math.round((todayDate - lastDate) / 86400000);
  if (diffDays > 1) return 0;
  for (let i = days.length - 1; i > 0; i--) {
    const [ay, am, ad] = days[i].split('-').map(Number);
    const [by, bm, bd] = days[i - 1].split('-').map(Number);
    const diff = Math.round((new Date(ay, am-1, ad) - new Date(by, bm-1, bd)) / 86400000);
    if (diff === 1) streak++;
    else break;
  }
  return streak;
}

// ── DOM helpers ───────────────────────────────────────────

const $ = id => document.getElementById(id);

function showError(msg) {
  const el = $('form-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideError() {
  $('form-error').classList.add('hidden');
}

// ── Set Rows ──────────────────────────────────────────────

function renderSetRows() {
  const list = $('sets-list');
  list.querySelectorAll('.set-row').forEach((row, i) => {
    row.querySelector('.set-number').textContent = `Set ${i + 1}`;
  });
}

function addSetRow(value = '') {
  const list = $('sets-list');
  const idx  = list.querySelectorAll('.set-row').length + 1;

  const row = document.createElement('div');
  row.className = 'set-row';
  row.innerHTML = `
    <span class="set-number">Set ${idx}</span>
    <input
      type="number"
      class="set-input"
      placeholder="e.g. 60"
      min="1"
      max="9999"
      value="${value}"
      aria-label="Set ${idx} duration in seconds"
    />
    <span class="set-unit">sec</span>
    <button type="button" class="set-remove" aria-label="Remove set">✕</button>
  `;

  row.querySelector('.set-remove').addEventListener('click', () => {
    if (list.querySelectorAll('.set-row').length > 1) {
      row.remove();
      renderSetRows();
    }
  });

  list.appendChild(row);
}

function getSetValues() {
  return Array.from($('sets-list').querySelectorAll('.set-input'))
    .map(inp => parseInt(inp.value, 10))
    .filter(v => !isNaN(v) && v > 0);
}

function clearForm() {
  $('session-date').value = todayStr();
  $('sets-list').innerHTML = '';
  addSetRow();
  hideError();
}

// ── Form Submit ───────────────────────────────────────────

async function handleFormSubmit(e) {
  e.preventDefault();
  hideError();

  const date = $('session-date').value;
  if (!date) { showError('Please select a date.'); return; }

  const sets = getSetValues();
  if (sets.length === 0) { showError('Please add at least one set with a valid duration.'); return; }

  const hasRaw = Array.from($('sets-list').querySelectorAll('.set-input'))
    .some(inp => inp.value.trim() !== '' && (isNaN(parseInt(inp.value, 10)) || parseInt(inp.value, 10) <= 0));
  if (hasRaw) {
    showError('Some set durations are invalid. Please enter positive whole numbers only.');
    return;
  }

  const prevBest = globalBest();
  const session  = { id: genId(), date, sets };

  try {
    await insertSession(session);
  } catch (err) {
    showError('Failed to save session. Please try again.');
    console.error(err);
    return;
  }

  sessions.push(session);
  sessions.sort((a, b) => a.date.localeCompare(b.date));
  renderAll();
  const { msg, highlight } = pickEncouragement(session, prevBest);
  showToast(msg, highlight);
  clearForm();
}

// ── Stats ─────────────────────────────────────────────────

function updateStats() {
  const total     = sessions.reduce((acc, s) => acc + sessionTotal(s), 0);
  const best      = globalBest();
  const avgPerSes = sessions.length > 0 ? Math.round(total / sessions.length) : 0;
  const streak    = currentStreak();

  $('stat-sessions').textContent    = sessions.length;
  $('stat-total-time').textContent  = formatSeconds(total);
  $('stat-best-set').textContent    = formatSeconds(best);
  $('stat-avg-session').textContent = formatSeconds(avgPerSes);
  $('stat-streak').textContent      = streak;
}

// ── Charts ────────────────────────────────────────────────

const CHART_COLORS = {
  total: { line: '#5b6af0', fill: 'rgba(91,106,240,0.12)', point: '#5b6af0' },
  best:  { line: '#4ade80', fill: 'rgba(74,222,128,0.12)', point: '#4ade80' },
};

function weekKey(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const day  = date.getDay();
  const mon  = new Date(date);
  mon.setDate(d - ((day + 6) % 7));
  return [
    mon.getFullYear(),
    String(mon.getMonth() + 1).padStart(2, '0'),
    String(mon.getDate()).padStart(2, '0'),
  ].join('-');
}

function monthKey(dateStr) {
  return dateStr.slice(0, 7);
}

function formatPeriodLabel(key, period) {
  if (period === 'daily') return formatDate(key);
  if (period === 'monthly') {
    const [y, m] = key.split('-');
    return new Date(Number(y), Number(m) - 1, 1)
      .toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  }
  return formatDate(key);
}

function buildChartData(type) {
  const sorted = [...sessions].sort((a, b) => a.date.localeCompare(b.date));

  const buckets = new Map();
  for (const s of sorted) {
    const key = activePeriod === 'weekly'  ? weekKey(s.date)
              : activePeriod === 'monthly' ? monthKey(s.date)
              : s.date;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(s);
  }

  const keys   = [...buckets.keys()].sort();
  const labels = keys.map(k => formatPeriodLabel(k, activePeriod));
  const data   = keys.map(k => {
    const group = buckets.get(k);
    if (type === 'total') return group.reduce((sum, s) => sum + sessionTotal(s), 0);
    return Math.max(...group.map(sessionBest));
  });

  return { labels, data };
}

function chartDefaults(color) {
  const cs = prop => getComputedStyle(document.documentElement).getPropertyValue(prop).trim();
  return {
    type: 'line',
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: cs('--bg-card'),
          borderColor:     cs('--border'),
          borderWidth: 1,
          titleColor:  cs('--text-secondary'),
          bodyColor:   cs('--text-primary'),
          padding: 10,
          callbacks: { label: ctx => ` ${formatSeconds(ctx.parsed.y)}` },
        },
      },
      scales: {
        x: {
          grid:  { color: cs('--border') + '80' },
          ticks: { color: cs('--text-muted'), font: { family: 'Inter', size: 11 }, maxRotation: 40 },
        },
        y: {
          beginAtZero: true,
          grid:  { color: cs('--border') + '80' },
          ticks: { color: cs('--text-muted'), font: { family: 'Inter', size: 11 }, callback: v => formatSeconds(v) },
        },
      },
      elements: {
        line:  { tension: 0.35, borderWidth: 2, borderColor: color.line },
        point: { radius: 4, hoverRadius: 6, backgroundColor: color.line, borderColor: cs('--bg'), borderWidth: 2 },
      },
    },
  };
}

function updateCharts() {
  const empty = sessions.length === 0;

  $('chart-empty').classList.toggle('hidden', !empty);
  $('chart-total').classList.toggle('hidden', empty);
  $('chart-best').classList.toggle('hidden', true);

  if (empty) {
    if (chartTotal) { chartTotal.destroy(); chartTotal = null; }
    if (chartBest)  { chartBest.destroy();  chartBest  = null; }
    return;
  }

  const totalData  = buildChartData('total');
  const totalColor = CHART_COLORS.total;
  if (chartTotal) {
    chartTotal.data.labels = totalData.labels;
    chartTotal.data.datasets[0].data = totalData.data;
    chartTotal.update();
  } else {
    const cfg = chartDefaults(totalColor);
    cfg.data = { labels: totalData.labels, datasets: [{ data: totalData.data, borderColor: totalColor.line, backgroundColor: totalColor.fill, fill: true }] };
    chartTotal = new Chart($('chart-total'), cfg);
  }

  const bestData  = buildChartData('best');
  const bestColor = CHART_COLORS.best;
  if (chartBest) {
    chartBest.data.labels = bestData.labels;
    chartBest.data.datasets[0].data = bestData.data;
    chartBest.update();
  } else {
    const cfg = chartDefaults(bestColor);
    cfg.data = { labels: bestData.labels, datasets: [{ data: bestData.data, borderColor: bestColor.line, backgroundColor: bestColor.fill, fill: true }] };
    chartBest = new Chart($('chart-best'), cfg);
  }

  applyChartTabVisibility();
}

function applyChartTabVisibility() {
  if (sessions.length === 0) return;
  $('chart-total').classList.toggle('hidden', activeChart !== 'total');
  $('chart-best').classList.toggle('hidden',  activeChart !== 'best');
}

function initChartTabs() {
  document.querySelectorAll('.chart-tab[data-chart]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.chart-tab[data-chart]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeChart = btn.dataset.chart;
      applyChartTabVisibility();
    });
  });

  document.querySelectorAll('.chart-tab[data-period]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.chart-tab[data-period]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activePeriod = btn.dataset.period;
      if (chartTotal) { chartTotal.destroy(); chartTotal = null; }
      if (chartBest)  { chartBest.destroy();  chartBest  = null; }
      if (sessions.length > 0) updateCharts();
    });
  });
}

// ── Log Table ─────────────────────────────────────────────

function updateLog() {
  const tbody    = $('log-tbody');
  const empty    = $('log-empty');
  const logCount = $('log-count');

  tbody.innerHTML = '';
  logCount.textContent = `${sessions.length} session${sessions.length !== 1 ? 's' : ''}`;

  if (sessions.length === 0) {
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');

  const bestSet   = globalBest();
  const bestTotal = Math.max(...sessions.map(sessionTotal));

  const sorted = [...sessions].sort((a, b) => {
    if (b.date !== a.date) return b.date.localeCompare(a.date);
    return b.id.localeCompare(a.id);
  });

  sorted.forEach(session => {
    const total  = sessionTotal(session);
    const topSet = sessionBest(session);
    const isBestSet   = topSet === bestSet   && bestSet   > 0;
    const isBestTotal = total  === bestTotal && bestTotal > 0;

    const setsPills  = session.sets.map(s => `<span class="set-pill">${s}s</span>`).join('');
    const setBadge   = isBestSet   ? `<span class="best-badge">★ PB</span>` : '';
    const totalBadge = isBestTotal ? `<span class="best-badge">★ PB</span>` : '';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${formatDate(session.date)}</td>
      <td>${session.sets.length}</td>
      <td>${formatSeconds(total)}${totalBadge}</td>
      <td>${formatSeconds(topSet)}${setBadge}</td>
      <td><div class="sets-detail">${setsPills}</div></td>
      <td>
        <button
          class="btn btn-ghost btn-icon"
          aria-label="Delete session on ${formatDate(session.date)}"
          data-id="${session.id}"
        >✕</button>
      </td>
    `;

    tr.querySelector('button[data-id]').addEventListener('click', () => {
      openDeleteModal(session.id);
    });

    tbody.appendChild(tr);
  });
}

// ── Delete Modal ──────────────────────────────────────────

function openDeleteModal(id) {
  pendingDeleteId = id;
  $('modal-overlay').classList.remove('hidden');
}

function closeDeleteModal() {
  pendingDeleteId = null;
  $('modal-overlay').classList.add('hidden');
}

async function confirmDelete() {
  if (!pendingDeleteId) return;
  try {
    await deleteSession(pendingDeleteId);
  } catch (err) {
    console.error('Delete error:', err);
    closeDeleteModal();
    return;
  }
  sessions = sessions.filter(s => s.id !== pendingDeleteId);
  renderAll();
  closeDeleteModal();
}

// ── Render All ────────────────────────────────────────────

function renderAll() {
  updateStats();
  updateCharts();
  updateLog();
}

// ── Toast ─────────────────────────────────────────────────

const PHRASES = [
  'Keep showing up.',
  'Consistency beats intensity.',
  'Another one logged.',
  'Every second counts.',
  'Small efforts, big results.',
  'Strong work.',
  'You did the thing.',
  'Progress over perfection.',
];

let toastTimer = null;

function showToast(msg, highlight = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('toast-highlight', highlight);
  el.classList.remove('hidden');
  el.offsetHeight;
  el.classList.add('visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('visible');
    setTimeout(() => el.classList.add('hidden'), 260);
  }, 3000);
}

function pickEncouragement(session, prevBest) {
  const newBest = sessionBest(session);
  const count   = sessions.length;
  const streak  = currentStreak();

  if (newBest > prevBest)                        return { msg: `New personal best — ${formatSeconds(newBest)}!`, highlight: true };
  if ([5, 10, 25, 50, 100].includes(count))      return { msg: `${count} sessions. You're building something real.`, highlight: true };
  if ([3, 7, 14, 30].includes(streak))           return { msg: `${streak}-day streak!`, highlight: true };
  return { msg: PHRASES[Math.floor(Math.random() * PHRASES.length)], highlight: false };
}

// ── Theme ─────────────────────────────────────────────────

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(THEME_KEY, theme);
  document.querySelectorAll('.theme-swatch').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === theme);
  });
  if (chartTotal) { chartTotal.destroy(); chartTotal = null; }
  if (chartBest)  { chartBest.destroy();  chartBest  = null; }
  if (sessions.length > 0) updateCharts();
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY) || 'dark';
  applyTheme(saved);
  document.querySelectorAll('.theme-swatch').forEach(btn => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
  });
}

// ── Auth ──────────────────────────────────────────────────

function populateUserInfo(user) {
  const email   = user.email || '';
  const handle  = email.split('@')[0];
  const initial = handle.charAt(0).toUpperCase();
  const since   = new Date(user.created_at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  $('user-avatar').textContent    = initial;
  $('user-avatar-lg').textContent = initial;
  $('user-handle').textContent    = handle;
  $('user-dropdown-email').textContent = email;
  $('user-dropdown-since').textContent = `Member since ${since}`;
}

function closeUserDropdown() {
  $('user-dropdown').classList.add('hidden');
  $('user-btn').setAttribute('aria-expanded', 'false');
}

function showAuthScreen() {
  $('auth-overlay').classList.remove('hidden');
  $('user-area').classList.add('hidden');
  closeUserDropdown();
}

function showApp(user) {
  $('auth-overlay').classList.add('hidden');
  populateUserInfo(user);
  $('user-area').classList.remove('hidden');
}

function showAuthError(msg) {
  const el = $('auth-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideAuthError() {
  $('auth-error').classList.add('hidden');
}

function initAuth() {
  $('auth-signin-btn').addEventListener('click', async () => {
    hideAuthError();
    const email    = $('auth-email').value.trim();
    const password = $('auth-password').value;
    if (!email || !password) { showAuthError('Please enter your email and password.'); return; }
    const { error } = await db.auth.signInWithPassword({ email, password });
    if (error) showAuthError(error.message);
  });

  $('auth-signup-btn').addEventListener('click', async () => {
    hideAuthError();
    const email    = $('auth-email').value.trim();
    const password = $('auth-password').value;
    if (!email || !password) { showAuthError('Please enter an email and password.'); return; }
    if (password.length < 6) { showAuthError('Password must be at least 6 characters.'); return; }
    const { error } = await db.auth.signUp({ email, password });
    if (error) showAuthError(error.message);
    else showAuthError('Check your email for a confirmation link, then sign in.');
  });

  // User profile dropdown toggle
  $('user-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const dropdown = $('user-dropdown');
    const isHidden = dropdown.classList.contains('hidden');
    dropdown.classList.toggle('hidden', !isHidden);
    $('user-btn').setAttribute('aria-expanded', isHidden ? 'true' : 'false');
  });

  // (sign out handled by global signOut() called via onclick)

  // Close dropdown on outside click (not when clicking inside it)
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#user-dropdown') && !e.target.closest('#user-btn')) {
      closeUserDropdown();
    }
  });

  // Auth state changes (sign in / sign out after initial load)
  db.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_IN') {
      currentUser = session.user;
      showApp(currentUser);
      await loadSessions();
      renderAll();
    } else if (event === 'SIGNED_OUT') {
      currentUser = null;
      sessions    = [];
      showAuthScreen();
      renderAll();
    }
  });
}

async function initSession() {
  const { data: { session } } = await db.auth.getSession();
  if (session?.user) {
    currentUser = session.user;
    showApp(currentUser);
    await loadSessions();
    renderAll();
  } else {
    showAuthScreen();
  }
}

// ── Sign Out (global so onclick="" can reach it) ──────────

window.signOut = async function () {
  try { await db.auth.signOut(); } catch (_) {}
  Object.keys(localStorage)
    .filter(k => k.startsWith('sb-'))
    .forEach(k => localStorage.removeItem(k));
  currentUser = null;
  sessions    = [];
  if (chartTotal) { chartTotal.destroy(); chartTotal = null; }
  if (chartBest)  { chartBest.destroy();  chartBest  = null; }
  showAuthScreen();
  renderAll();
};

// ── Init ──────────────────────────────────────────────────

function init() {
  initTheme();
  initAuth();
  initSession();

  $('session-date').value = todayStr();
  addSetRow();

  $('session-form').addEventListener('submit', handleFormSubmit);
  $('add-set-btn').addEventListener('click', () => addSetRow());
  $('clear-form-btn').addEventListener('click', clearForm);

  $('modal-confirm').addEventListener('click', confirmDelete);
  $('modal-cancel').addEventListener('click', closeDeleteModal);
  $('modal-overlay').addEventListener('click', e => {
    if (e.target === $('modal-overlay')) closeDeleteModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeDeleteModal();
  });

  initChartTabs();
}

document.addEventListener('DOMContentLoaded', init);
