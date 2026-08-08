/* ============================================================
   Dashboard de Sincronización DBF — Sistemas ↔ Sucursales
   ============================================================ */

'use strict';

const API_URL = 'http://212.227.6.127:8000/api/dbf-report?format=json';

const state = {
  selected: { plaza: new Set(), grupo: new Set(), computadora: new Set(), archivo: new Set() },
  sync: new Set(),
  online: new Set(),
  cat: new Set(),
  ext: new Set(),
  query: '',
  minSize: null,
  maxSize: null,
  fromDate: null,
  toDateEnd: null,
  sortKey: 'sync',
  sortDir: 'asc',
  page: 1,
  perPage: 20,
};

let DATA = [];
let FILTERED = [];
let charts = {};
let toastTimer = null;

const PALETTE = ['#6366f1', '#22d3ee', '#34d399', '#fbbf24', '#f87171', '#a78bfa', '#60a5fa', '#f472b6', '#fb923c', '#4ade80'];

const ICONS = {
  files: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  ref: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
  check: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  slash: '<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>',
  gauge: '<path d="M12 15l3.5-3.5"/><path d="M20.3 18a10 10 0 1 0-16.6 0"/>',
  online: '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/><circle cx="12" cy="10" r="2.5"/>',
  hdd: '<line x1="22" y1="12" x2="2" y2="12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" y1="16" x2="6.01" y2="16"/><line x1="10" y1="16" x2="10.01" y2="16"/>',
};

const fmt = new Intl.NumberFormat('es-MX');

/* ---------- utilidades ---------- */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtNum(n) {
  return fmt.format(Math.round(n));
}

function fmtSize(kb) {
  if (kb == null || isNaN(kb)) return '—';
  if (kb < 1024) return kb.toFixed(kb < 10 ? 1 : 0) + ' KB';
  if (kb < 1024 * 1024) return (kb / 1024).toFixed(2) + ' MB';
  return (kb / 1024 / 1024).toFixed(2) + ' GB';
}

function parseModDate(str) {
  if (!str) return null;
  const m = String(str).match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)?$/i);
  if (!m) return null;
  let h = +m[4];
  if (m[7]) {
    const ampm = m[7].toUpperCase();
    if (ampm === 'PM' && h !== 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
  }
  return new Date(+m[1], +m[2] - 1, +m[3], h, +m[5], +m[6]);
}

function parseConnDate(str) {
  if (!str) return null;
  const d = new Date(str.replace(' ', 'T'));
  return isNaN(d) ? null : d;
}

function timeAgo(date) {
  if (!date) return '—';
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return 'hace ' + s + ' s';
  if (s < 3600) return 'hace ' + Math.floor(s / 60) + ' min';
  if (s < 86400) return 'hace ' + Math.floor(s / 3600) + ' h';
  if (s < 86400 * 30) return 'hace ' + Math.floor(s / 86400) + ' d';
  return date.toLocaleDateString('es-MX');
}

function toast(msg, isError) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.toggle('toast--error', !!isError);
  el.classList.add('is-show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-show'), 3500);
}

function svgIcon(name, size) {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="' + (size || 16) + '" height="' + (size || 16) + '">' + ICONS[name] + '</svg>';
}

/* ---------- carga de datos ---------- */

async function loadData() {
  const loader = document.getElementById('loader');
  const btn = document.getElementById('btnRefresh');
  loader.classList.remove('is-hidden');
  btn.classList.add('is-loading');
  try {
    const res = await fetch(API_URL);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    DATA = (json.data || []).map(enrich);
    buildFilterOptions();
    resetFilters();
    applyFilters();
    renderAll();
    document.getElementById('lastUpdate').textContent = 'Actualizado ' + new Date().toLocaleTimeString('es-MX');
    document.getElementById('footerTime').textContent = 'Reporte del ' + new Date().toLocaleString('es-MX');
    toast('Datos cargados: ' + fmtNum(DATA.length) + ' registros');
  } catch (e) {
    document.getElementById('kpiGrid').innerHTML =
      '<div class="panel" style="grid-column:1/-1;text-align:center;padding:40px;color:var(--red)">' +
      'No se pudo conectar con la API.<br><code style="font-size:.8rem;color:var(--muted)">' + esc(API_URL) + '</code><br>' +
      '<span style="color:var(--muted);font-size:.82rem">' + esc(e.message) + '</span></div>';
    toast('Error al consultar la API: ' + e.message, true);
  } finally {
    loader.classList.add('is-hidden');
    btn.classList.remove('is-loading');
  }
}

function enrich(r) {
  const archivo = r.archivo || '';
  const ext = archivo.includes('.') ? archivo.split('.').pop().toUpperCase() : '';
  const rbf = r.ruta_rbf;
  const centralCat = rbf ? String(rbf).split('/').filter(Boolean)[1] || null : null;
  const fileCat = ext === 'EXE' ? 'exe' : /quickbck/i.test(archivo) ? 'quickbck' : 'other';
  let sync;
  if (!rbf) sync = 'Sin referencia';
  else if (r.md5 && r.hash_rbf && String(r.md5).toUpperCase() === String(r.hash_rbf).toUpperCase()) sync = 'Sincronizado';
  else sync = 'Desactualizado';
  return Object.assign({}, r, {
    ext,
    centralCat,
    fileCat,
    sync,
    computadora: r.computadora || 'N/D',
    modDate: parseModDate(r.ultima_modificacion),
    connDate: parseConnDate(r.ultima_conexion),
  });
}

