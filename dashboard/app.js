/* ============================================================
   Dashboard Sincronización DBF — Central ⇄ Sucursales
   Tabs: Plazas · Resumen · Equipos · Mapas de calor · Vendedores · CEDIS · Detalle
   Auto-refresco 10 min en segundo plano + tema claro/oscuro
   ============================================================ */
'use strict';

const API_URL = 'http://212.227.6.127:8000/api/dbf-report?format=json';
const REFRESH_MS = 10 * 60 * 1000;

const SYNC_ORDER = { 'Desactualizado': 0, 'Sin referencia': 1, 'Sincronizado': 2 };
const SYNC_COLORS = { 'Sincronizado': '#34d399', 'Sin referencia': '#8a92a8', 'Desactualizado': '#f87171' };
const TIPO_LABEL = { vendedor: 'Vendedor', cedis: 'CEDIS', tienda: 'Tienda' };
const TIPO_BADGE = { vendedor: 'badge--blue', cedis: 'badge--amber', tienda: 'badge--muted' };

const VENDOR_RE = /vendedor|b2b|ventas?\s*(especial|corporativ)?|corporativ|especial/i;
const VENDOR_NAMES = new Set(['Yasmileth Valenzuela', 'ERVIN MACHADO', 'MELANI FARDO', 'KARINA PICADO', 'Adriana de la Rosa']);
const CEDIS_RE = /almacen|bodega|activo fijo|gerente/i;

const PALETTE = ['#6366f1', '#22d3ee', '#a78bfa', '#f472b6', '#34d399', '#fbbf24', '#f87171', '#60a5fa', '#fb923c', '#34a853'];

const state = {
  selected: { plaza: new Set(), grupo: new Set(), computadora: new Set(), archivo: new Set() },
  sync: new Set(), online: new Set(), cat: new Set(), ext: new Set(), tipo: new Set(),
  query: '', minSize: null, maxSize: null, fromDate: null, toDateEnd: null,
  sortKey: 'sync', sortDir: 'asc',
  eqSortKey: 'computadora', eqSortDir: 'asc',
  page: 1, perPage: 20, heatMetric: 'count',
  plazaSel: null, syncMode: 'catalogos', plazaQuery: ''
};

let DATA = [];
let FILTERED = [];
let nextRefreshAt = Date.now() + REFRESH_MS;
let autoTimer = null;
let activeTab = 'plazas';

/* ============================ Helpers ============================ */

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = n => new Intl.NumberFormat('es-MX').format(Math.round(n));

function fmtSize(kb) {
  if (!kb) return '0 KB';
  if (kb < 1024) return fmtNum(kb) + ' KB';
  const mb = kb / 1024;
  if (mb < 1024) return fmtNum(mb) + ' MB';
  return fmtNum(mb / 1024) + ' GB';
}

function timeAgo(ts) {
  if (!ts) return '—';
  const sec = Math.max(0, (Date.now() - ts) / 1000);
  if (sec < 60) return 'hace ' + Math.round(sec) + ' s';
  if (sec < 3600) return 'hace ' + Math.round(sec / 60) + ' min';
  if (sec < 86400) return 'hace ' + Math.round(sec / 3600) + ' h';
  return 'hace ' + Math.round(sec / 86400) + ' días';
}

function parseModDate(s) {
  if (!s) return -Infinity;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return -Infinity;
  let h = parseInt(m[4], 10);
  const isPM = /pm/i.test(m[7]);
  if (isPM && h < 12) h += 12;
  if (!isPM && h === 12) h = 0;
  return new Date(+m[1], +m[2] - 1, +m[3], h, +m[5], +m[6]).getTime();
}

function parseConnDate(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d.getTime();
}

function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
const RGB = {
  indigo: hexRgb('#6366f1'), cyan: hexRgb('#22d3ee'),
  green: hexRgb('#34d399'), gray: hexRgb('#8a92a8'), red: hexRgb('#f87171')
};

let toastTimer = null;
function toast(msg, isError) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast is-show' + (isError ? ' toast--error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('is-show'); }, 3200);
}

/* ============================ Clasificación ============================ */

function esVendedor(r) {
  return VENDOR_NAMES.has(r.computadora) || VENDOR_RE.test([r.grupo, r.computadora].join(' '));
}
function esCedis(r) {
  return CEDIS_RE.test([r.grupo, r.computadora].join(' '));
}

function enrich(r) {
  const ruta = r.ruta_rbf || '';
  const parts = ruta.split('/');
  const centralCat = parts.length > 1 && ruta.startsWith('/') ? (parts[1] || 'N/A') : null;
  const name = String(r.archivo || '');
  const ext = name.includes('.') ? name.split('.').pop().toUpperCase() : 'SIN';
  const isExe = ext === 'EXE';
  const fileCat = isExe ? 'exe' : /quickbck/i.test(name) ? 'quickbck' : 'other';
  const hasRef = !!r.ruta_rbf;
  const sync = hasRef
    ? (r.md5 && r.md5 === r.hash_rbf ? 'Sincronizado' : 'Desactualizado')
    : 'Sin referencia';
  return {
    ...r,
    ext, fileCat, centralCat, hasRef, sync,
    tipo: esVendedor(r) ? 'vendedor' : esCedis(r) ? 'cedis' : 'tienda',
    modDate: parseModDate(r.ultima_modificacion),
    connDate: parseConnDate(r.ultima_conexion),
    computadora: r.computadora || 'N/D'
  };
}

/* ============================ Estado / filtros ============================ */

function resetFilters() {
  Object.values(state.selected).forEach(s => s.clear());
  state.sync.clear(); state.online.clear(); state.cat.clear(); state.ext.clear(); state.tipo.clear();
  state.query = ''; state.minSize = null; state.maxSize = null;
  state.fromDate = null; state.toDateEnd = null;
  state.page = 1;
  ['searchQuery', 'minSize', 'maxSize', 'fromDate', 'toDate'].forEach(id => { $(id).value = ''; });
}

function buildFilterOptions() {
  const opts = { plaza: new Map(), grupo: new Map(), computadora: new Map(), archivo: new Map() };
  for (const r of DATA) {
    for (const k of Object.keys(opts)) {
      const v = r[k === 'computadora' ? 'computadora' : k];
      const key = String(v ?? 'N/A');
      opts[k].set(key, (opts[k].get(key) || 0) + 1);
    }
  }
  for (const k of Object.keys(opts)) {
    const list = Array.from(opts[k].entries()).sort((a, b) => a[0].localeCompare(b[0], 'es'));
    createMultiselect('ms' + k.charAt(0).toUpperCase() + k.slice(1), k, list);
  }
  createChips('chipsSync', 'sync', [
    { v: 'Sincronizado', label: 'Sincronizado', cls: 'chip--green' },
    { v: 'Sin referencia', label: 'Sin referencia' },
    { v: 'Desactualizado', label: 'Desactualizado', cls: 'chip--red' }
  ]);
  createChips('chipsOnline', 'online', [
    { v: 'online', label: 'Online', cls: 'chip--green' },
    { v: 'offline', label: 'Offline', cls: 'chip--red' }
  ]);
  createChips('chipsTipo', 'tipo', [
    { v: 'vendedor', label: 'Vendedor', cls: 'chip--blue' },
    { v: 'cedis', label: 'CEDIS', cls: 'chip--amber' },
    { v: 'tienda', label: 'Tienda' }
  ]);
  createChips('chipsCat', 'cat', Array.from(new Set(DATA.filter(r => r.centralCat).map(r => r.centralCat)))
    .sort((a, b) => a.localeCompare(b, 'es'))
    .map(c => ({ v: c, label: c, cls: 'chip--purple' })));
  createChips('chipsExt', 'ext', Array.from(new Set(DATA.map(r => r.ext)))
    .sort((a, b) => a.localeCompare(b, 'es'))
    .map(e => ({ v: e, label: e, cls: 'chip--blue' })));
}

function syncChipUI() {
  const selMap = { chipsSync: state.sync, chipsOnline: state.online, chipsCat: state.cat, chipsExt: state.ext, chipsTipo: state.tipo };
  for (const [hostId, set] of Object.entries(selMap)) {
    document.querySelectorAll('#' + hostId + ' .chip').forEach(chip => {
      chip.classList.toggle('is-active', set.has(chip.textContent.trim()));
    });
  }
}

