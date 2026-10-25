/* ============================================================
   AeroAtlas — global airport atlas
   Vanilla JS + MapLibre GL. Airport data © OurAirports.
   ============================================================ */
(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const DATA = window.AERO_DATA;
  const BASEMAP = window.AERO_BASEMAP;
  const loader = $('#loader');
  const loaderStatus = $('#loaderStatus');

  function fatal(message) {
    if (!loader) return;
    loader.classList.add('error');
    if (loaderStatus) loaderStatus.textContent = message;
  }

  if (!DATA || !DATA.airports) { fatal('机场数据加载失败，请检查 data/airports.js'); return; }
  if (!BASEMAP) { fatal('底图数据加载失败，请检查 data/basemap.js'); return; }
  if (!window.AERO_BASEMAP_STYLE) { fatal('底图样式加载失败，请检查 data/basemap-style.js'); return; }
  if (!window.maplibregl) { fatal('地图引擎加载失败，请检查 vendor/maplibregl.js'); return; }

  const ERRORS = [];
  window.__AERO_ERRORS__ = ERRORS;
  window.addEventListener('error', (event) => {
    ERRORS.push('window: ' + (event.message || 'unknown'));
  });
  window.addEventListener('unhandledrejection', (event) => {
    ERRORS.push('promise: ' + ((event.reason && event.reason.message) || event.reason));
  });

  /* ----------------------------------------------------------
     Data
     ---------------------------------------------------------- */
  const AIRPORTS = DATA.airports;
  const META = DATA.meta;

  const TYPE_INFO = {
    1: { label: '大型机场', en: 'LARGE AIRPORT', color: '#eaf7ff' },
    2: { label: '中型机场', en: 'MEDIUM AIRPORT', color: '#9fc7ee' },
    3: { label: '小型机场', en: 'SMALL AIRPORT', color: '#6f8dab' },
    4: { label: '水上基地', en: 'SEAPLANE BASE', color: '#65e0c9' },
    5: { label: '直升机场', en: 'HELIPORT', color: '#c2a6ff' }
  };

  const SURFACE_LABEL = {
    ASP: '沥青', CON: '混凝土', GRS: '草地', WTR: '水面',
    GRV: '砾石', DRT: '泥土', SND: '沙地', SNO: '冰雪', UNK: '未知'
  };

  const POPULAR = ['KJFK', 'EGLL', 'ZBAA', 'RJTT', 'OMDB', 'KLAX', 'YSSY', 'EDDF'];
  const FAV_KEY = 'aeroatlas.favorites.v2';
  const RECENT_KEY = 'aeroatlas.recent.v1';

  const norm = (value) => String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));

  const countryOf = (iso) => META.countries[iso] || iso || '未知';
  const cityLine = (a) => (a[2] ? a[2] + ', ' + countryOf(a[3]) : countryOf(a[3]));

  const byCode = new Map();
  const searchRows = new Array(AIRPORTS.length);
  for (let i = 0; i < AIRPORTS.length; i += 1) {
    const a = AIRPORTS[i];
    byCode.set(a[0], a);
    searchRows[i] = {
      a,
      code: a[0],
      iata: a[6] || '',
      type: a[4],
      nameN: norm(a[1]),
      cityN: norm(a[2]),
      countryN: norm(countryOf(a[3])),
      rank: (a[4] === 1 ? 100000 : a[4] === 2 ? 50000 : 0) +
        (a[9] ? 30000 : 0) +
        (a[6] ? 10000 : 0) +
        Math.min((a[10] || []).length, 4) * 1000 +
        (((a[10] && a[10][0] && a[10][0][2]) || 0))
    };
  }

  function readStore(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : fallback;
    } catch (err) {
      return fallback;
    }
  }

  function writeStore(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (err) { /* private mode */ }
  }

  let favOrder = readStore(FAV_KEY, []).filter((code) => byCode.has(code));
  const favSet = new Set(favOrder);
  let recent = readStore(RECENT_KEY, []).filter((code) => byCode.has(code));
  let favOnly = false;
  let authAvailable = false;
  let authUser = null;
  let authBusy = false;
  let authTab = 'login';
  let accountSyncTimer = 0;

  // One-time local seed generated from 机场24.docx. Public deployments are
  // excluded so visitors do not inherit the owner's personal collection.
  let seededFavoriteCount = 0;
  const AIRPORTS24_SEED_KEY = 'aeroatlas.seed.airports24.v1';
  const seedHost = window.location.hostname;
  const isLocalOrigin = window.location.protocol === 'file:' ||
    seedHost === 'localhost' || seedHost === '127.0.0.1' ||
    /^10\./.test(seedHost) || /^192\.168\./.test(seedHost) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(seedHost);

  const cloudConfig = window.AERO_CLOUD && window.AERO_CLOUD.enabled ? window.AERO_CLOUD : null;
  let cloud = null;
  if (cloudConfig && cloudConfig.url && cloudConfig.key &&
      window.supabase && typeof window.supabase.createClient === 'function') {
    try {
      cloud = window.supabase.createClient(cloudConfig.url, cloudConfig.key, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true
        }
      });
    } catch (err) {
      cloud = null;
    }
  }
  const cloudEnabled = !!cloud;

  if (isLocalOrigin && Array.isArray(window.AERO_AIRPORTS24)) {
    let alreadySeeded = false;
    try { alreadySeeded = localStorage.getItem(AIRPORTS24_SEED_KEY) === '1'; } catch (err) { /* ignore */ }
    if (!alreadySeeded) {
      window.AERO_AIRPORTS24.forEach((code) => {
        if (byCode.has(code) && !favSet.has(code)) {
          favSet.add(code);
          favOrder.push(code);
          seededFavoriteCount += 1;
        }
      });
      writeStore(FAV_KEY, favOrder);
      try { localStorage.setItem(AIRPORTS24_SEED_KEY, '1'); } catch (err) { /* ignore */ }
    }
  }

  const state = {
    selected: null,
    hoverId: null,
    mapReady: false,
    results: [],
    activeIndex: -1,
    panelOpen: false,
    types: new Set([1, 2, 3, 4, 5]),
    lastPointer: null
  };

  /* Elements */
  const els = {
    sidebar: $('#sidebar'),
    card: $('#airportCard'),
    cardClose: $('#cardClose'),
    cardFav: $('#cardFav'),
    cardCopy: $('#cardCopy'),
    searchInput: $('#searchInput'),
    searchClear: $('#searchClear'),
    searchPanel: $('#searchPanel'),
    searchWrap: $('#searchWrap'),
    favList: $('#favList'),
    favCount: $('#favCount'),
    favFit: $('#favFit'),
    favBackup: $('#favBackup'),
    favMenu: $('#favMenu'),
    exportFav: $('#exportFav'),
    importFav: $('#importFav'),
    favFileInput: $('#favFileInput'),
    favOnly: $('#favOnly'),
    typeChips: $('#typeChips'),
    filterReset: $('#filterReset'),
    randomBtn: $('#randomBtn'),
    zoomIn: $('#zoomIn'),
    zoomOut: $('#zoomOut'),
    resetView: $('#resetView'),
    hudLat: $('#hudLat'),
    hudLon: $('#hudLon'),
    hudZoom: $('#hudZoom'),
    cursorTip: $('#cursorTip'),
    tipCode: $('#tipCode'),
    tipName: $('#tipName'),
    toast: $('#toast'),
    toastText: $('#toastText'),
    offlineBadge: $('#offlineBadge'),
    cardType: $('#cardType'),
    cardCountry: $('#cardCountry'),
    cardIcao: $('#cardIcao'),
    cardIata: $('#cardIata'),
    cardName: $('#cardName'),
    cardLoc: $('#cardLoc'),
    statLat: $('#statLat'),
    statLon: $('#statLon'),
    statElev: $('#statElev'),
    statSched: $('#statSched'),
    runwayBlock: $('#runwayBlock'),
    runwayCount: $('#runwayCount'),
    runwayList: $('#runwayList'),
    totalAirports: $('#totalAirports'),
    totalCountries: $('#totalCountries'),
    brandBadge: $('#brandBadge'),
    accountBar: $('#accountBar'),
    accountAvatar: $('#accountAvatar'),
    accountName: $('#accountName'),
    accountSub: $('#accountSub'),
    accountAction: $('#accountAction'),
    authModal: $('#authModal'),
    authCard: $('#authCard'),
    authClose: $('#authClose'),
    authForm: $('#authForm'),
    authTabs: $('#authTabs'),
    authIdentityLabel: $('#authIdentityLabel'),
    authDisplayField: $('#authDisplayField'),
    authDisplayName: $('#authDisplayName'),
    authUsername: $('#authUsername'),
    authPassword: $('#authPassword'),
    authConfirm: $('#authConfirm'),
    authConfirmField: $('#authConfirmField'),
    authNotice: $('#authNotice'),
    authError: $('#authError'),
    authSubmit: $('#authSubmit'),
    authUnavailable: $('#authUnavailable'),
    authTitle: $('#authTitle'),
    authHint: $('#authHint'),
    authFoot: $('#authFoot'),
    authDismiss: $('#authDismiss')
  };

  /* ----------------------------------------------------------
     UI helpers
     ---------------------------------------------------------- */
  let toastTimer = 0;
  function toast(message) {
    if (!els.toast) return;
    els.toastText.textContent = message;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => els.toast.classList.remove('show'), 2400);
  }

  function fmtLat(v) {
    return Math.abs(v).toFixed(4) + '° ' + (v >= 0 ? 'N' : 'S');
  }
  function fmtLon(v) {
    return Math.abs(v).toFixed(4) + '° ' + (v >= 0 ? 'E' : 'W');
  }
  function fmtElev(ft) {
    if (ft == null) return '—';
    return ft.toLocaleString('en-US') + ' ft · ' + Math.round(ft * 0.3048).toLocaleString('en-US') + ' m';
  }
  function fmtZoom() {
    if (!state.mapReady) return 'Z 1.0';
    els.hudZoom.textContent = 'Z ' + map.getZoom().toFixed(1);
  }

  function updateMetaNumbers() {
    els.totalAirports.textContent = META.total.toLocaleString('en-US');
    els.totalCountries.textContent = META.countryCount;
    els.brandBadge.textContent = Math.round(META.total / 1000) + 'K';
  }

  /* ----------------------------------------------------------
     Map
     ---------------------------------------------------------- */
  const emptyFC = () => ({ type: 'FeatureCollection', features: [] });

  // Draw small airports first and large ones last so the important dots win
  // when they overlap.
  const renderAirports = AIRPORTS.slice().sort((a, b) => b[4] - a[4] || a[0].localeCompare(b[0]));
  const airportFeatures = new Array(renderAirports.length);
  for (let i = 0; i < renderAirports.length; i += 1) {
    const a = renderAirports[i];
    airportFeatures[i] = {
      type: 'Feature',
      id: i,
      properties: { i: a[0], t: a[4], n: a[1] },
      geometry: { type: 'Point', coordinates: [a[8], a[7]] }
    };
  }

  const AIRPORT_STYLE = {
    1: { color: '#eaf7ff', opacity: 0.95, radii: [1.55, 2.25, 3.7, 6.5, 10.5] },
    2: { color: '#9fc7ee', opacity: 0.8, radii: [1.05, 1.6, 2.95, 5.2, 8.6] },
    3: { color: '#6f8dab', opacity: 0.52, radii: [0.75, 1.15, 2.1, 3.8, 6.4] },
    4: { color: '#65e0c9', opacity: 0.68, radii: [0.8, 1.2, 2.2, 4.0, 6.8] },
    5: { color: '#c2a6ff', opacity: 0.44, radii: [0.72, 1.1, 2.0, 3.7, 6.2] }
  };

  const AIRPORT_LAYER_IDS = ['airports'];

  function airportRadius(stop) {
    return ['match', ['get', 't'],
      1, AIRPORT_STYLE[1].radii[stop], 2, AIRPORT_STYLE[2].radii[stop],
      3, AIRPORT_STYLE[3].radii[stop], 4, AIRPORT_STYLE[4].radii[stop],
      5, AIRPORT_STYLE[5].radii[stop], 0.8];
  }

  function airportOpacity(factor) {
    return ['match', ['get', 't'],
      1, AIRPORT_STYLE[1].opacity * factor, 2, AIRPORT_STYLE[2].opacity * factor,
      3, AIRPORT_STYLE[3].opacity * factor, 4, AIRPORT_STYLE[4].opacity * factor,
      5, AIRPORT_STYLE[5].opacity * factor, 0.6];
  }

  // A single circle layer is much cheaper than one layer per airport type.
  // `zoom` stays at the top level of the interpolate; the stop outputs are
  // per-type matches, which MapLibre supports.
  const AIRPORT_RADIUS = ['interpolate', ['linear'], ['zoom'],
    0, airportRadius(0), 4, airportRadius(1), 8, airportRadius(2),
    12, airportRadius(3), 16, airportRadius(4)];

  const AIRPORT_OPACITY = ['interpolate', ['linear'], ['zoom'],
    0, airportOpacity(0.55), 3, airportOpacity(0.7),
    6, airportOpacity(0.9), 9, airportOpacity(1)];

  const AIRPORT_LAYERS = [{
    id: 'airports',
    type: 'circle',
    source: 'airports',
    filter: ['in', ['get', 't'], ['literal', [1, 2]]],
    paint: {
      'circle-color': ['match', ['get', 't'],
        1, '#eaf7ff', 2, '#9fc7ee', 3, '#6f8dab', 4, '#65e0c9', 5, '#c2a6ff', '#8fa4bd'],
      'circle-radius': AIRPORT_RADIUS,
      'circle-opacity': AIRPORT_OPACITY,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': ['case', ['boolean', ['feature-state', 'hover'], false], 1.2, 0],
      'circle-stroke-opacity': 0.85
    }
  }];

  // Keep the world view light: 14k small/heliport dots only join at closer
  // zooms, while every major airport stays visible at all levels.
  const MINOR_AIRPORT_MIN_ZOOM = 3.0;
  let minorVisible = false;

  const baseStyle = window.AERO_BASEMAP_STYLE;
  if (!baseStyle) { fatal('底图样式加载失败，请检查 data/basemap-style.js'); return; }

  const style = JSON.parse(JSON.stringify(baseStyle));
  style.name = 'AeroAtlas Night';
  style.sources.airports = {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: airportFeatures }
  };
  style.sources.selected = { type: 'geojson', data: emptyFC() };
  style.sources.runways = { type: 'geojson', data: emptyFC() };
  style.sources['fallback-land'] = { type: 'geojson', data: BASEMAP.land };

  const backgroundIndex = Math.max(0, style.layers.findIndex((layer) => layer.type === 'background'));
  style.layers.splice(backgroundIndex + 1, 0, {
    id: 'fallback-land', type: 'fill', source: 'fallback-land',
    layout: { visibility: 'none' },
    paint: { 'fill-color': '#08111c', 'fill-opacity': 1 }
  });

  style.layers.push(
    {
      id: 'airport-glow', type: 'circle', source: 'airports',
      filter: ['==', ['get', 't'], 1],
      paint: {
        'circle-color': '#bfeaff',
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 2, 8, 5, 12, 10, 16, 16],
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], 4, 0, 8, 0.09, 12, 0.12],
        'circle-blur': 1
      }
    },
    {
      id: 'runway-line', type: 'line', source: 'runways',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#e9f7ff',
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.2, 11, 2.4, 14, 5.2, 17, 9],
        'line-opacity': 0.92,
        'line-blur': 0.25
      }
    },
    ...AIRPORT_LAYERS,
    {
      id: 'selected-halo', type: 'circle', source: 'selected',
      paint: {
        'circle-color': '#5cd6ff',
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 9, 8, 20, 12, 32],
        'circle-opacity': 0.13,
        'circle-blur': 1
      }
    },
    {
      id: 'selected-ring', type: 'circle', source: 'selected',
      paint: {
        'circle-color': 'rgba(0,0,0,0)',
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 7, 8, 13, 12, 19],
        'circle-stroke-color': '#9fe9ff',
        'circle-stroke-width': 1.4,
        'circle-stroke-opacity': 0.95
      }
    }
  );

  let map;
  try {
    map = new maplibregl.Map({
      container: 'map',
      style,
      center: [16, 22],
      zoom: 1.2,
      minZoom: 0.5,
      maxZoom: 16,
      maxPitch: 0,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      renderWorldCopies: true,
      attributionControl: false,
      fadeDuration: 0,
      antialias: false
    });
  } catch (err) {
    fatal('无法初始化地图渲染器：' + err.message);
    return;
  }

  // Cap the internal render resolution on HiDPI displays. 1.5x keeps labels
  // crisp while cutting the number of shaded pixels by ~44% at 2x DPR.
  try {
    map.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  } catch (err) { /* ignore unsupported */ }

  map.touchZoomRotate.disableRotation();
  if (map.keyboard && map.keyboard.disableRotation) map.keyboard.disableRotation();
  window.AeroAtlas = {
    map,
    state,
    select: (code) => selectAirport(code),
    favorite: (code) => toggleFavorite(code),
    search: (query) => searchAirports(query)
  };

  function sidebarWidth() {
    return els.sidebar.getBoundingClientRect().width;
  }
  function cardWidth() {
    return els.card.getBoundingClientRect().width;
  }

  function clearPadding() {
    if (!state.mapReady) return;
    const pad = map.getPadding();
    if (pad.top || pad.bottom || pad.left || pad.right) {
      map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    }
  }

  function mapPadding() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (vw <= 980) {
      return {
        left: 16,
        right: 16,
        top: 76,
        bottom: state.selected ? Math.round(vh * 0.52) : Math.round(Math.min(vh * 0.38, 330))
      };
    }
    const left = Math.round(sidebarWidth()) + 36;
    const right = state.selected ? Math.round(cardWidth()) + 36 : 24;
    if (vw - left - right < 250) {
      return { left: Math.max(250, Math.round(vw * 0.24)), right: 24, top: 60, bottom: 60 };
    }
    return { left, right, top: 60, bottom: 60 };
  }

  function fitWorld(animate) {
    if (!state.mapReady) return;
    clearPadding();
    const vw = window.innerWidth;
    if (vw <= 980) {
      map.easeTo({
        center: [18, 26],
        zoom: animate ? 0.95 : 1.1,
        duration: animate ? 900 : 0,
        essential: true
      });
      return;
    }
    map.fitBounds([[-179, -57], [179, 79]], {
      padding: {
        top: 24,
        right: 0,
        bottom: 24,
        left: Math.round(sidebarWidth()) + 18
      },
      maxZoom: 3.4,
      duration: animate ? 1300 : 0,
      essential: true
    });
  }

  /* ----------------------------------------------------------
     Favorites
     ---------------------------------------------------------- */
  const favMarkers = new Map();
  const favLayer = $('#favLayer');

  function buildFavMarker(a) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'fav-marker';
    el.title = a[0] + ' · ' + a[1];
    el.setAttribute('aria-label', '收藏机场 ' + a[0] + ' ' + a[1]);
    el.innerHTML =
      '<svg class="ic" viewBox="0 0 24 24"><use href="#i-star"/></svg>' +
      '<span class="fav-tag">' + esc(a[0]) + '</span>';
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      selectAirport(a[0]);
    });
    favLayer.appendChild(el);
    return el;
  }

  function syncFavMarkers() {
    if (!state.mapReady) return;
    favMarkers.forEach((el, code) => {
      if (!favSet.has(code)) {
        el.remove();
        favMarkers.delete(code);
      }
    });
    favSet.forEach((code) => {
      if (!favMarkers.has(code)) {
        const a = byCode.get(code);
        if (a) favMarkers.set(code, buildFavMarker(a));
      }
    });
    applyMarkerVisibility();
    positionFavMarkers();
  }

  function applyMarkerVisibility() {
    favMarkers.forEach((el, code) => {
      const a = byCode.get(code);
      if (!a) return;
      el.style.visibility = state.types.has(a[4]) ? '' : 'hidden';
    });
  }

  function visibleCenterX() {
    const vw = window.innerWidth;
    if (vw <= 980) return vw / 2;
    const left = Math.round(sidebarWidth()) + 18;
    const right = state.selected ? Math.round(cardWidth()) + 18 : 0;
    return (left + (vw - right)) / 2;
  }

  function visibleCenter() {
    if (window.innerWidth <= 980) return map.getCenter();
    return map.unproject([visibleCenterX(), window.innerHeight / 2]);
  }

  let favRaf = 0;
  function scheduleFavPositions() {
    if (!favMarkers.size || favRaf) return;
    favRaf = window.requestAnimationFrame(() => {
      favRaf = 0;
      positionFavMarkers();
    });
  }

  function positionFavMarkers() {
    if (!state.mapReady || !favMarkers.size) return;
    const width = window.innerWidth;
    const height = window.innerHeight;
    const centerX = visibleCenterX();
    const world = 512 * Math.pow(2, map.getZoom());
    favMarkers.forEach((el, code) => {
      const a = byCode.get(code);
      if (!a) return;
      const point = map.project([a[8], a[7]]);
      let bestX = null;
      let bestDistance = Infinity;
      for (let copy = -1; copy <= 1; copy += 1) {
        const x = point.x + copy * world;
        if (x < -30 || x > width + 30) continue;
        const distance = Math.abs(x - centerX);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestX = x;
        }
      }
      if (bestX == null || point.y < -30 || point.y > height + 30) {
        el.hidden = true;
        return;
      }
      el.hidden = false;
      el.style.transform = 'translate(' + bestX + 'px,' + point.y + 'px) translate(-50%,-50%)';
    });
  }

  function applyFilters() {
    if (!state.mapReady) return;
    const types = Array.from(state.types);
    if (!minorVisible) {
      for (let i = types.length - 1; i >= 0; i -= 1) {
        if (types[i] > 2) types.splice(i, 1);
      }
    }
    let filter;
    if (types.length === 0) filter = ['==', ['get', 't'], 0];
    else if (types.length === 5) filter = null;
    else filter = ['in', ['get', 't'], ['literal', types]];

    map.setFilter('airports', filter);
    map.setPaintProperty('airports', 'circle-opacity', favOnly ? 0.1 : AIRPORT_OPACITY);
    applyMarkerVisibility();
  }

  function renderTypeChips() {
    els.typeChips.innerHTML = Object.keys(TYPE_INFO).map((key) => {
      const info = TYPE_INFO[key];
      const count = (META.types && META.types[key]) || 0;
      return '<button class="chip is-on" type="button" data-type="' + key + '" ' +
        'style="--c:' + info.color + '" aria-pressed="true">' +
        '<i></i><span>' + info.label + '</span><b>' + count.toLocaleString('en-US') + '</b></button>';
    }).join('');
  }

  function renderFavorites() {
    els.favCount.textContent = favOrder.length;
    els.favFit.disabled = favOrder.length === 0;
    document.body.classList.toggle('many-favorites', favOrder.length > 30);

    if (!favOrder.length) {
      const picks = POPULAR.slice(0, 5).map((code) => {
        const a = byCode.get(code);
        if (!a) return '';
        return '<button class="popular-item" type="button" data-code="' + esc(code) + '">' +
          '<span class="popular-code">' + esc(code) + '</span>' +
          '<span class="popular-name">' + esc(a[1]) + '</span>' +
          '<span class="popular-city">' + esc(a[2] || countryOf(a[3])) + '</span>' +
          '</button>';
      }).join('');

      els.favList.innerHTML =
        '<div class="fav-empty">' +
        '<svg class="ic" viewBox="0 0 24 24"><use href="#i-star"/></svg>' +
        '<b>还没有收藏的机场</b>' +
        '<span>搜索 ICAO 代码，在机场卡片中点击 <em>收藏机场</em>，' +
        '它会以金色星标点亮地图。</span></div>' +
        '<div class="popular-head"><span>热门机场</span><span>POPULAR</span></div>' +
        '<div class="popular-list">' + picks + '</div>';
      return;
    }

    els.favList.innerHTML = favOrder.map((code) => {
      const a = byCode.get(code);
      if (!a) return '';
      const active = state.selected && state.selected[0] === code ? ' is-active' : '';
      return '<div class="fav-item' + active + '" data-code="' + esc(code) + '" role="button" tabindex="0" ' +
        'aria-label="查看 ' + esc(code) + ' ' + esc(a[1]) + '">' +
        '<svg class="ic" viewBox="0 0 24 24"><use href="#i-star"/></svg>' +
        '<div class="fav-item-main">' +
        '<span class="fav-item-code">' + esc(code) + '</span>' +
        '<span class="fav-item-name">' + esc(a[1]) + '</span>' +
        '<span class="fav-item-sub">' + esc(cityLine(a)) + '</span>' +
        '</div>' +
        '<button class="fav-remove" type="button" data-remove="' + esc(code) + '" ' +
        'aria-label="取消收藏 ' + esc(code) + '">' +
        '<svg class="ic" viewBox="0 0 24 24"><use href="#i-close"/></svg></button>' +
        '</div>';
    }).join('');
  }

  function updateActiveFavItem() {
    $$('.fav-item', els.favList).forEach((item) => {
      item.classList.toggle('is-active', !!state.selected && item.dataset.code === state.selected[0]);
    });
  }

  function syncSearchStars() {
    $$('.result-star', els.searchPanel).forEach((star) => {
      const isOn = favSet.has(star.dataset.fav);
      star.classList.toggle('is-fav', isOn);
      const icon = star.querySelector('.ic');
      if (icon) icon.classList.toggle('solid', isOn);
      star.setAttribute('aria-label',
        (isOn ? '取消收藏 ' : '收藏 ') + star.dataset.fav);
    });
  }

  function updateFavButtons() {
    const isFav = !!state.selected && favSet.has(state.selected[0]);
    els.cardFav.classList.toggle('is-fav', isFav);
    els.cardFav.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><use href="#i-star"/></svg>' +
      '<span>' + (isFav ? '已收藏' : '收藏机场') + '</span>';
    els.cardFav.setAttribute('aria-pressed', isFav ? 'true' : 'false');
    els.card.classList.toggle('is-fav', isFav);
    if (isFav) {
      els.cardFav.querySelector('.ic').classList.add('solid');
    }

    syncSearchStars();
    renderFavorites();
    updateActiveFavItem();
  }

  function toggleFavorite(code) {
    if (!byCode.has(code)) return;
    const a = byCode.get(code);
    if (favSet.has(code)) {
      favSet.delete(code);
      favOrder = favOrder.filter((item) => item !== code);
      persistFavorites();
      toast(code + ' 已取消收藏');
      if (state.selected && state.selected[0] === code) updateFavButtons();
      else renderFavorites();
      syncFavMarkers();
      if (!favOrder.length && favOnly) {
        favOnly = false;
        els.favOnly.checked = false;
        applyFilters();
      }
      updateMarkerLabelMode();
      syncSearchStars();
    } else {
      favSet.add(code);
      favOrder.unshift(code);
      persistFavorites();
      toast(code + ' 已加入收藏' + (a[2] ? ' · ' + a[2] : ''));
      if (state.selected && state.selected[0] === code) updateFavButtons();
      else renderFavorites();
      syncFavMarkers();
      updateMarkerLabelMode();
      syncSearchStars();
    }
  }

  function setFavorite(code, on) {
    if (on === favSet.has(code)) return;
    toggleFavorite(code);
  }

  function openFavMenu(focusFirst) {
    if (!els.favMenu || !els.favMenu.hidden) return;
    els.favMenu.hidden = false;
    els.favBackup.setAttribute('aria-expanded', 'true');
    document.body.classList.add('fav-menu-open');
    if (focusFirst) {
      window.requestAnimationFrame(() => els.exportFav.focus({ preventScroll: true }));
    }
  }

  function closeFavMenu(returnFocus) {
    if (!els.favMenu || els.favMenu.hidden) return;
    const hadFocus = els.favMenu.contains(document.activeElement);
    els.favMenu.hidden = true;
    els.favBackup.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('fav-menu-open');
    if (returnFocus || hadFocus) els.favBackup.focus({ preventScroll: true });
  }

  function toggleFavMenu(focusFirst) {
    if (els.favMenu.hidden) openFavMenu(focusFirst);
    else closeFavMenu(true);
  }

  function exportFavorites() {
    if (!favOrder.length) {
      toast('还没有收藏机场，先收藏几座吧');
      return;
    }
    const payload = {
      app: 'AeroAtlas',
      version: 1,
      exportedAt: new Date().toISOString(),
      count: favOrder.length,
      favorites: favOrder.slice()
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'aeroatlas-favorites-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    closeFavMenu(true);
    toast('已导出 ' + favOrder.length + ' 座收藏机场');
  }

  function importFavoritesFromFile(file) {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      toast('导入失败：文件不能超过 2 MB');
      return;
    }
    file.text().then((text) => {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        toast('导入失败：不是有效的 JSON 文件');
        closeFavMenu(true);
        return;
      }
      const list = Array.isArray(parsed)
        ? parsed
        : (parsed && Array.isArray(parsed.favorites) ? parsed.favorites : null);
      if (!list) {
        toast('导入失败：缺少收藏列表');
        closeFavMenu(true);
        return;
      }
      const seen = new Set();
      const codes = [];
      list.forEach((item) => {
        const code = String(item == null ? '' : item).trim().toUpperCase();
        if (/^[A-Z]{4}$/.test(code) && byCode.has(code) && !seen.has(code)) {
          seen.add(code);
          codes.push(code);
        }
      });
      if (!codes.length) {
        toast('未找到可导入的机场代码');
        closeFavMenu(true);
        return;
      }
      let added = 0;
      codes.forEach((code) => {
        if (!favSet.has(code)) {
          favSet.add(code);
          favOrder.push(code);
          added += 1;
        }
      });
      persistFavorites();
      syncFavMarkers();
      updateFavButtons();
      updateMarkerLabelMode();
      closeFavMenu(true);
      toast(added
        ? '已导入 ' + codes.length + ' 座机场（新增 ' + added + '）'
        : '已导入 ' + codes.length + ' 座机场 · 均已在收藏中');
    }).catch(() => {
      toast('导入失败：无法读取文件');
      closeFavMenu(true);
    });
  }

  function updateMarkerLabelMode() {
    if (!state.mapReady) return;
    const hide = map.getZoom() < 3.1;
    document.body.classList.toggle('hide-fav-labels', hide);
  }

  /* ----------------------------------------------------------
     Accounts (file-backed local server)
     ---------------------------------------------------------- */
  async function apiRequest(path, options = {}) {
    const init = {
      method: options.method || 'GET',
      credentials: 'same-origin',
      headers: {}
    };
    if (options.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    const response = await fetch(path, init);
    let data = null;
    try { data = await response.json(); } catch (err) { /* non-JSON error page */ }
    if (!response.ok) {
      const error = new Error((data && data.error) || '请求失败');
      error.status = response.status;
      throw error;
    }
    return data || {};
  }

  function updateAccountUI() {
    if (authUser) {
      els.accountBar.classList.add('is-logged');
      els.accountAvatar.textContent = String(authUser.username || '?').slice(0, 1).toUpperCase();
      els.accountName.textContent = authUser.username;
      els.accountSub.textContent = authUser.cloud ? '云端账号 · 已同步' : '收藏已绑定账号';
      els.accountAction.textContent = '退出';
    } else {
      els.accountBar.classList.remove('is-logged');
      els.accountAvatar.textContent = '?';
      els.accountName.textContent = '游客模式';
      if (cloudEnabled) {
        els.accountSub.textContent = authAvailable ? '登录后收藏同步到云端' : '云端账号准备中…';
      } else {
        els.accountSub.textContent = authAvailable ? '登录后收藏跟随账号' : '账号功能需本地启动';
      }
      els.accountAction.textContent = authAvailable ? '登录 / 注册' : '了解';
    }
  }

  function setAccountSyncStatus(text) {
    if (authUser) els.accountSub.textContent = text;
  }

  function setAuthNotice(text) {
    if (!els.authNotice) return;
    els.authNotice.textContent = text || '';
    els.authNotice.hidden = !text;
  }

  function setAuthTab(tab) {
    authTab = tab === 'register' ? 'register' : 'login';
    const isRegister = authTab === 'register';
    const cloudMode = cloudEnabled;
    $$('.auth-tab', els.authTabs).forEach((button) => {
      button.classList.toggle('is-active', button.dataset.authTab === authTab);
    });
    els.authTitle.textContent = isRegister ? '注册账号' : '登录账号';
    els.authHint.textContent = cloudMode
      ? (isRegister
        ? '注册后账号和收藏保存在 Supabase 云端。'
        : '登录后从云端加载账号和收藏。')
      : (isRegister
        ? '注册后，当前收藏会归入新账号并保存在本机。'
        : '登录后会切换到该账号的收藏；游客收藏仍保留在本机。');

    els.authIdentityLabel.textContent = cloudMode ? '邮箱' : '用户名';
    els.authUsername.type = cloudMode ? 'email' : 'text';
    els.authUsername.setAttribute('autocomplete', cloudMode ? 'email' : 'username');
    els.authUsername.setAttribute('placeholder', cloudMode ? 'you@example.com' : '3-20 位字母、数字或下划线');
    if (cloudMode) {
      els.authUsername.removeAttribute('pattern');
      els.authUsername.setAttribute('minlength', '5');
      els.authUsername.setAttribute('maxlength', '254');
    } else {
      els.authUsername.setAttribute('pattern', '[A-Za-z0-9_]{3,20}');
      els.authUsername.setAttribute('minlength', '3');
      els.authUsername.setAttribute('maxlength', '20');
    }

    els.authDisplayField.hidden = !(cloudMode && isRegister);
    els.authConfirmField.hidden = !isRegister;
    els.authPassword.setAttribute('autocomplete', isRegister ? 'new-password' : 'current-password');
    els.authSubmit.textContent = isRegister ? (cloudMode ? '注册' : '注册并登录') : '登录';
    els.authError.textContent = '';
    setAuthNotice('');
    if (els.authFoot) {
      els.authFoot.innerHTML = cloudMode
        ? '账号和收藏保存在 <code>Supabase</code> 云数据库；密码由 Supabase Auth 哈希保存，不保存明文。'
        : '账号与收藏保存在本机 <code>storage/accounts.json</code>；密码以 PBKDF2 哈希存储，不保存明文。';
    }
  }

  function resetAuthForm() {
    els.authForm.reset();
    els.authError.textContent = '';
    setAuthNotice('');
    els.authSubmit.disabled = false;
    els.authSubmit.textContent = authTab === 'register'
      ? (cloudEnabled ? '注册' : '注册并登录')
      : '登录';
    authBusy = false;
  }

  function openAuthModal(tab = 'login') {
    closeFavMenu();
    closeSearchPanel();
    els.authModal.hidden = false;
    const available = authAvailable;
    els.authModal.classList.toggle('is-unavailable', !available);
    els.authUnavailable.hidden = available;
    els.authForm.hidden = !available;
    els.authTabs.hidden = !available;
    els.authHint.hidden = !available;
    if (!available) {
      els.authTitle.textContent = '本地账号';
      els.authHint.textContent = '';
      els.authError.textContent = '';
      window.setTimeout(() => els.authClose.focus(), 30);
      return;
    }
    resetAuthForm();
    setAuthTab(tab);
    const focusTarget = cloudEnabled && tab === 'register' ? els.authDisplayName : els.authUsername;
    window.setTimeout(() => focusTarget.focus(), 30);
  }

  function closeAuthModal() {
    if (els.authModal.hidden) return;
    els.authModal.hidden = true;
    authBusy = false;
    els.authSubmit.disabled = false;
    if (els.authModal.contains(document.activeElement)) {
      els.accountAction.focus();
    }
  }

  function applyFavorites(codes) {
    const next = [];
    const seen = new Set();
    (Array.isArray(codes) ? codes : []).forEach((value) => {
      const code = String(value == null ? '' : value).trim().toUpperCase();
      if (byCode.has(code) && !seen.has(code)) {
        seen.add(code);
        next.push(code);
      }
    });
    favOrder = next;
    favSet.clear();
    next.forEach((code) => favSet.add(code));

    if (favOnly && !next.length) {
      favOnly = false;
      els.favOnly.checked = false;
      applyFilters();
    }
    syncFavMarkers();
    updateFavButtons();
    updateMarkerLabelMode();
  }

  function persistFavorites() {
    if (authUser && authUser.cloud) scheduleCloudSync();
    else if (authUser) scheduleAccountSync();
    else writeStore(FAV_KEY, favOrder);
  }

  function scheduleCloudSync() {
    if (!authUser || !authUser.cloud) return;
    setAccountSyncStatus('云端同步中…');
    clearTimeout(accountSyncTimer);
    accountSyncTimer = window.setTimeout(async () => {
      if (!authUser || !authUser.cloud) return;
      try {
        const { error } = await cloud.from('profiles').update({
          favorites: favOrder.slice(),
          updated_at: new Date().toISOString()
        }).eq('id', authUser.id);
        if (error) throw error;
        setAccountSyncStatus('云端账号 · 已同步');
      } catch (err) {
        setAccountSyncStatus('云端账号 · 同步失败');
        toast('云端收藏同步失败，请检查网络');
      }
    }, 450);
  }

  function scheduleAccountSync() {
    if (!authUser) return;
    setAccountSyncStatus('同步中…');
    clearTimeout(accountSyncTimer);
    accountSyncTimer = window.setTimeout(async () => {
      if (!authUser) return;
      try {
        await apiRequest('/api/favorites', {
          method: 'PUT',
          body: { favorites: favOrder.slice() }
        });
        setAccountSyncStatus('收藏已绑定账号 · 已同步');
      } catch (err) {
        setAccountSyncStatus('收藏已绑定账号 · 同步失败');
        toast('账号收藏同步失败，请检查本地服务');
      }
    }, 450);
  }

  function cloudFallbackName(user) {
    return (user && user.user_metadata && user.user_metadata.display_name) ||
      (user && user.email ? user.email.split('@')[0] : 'pilot');
  }

  function cloudErrorMessage(error) {
    const message = String((error && (error.message || error.error_description)) || '');
    if (/Invalid login credentials/i.test(message)) return '邮箱或密码错误';
    if (/Email not confirmed/i.test(message)) return '邮箱还没确认，请先点击确认邮件里的链接';
    if (/User already registered/i.test(message)) return '这个邮箱已经注册，请直接登录';
    if (/Password should be at least/i.test(message)) return '密码至少需要 6 位';
    if (/email rate limit/i.test(message)) return '邮件发送太频繁，请稍后再试';
    if (/Signups not allowed/i.test(message)) return '项目暂时关闭了注册';
    if (/Invalid email/i.test(message)) return '请输入有效邮箱';
    if (/Failed to fetch|NetworkError|Load failed/i.test(message)) return '无法连接 Supabase，请检查网络';
    return message || '操作失败，请稍后重试';
  }

  async function ensureCloudProfile(user) {
    const select = 'id,display_name,favorites';
    let { data, error } = await cloud.from('profiles')
      .select(select)
      .eq('id', user.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      const inserted = await cloud.from('profiles').insert({
        id: user.id,
        display_name: cloudFallbackName(user),
        favorites: []
      }).select(select).single();
      if (inserted.error) {
        const retry = await cloud.from('profiles')
          .select(select)
          .eq('id', user.id)
          .maybeSingle();
        if (retry.error || !retry.data) throw inserted.error;
        data = retry.data;
      } else {
        data = inserted.data;
      }
    }
    return data || { id: user.id, display_name: cloudFallbackName(user), favorites: [] };
  }

  async function finishCloudLogin(user, options = {}) {
    const profile = await ensureCloudProfile(user);
    const favorites = Array.isArray(profile.favorites) ? profile.favorites : [];
    authUser = {
      id: user.id,
      username: profile.display_name || cloudFallbackName(user),
      email: user.email || '',
      cloud: true
    };
    seededFavoriteCount = 0;
    applyFavorites(favorites);
    updateAccountUI();

    const initialFavorites = Array.isArray(options.initialFavorites) ? options.initialFavorites : null;
    if (!favorites.length && initialFavorites && initialFavorites.length) {
      const codes = [];
      const seen = new Set();
      initialFavorites.forEach((value) => {
        const code = String(value == null ? '' : value).trim().toUpperCase();
        if (byCode.has(code) && !seen.has(code)) {
          seen.add(code);
          codes.push(code);
        }
      });
      if (codes.length) {
        const { error } = await cloud.from('profiles').update({
          favorites: codes,
          updated_at: new Date().toISOString()
        }).eq('id', user.id);
        if (error) {
          toast('账号已登录，但初始收藏没有同步成功');
          return;
        }
        applyFavorites(codes);
        updateAccountUI();
      }
    }
  }

  async function submitAuth(event) {
    event.preventDefault();
    if (!authAvailable || authBusy) return;
    const isRegister = authTab === 'register';
    const identity = els.authUsername.value.trim();
    const password = els.authPassword.value;
    const displayName = els.authDisplayName.value.trim();
    els.authError.textContent = '';
    setAuthNotice('');

    if (cloudEnabled) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(identity)) {
        els.authError.textContent = '请输入有效邮箱';
        return;
      }
      if (isRegister && displayName && (displayName.length < 2 || displayName.length > 24)) {
        els.authError.textContent = '显示名称需为 2-24 位';
        return;
      }
      if (password.length < 6) {
        els.authError.textContent = '密码至少需要 6 位';
        return;
      }
      if (isRegister && password !== els.authConfirm.value) {
        els.authError.textContent = '两次输入的密码不一致';
        return;
      }

      authBusy = true;
      els.authSubmit.disabled = true;
      els.authSubmit.textContent = isRegister ? '正在注册…' : '正在登录…';
      try {
        if (isRegister) {
          const { data, error } = await cloud.auth.signUp({
            email: identity,
            password,
            options: {
              data: { display_name: displayName || identity.split('@')[0] }
            }
          });
          if (error) throw error;
          if (!data.session || !data.user) {
            setAuthTab('login');
            els.authUsername.value = identity;
            els.authPassword.value = '';
            els.authConfirm.value = '';
            setAuthNotice('确认邮件已发送到 ' + identity + '。请点击邮件里的确认链接，然后回来登录。');
            els.authSubmit.disabled = false;
            els.authSubmit.textContent = '登录';
            authBusy = false;
            return;
          }
          await finishCloudLogin(data.user, { initialFavorites: favOrder.slice() });
          closeAuthModal();
          toast('注册成功，账号已同步到云端');
        } else {
          const { data, error } = await cloud.auth.signInWithPassword({
            email: identity,
            password
          });
          if (error) throw error;
          await finishCloudLogin(data.user);
          closeAuthModal();
          toast('登录成功，已加载云端收藏');
        }
      } catch (err) {
        els.authError.textContent = cloudErrorMessage(err);
      } finally {
        authBusy = false;
        els.authSubmit.disabled = false;
        if (!els.authModal.hidden) {
          els.authSubmit.textContent = authTab === 'register' ? '注册' : '登录';
        }
      }
      return;
    }

    if (!/^[A-Za-z0-9_]{3,20}$/.test(identity)) {
      els.authError.textContent = '用户名需为 3-20 位字母、数字或下划线';
      return;
    }
    if (password.length < 6) {
      els.authError.textContent = '密码至少需要 6 位';
      return;
    }
    if (isRegister && password !== els.authConfirm.value) {
      els.authError.textContent = '两次输入的密码不一致';
      return;
    }

    authBusy = true;
    els.authSubmit.disabled = true;
    els.authSubmit.textContent = isRegister ? '正在注册…' : '正在登录…';
    try {
      const body = { username: identity, password };
      if (isRegister) body.favorites = favOrder.slice();
      const data = await apiRequest(isRegister ? '/api/register' : '/api/login', {
        method: 'POST',
        body
      });
      authUser = data.user;
      seededFavoriteCount = 0;
      applyFavorites(data.favorites || []);
      updateAccountUI();
      closeAuthModal();
      toast(isRegister
        ? '注册成功，收藏已绑定到 ' + authUser.username
        : '登录成功，已切换到 ' + authUser.username + ' 的收藏');
    } catch (err) {
      els.authError.textContent = err.message || '操作失败，请稍后重试';
    } finally {
      authBusy = false;
      els.authSubmit.disabled = false;
      if (!els.authModal.hidden) {
        els.authSubmit.textContent = authTab === 'register' ? '注册并登录' : '登录';
      }
    }
  }

  async function logoutAccount() {
    if (!authUser) return;
    const username = authUser.username;
    const isCloud = !!authUser.cloud;
    clearTimeout(accountSyncTimer);
    try {
      if (isCloud) await cloud.auth.signOut();
      else await apiRequest('/api/logout', { method: 'POST', body: {} });
    } catch (err) { /* local logout still applies */ }
    authUser = null;
    const guest = readStore(FAV_KEY, []).filter((code) => byCode.has(code));
    applyFavorites(guest);
    updateAccountUI();
    toast('已退出 ' + username + '，当前为游客模式');
  }

  async function initAuth() {
    els.accountBar.hidden = false;
    if (cloudEnabled) {
      authAvailable = true;
      updateAccountUI();
      try {
        const { data: { session } } = await cloud.auth.getSession();
        if (session && session.user) {
          await finishCloudLogin(session.user);
        }
      } catch (err) {
        updateAccountUI();
      }
      updateAccountUI();
      return;
    }
    if (!isLocalOrigin) {
      authAvailable = false;
      els.accountBar.hidden = true;
      return;
    }
    if (window.location.protocol === 'file:') {
      authAvailable = false;
      updateAccountUI();
      return;
    }
    try {
      const health = await apiRequest('/api/health');
      authAvailable = !!health.ok;
    } catch (err) {
      authAvailable = false;
    }
    if (!authAvailable) {
      updateAccountUI();
      return;
    }
    try {
      const data = await apiRequest('/api/me');
      if (data && data.user) {
        authUser = data.user;
        seededFavoriteCount = 0;
        applyFavorites(data.favorites || []);
      }
    } catch (err) {
      authUser = null;
    }
    updateAccountUI();
  }

  function fitFavoriteBounds() {
    if (!state.mapReady) return;
    clearPadding();
    const points = favOrder.map((code) => {
      const a = byCode.get(code);
      return a ? [a[8], a[7]] : null;
    }).filter(Boolean);
    if (!points.length) {
      toast('还没有收藏机场，先收藏一座吧');
      return;
    }
    if (points.length === 1) {
      const [lon, lat] = points[0];
      map.fitBounds([[lon - 0.02, lat - 0.02], [lon + 0.02, lat + 0.02]], {
        padding: mapPadding(),
        maxZoom: 8,
        duration: 1200,
        essential: true
      });
      return;
    }
    const bounds = new maplibregl.LngLatBounds();
    points.forEach((point) => bounds.extend(point));
    map.fitBounds(bounds, { padding: mapPadding(), maxZoom: 7.5, duration: 1200, essential: true });
  }

  function setFavoritesOnly(on) {
    if (on && !favOrder.length) {
      els.favOnly.checked = false;
      toast('还没有收藏机场，先收藏一座吧');
      return;
    }
    favOnly = on;
    els.favOnly.checked = on;
    applyFilters();
    if (on) {
      if (state.selected) deselectAirport();
      fitFavoriteBounds();
    }
  }

  /* ----------------------------------------------------------
     Card + selection
     ---------------------------------------------------------- */
  function renderCard(a) {
    const info = TYPE_INFO[a[4]] || TYPE_INFO[3];
    els.cardType.textContent = info.en;
    els.cardCountry.textContent = countryOf(a[3]).toUpperCase();
    els.cardIcao.textContent = a[0];
    els.cardIata.textContent = a[6] || '';
    els.cardIata.style.display = a[6] ? '' : 'none';
    els.cardName.textContent = a[1];
    els.cardLoc.textContent = cityLine(a);
    els.statLat.textContent = fmtLat(a[7]);
    els.statLon.textContent = fmtLon(a[8]);
    els.statElev.textContent = fmtElev(a[5]);
    els.statSched.textContent = a[9] ? '是' : '否';

    const runways = a[10] || [];
    if (runways.length) {
      els.runwayBlock.hidden = false;
      els.runwayCount.textContent = String(runways.length);
      els.runwayList.innerHTML = runways.map((r) => {
        const meters = Math.round(r[2] * 0.3048).toLocaleString('en-US');
        return '<div class="runway-row">' +
          '<b>' + esc(r[0] || '—') + ' / ' + esc(r[1] || '—') + '</b>' +
          '<span>' + meters + ' m</span>' +
          '<em>' + esc(SURFACE_LABEL[r[3]] || r[3]) + '</em>' +
          (r[4] ? '<i class="lit">灯光</i>' : '') +
          '</div>';
      }).join('');
    } else {
      els.runwayBlock.hidden = true;
    }
    updateFavButtons();
  }

  function showCard() {
    els.card.classList.add('open');
    els.card.setAttribute('aria-hidden', 'false');
    els.card.inert = false;
    document.body.classList.add('has-card');
    scheduleFavPositions();
  }

  function hideCard() {
    els.card.classList.remove('open');
    els.card.setAttribute('aria-hidden', 'true');
    els.card.inert = true;
    document.body.classList.remove('has-card');
    scheduleFavPositions();
  }

  function updateSelectionLayers(a) {
    if (!state.mapReady) return;
    const selected = map.getSource('selected');
    if (selected) {
      selected.setData({
        type: 'FeatureCollection',
        features: a ? [{
          type: 'Feature',
          properties: {},
          geometry: { type: 'Point', coordinates: [a[8], a[7]] }
        }] : []
      });
    }
    const runwaySource = map.getSource('runways');
    if (runwaySource) {
      const lines = a && a[10] ? a[10].map((r) => ({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: [[r[6], r[5]], [r[8], r[7]]]
        }
      })) : [];
      runwaySource.setData({ type: 'FeatureCollection', features: lines });
    }
  }

  function flyToAirport(a) {
    if (!state.mapReady) return;
    clearPadding();
    const zoom = window.innerWidth <= 980
      ? 10.2
      : (a[4] === 1 ? 10.6 : a[4] === 2 ? 11.1 : 11.8);
    map.flyTo({
      center: [a[8], a[7]],
      zoom,
      padding: mapPadding(),
      speed: 1.35,
      curve: 1.42,
      essential: true
    });
  }

  function selectAirport(code) {
    const a = byCode.get(code);
    if (!a) return;
    state.selected = a;
    renderCard(a);
    showCard();
    updateSelectionLayers(a);
    flyToAirport(a);
    addRecent(code);
    closeFavMenu();
    closeSearchPanel();
    els.searchInput.value = a[0];
    els.searchClear.hidden = false;
    if (document.activeElement === els.searchInput) els.searchInput.blur();
    updateActiveFavItem();
  }

  function deselectAirport() {
    state.selected = null;
    hideCard();
    updateSelectionLayers(null);
    updateActiveFavItem();
  }

  function addRecent(code) {
    recent = [code].concat(recent.filter((item) => item !== code)).slice(0, 6);
    writeStore(RECENT_KEY, recent);
  }

  /* Shareable deep links: ?icao=KJFK&fav=KJFK,EGLL&favonly=1 */
  function applyDeepLinks() {
    try {
      const params = new URLSearchParams(window.location.search);
      const favParam = params.get('fav');
      if (favParam) {
        favParam.split(',').map((code) => code.trim().toUpperCase()).forEach((code) => {
          if (byCode.has(code) && !favSet.has(code)) {
            favSet.add(code);
            favOrder.push(code);
          }
        });
        if (authUser) persistFavorites();
        else writeStore(FAV_KEY, favOrder);
        renderFavorites();
      }
      if (params.get('favonly') === '1' && favOrder.length) {
        favOnly = true;
        els.favOnly.checked = true;
        applyFilters();
      }
      const icao = (params.get('icao') || '').trim().toUpperCase();
      if (byCode.has(icao)) {
        window.setTimeout(() => selectAirport(icao), 600);
      }
    } catch (err) { /* ignore malformed links */ }
  }

  /* ----------------------------------------------------------
     Search
     ---------------------------------------------------------- */
  function searchAirports(query) {
    const q = query.trim();
    if (!q) return [];
    const upper = q.toUpperCase();
    const lower = norm(q);
    const found = [];
    for (let i = 0; i < searchRows.length; i += 1) {
      const row = searchRows[i];
      let score = 0;
      if (row.code === upper) score = 10000;
      else if (row.code.startsWith(upper)) score = 9000 - (row.code.length - upper.length);
      else if (row.iata && row.iata === upper) score = 8600;
      else if (row.nameN.startsWith(lower)) score = 7600;
      else if (row.cityN.startsWith(lower)) score = 6600;
      else if (row.nameN.includes(lower)) score = 5200;
      else if (row.cityN.includes(lower)) score = 4200;
      else if (row.countryN.includes(lower)) score = 3200;
      if (score) {
        score += (5 - row.type) * 6;
        found.push([score, row]);
      }
    }
    found.sort((x, y) => y[0] - x[0] || y[1].rank - x[1].rank || x[1].a[1].localeCompare(y[1].a[1]));
    return found.slice(0, 8).map((item) => item[1]);
  }

  function searchResultHTML(row, index) {
    const a = row.a;
    const isFav = favSet.has(row.code);
    const active = index === state.activeIndex ? ' active' : '';
    const sub = cityLine(a) + ' · ' + TYPE_INFO[row.type].label + (row.iata ? ' · ' + row.iata : '');
    return '<div class="result' + active + '" data-code="' + esc(row.code) + '" role="option" ' +
      'aria-selected="' + (index === state.activeIndex) + '">' +
      '<span class="result-code">' + esc(row.code) + '</span>' +
      '<span class="result-body">' +
      '<span class="result-name">' + esc(a[1]) + '</span>' +
      '<span class="result-sub">' + esc(sub) + '</span>' +
      '</span>' +
      '<button class="result-star' + (isFav ? ' is-fav' : '') + '" type="button" tabindex="-1" ' +
      'data-fav="' + esc(row.code) + '" aria-label="' + (isFav ? '取消收藏 ' : '收藏 ') + esc(row.code) + '">' +
      '<svg class="ic' + (isFav ? ' solid' : '') + '" viewBox="0 0 24 24"><use href="#i-star"/></svg>' +
      '</button></div>';
  }

  function renderSearch() {
    const query = els.searchInput.value.trim();
    els.searchClear.hidden = !query;

    if (!query) {
      renderIdlePanel();
      return;
    }

    state.results = searchAirports(query);
    state.activeIndex = state.results.length ? 0 : -1;

    if (!state.results.length) {
      els.searchPanel.innerHTML =
        '<div class="search-empty">' +
        '<svg class="ic" viewBox="0 0 24 24"><use href="#i-search"/></svg>' +
        '<b>未找到匹配的机场</b>' +
        '<span>请检查 ICAO 四字码，例如 <code>KJFK</code>、<code>EGLL</code>、<code>ZBAA</code>。<br>' +
        '也可以尝试机场名称或城市。</span></div>';
      return;
    }

    els.searchPanel.innerHTML = state.results.map(searchResultHTML).join('');
  }

  function renderIdlePanel() {
    state.results = [];
    state.activeIndex = -1;
    const recents = recent.filter((code) => byCode.has(code));
    let html = '';
    if (recents.length) {
      html += '<div class="panel-label">最近查看</div><div class="quick">' +
        recents.map((code) => {
          const a = byCode.get(code);
          return '<button type="button" data-code="' + esc(code) + '">' + esc(code) +
            '<small>' + esc(a[2] || countryOf(a[3])) + '</small></button>';
        }).join('') + '</div>';
    }
    html += '<div class="panel-label">热门机场</div><div class="quick">' +
      POPULAR.map((code) => {
        const a = byCode.get(code);
        if (!a) return '';
        return '<button type="button" data-code="' + esc(code) + '">' + esc(code) +
          '<small>' + esc(a[2] || countryOf(a[3])) + '</small></button>';
      }).join('') + '</div>';
    els.searchPanel.innerHTML = html;
  }

  function openSearchPanel() {
    closeFavMenu();
    renderSearch();
    els.searchPanel.classList.add('open');
    els.searchPanel.style.display = '';
    state.panelOpen = true;
    els.searchInput.setAttribute('aria-expanded', 'true');
  }

  function closeSearchPanel() {
    els.searchPanel.classList.remove('open');
    state.panelOpen = false;
    els.searchInput.setAttribute('aria-expanded', 'false');
  }

  function moveActive(delta) {
    if (!state.results.length) return;
    state.activeIndex = (state.activeIndex + delta + state.results.length) % state.results.length;
    $$('.result', els.searchPanel).forEach((row, index) => {
      const active = index === state.activeIndex;
      row.classList.toggle('active', active);
      row.setAttribute('aria-selected', active ? 'true' : 'false');
      if (active) row.scrollIntoView({ block: 'nearest' });
    });
  }

  /* ----------------------------------------------------------
     Map UI events
     ---------------------------------------------------------- */
  function updateTooltip(feature, x, y) {
    if (!feature) {
      els.cursorTip.hidden = true;
      map.getCanvas().style.cursor = '';
      return;
    }
    els.tipCode.textContent = feature.properties.i;
    els.tipName.textContent = feature.properties.n;
    els.cursorTip.hidden = false;
    const tipW = els.cursorTip.offsetWidth;
    if (els.cursorTip.offsetHeight) { /* force layout */ }
    els.cursorTip.style.left = Math.max(8, Math.min(x + 14, window.innerWidth - tipW - 12)) + 'px';
    els.cursorTip.style.top = (y + 18) + 'px';
    map.getCanvas().style.cursor = 'pointer';
  }

  function clearHover() {
    if (state.hoverId != null) {
      map.setFeatureState({ source: 'airports', id: state.hoverId }, { hover: false });
      state.hoverId = null;
    }
    els.cursorTip.hidden = true;
    map.getCanvas().style.cursor = '';
  }

  let hoverRaf = 0;
  let lastHoverAt = 0;
  let lastHudAt = 0;
  map.on('mousemove', (event) => {
    const original = event.originalEvent;
    if (original && original.buttons) return;
    const now = performance.now();
    if (now - lastHudAt > 60) {
      lastHudAt = now;
      updateHud(event.lngLat);
    }
    if (now - lastHoverAt < 90 || hoverRaf) return;
    lastHoverAt = now;
    hoverRaf = window.requestAnimationFrame(() => {
      hoverRaf = 0;
      const features = map.queryRenderedFeatures(event.point, { layers: AIRPORT_LAYER_IDS });
      if (features.length && !state.panelOpen) {
        const feature = features[0];
        if (state.hoverId != null && state.hoverId !== feature.id) {
          map.setFeatureState({ source: 'airports', id: state.hoverId }, { hover: false });
        }
        state.hoverId = feature.id;
        map.setFeatureState({ source: 'airports', id: feature.id }, { hover: true });
        updateTooltip(feature, original ? original.clientX : event.point.x, original ? original.clientY : event.point.y);
      } else {
        clearHover();
      }
    });
  });

  map.on('mouseout', clearHover);

  function updateHud(lngLat) {
    if (!lngLat) return;
    els.hudLat.textContent = fmtLat(lngLat.lat);
    els.hudLon.textContent = fmtLon(lngLat.lng);
  }

  map.on('zoomstart', clearHover);

  map.on('zoom', () => {
    const next = map.getZoom() >= MINOR_AIRPORT_MIN_ZOOM;
    if (next !== minorVisible) {
      minorVisible = next;
      applyFilters();
    }
    updateMarkerLabelMode();
  });

  map.on('zoomend', () => {
    fmtZoom();
    updateMarkerLabelMode();
  });

  map.on('movestart', () => {
    clearHover();
    els.cursorTip.hidden = true;
  });

  map.on('move', scheduleFavPositions);

  map.on('click', (event) => {
    const features = map.queryRenderedFeatures(event.point, { layers: AIRPORT_LAYER_IDS });
    if (features.length) {
      selectAirport(features[0].properties.i);
    } else if (state.selected) {
      deselectAirport();
    }
  });

  /* Basemap fallback if vector tiles cannot be reached */
  let vectorErrors = 0;
  let vectorLoaded = false;
  let fallbackUsed = false;

  function enableLandFallback() {
    if (fallbackUsed || !state.mapReady) return;
    fallbackUsed = true;
    try { map.setLayoutProperty('fallback-land', 'visibility', 'visible'); } catch (err) { /* noop */ }
    try { map.setPaintProperty('background', 'background-color', 'rgba(0,0,0,0)'); } catch (err) { /* noop */ }
    if (els.offlineBadge) {
      els.offlineBadge.hidden = false;
      els.offlineBadge.textContent = '底图瓦片受限 · 机场数据仍可用';
    }
  }

  map.on('sourcedata', (event) => {
    if (event.sourceId === 'openmaptiles' && event.isSourceLoaded) vectorLoaded = true;
  });

  map.on('error', (event) => {
    const sourceId = event && (event.sourceId || (event.error && event.error.sourceId));
    const message = event && event.error ? (event.error.message || String(event.error)) : 'unknown map error';
    if (ERRORS.length < 30) ERRORS.push('map' + (sourceId ? '[' + sourceId + ']' : '') + ': ' + message);
    if (sourceId === 'openmaptiles') {
      vectorErrors += 1;
      if (vectorErrors >= 5) enableLandFallback();
    }
  });

  /* ----------------------------------------------------------
     Loader / init
     ---------------------------------------------------------- */
  let finished = false;
  function finishLoading() {
    if (finished) return;
    finished = true;
    if (!loader) return;
    loaderStatus.textContent = '就绪 · READY';
    loader.classList.add('done');
    window.setTimeout(() => { if (loader.parentNode) loader.parentNode.removeChild(loader); }, 900);
  }

  map.on('load', () => {
    state.mapReady = true;
    fmtZoom();
    fitWorld(false);
    minorVisible = map.getZoom() >= MINOR_AIRPORT_MIN_ZOOM;
    applyFilters();
    updateHud(visibleCenter());
    applyDeepLinks();
    syncFavMarkers();
    updateMarkerLabelMode();
    updateFavButtons();
    if (seededFavoriteCount > 0) {
      toast('已收藏 机场24 的 ' + seededFavoriteCount + ' 座机场');
    }
    window.setTimeout(finishLoading, 450);
    if (!vectorLoaded) {
      window.setTimeout(() => {
        if (!vectorLoaded) enableLandFallback();
      }, 9000);
    }
  });

  window.setTimeout(() => {
    if (!state.mapReady) loaderStatus.textContent = '正在等待地图渲染…';
    window.setTimeout(finishLoading, 1600);
  }, 6500);

  /* ----------------------------------------------------------
     Bindings
     ---------------------------------------------------------- */
  updateMetaNumbers();
  renderTypeChips();
  renderFavorites();
  updateFavButtons();
  els.card.inert = true;
  els.searchInput.setAttribute('aria-expanded', 'false');
  els.searchInput.setAttribute('role', 'combobox');
  els.searchInput.setAttribute('aria-controls', 'searchPanel');
  els.searchInput.setAttribute('aria-autocomplete', 'list');
  els.cardFav.setAttribute('aria-pressed', 'false');

  if (els.cardFav) els.cardFav.classList.remove('is-fav');
  els.cardFav.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><use href="#i-star"/></svg><span>收藏机场</span>';

  els.searchInput.addEventListener('focus', openSearchPanel);
  els.searchInput.addEventListener('click', () => {
    if (!state.panelOpen) openSearchPanel();
  });
  els.searchInput.addEventListener('input', () => {
    if (!state.panelOpen) {
      els.searchPanel.classList.add('open');
      state.panelOpen = true;
    }
    renderSearch();
  });

  els.searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const row = state.results[state.activeIndex] || state.results[0];
      if (row) selectAirport(row.code);
    } else if (event.key === 'Escape') {
      closeSearchPanel();
      els.searchInput.blur();
    }
  });

  els.searchClear.addEventListener('click', () => {
    els.searchInput.value = '';
    els.searchClear.hidden = true;
    renderIdlePanel();
    els.searchInput.focus();
  });

  els.searchPanel.addEventListener('click', (event) => {
    const star = event.target.closest('[data-fav]');
    if (star) {
      event.stopPropagation();
      toggleFavorite(star.dataset.fav);
      return;
    }
    const row = event.target.closest('[data-code]');
    if (row) selectAirport(row.dataset.code);
  });

  els.searchPanel.addEventListener('mousemove', (event) => {
    const row = event.target.closest('.result');
    if (!row) return;
    const index = state.results.findIndex((item) => item.code === row.dataset.code);
    if (index >= 0 && index !== state.activeIndex) {
      state.activeIndex = index;
      $$('.result', els.searchPanel).forEach((item, i) => {
        item.classList.toggle('active', i === index);
        item.setAttribute('aria-selected', i === index ? 'true' : 'false');
      });
    }
  });

  document.addEventListener('pointerdown', (event) => {
    if (!els.searchWrap.contains(event.target)) closeSearchPanel();
    if (!els.favMenu.hidden && !els.favMenu.contains(event.target) && !els.favBackup.contains(event.target)) {
      closeFavMenu();
    }
  });

  els.cardClose.addEventListener('click', deselectAirport);
  els.cardFav.addEventListener('click', () => {
    if (state.selected) toggleFavorite(state.selected[0]);
  });  els.cardCopy.addEventListener('click', async () => {
    if (!state.selected) return;
    const a = state.selected;
    const text = a[0] + ' ' + a[7].toFixed(4) + ', ' + a[8].toFixed(4);
    try {
      await navigator.clipboard.writeText(text);
      toast('坐标已复制 · ' + a[0]);
    } catch (err) {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); toast('坐标已复制 · ' + a[0]); }
      catch (e) { toast('复制失败，请手动选择坐标'); }
      area.remove();
    }
  });

  els.favList.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove]');
    if (remove) {
      event.stopPropagation();
      toggleFavorite(remove.dataset.remove);
      return;
    }
    const pick = event.target.closest('.popular-item');
    if (pick) {
      selectAirport(pick.dataset.code);
      return;
    }
    const item = event.target.closest('.fav-item');
    if (item) selectAirport(item.dataset.code);
  });

  els.favList.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const item = event.target.closest('.fav-item');
    if (!item) return;
    event.preventDefault();
    selectAirport(item.dataset.code);
  });

  els.favFit.addEventListener('click', () => {
    if (!favOrder.length) { toast('还没有收藏机场，先收藏一座吧'); return; }
    els.favOnly.checked = true;
    setFavoritesOnly(true);
  });

  els.favBackup.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleFavMenu(event.detail === 0);
  });

  els.accountAction.addEventListener('click', () => {
    if (authUser) {
      logoutAccount();
      return;
    }
    openAuthModal('login');
  });

  els.authClose.addEventListener('click', closeAuthModal);
  els.authDismiss.addEventListener('click', closeAuthModal);
  els.authModal.addEventListener('click', (event) => {
    if (event.target.matches('[data-auth-close]')) closeAuthModal();
  });
  els.authTabs.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-auth-tab]');
    if (tab) setAuthTab(tab.dataset.authTab);
  });
  els.authForm.addEventListener('submit', submitAuth);

  els.exportFav.addEventListener('click', exportFavorites);

  els.importFav.addEventListener('click', () => {
    closeFavMenu(true);
    els.favFileInput.click();
  });

  els.favFileInput.addEventListener('change', () => {
    const file = els.favFileInput.files && els.favFileInput.files[0];
    els.favFileInput.value = '';
    if (file) importFavoritesFromFile(file);
  });

  els.favMenu.addEventListener('keydown', (event) => {
    const items = [els.exportFav, els.importFav];
    const index = items.indexOf(document.activeElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[(index + 1 + items.length) % items.length].focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[(index - 1 + items.length) % items.length].focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeFavMenu(true);
    }
  });

  els.favOnly.addEventListener('change', () => setFavoritesOnly(els.favOnly.checked));

  els.typeChips.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-type]');
    if (!chip) return;
    const type = Number(chip.dataset.type);
    if (state.types.has(type)) {
      if (state.types.size === 1) { toast('至少保留一个图层'); return; }
      state.types.delete(type);
      chip.classList.remove('is-on');
      chip.setAttribute('aria-pressed', 'false');
    } else {
      state.types.add(type);
      chip.classList.add('is-on');
      chip.setAttribute('aria-pressed', 'true');
    }
    applyFilters();
  });

  els.filterReset.addEventListener('click', () => {
    state.types = new Set([1, 2, 3, 4, 5]);
    $$('.chip', els.typeChips).forEach((chip) => {
      chip.classList.add('is-on');
      chip.setAttribute('aria-pressed', 'true');
    });
    applyFilters();
    toast('图层已重置');
  });

  els.randomBtn.addEventListener('click', () => {
    const pool = AIRPORTS.filter((a) => a[4] === 1 || a[4] === 2);
    const a = pool[Math.floor(Math.random() * pool.length)];
    if (!a) return;
    selectAirport(a[0]);
    toast('随机探索 · ' + a[0] + ' · ' + a[1]);
  });

  els.zoomIn.addEventListener('click', () => map.zoomIn({ duration: 300 }));
  els.zoomOut.addEventListener('click', () => map.zoomOut({ duration: 300 }));
  els.resetView.addEventListener('click', () => {
    deselectAirport();
    fitWorld(true);
  });

  /* Keyboard shortcuts */
  document.addEventListener('keydown', (event) => {
    if (!els.authModal.hidden) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeAuthModal();
      }
      return;
    }
    const target = event.target;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    if ((event.key === '/' && !typing) || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k')) {
      event.preventDefault();
      els.searchInput.focus();
      els.searchInput.select();
      return;
    }
    if (event.key === 'Escape') {
      if (!els.favMenu.hidden) {
        closeFavMenu(true);
      } else if (state.panelOpen) {
        closeSearchPanel();
        els.searchInput.blur();
      } else if (state.selected) {
        deselectAirport();
      }
      return;
    }
    if (!typing && (event.key === 'f' || event.key === 'F') && state.selected) {
      toggleFavorite(state.selected[0]);
    }
  });

  window.addEventListener('resize', () => {
    map.resize();
    scheduleFavPositions();
  });

  map.on('moveend', () => {
    updateHud(visibleCenter());
    updateMarkerLabelMode();
    scheduleFavPositions();
  });
  initAuth();
  fmtZoom();
})();