/* ---------- opciones de filtro ---------- */

function buildFilterOptions() {
  const countBy = (get) => {
    const m = new Map();
    for (const r of DATA) {
      const k = get(r);
      m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  };
  createMultiselect('msPlaza', 'plaza', 'Plaza', sortCounts(countBy((r) => r.plaza), false));
  createMultiselect('msGrupo', 'grupo', 'Grupo', sortCounts(countBy((r) => r.grupo), false));
  createMultiselect('msComputadora', 'computadora', 'Computadora', sortCounts(countBy((r) => r.computadora), true));
  createMultiselect('msArchivo', 'archivo', 'Archivo', sortCounts(countBy((r) => r.archivo), true));

  createChips('chipsSync', [
    { v: 'Sincronizado', label: '✓ Sincronizado', cls: 'chip--green' },
    { v: 'Sin referencia', label: 'Sin referencia', cls: '' },
    { v: 'Desactualizado', label: '✗ Desactualizado', cls: 'chip--red' },
  ], state.sync);

  createChips('chipsOnline', [
    { v: 'online', label: '● Online', cls: 'chip--green' },
    { v: 'offline', label: '○ Offline', cls: 'chip--red' },
  ], state.online);

  const catCounts = countBy((r) => r.centralCat);
  createChips('chipsCat', Array.from(catCounts.entries())
    .filter(([k]) => k)
    .sort((a, b) => b[1] - a[1])
    .map(([v]) => ({ v, label: v })), state.cat);

  createChips('chipsExt', Array.from(countBy((r) => r.ext).entries())
    .filter(([k]) => k)
    .sort((a, b) => b[1] - a[1])
    .map(([v]) => ({ v, label: v })), state.ext);
}

function sortCounts(map, alpha) {
  const arr = Array.from(map.entries()).filter(([k]) => k);
  if (alpha) arr.sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'es'));
  else arr.sort((a, b) => b[1] - a[1]);
  return arr;
}

/* ---------- multiselect ---------- */

function createMultiselect(hostId, key, label, options) {
  const host = document.getElementById(hostId);
  host.innerHTML = '';
  host.classList.remove('ms');
  host.classList.add('ms');
  const selected = state.selected[key];

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'ms__toggle';
  toggle.innerHTML = '<span class="ms__toggle-label">' + esc(label) + '</span>' +
    '<span class="ms__toggle-count">0</span><span class="ms__caret">▼</span>';

  const menu = document.createElement('div');
  menu.className = 'ms__menu';
  const search = document.createElement('input');
  search.className = 'ms__search';
  search.placeholder = 'Buscar ' + label.toLowerCase() + '…';
  const listEl = document.createElement('div');
  listEl.className = 'ms__options';
  menu.appendChild(search);
  menu.appendChild(listEl);

  const selAll = document.createElement('button');
  selAll.type = 'button';
  selAll.className = 'ms__select-all';
  selAll.textContent = 'Seleccionar todas';
  menu.appendChild(selAll);

  host.appendChild(toggle);
  host.appendChild(menu);

  const updateLabel = () => {
    const n = selected.size;
    toggle.querySelector('.ms__toggle-label').textContent = n === 0 ? label + ' (todas)' : label + ' (' + n + ')';
    toggle.querySelector('.ms__toggle-count').textContent = n === 0 ? 'Todas' : String(n);
  };

  const renderOptions = () => {
    const q = search.value.toLowerCase();
    listEl.innerHTML = '';
    let shown = 0;
    for (const [value, count] of options) {
      if (q && !String(value).toLowerCase().includes(q)) continue;
      shown++;
      const o = document.createElement('label');
      o.className = 'ms__option';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selected.has(value);
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(value);
        else selected.delete(value);
        if (selected.size === options.length) selected.clear();
        updateLabel();
        onFilterChange();
      });
      o.appendChild(cb);
      const span = document.createElement('span');
      span.textContent = value;
      o.appendChild(span);
      const b = document.createElement('b');
      b.textContent = fmtNum(count);
      o.appendChild(b);
      listEl.appendChild(o);
    }
    if (!shown) {
      const e = document.createElement('div');
      e.className = 'ms__empty';
      e.textContent = 'Sin resultados';
      listEl.appendChild(e);
    }
  };

  selAll.addEventListener('click', () => {
    selected.clear();
    updateLabel();
    renderOptions();
    onFilterChange();
  });

  toggle.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const isOpen = host.classList.contains('is-open');
    closeAllMenus();
    if (!isOpen) {
      host.classList.add('is-open');
      search.focus();
    }
    renderOptions();
  });

  search.addEventListener('input', renderOptions);
  search.addEventListener('click', (e) => e.stopPropagation());
  menu.addEventListener('click', (e) => e.stopPropagation());

  updateLabel();
  renderOptions();
}

function closeAllMenus() {
  document.querySelectorAll('.ms.is-open').forEach((el) => el.classList.remove('is-open'));
}

document.addEventListener('click', () => closeAllMenus());

/* ---------- chips ---------- */