function matches(r) {
  if (state.selected.plaza.size && !state.selected.plaza.has(r.plaza)) return false;
  if (state.selected.grupo.size && !state.selected.grupo.has(r.grupo)) return false;
  if (state.selected.computadora.size && !state.selected.computadora.has(r.computadora)) return false;
  if (state.selected.archivo.size && !state.selected.archivo.has(r.archivo)) return false;
  if (state.sync.size && !state.sync.has(r.sync)) return false;
  if (state.online.size && !state.online.has(r.estado)) return false;
  if (state.cat.size && !state.cat.has(r.centralCat)) return false;
  if (state.ext.size && !state.ext.has(r.ext)) return false;
  if (state.tipo.size && !state.tipo.has(r.tipo)) return false;
  if (state.query) {
    const q = state.query.toLowerCase();
    if (!String(r.archivo + ' ' + r.md5 + ' ' + r.ruta + ' ' + r.ruta_rbf + ' ' + r.computadora).toLowerCase().includes(q)) return false;
  }
  const sz = r.tamano_kb || 0;
  if (state.minSize !== null && state.minSize !== '' && sz < +state.minSize) return false;
  if (state.maxSize !== null && state.maxSize !== '' && sz > +state.maxSize) return false;
  if (state.fromDate) {
    const d = new Date(state.fromDate + 'T00:00:00').getTime();
    if (r.modDate !== -Infinity && r.modDate < d) return false;
  }
  if (state.toDateEnd) {
    const d = new Date(state.toDateEnd + 'T23:59:59.999').getTime();
    if (r.modDate !== -Infinity && r.modDate > d) return false;
  }
  return true;
}

function applyFilters() {
  FILTERED = DATA.filter(matches);
  const had = state.query || state.selected.plaza.size || state.selected.grupo.size || state.selected.computadora.size ||
    state.selected.archivo.size || state.sync.size || state.online.size || state.cat.size || state.ext.size || state.tipo.size ||
    state.minSize !== null && state.minSize !== '' || state.maxSize !== null && state.maxSize !== '' || state.fromDate || state.toDateEnd;
  if (!had) state.page = 1;
  if (state.page > Math.max(1, Math.ceil(FILTERED.length / state.perPage))) state.page = 1;
  $('resultCount').textContent = fmtNum(FILTERED.length) + ' registros';
  renderActiveFilters();
  renderAll();
}

/* ============================ Multiselect / chips ============================ */

function createMultiselect(hostId, key, items) {
  const host = $(hostId);
  if (!host) return;
  host.innerHTML = '';
  const selected = state.selected[key];

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'ms__toggle';
  toggle.innerHTML = '<span class="ms__toggle-label">Todos</span><span class="ms__toggle-count">0</span><span class="ms__caret">▼</span>';

  const menu = document.createElement('div');
  menu.className = 'ms__menu';
  menu.innerHTML = '<input type="search" class="ms__search" placeholder="Buscar…" autocomplete="off"><button type="button" class="ms__select-all">Seleccionar todos</button><div class="ms__options"></div>';

  const optionsBox = menu.querySelector('.ms__options');
  const search = menu.querySelector('.ms__search');
  const selectAll = menu.querySelector('.ms__select-all');

  function renderOptions(filter = '') {
    optionsBox.innerHTML = '';
    const shown = items.filter(([name]) => !filter || name.toLowerCase().includes(filter.toLowerCase()));
    if (!shown.length) { optionsBox.innerHTML = '<div class="ms__empty">Sin coincidencias</div>'; return; }
    shown.forEach(([name, count]) => {
      const label = document.createElement('label');
      label.className = 'ms__option';
      label.innerHTML = '<input type="checkbox" value="' + esc(name) + '"><span>' + esc(name) + '</span><b>' + fmtNum(count) + '</b>';
      label.querySelector('input').checked = selected.has(name);
      label.querySelector('input').addEventListener('change', e => {
        if (e.target.checked) selected.add(name); else selected.delete(name);
        updateToggle();
        applyFilters();
      });
      optionsBox.appendChild(label);
    });
  }

  function updateToggle() {
    const n = selected.size;
    const label = toggle.querySelector('.ms__toggle-label');
    toggle.querySelector('.ms__toggle-count').textContent = n;
    label.textContent = n === 0 ? 'Todos' : n === items.length ? 'Todos' : n + ' seleccionado' + (n > 1 ? 's' : '');
  }

  toggle.addEventListener('click', e => { e.stopPropagation(); closeAllMenus(); host.classList.toggle('is-open'); menu.classList.toggle('is-open'); });
  search.addEventListener('input', () => renderOptions(search.value));
  selectAll.addEventListener('click', () => {
    const all = items.map(([name]) => name);
    if (selected.size === items.length) { all.forEach(n => selected.delete(n)); }
    else { all.forEach(n => selected.add(n)); }
    renderOptions(search.value);
    updateToggle();
    applyFilters();
  });

  host.appendChild(toggle);
  host.appendChild(menu);
  renderOptions();
  updateToggle();
}

function createChips(hostId, key, opts) {
  const host = $(hostId);
  if (!host) return;
  host.innerHTML = '';
  const selected = state[key];
  opts.forEach(o => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip ' + (o.cls || '');
    chip.textContent = o.label;
    chip.classList.toggle('is-active', selected.has(o.v));
    chip.addEventListener('click', () => {
      if (selected.has(o.v)) selected.delete(o.v); else selected.add(o.v);
      chip.classList.toggle('is-active', selected.has(o.v));
      applyFilters();
    });
    host.appendChild(chip);
  });
}

function closeAllMenus() {
  document.querySelectorAll('.ms').forEach(m => { m.classList.remove('is-open'); m.querySelector('.ms__menu')?.classList.remove('is-open'); });
}

/* ============================ KPIs ============================ */

function kpiCard(label, value, sub, cls, icon) {
  return '<div class="kpi-card ' + (cls || '') + '"><span class="kpi-card__icon">' + icon + '</span>' +
    '<div class="kpi-card__label">' + label + '</div>' +
    '<div class="kpi-card__value" data-count="' + value + '">0</div>' +
    (sub ? '<div class="kpi-card__sub">' + sub + '</div>' : '') + '</div>';
}