function createChips(id, opts, selected) {
  const host = document.getElementById(id);
  host.innerHTML = '';
  for (const o of opts) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip ' + o.cls;
    b.textContent = o.label;
    b.addEventListener('click', () => {
      if (selected.has(o.v)) selected.delete(o.v);
      else selected.add(o.v);
      b.classList.toggle('is-active', selected.has(o.v));
      onFilterChange();
    });
    host.appendChild(b);
  }
  selected.forEach((v) => {
    const b = Array.from(host.children).find((c) => c.textContent && c.textContent.includes(v) || (v === 'online' && c.textContent.includes('Online')) || (v === 'offline' && c.textContent.includes('Offline')));
    if (b) b.classList.add('is-active');
  });
}

/* ---------- filtrado ---------- */

function readControls() {
  const val = (id) => document.getElementById(id).value;
  const v = (id) => (val(id) === '' ? null : parseFloat(val(id)));
  state.query = val('searchQuery');
  state.minSize = v('minSize');
  state.maxSize = v('maxSize');
  const fd = val('fromDate');
  const td = val('toDate');
  state.fromDate = fd ? new Date(fd + 'T00:00:00') : null;
  state.toDateEnd = td ? new Date(new Date(td + 'T00:00:00').getTime() + 86399999) : null;
}

function matches(r) {
  const s = state.selected;
  if (s.plaza.size && !s.plaza.has(r.plaza)) return false;
  if (s.grupo.size && !s.grupo.has(r.grupo)) return false;
  if (s.computadora.size && !s.computadora.has(r.computadora)) return false;
  if (s.archivo.size && !s.archivo.has(r.archivo)) return false;
  if (state.sync.size && !state.sync.has(r.sync)) return false;
  if (state.online.size && !state.online.has(r.estado)) return false;
  if (state.cat.size && !state.cat.has(r.centralCat)) return false;
  if (state.ext.size && !state.ext.has(r.ext)) return false;
  if (state.query) {
    const q = state.query.toLowerCase();
    const hay = [r.archivo, r.md5, r.hash_rbf, r.ruta, r.ruta_rbf, r.computadora, r.plaza, r.grupo].join(' ').toLowerCase();
    if (!hay.includes(q)) return false;
  }
  if (state.minSize != null && r.tamano_kb < state.minSize) return false;
  if (state.maxSize != null && r.tamano_kb > state.maxSize) return false;
  if (state.fromDate && (!r.modDate || r.modDate < state.fromDate)) return false;
  if (state.toDateEnd && (!r.modDate || r.modDate > state.toDateEnd)) return false;
  return true;
}

function applyFilters() {
  FILTERED = DATA.filter(matches);
  if (state.page > Math.max(1, Math.ceil(FILTERED.length / state.perPage))) state.page = 1;
}

function onFilterChange() {
  applyFilters();
  renderAll();
}

/* ---------- render: KPIs ---------- */

function renderKPIs() {
  const total = FILTERED.length;
  const conRef = FILTERED.filter((r) => r.centralCat).length;
  const sinRef = total - conRef;
  const syncCount = FILTERED.filter((r) => r.sync === 'Sincronizado').length;
  const desact = FILTERED.filter((r) => r.sync === 'Desactualizado').length;
  const coverage = total ? (conRef / total) * 100 : 0;
  const sizeKb = FILTERED.reduce((a, r) => a + (r.tamano_kb || 0), 0);

  const compSet = new Map();
  for (const r of FILTERED) {
    const c = compSet.get(r.computadora) || { online: false };
    if (r.estado === 'online') c.online = true;
    compSet.set(r.computadora, c);
  }
  let online = 0, offline = 0;
  compSet.forEach((c) => (c.online ? online++ : offline++));

  const cards = [
    { label: 'Archivos monitoreados', value: total, sub: 'registros en el reporte', icon: 'files', cls: 'kpi--accent' },
    { label: 'Con referencia central', value: conRef, sub: 'publicados por Sistemas', icon: 'ref', cls: 'kpi--blue' },
    { label: 'Sincronizados', value: syncCount, sub: 'hash coincide con RBF', icon: 'check', cls: 'kpi--green' },
    { label: 'Sin referencia', value: sinRef, sub: 'locales / no aplican', icon: 'slash', cls: 'kpi--purple' },
    { label: 'Cobertura de referencia', value: coverage.toFixed(1) + '%', sub: 'del total filtrado', icon: 'gauge', cls: 'kpi--amber' },
    { label: 'Equipos online', value: online, sub: 'sucursales conectadas', icon: 'online', cls: 'kpi--green' },
    { label: 'Equipos offline', value: offline, sub: 'sin conexión reciente', icon: 'online', cls: 'kpi--red' },
    { label: 'Tamaño total', value: fmtSize(sizeKb), sub: 'suma de archivos', icon: 'hdd', cls: 'kpi--purple' },
  ];

  const grid = document.getElementById('kpiGrid');
  grid.innerHTML = cards.map((c, i) =>
    '<div class="kpi-card ' + c.cls + '" style="animation-delay:' + (i * 0.06) + 's">' +
    '<div class="kpi-card__icon">' + svgIcon(c.icon, 18) + '</div>' +
    '<div class="kpi-card__label">' + c.label + '</div>' +
    '<div class="kpi-card__value" data-kpi="' + i + '">' + esc(c.value) + '</div>' +
    '<div class="kpi-card__sub">' + c.sub + '</div></div>'
  ).join('');

  cards.forEach((c, i) => {
    if (typeof c.value === 'number') countUp(grid.querySelector('[data-kpi="' + i + '"]'), c.value);
  });
}

function countUp(el, target) {
  const dur = 900;
  const t0 = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = fmtNum(target * eased);
    if (p < 1) requestAnimationFrame(step);
    else el.textContent = fmtNum(target);
  };
  requestAnimationFrame(step);
}

/* ---------- render: gráficas ---------- */

function chartDefaults() {
  Chart.defaults.color = '#8a92a8';
  Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';
  Chart.defaults.font.family = '"Inter", system-ui, sans-serif';
  Chart.defaults.font.size = 11;
  Chart.defaults.plugins.legend.labels.boxWidth = 12;
  Chart.defaults.plugins.legend.labels.boxHeight = 12;
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  Chart.defaults.plugins.legend.labels.pointStyle = 'circle';
}

const centerText = {
  id: 'centerText',
  afterDraw(chart) {
    if (!chart.options.centerText) return;
    const meta = chart.getDatasetMeta(0);
    if (!meta.data.length) return;
    const total = chart.data.datasets[0].data.reduce((a, b) => a + b, 0);
    const { ctx, chartArea } = chart;
    const x = chartArea.left + (chartArea.right - chartArea.left) / 2;
    const y = chartArea.top + (chartArea.bottom - chartArea.top) / 2;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#e8ebf5';
    ctx.font = '700 22px Inter, sans-serif';
    ctx.fillText(fmtNum(total), x, y);
    ctx.fillStyle = '#8a92a8';
    ctx.font = '600 11px Inter, sans-serif';
    ctx.fillText(chart.options.centerText, x, y + 20);
    ctx.restore();
  },
};

function renderChart(key, canvasId, config, empty) {
  if (charts[key]) { charts[key].destroy(); delete charts[key]; }
  const wrap = document.getElementById(canvasId).parentElement;
  const canvas = document.getElementById(canvasId);
  wrap.querySelector('.chart-card__empty')?.remove();
  if (empty) {
    canvas.style.display = 'none';
    const note = document.createElement('p');
    note.className = 'chart-card__empty';
    note.textContent = 'Sin datos con los filtros actuales';
    wrap.appendChild(note);
    return;
  }
  canvas.style.display = '';
  charts[key] = new Chart(canvas, config);
}