function countUpAll() {
  document.querySelectorAll('.kpi-card__value[data-count]').forEach(el => {
    const target = parseFloat(el.dataset.count);
    const dur = 900, t0 = performance.now();
    function frame(t) {
      const p = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      el.textContent = target >= 1e6 ? fmtSize(target) : (target >= 1000 ? fmtNum(target * e) : Math.round(target * e));
      if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });
}

function coveragePct(conRef, total) { return total ? (conRef / total) * 100 : 0; }

function renderKPIs() {
  const total = FILTERED.length;
  const conRef = FILTERED.filter(r => r.hasRef).length;
  const sync = FILTERED.filter(r => r.sync === 'Sincronizado').length;
  const sinRef = total - conRef;
  const cover = total ? (conRef / total) * 100 : 0;
  const computadoras = new Set(FILTERED.map(r => r.computadora)).size;
  const onlineSet = new Set(FILTERED.filter(r => r.estado === 'online').map(r => r.computadora));
  const offComputers = new Set(FILTERED.map(r => r.computadora));
  onlineSet.forEach(c => offComputers.delete(c));
  const totalSize = FILTERED.reduce((a, r) => a + (r.tamano_kb || 0), 0);

  $('kpiGrid').innerHTML =
    kpiCard('Archivos totales', total, computadoras + ' sucursales', 'kpi--accent', '&#128190;') +
    kpiCard('Con referencia central', conRef, 'Catálogos publicados por Sistemas', '', '&#128203;') +
    kpiCard('Sincronizados', sync, (total ? (sync / total) * 100 : 0).toFixed(1) + '% del total', 'kpi--green', '&#10003;') +
    kpiCard('Sin referencia', sinRef, 'Archivos locales / ejecutables', 'kpi--amber', '&#9888;') +
    kpiCard('Cobertura', cover.toFixed(1) + '%', 'Con referencia / total', 'kpi--blue', '&#127775;') +
    kpiCard('Equipos online', onlineSet.size, 'Reportan conexión reciente', 'kpi--green', '&#128187;') +
    kpiCard('Equipos offline', offComputers.size, 'Sin conexión', 'kpi--red', '&#128273;') +
    kpiCard('Tamaño total', totalSize, fmtSize(totalSize), 'kpi--purple', '&#128190;');
  countUpAll();
}

function renderEquiposKPIs() {
  const comps = summarizeComputers(FILTERED);
  const online = comps.filter(c => c.online).length;
  const offline = comps.length - online;
  const nVend = comps.filter(c => c.tipo === 'vendedor').length;
  const nCed = comps.filter(c => c.tipo === 'cedis').length;
  const nTienda = comps.filter(c => c.tipo === 'tienda').length;
  const archivos = FILTERED.length;

  $('kpiEquipos').innerHTML =
    kpiCard('Equipos', comps.length, 'Sucursales y centros reportados', 'kpi--accent', '&#128187;') +
    kpiCard('Online', online, (comps.length ? (online / comps.length) * 100 : 0).toFixed(1) + ' % del total', 'kpi--green', '&#128268;') +
    kpiCard('Offline', offline, 'Sin registro online', 'kpi--red', '&#128273;') +
    kpiCard('Tiendas', nTienda, 'Sucursales tipo tienda', '', '&#127978;') +
    kpiCard('Vendedores', nVend, 'Equipos de venta / B2B', 'kpi--blue', '&#128104;') +
    kpiCard('CEDIS', nCed, 'Almacenes / distribución', 'kpi--amber', '&#128666;') +
    kpiCard('Archivos reportados', archivos, 'Registros de los equipos', 'kpi--purple', '&#128190;');
  countUpAll();
}

function renderVendedoresKPIs(rows) {
  const comps = summarizeComputers(rows);
  const online = comps.filter(c => c.online).length;
  const offline = comps.length - online;
  const conRef = rows.filter(r => r.hasRef).length;
  const sync = rows.filter(r => r.sync === 'Sincronizado').length;
  const size = rows.reduce((a, r) => a + (r.tamano_kb || 0), 0);

  $('kpiVendedores').innerHTML =
    kpiCard('Equipos de venta', comps.length, 'Fuerza de ventas / B2B', 'kpi--blue', '&#128104;') +
    kpiCard('Archivos', rows.length, 'Registros reportados', 'kpi--accent', '&#128190;') +
    kpiCard('Con referencia', conRef, 'Catálogos de Sistemas', '', '&#128203;') +
    kpiCard('Sincronizados', sync, (rows.length ? (sync / rows.length) * 100 : 0).toFixed(1) + '%', 'kpi--green', '&#10003;') +
    kpiCard('Equipos online', online, 'Con conexión reciente', 'kpi--green', '&#128268;') +
    kpiCard('Equipos offline', offline, 'Sin registro online', 'kpi--red', '&#128273;') +
    kpiCard('Cobertura', (rows.length ? (conRef / rows.length) * 100 : 0).toFixed(1) + '%', 'Referencia / total', 'kpi--amber', '&#127775;') +
    kpiCard('Tamaño', size, fmtSize(size), 'kpi--purple', '&#128190;');
  countUpAll();
}

function renderCedisKPIs(rows) {
  const comps = summarizeComputers(rows);
  const online = comps.filter(c => c.online).length;
  const offline = comps.length - online;
  const conRef = rows.filter(r => r.hasRef).length;
  const sync = rows.filter(r => r.sync === 'Sincronizado').length;
  const size = rows.reduce((a, r) => a + (r.tamano_kb || 0), 0);

  $('kpiCedis').innerHTML =
    kpiCard('Centros CEDIS', comps.length, 'Almacenes / distribución', 'kpi--amber', '&#128666;') +
    kpiCard('Archivos', rows.length, 'Registros reportados', 'kpi--accent', '&#128190;') +
    kpiCard('Con referencia', conRef, 'Catálogos de Sistemas', '', '&#128203;') +
    kpiCard('Sincronizados', sync, (rows.length ? (sync / rows.length) * 100 : 0).toFixed(1) + '%', 'kpi--green', '&#10003;') +
    kpiCard('Centros online', online, 'Con conexión reciente', 'kpi--green', '&#128268;') +
    kpiCard('Centros offline', offline, 'Sin registro online', 'kpi--red', '&#128273;') +
    kpiCard('Cobertura', (rows.length ? (conRef / rows.length) * 100 : 0).toFixed(1) + '%', 'Referencia / total', 'kpi--blue', '&#127775;') +
    kpiCard('Tamaño', size, fmtSize(size), 'kpi--purple', '&#128190;');
  countUpAll();
}

/* ============================ Gráficas ============================ */

const centerText = {
  id: 'centerText',
  afterDraw(chart) {
    if (chart.config.type !== 'doughnut') return;
    const { ctx } = chart;
    const meta = chart.getDatasetMeta(0);
    if (!meta || !meta.data.length) return;
    const first = meta.data[0];
    const x = first.x, y = first.y;
    const total = chart.data.datasets[0].data.reduce((a, b) => a + b, 0);
    const light = document.documentElement.dataset.theme === 'light';
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = light ? '#1b2338' : '#e8ebf5';
    ctx.font = '700 20px Inter, sans-serif';
    ctx.fillText(fmtNum(total), x, y - 6);
    ctx.fillStyle = light ? '#5d6b84' : '#8a92a8';
    ctx.font = '500 10px Inter, sans-serif';
    ctx.fillText(chart.options.plugins.centerText?.label || '', x, y + 14);
    ctx.restore();
  }
};

function chartDefaults() {
  const light = document.documentElement.dataset.theme === 'light';
  Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
  Chart.defaults.color = light ? '#5d6b84' : '#8a92a8';
  Chart.defaults.borderColor = light ? 'rgba(15,23,42,0.07)' : 'rgba(255,255,255,0.06)';
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  Chart.defaults.plugins.legend.labels.boxWidth = 8;
  Chart.defaults.plugins.tooltip.backgroundColor = light ? '#ffffff' : '#141a2e';
  Chart.defaults.plugins.tooltip.titleColor = light ? '#1b2338' : '#e8ebf5';
  Chart.defaults.plugins.tooltip.bodyColor = light ? '#1b2338' : '#c6c9d4';
  Chart.defaults.plugins.tooltip.borderColor = 'rgba(99,102,241,0.4)';
  Chart.defaults.plugins.tooltip.borderWidth = 1;
}

function dona(id, labels, data, colors, centerLabel) {
  const host = $(id);
  if (!host) return;
  showChartHost(id);
  const ctx = host.getContext('2d');
  const existing = Chart.getChart(host);
  if (existing) existing.destroy();
  new Chart(ctx, {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 0, hoverOffset: 6 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: '68%',
      plugins: {
        legend: { position: 'right', labels: { padding: 14 } },
        centerText: { label: centerLabel }
      }
    },
    plugins: [centerText]
  });
}

function barChart(id, labels, datasets, opts = {}) {
  const host = $(id);
  if (!host) return;
  showChartHost(id);
  const ctx = host.getContext('2d');
  const existing = Chart.getChart(host);
  if (existing) existing.destroy();
  const light = document.documentElement.dataset.theme === 'light';
  const isH = opts.horizontal;
  new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      indexAxis: isH ? 'y' : 'x',
      plugins: {
        legend: opts.legend === false ? { display: false } : { position: 'top', labels: { padding: 12 } },
        tooltip: {
          callbacks: isH ? { label: c => ' ' + fmtNum(c.parsed.x) + (opts.tooltipUnit || '') } : undefined
        }
      },
      scales: {
        x: isH ? { grid: { display: false }, ticks: { font: { size: 10 } } } : { grid: { display: false }, stacked: opts.stacked },
        y: isH ? { grid: { color: light ? 'rgba(15,23,42,0.06)' : 'rgba(255,255,255,0.05)' }, ticks: { font: { size: 10 } }, stacked: opts.stacked }
            : { grid: { color: light ? 'rgba(15,23,42,0.06)' : 'rgba(255,255,255,0.05)' }, ticks: { font: { size: 10 } } }
      }
    }
  });
}

function lineChart(id, labels, data) {
  const host = $(id);
  if (!host) return;
  showChartHost(id);
  const ctx = host.getContext('2d');
  const existing = Chart.getChart(host);
  if (existing) existing.destroy();
  const grad = ctx.createLinearGradient(0, 0, 0, 320);
  grad.addColorStop(0, 'rgba(99,102,241,0.35)');
  grad.addColorStop(1, 'rgba(99,102,241,0.02)');
  new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data, borderColor: '#6366f1', backgroundColor: grad, fill: true,
        tension: 0.35, pointRadius: 0, pointHoverRadius: 4, borderWidth: 2
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 } } },
        y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { font: { size: 10 } } }
      }
    }
  });
}

function renderCharts() {
  const total = FILTERED.length;
  if (!total) {
    ['chartSync', 'chartCat', 'chartExt', 'chartPlaza', 'chartActivity', 'chartHeavy'].forEach(id => {
      renderEmpty(id, 'Sin datos con los filtros actuales');
    });
    return;
  }

  const syncCounts = ['Sincronizado', 'Sin referencia', 'Desactualizado'].map(k => FILTERED.filter(r => r.sync === k).length);
  dona('chartSync', ['Sincronizado', 'Sin referencia', 'Desactualizado'], syncCounts,
    [SYNC_COLORS.Sincronizado, SYNC_COLORS['Sin referencia'], SYNC_COLORS.Desactualizado], 'archivos');

  const cats = new Map();
  FILTERED.filter(r => r.centralCat).forEach(r => cats.set(r.centralCat, (cats.get(r.centralCat) || 0) + 1));
  const catArr = Array.from(cats.entries()).sort((a, b) => b[1] - a[1]);
  if (catArr.length) dona('chartCat', catArr.map(([k]) => k), catArr.map(([, v]) => v), PALETTE, 'archivos');
  else renderEmpty('chartCat', 'Sin catálogos centrales');

  const exts = new Map();
  FILTERED.forEach(r => exts.set(r.ext, (exts.get(r.ext) || 0) + 1));
  const extArr = Array.from(exts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
  barChart('chartExt', extArr.map(([k]) => k), [{
    label: 'Archivos', data: extArr.map(([, v]) => v),
    backgroundColor: 'rgba(99,102,241,0.7)', borderRadius: 6, maxBarThickness: 34
  }], { legend: false });

  const plazas = Array.from(new Set(FILTERED.map(r => r.plaza))).sort((a, b) => a.localeCompare(b, 'es'));
  const pCon = plazas.map(p => FILTERED.filter(r => r.plaza === p && r.hasRef).length);
  const pSin = plazas.map(p => FILTERED.filter(r => r.plaza === p && !r.hasRef).length);
  barChart('chartPlaza', plazas, [
    { label: 'Con referencia', data: pCon, backgroundColor: '#6366f1', borderRadius: 4, maxBarThickness: 30, stack: 'a' },
    { label: 'Sin referencia', data: pSin, backgroundColor: 'rgba(138,146,168,0.5)', borderRadius: 4, maxBarThickness: 30, stack: 'a' }
  ], { stacked: true });

  const days = [];
  const counts = [];
  const now = new Date();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now); d.setDate(now.getDate() - i); d.setHours(0, 0, 0, 0);
    const next = d.getTime() + 86400000;
    days.push(d.toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit' }));
    counts.push(FILTERED.filter(r => r.modDate !== -Infinity && r.modDate >= d.getTime() && r.modDate < next).length);
  }
  lineChart('chartActivity', days, counts);

  const heavy = new Map();
  FILTERED.forEach(r => heavy.set(r.archivo, (heavy.get(r.archivo) || 0) + (r.tamano_kb || 0)));
  const heavyArr = Array.from(heavy.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
  barChart('chartHeavy', heavyArr.map(([k]) => k), [{
    label: 'Tamaño (MB)', data: heavyArr.map(([, v]) => Math.round(v / 1024)),
    backgroundColor: 'rgba(34,211,238,0.65)', borderRadius: 6, maxBarThickness: 30
  }], { legend: false, tooltipUnit: ' MB' });
}

function renderEmpty(id, msg) {
  const host = $(id);
  if (!host) return;
  const existing = Chart.getChart(host);
  if (existing) existing.destroy();
  let note = host.parentElement.querySelector('.chart-card__empty');
  if (!note) {
    note = document.createElement('div');
    note.className = 'chart-card__empty';
    host.parentElement.appendChild(note);
  }
  note.textContent = msg;
  host.style.display = 'none';
}

function showChartHost(id) {
  const host = $(id);
  if (!host) return;
  host.style.display = '';
  const note = host.parentElement.querySelector('.chart-card__empty');
  if (note) note.remove();
}

function renderEquiposCharts() {
  const comps = summarizeComputers(FILTERED);
  const online = comps.filter(c => c.online).length;
  const offline = comps.length - online;
  dona('chartEqStatus', ['Online', 'Offline'], [online, offline], ['#34d399', '#f87171'], 'equipos');

  const plazas = Array.from(new Set(comps.map(c => c.plaza))).sort((a, b) => a.localeCompare(b, 'es'));
  barChart('chartEqPlaza', plazas, [
    { label: 'Online', data: plazas.map(p => comps.filter(c => c.plaza === p && c.online).length), backgroundColor: 'rgba(52,211,153,0.85)', borderRadius: 4, maxBarThickness: 26, stack: 'a' },
    { label: 'Offline', data: plazas.map(p => comps.filter(c => c.plaza === p && !c.online).length), backgroundColor: 'rgba(248,113,113,0.75)', borderRadius: 4, maxBarThickness: 26, stack: 'a' }
  ], { stacked: true });
}

function renderVendCharts(rows) {
  const comps = summarizeComputers(rows);
  const byPlaza = new Map();
  comps.forEach(c => byPlaza.set(c.plaza, (byPlaza.get(c.plaza) || 0) + 1));
  const arr = Array.from(byPlaza.entries()).sort((a, b) => b[1] - a[1]);
  if (arr.length) dona('chartVendPlaza', arr.map(([k]) => k), arr.map(([, v]) => v), PALETTE, 'equipos');
  else renderEmpty('chartVendPlaza', 'Sin datos');

  const files = new Map();
  rows.forEach(r => files.set(r.archivo, (files.get(r.archivo) || 0) + 1));
  const fArr = Array.from(files.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (fArr.length) barChart('chartVendFiles', fArr.map(([k]) => k), [{
    label: 'Archivos', data: fArr.map(([, v]) => v),
    backgroundColor: 'rgba(96,165,250,0.7)', borderRadius: 6, maxBarThickness: 24
  }], { legend: false, horizontal: true });
  else renderEmpty('chartVendFiles', 'Sin datos');
}

function renderCedisCharts(rows) {
  const byPlaza = new Map();
  rows.forEach(r => byPlaza.set(r.plaza, (byPlaza.get(r.plaza) || 0) + 1));
  const arr = Array.from(byPlaza.entries()).sort((a, b) => b[1] - a[1]);
  if (arr.length) dona('chartCedisPlaza', arr.map(([k]) => k), arr.map(([, v]) => v), PALETTE, 'archivos');
  else renderEmpty('chartCedisPlaza', 'Sin datos');

  const comps = summarizeComputers(rows).sort((a, b) => b.total - a.total);
  if (comps.length) barChart('chartCedisFiles', comps.map(c => c.computadora), [{
    label: 'Archivos', data: comps.map(c => c.total),
    backgroundColor: 'rgba(251,191,36,0.7)', borderRadius: 6, maxBarThickness: 26
  }], { legend: false, horizontal: true });
  else renderEmpty('chartCedisFiles', 'Sin datos');
}

/* ============================ Tablas ============================ */

function summarizeComputers(rows) {
  const map = new Map();
  for (const r of rows) {
    let c = map.get(r.computadora);
    if (!c) {
      c = { computadora: r.computadora, plaza: r.plaza, grupo: r.grupo, tipo: r.tipo, online: false, connDate: null, total: 0, conRef: 0, sync: 0, size: 0 };
      map.set(r.computadora, c);
    }
    c.total++;
    if (r.hasRef) c.conRef++;
    if (r.sync === 'Sincronizado') c.sync++;
    c.size += r.tamano_kb || 0;
    if (r.estado === 'online') c.online = true;
    if (r.connDate && (!c.connDate || r.connDate > c.connDate)) c.connDate = r.connDate;
  }
  return Array.from(map.values());
}

function badgeEstado(estado) {
  return estado === 'online'
    ? '<span class="badge badge--green">Online</span>'
    : '<span class="badge badge--red">Offline</span>';
}

function badgeSync(sync) {
  const cls = sync === 'Sincronizado' ? 'badge--green' : sync === 'Desactualizado' ? 'badge--red' : 'badge--muted';
  return '<span class="badge ' + cls + '">' + esc(sync) + '</span>';
}

function coverageBar(cov) {
  const cls = cov >= 90 ? 'var(--green)' : cov >= 50 ? 'var(--amber)' : 'var(--red)';
  return '<div class="coverage-cell"><div class="progress"><div class="progress__fill" style="width:' + cov.toFixed(1) + '%;background:linear-gradient(90deg,' + cls + ',' + cls + ')"></div></div>' +
    '<span class="coverage-pct">' + cov.toFixed(1) + '%</span></div>';
}

function renderPlazaTable() {
  const tbody = $('tblPlaza').querySelector('tbody');
  tbody.innerHTML = '';
  const plazas = Array.from(new Set(FILTERED.map(r => r.plaza))).sort((a, b) => a.localeCompare(b, 'es'));
  if (!plazas.length) { tbody.innerHTML = '<tr><td colspan="9" class="empty-hint">Sin datos</td></tr>'; clearTotals(); return; }
  const totals = { total: 0, conRef: 0, sync: 0, online: 0, offline: 0, size: 0 };
  plazas.forEach((p, i) => {
    const rows = FILTERED.filter(r => r.plaza === p);
    const total = rows.length;
    const conRef = rows.filter(r => r.hasRef).length;
    const sync = rows.filter(r => r.sync === 'Sincronizado').length;
    const online = rows.filter(r => r.estado === 'online').length;
    const offline = total - online;
    const size = rows.reduce((a, r) => a + (r.tamano_kb || 0), 0);
    totals.total += total; totals.conRef += conRef; totals.sync += sync; totals.online += online; totals.offline += offline; totals.size += size;
    const maxSize = Math.max(...FILTERED.map(r => r.tamano_kb || 0), 1);
    const tr = document.createElement('tr');
    tr.style.animationDelay = (i * 0.03) + 's';
    tr.innerHTML = '<td><b>' + esc(p) + '</b></td>' +
      '<td class="num"><b>' + fmtNum(total) + '</b></td>' +
      '<td class="num">' + fmtNum(conRef) + '</td>' +
      '<td class="num">' + fmtNum(sync) + '</td>' +
      '<td class="num">' + fmtNum(total - conRef) + '</td>' +
      '<td class="num">' + coverageBar((conRef / total) * 100) + '</td>' +
      '<td class="num" style="color:var(--green)">' + fmtNum(online) + '</td>' +
      '<td class="num" style="color:var(--red)">' + fmtNum(offline) + '</td>' +
      '<td class="num"><div class="size-bar"><span>' + fmtSize(size) + '</span><div class="size-bar__track"><div class="size-bar__fill" style="width:' + (size / maxSize * 100) + '%"></div></div></div></td>';
    tbody.appendChild(tr);
  });
  $('sumTotal').textContent = fmtNum(totals.total);
  $('sumConRef').textContent = fmtNum(totals.conRef);
  $('sumSync').textContent = fmtNum(totals.sync);
  $('sumSinRef').textContent = fmtNum(totals.total - totals.conRef);
  $('sumCover').textContent = (totals.total ? (totals.conRef / totals.total) * 100 : 0).toFixed(1) + '%';
  $('sumOnline').textContent = fmtNum(totals.online);
  $('sumOffline').textContent = fmtNum(totals.offline);
  $('sumSize').textContent = fmtSize(totals.size);
}

function clearTotals() {
  ['sumTotal', 'sumConRef', 'sumSync', 'sumSinRef', 'sumCover', 'sumOnline', 'sumOffline', 'sumSize'].forEach(id => { $(id).textContent = '—'; });
}

function renderRanking() {
  const tbody = $('tblComputers').querySelector('tbody');
  tbody.innerHTML = '';
  const comps = summarizeComputers(FILTERED).sort((a, b) => b.total - a.total).slice(0, 50);
  if (!comps.length) { tbody.innerHTML = '<tr><td colspan="9" class="empty-hint">Sin datos</td></tr>'; return; }
  comps.forEach((c, i) => {
    const cov = (c.conRef / c.total) * 100;
    const tr = document.createElement('tr');
    tr.style.animationDelay = (i * 0.02) + 's';
    tr.innerHTML = '<td class="num mono muted">' + (i + 1) + '</td>' +
      '<td><b>' + esc(c.computadora) + '</b></td>' +
      '<td>' + esc(c.plaza) + '</td>' +
      '<td><span class="badge ' + TIPO_BADGE[c.tipo] + '">' + TIPO_LABEL[c.tipo] + '</span></td>' +
      '<td class="num"><b>' + fmtNum(c.total) + '</b></td>' +
      '<td class="num">' + fmtNum(c.conRef) + '</td>' +
      '<td class="num">' + fmtNum(c.total - c.conRef) + '</td>' +
      '<td class="num" style="color:var(--green)">' + fmtNum(c.sync) + '</td>' +
      '<td>' + coverageBar(cov) + '</td>';
    tbody.appendChild(tr);
  });
}

function renderDetailTable() {
  const tbody = $('tblDetail').querySelector('tbody');
  const sorted = sortRows(FILTERED);
  const pages = Math.max(1, Math.ceil(sorted.length / state.perPage));
  if (state.page > pages) state.page = pages;
  const start = (state.page - 1) * state.perPage;
  const slice = sorted.slice(start, start + state.perPage);
  tbody.innerHTML = '';
  if (!slice.length) { tbody.innerHTML = '<tr><td colspan="11" class="empty-hint">Sin datos con los filtros actuales</td></tr>'; }
  slice.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.style.animationDelay = (i * 0.015) + 's';
    tr.innerHTML =
      '<td><b>' + esc(r.archivo) + '</b></td>' +
      '<td>' + esc(r.computadora) + '</td>' +
      '<td>' + esc(r.plaza) + '</td>' +
      '<td class="muted">' + esc(r.grupo) + '</td>' +
      '<td><span class="badge ' + TIPO_BADGE[r.tipo] + '">' + TIPO_LABEL[r.tipo] + '</span></td>' +
      '<td class="num"><div class="size-bar"><span>' + fmtSize(r.tamano_kb) + '</span><div class="size-bar__track"><div class="size-bar__fill" style="width:' + Math.min(100, (r.tamano_kb || 0) / 4000 * 100) + '%"></div></div></div></td>' +
      '<td>' + badgeSync(r.sync) + '</td>' +
      '<td>' + badgeEstado(r.estado) + '</td>' +
      '<td class="mono muted">' + esc(r.ultima_modificacion || '—') + '</td>' +
      '<td class="mono muted" title="' + esc(r.ruta_rbf || 'Sin referencia central') + '">' + (r.ruta_rbf ? esc(r.ruta_rbf) : '—') + '</td>' +
      '<td class="mono muted" title="' + esc(r.md5 || '') + '">' + esc((r.md5 || '—').slice(0, 12)) + '</td>';
    tbody.appendChild(tr);
  });
  const startNum = sorted.length ? start + 1 : 0;
  const endNum = Math.min(start + state.perPage, sorted.length);
  $('detailRange').textContent = 'Mostrando ' + startNum + '–' + endNum + ' de ' + fmtNum(sorted.length);
  $('pagerInfo').textContent = 'Página ' + state.page + ' de ' + pages;
  $('btnPrev').disabled = state.page <= 1;
  $('btnNext').disabled = state.page >= pages;
}