function renderCharts() {
  const total = FILTERED.length;
  if (!total) {
    ['chartSync', 'chartCat', 'chartExt', 'chartPlaza', 'chartActivity', 'chartHeavy', 'chartOffline'].forEach((id, i) =>
      renderChart('c' + i, id, null, true));
    return;
  }

  const bySync = [['Sincronizado', 0], ['Sin referencia', 0], ['Desactualizado', 0]];
  for (const r of FILTERED) {
    const i = bySync.findIndex(([k]) => k === r.sync);
    if (i >= 0) bySync[i][1]++;
  }
  renderChart('sync', 'chartSync', {
    type: 'doughnut',
    data: {
      labels: bySync.map(([k]) => k),
      datasets: [{ data: bySync.map(([, v]) => v), backgroundColor: ['#34d399', '#3b4260', '#f87171'], borderColor: 'transparent', borderWidth: 0, hoverOffset: 8 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 800, easing: 'easeOutQuart' },
      plugins: { legend: { position: 'bottom' } },
      cutout: '68%',
      centerText: 'archivos',
    },
    plugins: [centerText],
  }, bySync[1][1] + bySync[2][1] === 0);

  const catMap = new Map();
  for (const r of FILTERED) if (r.centralCat) catMap.set(r.centralCat, (catMap.get(r.centralCat) || 0) + 1);
  const cats = Array.from(catMap.entries()).sort((a, b) => b[1] - a[1]);
  renderChart('cat', 'chartCat', {
    type: 'doughnut',
    data: {
      labels: cats.map(([k]) => k),
      datasets: [{ data: cats.map(([, v]) => v), backgroundColor: PALETTE, borderColor: 'transparent', borderWidth: 0, hoverOffset: 8 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 800, easing: 'easeOutQuart' },
      plugins: { legend: { position: 'bottom' } },
      cutout: '68%',
    },
  }, cats.length === 0);

  const extMap = new Map();
  for (const r of FILTERED) if (r.ext) extMap.set(r.ext, (extMap.get(r.ext) || 0) + 1);
  const exts = Array.from(extMap.entries()).sort((a, b) => b[1] - a[1]);
  renderChart('ext', 'chartExt', {
    type: 'doughnut',
    data: {
      labels: exts.map(([k]) => k),
      datasets: [{ data: exts.map(([, v]) => v), backgroundColor: ['#6366f1', '#22d3ee', '#fbbf24', '#a78bfa', '#f87171', '#60a5fa', '#fb923c', '#f472b6', '#34d399', '#94a3b8'], borderColor: 'transparent', borderWidth: 0, hoverOffset: 8 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 800, easing: 'easeOutQuart' },
      plugins: { legend: { position: 'bottom' } },
      cutout: '68%',
    },
  }, exts.length === 0);

  const plazaMap = new Map();
  for (const r of FILTERED) {
    const p = r.plaza || 'N/A';
    const d = plazaMap.get(p) || { conRef: 0, sinRef: 0 };
    if (r.centralCat) d.conRef++; else d.sinRef++;
    plazaMap.set(p, d);
  }
  const plazas = Array.from(plazaMap.entries()).sort((a, b) => (b[1].conRef + b[1].sinRef) - (a[1].conRef + a[1].sinRef));
  renderChart('plaza', 'chartPlaza', {
    type: 'bar',
    data: {
      labels: plazas.map(([k]) => k),
      datasets: [
        { label: 'Con referencia', data: plazas.map(([, v]) => v.conRef), backgroundColor: '#22d3ee', borderRadius: 3, maxBarThickness: 26 },
        { label: 'Sin referencia', data: plazas.map(([, v]) => v.sinRef), backgroundColor: 'rgba(138,146,168,0.45)', borderRadius: 3, maxBarThickness: 26 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 800, easing: 'easeOutQuart' },
      plugins: { legend: { position: 'bottom' }, tooltip: { mode: 'index', intersect: false } },
      scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true } },
    },
  }, plazas.length === 0);

  const now = new Date();
  const labels = [], counts = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    labels.push(d.toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit' }));
    counts.push(0);
  }
  for (const r of FILTERED) {
    if (!r.modDate) continue;
    const diff = Math.floor((new Date(r.modDate.getFullYear(), r.modDate.getMonth(), r.modDate.getDate()).getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86400000);
    const idx = 13 - diff;
    if (idx >= 0 && idx <= 13) counts[idx]++;
  }
  const ctx = document.getElementById('chartActivity').getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 340);
  grad.addColorStop(0, 'rgba(99,102,241,0.45)');
  grad.addColorStop(1, 'rgba(99,102,241,0.02)');
  renderChart('activity', 'chartActivity', {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Archivos modificados',
        data: counts,
        borderColor: '#6366f1',
        backgroundColor: grad,
        fill: true,
        tension: 0.35,
        pointRadius: 2.5,
        pointHoverRadius: 5,
        pointBackgroundColor: '#a5b4fc',
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 900, easing: 'easeOutQuart' },
      plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } },
      scales: { x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 14 } }, y: { beginAtZero: true } },
    },
  }, false);

  const heavyMap = new Map();
  for (const r of FILTERED) {
    const d = heavyMap.get(r.archivo) || { size: 0, count: 0 };
    d.size += r.tamano_kb || 0;
    d.count++;
    heavyMap.set(r.archivo, d);
  }
  const heavy = Array.from(heavyMap.entries()).sort((a, b) => b[1].size - a[1].size).slice(0, 10);
  const heavyMax = heavy.length ? heavy[0][1].size : 1;
  renderChart('heavy', 'chartHeavy', {
    type: 'bar',
    data: {
      labels: heavy.map(([k]) => k.length > 22 ? k.slice(0, 20) + '…' : k),
      datasets: [{
        label: 'Tamaño',
        data: heavy.map(([, v]) => +(v.size / 1024).toFixed(1)),
        backgroundColor: heavy.map((_, i) => `hsla(${230 - i * 14}, 85%, 62%, 0.9)`),
        borderRadius: 4,
        maxBarThickness: 18,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 900, easing: 'easeOutQuart' },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => ' ' + c.parsed.x + ' MB · ' + fmtNum(heavy[c.dataIndex][1].count) + ' archivos' } },
      },
      scales: { x: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' } }, y: { grid: { display: false } } },
    },
  }, heavy.length === 0);

  const offMap = new Map();
  const seenComp = new Map();
  for (const r of FILTERED) {
    const key = r.computadora;
    const cur = seenComp.get(key) || { online: false, plaza: r.plaza || 'N/A' };
    if (r.estado === 'online') cur.online = true;
    seenComp.set(key, cur);
  }
  seenComp.forEach((c) => {
    if (!c.online) offMap.set(c.plaza, (offMap.get(c.plaza) || 0) + 1);
  });
  const offs = Array.from(offMap.entries()).sort((a, b) => b[1] - a[1]);
  renderChart('offline', 'chartOffline', {
    type: 'bar',
    data: {
      labels: offs.map(([k]) => k),
      datasets: [{ label: 'Equipos offline', data: offs.map(([, v]) => v), backgroundColor: '#f87171', borderRadius: 4, maxBarThickness: 20 }],
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 900, easing: 'easeOutQuart' },
      plugins: { legend: { display: false } },
      scales: { x: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: 'rgba(255,255,255,0.05)' } }, y: { grid: { display: false } } },
    },
  }, offs.length === 0);
}

/* ---------- render: tablas ---------- */

function renderTables() {
  renderPlazaTable();
  renderDetailTable();
  renderRanking();
}