function sortRows(rows) {
  const dir = state.sortDir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => {
    let va, vb;
    switch (state.sortKey) {
      case 'tamano_kb': va = a.tamano_kb || 0; vb = b.tamano_kb || 0; break;
      case 'modDate': va = a.modDate; vb = b.modDate; break;
      case 'md5': va = a.md5 || ''; vb = b.md5 || ''; break;
      case 'sync': va = SYNC_ORDER[a.sync]; vb = SYNC_ORDER[b.sync]; break;
      case 'estado': va = a.estado; vb = b.estado; break;
      default: va = String(a[state.sortKey] ?? ''); vb = String(b[state.sortKey] ?? '');
    }
    if (va === vb) return 0;
    if (va === -Infinity) return 1;
    if (vb === -Infinity) return -1;
    return typeof va === 'number' ? (va - vb) * dir : String(va).localeCompare(String(vb), 'es') * dir;
  });
}

function bindSortables() {
  document.querySelectorAll('th.sortable[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      const isDetail = th.closest('#tblDetail') !== null;
      const s = isDetail ? state : { sortKey: state.eqSortKey, sortDir: state.eqSortDir };
      if (s.sortKey === key) s.sortDir = s.sortDir === 'asc' ? 'desc' : 'asc';
      else { s.sortKey = key; s.sortDir = 'asc'; }
      if (isDetail) { state.page = 1; renderDetailTable(); } else { renderEquiposTable(); }
      updateSortArrows();
    });
  });
}

function updateSortArrows() {
  document.querySelectorAll('th.sortable[data-sort]').forEach(th => {
    const key = th.dataset.sort;
    const isDetail = th.closest('#tblDetail') !== null;
    const s = isDetail ? state : { sortKey: state.eqSortKey, sortDir: state.eqSortDir };
    const on = s.sortKey === key;
    th.classList.toggle('is-sorted', on);
    const arrow = th.querySelector('.sort-arrow');
    if (arrow) arrow.textContent = on ? (s.sortDir === 'asc' ? '▲' : '▼') : '';
  });
}

function renderEquiposTable() {
  const tbody = $('tblEquipos').querySelector('tbody');
  const comps = summarizeComputers(FILTERED);
  const dir = state.eqSortDir === 'asc' ? 1 : -1;
  comps.sort((a, b) => {
    let va, vb;
    switch (state.eqSortKey) {
      case 'total': case 'conRef': case 'sync': case 'size': va = a[state.eqSortKey]; vb = b[state.eqSortKey]; break;
      case 'connDate': va = a.connDate || -Infinity; vb = b.connDate || -Infinity; break;
      case 'estado': va = a.online ? 1 : 0; vb = b.online ? 1 : 0; break;
      default: va = String(a[state.eqSortKey] ?? ''); vb = String(b[state.eqSortKey] ?? '');
    }
    if (va === vb) return 0;
    if (va === -Infinity) return 1;
    if (vb === -Infinity) return -1;
    return typeof va === 'number' ? (va - vb) * dir : String(va).localeCompare(String(vb), 'es') * dir;
  });
  tbody.innerHTML = '';
  if (!comps.length) { tbody.innerHTML = '<tr><td colspan="11" class="empty-hint">Sin datos</td></tr>'; return; }
  const maxTotal = Math.max(...comps.map(c => c.total), 1);
  comps.forEach((c, i) => {
    const cov = (c.conRef / c.total) * 100;
    const tr = document.createElement('tr');
    tr.style.animationDelay = (i * 0.005) + 's';
    tr.innerHTML =
      '<td><b>' + esc(c.computadora) + '</b></td>' +
      '<td>' + esc(c.plaza) + '</td>' +
      '<td class="muted">' + esc(c.grupo) + '</td>' +
      '<td><span class="badge ' + TIPO_BADGE[c.tipo] + '">' + TIPO_LABEL[c.tipo] + '</span></td>' +
      '<td>' + badgeEstado(c.online ? 'online' : 'offline') + '</td>' +
      '<td class="mono muted">' + (c.connDate ? new Date(c.connDate).toLocaleString('es-MX', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' <span style="opacity:.7">(' + timeAgo(c.connDate) + ')</span>' : '—') + '</td>' +
      '<td class="num"><b>' + fmtNum(c.total) + '</b><div class="progress" style="margin-top:4px"><div class="progress__fill" style="width:' + (c.total / maxTotal * 100) + '%"></div></div></td>' +
      '<td class="num" style="color:var(--green)">' + fmtNum(c.sync) + '</td>' +
      '<td class="num">' + fmtNum(c.conRef) + '</td>' +
      '<td>' + coverageBar(cov) + '</td>' +
      '<td class="num">' + fmtSize(c.size) + '</td>';
    tbody.appendChild(tr);
  });
}

function renderTipoTable(tblId, rows) {
  const tbody = $(tblId).querySelector('tbody');
  tbody.innerHTML = '';
  const comps = summarizeComputers(rows).sort((a, b) => b.total - a.total);
  if (!comps.length) { tbody.innerHTML = '<tr><td colspan="10" class="empty-hint">Sin datos</td></tr>'; return; }
  const maxTotal = Math.max(...comps.map(c => c.total), 1);
  comps.forEach((c, i) => {
    const cov = (c.conRef / c.total) * 100;
    const tr = document.createElement('tr');
    tr.style.animationDelay = (i * 0.02) + 's';
    tr.innerHTML =
      '<td><b>' + esc(c.computadora) + '</b></td>' +
      '<td>' + esc(c.plaza) + '</td>' +
      '<td class="muted">' + esc(c.grupo) + '</td>' +
      '<td>' + badgeEstado(c.online ? 'online' : 'offline') + '</td>' +
      '<td class="num"><b>' + fmtNum(c.total) + '</b><div class="progress" style="margin-top:4px"><div class="progress__fill" style="width:' + (c.total / maxTotal * 100) + '%"></div></div></td>' +
      '<td class="num">' + fmtNum(c.conRef) + '</td>' +
      '<td class="num">' + fmtNum(c.total - c.conRef) + '</td>' +
      '<td class="num" style="color:var(--green)">' + fmtNum(c.sync) + '</td>' +
      '<td>' + coverageBar(cov) + '</td>' +
      '<td class="num">' + fmtSize(c.size) + '</td>';
    tbody.appendChild(tr);
  });
}

/* ============================ Mapas de calor ============================ */

function buildMatrix(rows, rowKey, colKey, metric) {
  const cell = new Map(), rowsM = new Map(), colsM = new Map();
  let max = 0;
  for (const r of rows) {
    const rk = String(r[rowKey] ?? 'N/A');
    const ck = String(r[colKey] ?? 'N/A');
    const key = rk + '\u0000' + ck;
    const v = cell.get(key) || 0;
    const add = metric === 'size' ? (r.tamano_kb || 0) : 1;
    cell.set(key, v + add);
    rowsM.set(rk, (rowsM.get(rk) || 0) + add);
    colsM.set(ck, (colsM.get(ck) || 0) + add);
    if (v + add > max) max = v + add;
  }
  return { cell, rows: rowsM, cols: colsM, max };
}

function renderHeatmap(hostId, hintId, rowOrder, colOrder, mat, colorByCol, metric) {
  const host = $(hostId);
  const hint = $(hintId);
  hint.textContent = metric === 'size' ? 'Celda = tamaño (KB acumulado)' : 'Celda = cantidad de archivos';
  host.innerHTML = '';
  if (!rowOrder.length || !colOrder.length) { host.innerHTML = '<span class="panel__hint">Sin datos con los filtros actuales</span>'; return; }

  const display = v => metric === 'size' ? fmtSize(v) : fmtNum(v);
  const cellBg = (hex, v) => {
    if (!v) return 'transparent';
    const a = Math.max(0.08, Math.pow(v / mat.max, 0.7) * 0.9);
    return 'rgba(' + hex.r + ',' + hex.g + ',' + hex.b + ',' + a.toFixed(2) + ')';
  };

  const head = document.createElement('div');
  head.className = 'heatmap__row';
  head.appendChild(Object.assign(document.createElement('div'), { className: 'heatmap__cell heatmap__cell--corner' }));
  for (const ck of colOrder) {
    const d = document.createElement('div');
    d.className = 'heatmap__cell heatmap__cell--head';
    d.textContent = ck;
    d.title = ck + ' · total ' + display(mat.cols.get(ck) || 0);
    head.appendChild(d);
  }
  host.appendChild(head);

  for (const rk of rowOrder) {
    const row = document.createElement('div');
    row.className = 'heatmap__row';
    const lab = document.createElement('div');
    lab.className = 'heatmap__cell heatmap__cell--label';
    lab.innerHTML = esc(rk) + ' <span class="heatmap__total">' + display(mat.rows.get(rk) || 0) + '</span>';
    lab.title = rk + ' · total ' + display(mat.rows.get(rk) || 0);
    row.appendChild(lab);
    for (const ck of colOrder) {
      const v = mat.cell.get(rk + '\u0000' + ck) || 0;
      const col = colorByCol[ck] || colorByCol._;
      const d = document.createElement('div');
      d.className = 'heatmap__cell';
      d.textContent = display(v);
      d.style.background = cellBg(col, v);
      d.title = rk + ' × ' + ck + ': ' + display(v) + (metric === 'size' ? '' : ' archivos');
      if (!v) d.classList.add('heatmap__cell--zero');
      row.appendChild(d);
    }
    host.appendChild(row);
  }
}

function renderHeatmaps() {
  const metric = state.heatMetric;
  if (!FILTERED.length) {
    ['hmSync', 'hmGrupo', 'hmArchivo'].forEach(id => { $(id).innerHTML = '<span class="panel__hint">Sin datos</span>'; });
    return;
  }

  const plazasSorted = arr => Array.from(arr.entries()).sort((a, b) => b[1] - a[1]).map(([k]) => k);

  const mSync = buildMatrix(FILTERED, 'plaza', 'sync', metric);
  const syncOrder = ['Sincronizado', 'Sin referencia', 'Desactualizado'];
  renderHeatmap('hmSync', 'hmSyncHint', plazasSorted(mSync.rows), syncOrder, mSync, {
    'Sincronizado': RGB.green, 'Sin referencia': RGB.gray, 'Desactualizado': RGB.red
  }, metric);

  const mGrupo = buildMatrix(FILTERED, 'plaza', 'grupo', metric);
  const gruposTop = Array.from(mGrupo.cols.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k]) => k);
  renderHeatmap('hmGrupo', 'hmGrupoHint', plazasSorted(mGrupo.rows), gruposTop, mGrupo, { _: RGB.indigo }, metric);

  const mArch = buildMatrix(FILTERED, 'archivo', 'plaza', metric);
  const archTop = Array.from(mArch.rows.entries()).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k]) => k);
  const plazasOrder = Array.from(mArch.cols.entries()).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  renderHeatmap('hmArchivo', 'hmArchivoHint', archTop, plazasOrder, mArch, { _: RGB.cyan }, metric);
}

/* ============================ Vista Plazas (por tienda) ============================ */