function renderPlazaTable() {
  const map = new Map();
  for (const r of FILTERED) {
    const p = r.plaza || 'N/A';
    const d = map.get(p) || { total: 0, conRef: 0, sync: 0, online: 0, offline: 0, size: 0 };
    d.total++;
    if (r.centralCat) d.conRef++;
    if (r.sync === 'Sincronizado') d.sync++;
    if (r.estado === 'online') d.online++; else d.offline++;
    d.size += r.tamano_kb || 0;
    map.set(p, d);
  }
  const rows = Array.from(map.entries()).sort((a, b) => b[1].total - a[1].total);
  const tbody = document.querySelector('#tblPlaza tbody');
  tbody.innerHTML = rows.map(([plaza, d], i) => {
    const cov = d.total ? (d.conRef / d.total) * 100 : 0;
    return '<tr style="animation-delay:' + Math.min(i * 0.03, 0.4) + 's">' +
      '<td><b>' + esc(plaza) + '</b></td>' +
      '<td class="num">' + fmtNum(d.total) + '</td>' +
      '<td class="num">' + fmtNum(d.conRef) + '</td>' +
      '<td class="num mono" style="color:var(--green)">' + fmtNum(d.sync) + '</td>' +
      '<td class="num muted">' + fmtNum(d.total - d.conRef) + '</td>' +
      '<td class="num"><span class="badge ' + (cov >= 50 ? 'badge--green' : cov > 0 ? 'badge--amber' : 'badge--red') + '">' + cov.toFixed(1) + '%</span></td>' +
      '<td class="num" style="color:var(--green)">' + fmtNum(d.online) + '</td>' +
      '<td class="num" style="color:' + (d.offline ? 'var(--red)' : 'var(--muted)') + '">' + fmtNum(d.offline) + '</td>' +
      '<td class="num mono">' + fmtSize(d.size) + '</td></tr>';
  }).join('') || '<tr><td colspan="9" class="muted" style="text-align:center;padding:24px">Sin datos</td></tr>';

  const sum = {
    total: rows.reduce((a, [, d]) => a + d.total, 0),
    conRef: rows.reduce((a, [, d]) => a + d.conRef, 0),
    sync: rows.reduce((a, [, d]) => a + d.sync, 0),
    online: rows.reduce((a, [, d]) => a + d.online, 0),
    offline: rows.reduce((a, [, d]) => a + d.offline, 0),
    size: rows.reduce((a, [, d]) => a + d.size, 0),
  };
  document.getElementById('sumTotal').textContent = fmtNum(sum.total);
  document.getElementById('sumConRef').textContent = fmtNum(sum.conRef);
  document.getElementById('sumSync').textContent = fmtNum(sum.sync);
  document.getElementById('sumSinRef').textContent = fmtNum(sum.total - sum.conRef);
  document.getElementById('sumCover').textContent = (sum.total ? (sum.conRef / sum.total) * 100 : 0).toFixed(1) + '%';
  document.getElementById('sumOnline').textContent = fmtNum(sum.online);
  document.getElementById('sumOffline').textContent = fmtNum(sum.offline);
  document.getElementById('sumSize').textContent = fmtSize(sum.size);
}

const SYNC_ORDER = { 'Desactualizado': 0, 'Sin referencia': 1, 'Sincronizado': 2 };

function sortRows() {
  const key = state.sortKey;
  const dir = state.sortDir === 'asc' ? 1 : -1;
  return FILTERED.slice().sort((a, b) => {
    let av, bv;
    if (key === 'sync') { av = SYNC_ORDER[a.sync] ?? 3; bv = SYNC_ORDER[b.sync] ?? 3; }
    else if (key === 'modDate') { av = a.modDate ? a.modDate.getTime() : -Infinity; bv = b.modDate ? b.modDate.getTime() : -Infinity; }
    else if (key === 'tamano_kb') { av = a.tamano_kb || 0; bv = b.tamano_kb || 0; }
    else { av = String(a[key] ?? '').toLowerCase(); bv = String(b[key] ?? '').toLowerCase(); }
    if (av === bv) return 0;
    return (av > bv ? 1 : -1) * dir;
  });
}

function renderDetailTable() {
  const maxSize = Math.max(1, ...FILTERED.map((r) => r.tamano_kb || 0));
  const sorted = sortRows();
  const totalPages = Math.max(1, Math.ceil(sorted.length / state.perPage));
  state.page = Math.min(state.page, totalPages);
  const start = (state.page - 1) * state.perPage;
  const page = sorted.slice(start, start + state.perPage);

  document.getElementById('detailRange').textContent = sorted.length
    ? (start + 1) + '–' + (start + page.length) + ' de ' + fmtNum(sorted.length)
    : '0 resultados';
  document.getElementById('pagerInfo').textContent = 'Página ' + state.page + ' / ' + totalPages;
  document.getElementById('btnPrev').disabled = state.page <= 1;
  document.getElementById('btnNext').disabled = state.page >= totalPages;

  const tbody = document.querySelector('#tblDetail tbody');
  tbody.innerHTML = page.map((r, i) => {
    const syncBadge = r.sync === 'Sincronizado'
      ? '<span class="badge badge--green">Sincronizado</span>'
      : r.sync === 'Desactualizado'
        ? '<span class="badge badge--red">Desactualizado</span>'
        : '<span class="badge badge--muted">Sin referencia</span>';
    const onlineBadge = r.estado === 'online'
      ? '<span class="badge badge--green">Online</span>'
      : '<span class="badge badge--red">Offline</span>';
    const pct = Math.min(100, ((r.tamano_kb || 0) / maxSize) * 100);
    const ref = r.ruta_rbf ? '<span class="mono" title="' + esc(r.ruta_rbf) + '">' + esc(r.ruta_rbf.split('/').filter(Boolean).slice(0, 2).join('/')) + '</span>' : '<span class="muted">—</span>';
    return '<tr style="animation-delay:' + Math.min(i * 0.02, 0.3) + 's">' +
      '<td><b>' + esc(r.archivo) + '</b><div class="muted" style="font-size:.7rem">' + esc(r.fileCat === 'other' ? (r.ext || '?') : r.fileCat) + '</div></td>' +
      '<td>' + esc(r.computadora) + '</td>' +
      '<td>' + esc(r.plaza) + '</td>' +
      '<td class="muted">' + esc(r.grupo) + '</td>' +
      '<td class="num"><div class="size-bar"><span class="mono">' + fmtSize(r.tamano_kb) + '</span><div class="size-bar__track"><div class="size-bar__fill" style="width:' + pct.toFixed(1) + '%"></div></div></div></td>' +
      '<td>' + syncBadge + '</td>' +
      '<td>' + onlineBadge + '</td>' +
      '<td class="muted" title="' + esc(r.ultima_modificacion || '') + '">' + timeAgo(r.modDate) + '</td>' +
      '<td>' + ref + '</td>' +
      '<td class="mono muted">' + esc(r.md5 || '—') + '</td></tr>';
  }).join('') || '<tr><td colspan="10" class="muted" style="text-align:center;padding:28px">Sin resultados con los filtros actuales</td></tr>';

  document.querySelectorAll('#tblDetail th.sortable').forEach((th) => {
    const active = th.dataset.sort === state.sortKey;
    th.classList.toggle('is-sorted', active);
    th.querySelector('.sort-arrow').textContent = active ? (state.sortDir === 'asc' ? '▲' : '▼') : '↕';
  });
}