function fileShort(name) {
  const i = String(name).lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

function chipsHtml(label, val, tone) {
  return '<span class="sync-chip' + (tone ? ' sync-chip--' + tone : '') + '">' + esc(label) + ' <b>' + val + '</b></span>';
}

function renderPlazaSidebar() {
  const list = $('plazaList');
  if (!list) return;
  const byPlaza = new Map();
  for (const r of FILTERED) {
    let comps = byPlaza.get(r.plaza);
    if (!comps) { comps = new Map(); byPlaza.set(r.plaza, comps); }
    let c = comps.get(r.computadora);
    if (!c) { c = { online: false }; comps.set(r.computadora, c); }
    if (r.estado === 'online') c.online = true;
  }

  const q = (state.plazaQuery || '').toLowerCase();
  const plazas = Array.from(byPlaza.entries())
    .map(([plaza, comps]) => {
      const arr = Array.from(comps.values());
      return { plaza, tiendas: arr.length, online: arr.filter(c => c.online).length };
    })
    .filter(p => !q || p.plaza.toLowerCase().includes(q))
    .sort((a, b) => b.tiendas - a.tiendas || a.plaza.localeCompare(b.plaza, 'es'));

  $('plazaCount').textContent = byPlaza.size ? byPlaza.size + ' plazas' : '—';

  if (!plazas.length) {
    list.innerHTML = '<div class="plaza-empty">Sin plazas con los filtros actuales</div>';
    return;
  }

  if (!state.plazaSel || !byPlaza.has(state.plazaSel)) {
    state.plazaSel = plazas[0].plaza;
    try { localStorage.setItem('dbf-plaza', state.plazaSel); } catch (e) {}
  }

  list.innerHTML = plazas.map(p => {
    const off = p.tiendas - p.online;
    const meta = '<span class="plaza-dot plaza-dot--on"></span>' + p.online +
      (off ? '<span class="plaza-dot plaza-dot--off"></span><span class="plaza-btn__off">' + off + '</span>' : '');
    return '<button type="button" class="plaza-btn' + (p.plaza === state.plazaSel ? ' is-active' : '') + '" data-plaza="' + esc(p.plaza) + '" title="' + esc(p.plaza) + ' · ' + p.online + ' en línea, ' + off + ' sin conexión">' +
      '<span class="plaza-btn__name">' + esc(p.plaza) + '</span>' +
      '<span class="plaza-btn__meta">' + meta + '</span>' +
    '</button>';
  }).join('');

  list.querySelectorAll('.plaza-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.plazaSel = btn.dataset.plaza;
      try { localStorage.setItem('dbf-plaza', state.plazaSel); } catch (e) {}
      renderPlazaSidebar();
      renderSyncView();
    });
  });
}