function renderRanking() {
  const map = new Map();
  for (const r of FILTERED) {
    const k = r.computadora;
    const d = map.get(k) || { plaza: r.plaza || 'N/A', total: 0, conRef: 0, sync: 0, offline: 0 };
    d.total++;
    if (r.centralCat) d.conRef++;
    if (r.sync === 'Sincronizado') d.sync++;
    if (r.estado !== 'online') d.offline++;
    map.set(k, d);
  }
  const rows = Array.from(map.entries()).sort((a, b) => b[1].total - a[1].total).slice(0, 50);
  const maxTotal = rows.length ? rows[0][1].total : 1;
  const tbody = document.querySelector('#tblComputers tbody');
  tbody.innerHTML = rows.map(([comp, d], i) => {
    const cov = d.total ? (d.conRef / d.total) * 100 : 0;
    const badge = cov >= 50 ? 'badge--green' : cov > 0 ? 'badge--amber' : 'badge--red';
    return '<tr style="animation-delay:' + Math.min(i * 0.02, 0.4) + 's">' +
      '<td class="muted mono">' + (i + 1) + '</td>' +
      '<td><b>' + esc(comp) + '</b>' + (d.offline ? ' <span class="badge badge--red">offline</span>' : '') + '</td>' +
      '<td class="muted">' + esc(d.plaza) + '</td>' +
      '<td class="num">' + fmtNum(d.total) + '</td>' +
      '<td class="num">' + fmtNum(d.conRef) + '</td>' +
      '<td class="num muted">' + fmtNum(d.total - d.conRef) + '</td>' +
      '<td class="num mono" style="color:var(--green)">' + fmtNum(d.sync) + '</td>' +
      '<td><div class="progress" style="width:110px"><div class="progress__fill" style="width:' + cov.toFixed(1) + '%"></div></div><span class="muted" style="font-size:.7rem">' + cov.toFixed(1) + '%</span></td></tr>';
  }).join('') || '<tr><td colspan="8" class="muted" style="text-align:center;padding:24px">Sin datos</td></tr>';
}

/* ---------- render: filtros activos ---------- */

function renderActiveFilters() {
  const host = document.getElementById('activeFilters');
  host.innerHTML = '';
  const add = (label, value, onRemove) => {
    const span = document.createElement('span');
    span.className = 'active-chip';
    span.innerHTML = label + ': <b></b>';
    span.querySelector('b').textContent = value;
    if (onRemove) {
      const x = document.createElement('span');
      x.className = 'active-chip__x';
      x.textContent = '×';
      x.addEventListener('click', onRemove);
      span.appendChild(x);
    }
    host.appendChild(span);
  };
  const addSet = (set, label) => {
    if (!set.size) return;
    let i = 0;
    set.forEach((v) => {
      if (i < 8) {
        add(label, v, () => { set.delete(v); syncChipUI(); onFilterChange(); });
        i++;
      }
    });
    if (set.size > i) add(label, '+' + (set.size - i) + ' más', null);
  };
  addSet(state.selected.plaza, 'Plaza');
  addSet(state.selected.grupo, 'Grupo');
  addSet(state.selected.computadora, 'Sucursal');
  addSet(state.selected.archivo, 'Archivo');
  addSet(state.sync, 'Sync');
  addSet(state.online, 'Estado');
  addSet(state.cat, 'Catálogo');
  addSet(state.ext, 'Tipo');
  if (state.query) add('Búsqueda', state.query, () => { state.query = ''; document.getElementById('searchQuery').value = ''; onFilterChange(); });
  if (state.minSize != null) add('Tamaño ≥', state.minSize + ' KB', () => { state.minSize = null; document.getElementById('minSize').value = ''; onFilterChange(); });
  if (state.maxSize != null) add('Tamaño ≤', state.maxSize + ' KB', () => { state.maxSize = null; document.getElementById('maxSize').value = ''; onFilterChange(); });
  if (state.fromDate) add('Desde', state.fromDate.toLocaleDateString('es-MX'), () => { state.fromDate = null; document.getElementById('fromDate').value = ''; onFilterChange(); });
  if (state.toDateEnd) add('Hasta', state.toDateEnd.toLocaleDateString('es-MX'), () => { state.toDateEnd = null; document.getElementById('toDate').value = ''; onFilterChange(); });

  if (!host.children.length) {
    const hint = document.createElement('span');
    hint.className = 'empty-hint';
    hint.textContent = 'Sin filtros activos — mostrando todo el reporte.';
    host.appendChild(hint);
  }
}