function centralCatalogs(rows) {
  const map = new Map();
  for (const r of rows) if (r.hasRef) map.set(r.archivo, (map.get(r.archivo) || 0) + 1);
  return Array.from(map.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es')).map(e => e[0]);
}

function renderSyncView() {
  const tbl = $('tblSync');
  if (!tbl) return;
  const head = tbl.querySelector('thead');
  const body = tbl.querySelector('tbody');

  if (!state.plazaSel) { head.innerHTML = ''; body.innerHTML = ''; $('syncPlazaHead').innerHTML = ''; return; }

  const rows = FILTERED.filter(r => r.plaza === state.plazaSel);
  const comps = summarizeComputers(rows);

  let files;
  if (state.syncMode === 'todos') {
    const map = new Map();
    for (const r of rows) map.set(r.archivo, (map.get(r.archivo) || 0) + 1);
    files = Array.from(map.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es')).map(e => e[0]);
    if (files.length > 40) files = files.slice(0, 40);
  } else {
    files = centralCatalogs(rows);
  }

  const online = comps.filter(c => c.online).length;
  const off = comps.length - online;
  const vend = comps.filter(c => c.tipo === 'vendedor').length;
  const ced = comps.filter(c => c.tipo === 'cedis').length;
  $('syncPlazaHead').innerHTML =
    chipsHtml('Tiendas', comps.length) +
    chipsHtml('Online', online, 'ok') +
    chipsHtml('Offline', off, 'err') +
    (vend ? chipsHtml('Vendedores', vend) : '') +
    (ced ? chipsHtml('CEDIS', ced) : '') +
    chipsHtml('Archivos', rows.length);

  head.innerHTML = '<tr><th class="col-store">Tienda</th>' +
    files.map(f => '<th title="' + esc(f) + '">' + esc(fileShort(f)) + '</th>').join('') + '</tr>';

  const byComp = new Map();
  for (const r of rows) {
    if (!files.includes(r.archivo)) continue;
    let m = byComp.get(r.computadora);
    if (!m) { m = new Map(); byComp.set(r.computadora, m); }
    if (!m.has(r.archivo)) m.set(r.archivo, r);
  }

  const groups = [
    { key: 'tienda', label: 'Sucursales' },
    { key: 'vendedor', label: 'Vendedores' },
    { key: 'cedis', label: 'CEDIS' }
  ];
  const sortedComps = comps.slice().sort((a, b) => (b.online - a.online) || a.computadora.localeCompare(b.computadora, 'es'));
  const nCols = files.length + 1;

  let html = '';
  for (const g of groups) {
    const members = sortedComps.filter(c => c.tipo === g.key);
    if (!members.length) continue;
    html += '<tr class="sync-tipo-row"><td colspan="' + nCols + '">' + g.label + ' · ' + members.length + '</td></tr>';
    for (const c of members) {
      const m = byComp.get(c.computadora) || new Map();
      const connTitle = (c.online ? 'En línea' : 'Sin conexión') + (c.connDate ? ' · última conexión ' + new Date(c.connDate).toLocaleString('es-MX') : '');
      html += '<tr class="is-clickable" data-comp="' + esc(c.computadora) + '">' +
        '<td class="col-store" title="' + esc(c.computadora) + ' — clic para ver el detalle">' +
          '<span class="store-name"><i class="conn-dot conn-dot--' + (c.online ? 'on' : 'off') + '" title="' + connTitle + '"></i>' + esc(c.computadora) + '</span>' +
          '<span class="store-sub">' + TIPO_LABEL[c.tipo] + (c.grupo ? ' · ' + c.grupo : '') + '</span>' +
        '</td>' +
        files.map(f => {
          const r = m.get(f);
          if (!r) return '<td class="num" title="No reportado"><i class="sync-light sync-light--blank"></i></td>';
          const cls = r.sync === 'Sincronizado' ? 'ok' : r.sync === 'Desactualizado' ? 'err' : 'ref';
          return '<td class="num" title="' + esc(f + ' · ' + r.sync + (r.hasRef ? ' · ' + r.md5 : '')) + '"><i class="sync-light sync-light--' + cls + '"></i></td>';
        }).join('') +
      '</tr>';
    }
  }
  body.innerHTML = html;

  body.querySelectorAll('tr.is-clickable').forEach(tr => {
    tr.addEventListener('click', () => openSyncModal(tr.dataset.comp));
  });
}

function openSyncModal(computadora) {
  const rows = FILTERED.filter(r => r.computadora === computadora);
  if (!rows.length) return;
  const comp = summarizeComputers(rows)[0];
  $('syncModalTitle').textContent = computadora;
  $('syncModalSub').textContent =
    (comp.plaza || '—') + ' · ' + TIPO_LABEL[comp.tipo] +
    (comp.online ? ' · En línea' : ' · Sin conexión') +
    (comp.connDate ? ' · Última conexión: ' + new Date(comp.connDate).toLocaleString('es-MX') : '') +
    ' · ' + rows.length + ' archivos';

  const sorted = rows.slice().sort((a, b) => {
    const sa = SYNC_ORDER[a.sync] ?? 1, sb = SYNC_ORDER[b.sync] ?? 1;
    return sa - sb || a.archivo.localeCompare(b.archivo, 'es');
  });
  $('tblModal').querySelector('tbody').innerHTML = sorted.map(r => {
    const cls = r.sync === 'Sincronizado' ? 'badge--green' : r.sync === 'Desactualizado' ? 'badge--red' : 'badge--amber';
    return '<tr>' +
      '<td class="mono">' + esc(r.archivo) + '</td>' +
      '<td><span class="badge ' + cls + '">' + esc(r.sync) + '</span></td>' +
      '<td class="num">' + fmtSize(r.tamano_kb) + '</td>' +
      '<td class="mono">' + esc(r.ultima_modificacion || '—') + '</td>' +
      '<td class="mono" title="' + esc(r.md5 || '') + '">' + esc(r.md5 || '—') + '</td>' +
      '<td class="mono" title="' + esc(r.hash_rbf || '') + '">' + esc(r.hash_rbf || '—') + '</td>' +
      '<td class="mono" title="' + esc(r.ruta_rbf || '') + '">' + esc(r.ruta_rbf || '—') + '</td>' +
    '</tr>';
  }).join('');

  $('syncModal').classList.add('is-open');
  document.body.style.overflow = 'hidden';
}

function closeSyncModal() {
  $('syncModal').classList.remove('is-open');
  document.body.style.overflow = '';
}

/* ============================ Filtros activos ============================ */

function addChip(host, label, value, onRemove) {
  const chip = document.createElement('span');
  chip.className = 'active-chip';
  chip.innerHTML = '<b>' + esc(label) + '</b><span class="active-chip__x" title="Quitar filtro">✕</span>';
  chip.querySelector('.active-chip__x').addEventListener('click', () => { onRemove(value); applyFilters(); });
  host.appendChild(chip);
}

function renderActiveFilters() {
  const host = $('activeFilters');
  host.innerHTML = '';
  let any = false;
  for (const [key, label] of [['plaza', 'Plaza'], ['grupo', 'Grupo'], ['computadora', 'Sucursal'], ['archivo', 'Archivo']]) {
    state.selected[key].forEach(v => { any = true; addChip(host, label, v, () => state.selected[key].delete(v)); });
  }
  state.sync.forEach(v => { any = true; addChip(host, 'Sync', v, () => state.sync.delete(v)); });
  state.online.forEach(v => { any = true; addChip(host, 'Estado', v === 'online' ? 'Online' : 'Offline', () => state.online.delete(v)); });
  state.tipo.forEach(v => { any = true; addChip(host, 'Tipo', TIPO_LABEL[v], () => state.tipo.delete(v)); });
  state.cat.forEach(v => { any = true; addChip(host, 'Catálogo', v, () => state.cat.delete(v)); });
  state.ext.forEach(v => { any = true; addChip(host, 'Ext', v, () => state.ext.delete(v)); });
  if (state.query) { any = true; addChip(host, 'Buscar', state.query, () => { state.query = ''; $('searchQuery').value = ''; }); }
  if (state.minSize !== null && state.minSize !== '') { any = true; addChip(host, 'Min', fmtNum(+state.minSize) + ' KB', () => { state.minSize = null; $('minSize').value = ''; }); }
  if (state.maxSize !== null && state.maxSize !== '') { any = true; addChip(host, 'Max', fmtNum(+state.maxSize) + ' KB', () => { state.maxSize = null; $('maxSize').value = ''; }); }
  if (state.fromDate) { any = true; addChip(host, 'Desde', state.fromDate, () => { state.fromDate = null; $('fromDate').value = ''; }); }
  if (state.toDateEnd) { any = true; addChip(host, 'Hasta', state.toDateEnd, () => { state.toDateEnd = null; $('toDate').value = ''; }); }
  if (!any) host.innerHTML = '<span class="empty-hint">Sin filtros — mostrando todos los datos</span>';
}

/* ============================ Render global ============================ */

function renderAll() {
  renderKPIs();
  renderCharts();
  renderPlazaTable();
  renderRanking();
  renderDetailTable();
  renderEquiposKPIs();
  renderEquiposCharts();
  renderEquiposTable();
  renderHeatmaps();
  renderPlazaSidebar();
  renderSyncView();
  const vendRows = FILTERED.filter(r => r.tipo === 'vendedor');
  renderVendedoresKPIs(vendRows);
  renderVendCharts(vendRows);
  renderTipoTable('tblVendedores', vendRows);
  const cedRows = FILTERED.filter(r => r.tipo === 'cedis');
  renderCedisKPIs(cedRows);
  renderCedisCharts(cedRows);
  renderTipoTable('tblCedis', cedRows);
  updateSortArrows();
}

/* ============================ Export CSV ============================ */

function exportCSV() {
  if (!FILTERED.length) { toast('No hay datos para exportar', true); return; }
  const cols = ['archivo', 'computadora', 'plaza', 'grupo', 'tipo', 'estado', 'ultima_conexion', 'tamano_kb', 'ultima_modificacion', 'md5', 'estado_archivo', 'sincronizacion', 'ruta_rbf', 'hash_rbf'];
  const head = cols.join(',');
  const body = FILTERED.map(r => cols.map(c => {
    const v = c === 'sincronizacion' ? r.sync : c === 'tipo' ? TIPO_LABEL[r.tipo] : r[c];
    const s = String(v ?? '');
    return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + head + '\n' + body], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  a.href = URL.createObjectURL(blob);
  a.download = 'reporte-dbf-' + ts + '.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 500);
  toast('CSV exportado (' + fmtNum(FILTERED.length) + ' registros)');
}

/* ============================ Carga de datos ============================ */

async function loadData(initial) {
  const loader = $('loader');
  const btn = $('btnRefresh');
  if (initial) loader.classList.remove('is-hidden');
  btn.classList.add('is-loading', 'is-refreshing');
  btn.disabled = true;
  $('lastUpdate').textContent = 'Actualizando…';
  try {
    const res = await fetch(API_URL);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    DATA = (json.data || []).map(enrich);
    buildFilterOptions();
    if (initial) { resetFilters(); try { const t = localStorage.getItem('dbf-tab'); if (t) switchTab(t); } catch (e) {} }
    applyFilters();
    markLoaded(initial);
  } catch (e) {
    console.error('Error cargando datos:', e);
    if (initial) {
      $('kpiGrid').innerHTML = '<div class="panel" style="grid-column:1/-1"><h3 class="panel__title" style="color:var(--red)">No se pudo conectar con el origen de datos</h3><p class="panel__desc">' + esc(e.message) + '</p><p class="panel__desc">Verifica la conexión y pulsa “Refrescar”.</p></div>';
      $('resultCount').textContent = '— registros';
    } else {
      $('lastUpdate').textContent = 'Última actualización ' + new Date().toLocaleTimeString('es-MX') + ' (falló el refresco)';
    }
    toast('No se pudieron obtener los datos: ' + e.message, true);
  } finally {
    if (initial) loader.classList.add('is-hidden');
    btn.classList.remove('is-loading', 'is-refreshing');
    btn.disabled = false;
  }
}

function markLoaded(initial) {
  const now = new Date();
  $('lastUpdate').textContent = (initial ? '' : 'Actualizado ') + now.toLocaleTimeString('es-MX');
  $('footerTime').textContent = 'Reporte del ' + now.toLocaleDateString('es-MX') + ' · ' + fmtNum(DATA.length) + ' registros';
  nextRefreshAt = Date.now() + REFRESH_MS;
  if (!autoTimer) autoTimer = setInterval(() => loadData(false), REFRESH_MS);
  toast((initial ? 'Datos cargados: ' : 'Datos actualizados: ') + fmtNum(DATA.length) + ' registros');
}

/* ============================ Tema ============================ */

function applyTheme(theme, persist) {
  const t = theme || document.documentElement.dataset.theme || 'dark';
  document.documentElement.dataset.theme = t;
  if (persist) { try { localStorage.setItem('dbf-theme', t); } catch (e) {} }
  chartDefaults();
  renderAll();
}

/* ============================ Tabs ============================ */

function switchTab(name) {
  activeTab = name;
  document.querySelectorAll('.tab-btn').forEach(b => {
    const on = b.dataset.tab === name;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('is-active', p.id === 'tab-' + name));
  try { localStorage.setItem('dbf-tab', name); } catch (e) {}
}

/* ============================ UI bindings ============================ */

function bindUI() {
  document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  document.addEventListener('click', e => {
    if (!e.target.closest('.ms')) closeAllMenus();
  });

  $('searchQuery').addEventListener('input', e => { state.query = e.target.value.trim(); state.page = 1; applyFilters(); });
  $('minSize').addEventListener('input', e => { state.minSize = e.target.value; state.page = 1; applyFilters(); });
  $('maxSize').addEventListener('input', e => { state.maxSize = e.target.value; state.page = 1; applyFilters(); });
  $('fromDate').addEventListener('change', e => { state.fromDate = e.target.value || null; state.page = 1; applyFilters(); });
  $('toDate').addEventListener('change', e => { state.toDateEnd = e.target.value || null; state.page = 1; applyFilters(); });
  $('perPage').addEventListener('change', e => { state.perPage = +e.target.value; state.page = 1; renderDetailTable(); });
  $('btnPrev').addEventListener('click', () => { if (state.page > 1) { state.page--; renderDetailTable(); } });
  $('btnNext').addEventListener('click', () => { state.page++; renderDetailTable(); });
  $('btnClearAll').addEventListener('click', () => { resetFilters(); buildFilterOptions(); syncChipUI(); applyFilters(); });
  $('btnRefresh').addEventListener('click', () => loadData(false));
  $('btnExport').addEventListener('click', exportCSV);
  $('btnTheme').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(cur, true);
  });
  $('heatMetric').addEventListener('change', e => { state.heatMetric = e.target.value; renderHeatmaps(); });

  $('plazaSearch').addEventListener('input', e => { state.plazaQuery = e.target.value.trim(); renderPlazaSidebar(); });
  $('syncMode').addEventListener('change', e => { state.syncMode = e.target.value; renderSyncView(); });
  $('syncModalClose').addEventListener('click', closeSyncModal);
  $('syncModal').addEventListener('click', e => { if (e.target === $('syncModal')) closeSyncModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSyncModal(); });

  bindSortables();
  setInterval(() => {
    const now = new Date();
    $('clock').textContent = now.toLocaleTimeString('es-MX');
    const remain = Math.max(0, nextRefreshAt - Date.now());
    const mm = String(Math.floor(remain / 60000)).padStart(2, '0');
    const ss = String(Math.floor((remain % 60000) / 1000)).padStart(2, '0');
    $('nextRefresh').textContent = 'Auto-refresco en ' + mm + ':' + ss;
  }, 1000);
}

/* ============================ Init ============================ */

function init() {
  if (!document.documentElement.dataset.theme) document.documentElement.dataset.theme = 'dark';
  chartDefaults();
  bindUI();
  try {
    const tab = localStorage.getItem('dbf-tab');
    if (tab) switchTab(tab);
    const p = localStorage.getItem('dbf-plaza');
    if (p) state.plazaSel = p;
  } catch (e) {}
  loadData(true);
}

document.addEventListener('DOMContentLoaded', init);