function activeChip(label, value, onRemove) {
  const span = document.createElement('span');
  span.className = 'active-chip';
  span.innerHTML = label + ': <b></b> <span class="active-chip__x">×</span>';
  span.querySelector('b').textContent = value;
  span.querySelector('.active-chip__x').addEventListener('click', onRemove);
  return span.outerHTML;
}

function syncChipUI() {
  document.querySelectorAll('.chips').forEach((host) => {
    const selMap = { 'chipsSync': state.sync, 'chipsOnline': state.online, 'chipsCat': state.cat, 'chipsExt': state.ext };
    const sel = selMap[host.id];
    if (!sel) return;
    Array.from(host.children).forEach((b) => {
      const map = {
        '✓ Sincronizado': 'Sincronizado', 'Sin referencia': 'Sin referencia', '✗ Desactualizado': 'Desactualizado',
        '● Online': 'online', '○ Offline': 'offline',
      };
      const val = map[b.textContent] || b.textContent;
      b.classList.toggle('is-active', sel.has(val));
    });
  });
}

/* ---------- render: principal ---------- */

function renderAll() {
  renderKPIs();
  renderCharts();
  renderTables();
  renderActiveFilters();
  document.getElementById('resultCount').textContent =
    FILTERED.length < DATA.length
      ? 'Filtrando ' + fmtNum(FILTERED.length) + ' de ' + fmtNum(DATA.length)
      : fmtNum(DATA.length) + ' registros';
}

/* ---------- export CSV ---------- */

function exportCSV() {
  if (!FILTERED.length) { toast('No hay datos que exportar', true); return; }
  const cols = ['Computadora', 'ShortKey', 'Plaza', 'Grupo', 'Estado', 'UltimaConexion', 'Archivo', 'Ruta', 'TamanoKB', 'UltimaModificacion', 'MD5', 'Sincronizacion', 'RutaRBF', 'HashRBF', 'CategoriaCentral', 'TipoArchivo'];
  const lines = [cols.join(',')];
  for (const r of FILTERED) {
    lines.push(cols.map((c) => {
      const v = {
        Computadora: r.computadora, ShortKey: r.short_key, Plaza: r.plaza, Grupo: r.grupo,
        Estado: r.estado, UltimaConexion: r.ultima_conexion, Archivo: r.archivo, Ruta: r.ruta,
        TamanoKB: r.tamano_kb, UltimaModificacion: r.ultima_modificacion, MD5: r.md5,
        Sincronizacion: r.sync, RutaRBF: r.ruta_rbf, HashRBF: r.hash_rbf,
        CategoriaCentral: r.centralCat || '', TipoArchivo: r.fileCat,
      }[c];
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(','));
  }
  const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  a.href = URL.createObjectURL(blob);
  a.download = 'reporte-dbf-' + stamp + '.csv';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Exportados ' + fmtNum(FILTERED.length) + ' registros a CSV');
}

/* ---------- inicialización ---------- */

function resetFilters() {
  Object.values(state.selected).forEach((s) => s.clear());
  state.sync.clear();
  state.online.clear();
  state.cat.clear();
  state.ext.clear();
  state.query = '';
  state.minSize = null;
  state.maxSize = null;
  state.fromDate = null;
  state.toDateEnd = null;
  state.sortKey = 'sync';
  state.sortDir = 'asc';
  state.page = 1;
  document.getElementById('searchQuery').value = '';
  document.getElementById('minSize').value = '';
  document.getElementById('maxSize').value = '';
  document.getElementById('fromDate').value = '';
  document.getElementById('toDate').value = '';
}

function bindUI() {
  ['searchQuery', 'minSize', 'maxSize', 'fromDate', 'toDate'].forEach((id) => {
    document.getElementById(id).addEventListener('input', () => { readControls(); onFilterChange(); });
  });
  document.getElementById('btnClearAll').addEventListener('click', () => { resetFilters(); syncChipUI(); buildFilterOptions(); onFilterChange(); });
  document.getElementById('btnRefresh').addEventListener('click', loadData);
  document.getElementById('btnExport').addEventListener('click', exportCSV);

  document.querySelectorAll('#tblDetail th.sortable').forEach((th) => {
    const arrow = document.createElement('span');
    arrow.className = 'sort-arrow';
    arrow.textContent = '↕';
    th.appendChild(arrow);
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.sortKey === key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      else { state.sortKey = key; state.sortDir = 'asc'; }
      state.page = 1;
      renderDetailTable();
    });
  });

  document.getElementById('perPage').addEventListener('change', (e) => {
    state.perPage = parseInt(e.target.value, 10);
    state.page = 1;
    renderDetailTable();
  });
  document.getElementById('btnPrev').addEventListener('click', () => { if (state.page > 1) { state.page--; renderDetailTable(); } });
  document.getElementById('btnNext').addEventListener('click', () => {
    const max = Math.max(1, Math.ceil(FILTERED.length / state.perPage));
    if (state.page < max) { state.page++; renderDetailTable(); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllMenus();
  });
}

function updateClock() {
  document.getElementById('clock').textContent = new Date().toLocaleTimeString('es-MX', { hour12: false });
}

function init() {
  chartDefaults();
  bindUI();
  updateClock();
  setInterval(updateClock, 1000);
  loadData();
}

document.addEventListener('DOMContentLoaded', init);
