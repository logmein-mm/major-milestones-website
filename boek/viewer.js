/*
 * Boekviewer — Major Milestones B.V.
 * PDF.js (pdfjs-dist 6.4.299, legacy build) + StPageFlip (page-flip 2.0.7)
 * Instellingen staan in index.html (window.BOEK_CONFIG).
 */
import * as pdfjsLib from './lib/pdfjs/pdf.min.mjs';

const CFG = Object.assign({
  pdf: 'boek.pdf',
  titel: 'Boek',
  ondertitel: '',
  downloadNaam: 'boek.pdf',
  terugLink: '../',
  terugTekst: 'Terug'
}, window.BOEK_CONFIG || {});

const LIB = new URL('./lib/pdfjs/', import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = LIB + 'pdf.worker.min.mjs';

/* ── Afstellingen ── */
const ZOOMS = [1, 1.25, 1.5, 2, 2.5, 3];              // 1 = passend in het scherm
const IS_TOUCH = matchMedia('(pointer: coarse)').matches;
const PIXEL_BUDGET = IS_TOUCH ? 22e6 : 48e6;           // max. pixels aan canvassen in geheugen
const MAX_CANVAS_W = IS_TOUCH ? 2000 : 2800;           // max. renderbreedte per pagina (px)
const AHEAD = 4, BEHIND = 2;                           // buffer rond de zichtbare pagina's
const STORE_KEY = 'boekviewer:' + CFG.pdf;

const $ = (id) => document.getElementById(id);
const stage = $('stage'), wrap = $('book-wrap');
const slider = $('slider'), pageInput = $('page-input');

/* ── Toestand ── */
let pdf = null, n = 0, bookRatio = 1.414;
let flip = null, pageEls = [], current = -1, portrait = false;
let zoomIdx = 0, needRebuild = false, pending = null;
const pageRatio = [];                                  // per pagina hoogte/breedte
const cache = new Map();                               // idx -> {canvas, w, px, t}
const linkLayers = new Map();                          // idx -> HTMLElement | Promise
let queue = [], job = null;                            // renderwachtrij en lopende render
let soundOn = true;
try { soundOn = localStorage.getItem('boekviewer:sound') !== 'off'; } catch (e) {}

/* ── Configuratie toepassen ── */
document.title = CFG.titel + (CFG.ondertitel ? ' — ' + CFG.ondertitel.split('·')[0].trim() : '');
$('t-titel').textContent = CFG.titel;
$('l-titel').textContent = CFG.titel;
$('t-sub').textContent = CFG.ondertitel;
$('back').href = CFG.terugLink;
$('back-txt').textContent = CFG.terugTekst;
for (const a of [$('dl'), $('err-dl')]) { a.href = CFG.pdf; a.setAttribute('download', CFG.downloadNaam); }

/* ═════════════ Laden ═════════════ */
function fail(msg) {
  $('err-msg').textContent = msg;
  $('loader').classList.add('failed');
}

if (location.protocol === 'file:') {
  fail('Deze pagina moet via een webserver worden geopend (na publicatie, of met een lokale testserver). ' +
       'Browsers laten een PDF niet laden als je het HTML-bestand direct vanaf je schijf opent.');
} else {
  start();
}

function start() {
  // Controle (alleen ter informatie): ondersteunt de server Range Requests?
  fetch(CFG.pdf, { method: 'HEAD' }).then((r) => {
    const ranges = /bytes/i.test(r.headers.get('Accept-Ranges') || '');
    const size = +r.headers.get('Content-Length') || 0;
    console.info('[boekviewer] PDF', CFG.pdf, (size / 1048576).toFixed(1) + ' MB,',
      ranges ? 'server ondersteunt Range Requests: pagina\'s worden per stuk geladen.'
             : 'server meldt GEEN Range Requests: het volledige bestand wordt eerst gedownload.');
    if (!ranges && size && !pdf) $('load-msg').textContent = 'Het boek (' + Math.round(size / 1048576) + ' MB) wordt in zijn geheel geladen…';
  }).catch(() => {});

  const task = pdfjsLib.getDocument({
    url: CFG.pdf,
    rangeChunkSize: 262144,        // 256 kB per verzoek
    disableAutoFetch: true,        // niet op de achtergrond alles ophalen
    disableStream: true,           // gebruik Range Requests i.p.v. één stroom
    isEvalSupported: false,
    standardFontDataUrl: LIB + 'standard_fonts/',
    wasmUrl: LIB + 'wasm/',
    iccUrl: LIB + 'iccs/'
  });
  task.onProgress = ({ loaded, total }) => {
    if (!total || pdf) return;
    const pct = Math.min(100, Math.round(loaded / total * 100));
    if (pct < 100 && loaded > 1048576) {
      const bar = $('l-bar'); bar.classList.add('det'); bar.style.width = pct + '%';
      $('load-msg').textContent = 'Boek laden… ' + pct + '%';
    }
  };
  task.promise.then(async (doc) => {
    pdf = doc; n = doc.numPages;
    const p1 = await doc.getPage(1);
    const vp = p1.getViewport({ scale: 1 });
    bookRatio = vp.height / vp.width;
    pageRatio[0] = bookRatio;
    slider.max = n;
    $('page-total').textContent = n;
    const fromHash = pageFromHash();
    let startIdx = fromHash ?? 0;
    let saved = null;
    if (fromHash == null) {
      try { saved = +localStorage.getItem(STORE_KEY) || null; } catch (e) {}
      if (saved && saved > 1 && saved <= n) startIdx = saved - 1; else saved = null;
    }
    build(startIdx);
    buildToc();
    setTimeout(() => $('loader').classList.add('hide'), 200);
    if (saved) toast('Verder lezen vanaf pagina ' + saved, 'Naar begin', () => goTo(0));
    else toast(IS_TOUCH ? 'Veeg of tik op de rand om te bladeren' : 'Klik of sleep aan een hoek om te bladeren');
  }).catch((err) => {
    console.error(err);
    if (err && err.name === 'PasswordException') fail('Deze PDF is met een wachtwoord beveiligd en kan niet online worden getoond.');
    else if (err && err.name === 'InvalidPDFException') fail('Het bestand "' + CFG.pdf + '" is geen geldige of een beschadigde PDF.');
    else if (err && err.name === 'ResponseException' && (err.missing || err.status === 404)) fail('Het PDF-bestand "' + CFG.pdf + '" is niet gevonden op de server.');
    else if (err && err.name === 'ResponseException') fail('De server gaf een fout (' + (err.status || 'onbekend') + ') bij het ophalen van de PDF.');
    else fail('Het boek kon niet in de browser worden geopend. Je kunt de PDF wel downloaden.');
  });
}

/* ═════════════ Boek opbouwen ═════════════ */
function fitSize() {
  const narrow = innerWidth <= 760;
  const availH = stage.clientHeight - (narrow ? 24 : 48);
  const availW = stage.clientWidth - (narrow ? 20 : 150);
  portrait = availW < availH * 0.95;                       // staand/smal scherm: één pagina
  const h = Math.min(availH, portrait ? availW * bookRatio : availW / 2 * bookRatio);
  const w = Math.floor(h / bookRatio);
  return { w, h: Math.floor(w * bookRatio) };
}

function isHard(i) { return i === 0 || (i === n - 1 && n % 2 === 0); }

function build(startIdx) {
  needRebuild = false;
  const z = ZOOMS[zoomIdx];
  const base = fitSize();
  const w = Math.round(base.w * z), h = Math.round(base.h * z);
  document.body.classList.toggle('portrait', portrait);
  stage.classList.toggle('zoomed', z > 1);

  if (flip) { try { flip.destroy(); } catch (e) {} flip = null; }
  wrap.innerHTML = '';
  const bookEl = document.createElement('div'); bookEl.id = 'book';
  wrap.appendChild(bookEl);
  wrap.style.width = (portrait ? w : w * 2) + 'px';
  wrap.style.height = h + 'px';

  pageEls = [];
  const frag = document.createDocumentFragment();
  for (let i = 0; i < n; i++) {
    const d = document.createElement('div');
    const side = i === 0 ? 'right' : (i % 2 === 1 ? 'left' : 'right');
    d.className = 'page ' + side + (isHard(i) ? ' cover' : '');
    if (isHard(i)) d.dataset.density = 'hard';
    d.innerHTML = '<div class="page-inner"><div class="ph">' + (i + 1) + '</div><div class="box"></div></div><div class="gutter"></div>';
    const box = d.querySelector('.box');
    placeBox(box, i);
    const c = cache.get(i);
    if (c) { box.appendChild(c.canvas); d.classList.add('ready'); }
    const l = linkLayers.get(i);
    if (l instanceof HTMLElement) box.appendChild(l);
    frag.appendChild(d); pageEls.push(d);
  }
  bookEl.appendChild(frag);

  const mouse = z === 1;   // ingezoomd: slepen = schuiven, bladeren via knoppen/toetsen
  flip = new St.PageFlip(bookEl, {
    width: w, height: h, size: 'fixed', autoSize: false,
    showCover: true, usePortrait: true,
    drawShadow: true, maxShadowOpacity: 0.55, flippingTime: 800,
    startPage: Math.max(0, Math.min(startIdx || 0, n - 1)),
    mobileScrollSupport: false, clickEventForward: true,
    useMouseEvents: mouse, showPageCorners: mouse, swipeDistance: 30
  });
  flip.loadFromHTML(pageEls);
  flip.on('flip', (e) => onPage(e.data));
  flip.on('changeOrientation', () => { current = -1; onPage(flip.getCurrentPageIndex()); });
  flip.on('changeState', (e) => {
    if (e.data === 'flipping') playFlip();
    if (e.data === 'read') afterFlip();
  });
  current = -1;
  onPage(flip.getCurrentPageIndex());
}

// Pagina's met een afwijkend formaat behouden hun eigen verhouding (gecentreerd).
function placeBox(box, i) {
  const r = pageRatio[i];
  box.style.cssText = 'position:absolute;inset:0;';
  if (!r || Math.abs(r - bookRatio) < 0.005) return;
  if (r > bookRatio) {
    const wPct = bookRatio / r * 100;
    box.style.cssText = `position:absolute;top:0;bottom:0;width:${wPct}%;left:${(100 - wPct) / 2}%;`;
  } else {
    const hPct = r / bookRatio * 100;
    box.style.cssText = `position:absolute;left:0;right:0;height:${hPct}%;top:${(100 - hPct) / 2}%;`;
  }
}

function busy() { return flip && flip.getState && flip.getState() !== 'read'; }

function afterFlip() {
  if (needRebuild) { build(current); return; }
  if (pending) { const p = pending; pending = null; p(); }
}

let resizeT;
addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { if (!pdf) return; if (busy()) needRebuild = true; else build(current); }, 200);
});

/* ═════════════ Pagina-wissel ═════════════ */
function visiblePages(idx) {
  if (portrait || idx <= 0) return [Math.max(idx, 0)];
  const l = idx % 2 === 1 ? idx : idx - 1;          // linkerpagina van de spread
  return l + 1 < n ? [l, l + 1] : [l];
}

function onPage(idx) {
  if (idx === current) return;
  current = idx;
  const vis = visiblePages(idx);
  const a = vis[0] + 1, b = vis[vis.length - 1] + 1;
  pageInput.value = a === b ? a : a + '–' + b;
  $('pageno').textContent = a === b ? 'Pagina ' + a + ' van ' + n : 'Pagina ' + a + '–' + b + ' van ' + n;
  slider.value = a;
  slider.style.setProperty('--p', ((a - 1) / Math.max(n - 1, 1) * 100) + '%');
  const atStart = idx <= 0, atEnd = vis[vis.length - 1] >= n - 1;
  for (const id of ['prev', 'prev2', 'first']) $(id).disabled = atStart;
  for (const id of ['next', 'next2', 'last']) $(id).disabled = atEnd;
  wrap.classList.toggle('closed-front', idx === 0 && !portrait);
  wrap.classList.toggle('closed-back', !portrait && vis.length === 1 && vis[0] === n - 1 && n > 1);
  try { history.replaceState(null, '', a > 1 ? '#page=' + a : location.pathname + location.search); } catch (e) {}
  try { localStorage.setItem(STORE_KEY, String(a)); } catch (e) {}
  markToc(a);

  const want = vis.slice();
  for (let k = 1; k <= AHEAD; k++) want.push(vis[vis.length - 1] + k);
  for (let k = 1; k <= BEHIND; k++) want.push(vis[0] - k);
  queue = want.filter((x) => x >= 0 && x < n);
  if (job && !queue.includes(job.idx)) job.task && job.task.cancel();   // verouderde render stoppen
  pump();
}

/* ═════════════ Renderen (PDF.js) ═════════════ */
function targetWidth() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const el = pageEls[visiblePages(current)[0]] || pageEls[0];
  const w = el ? el.offsetWidth || parseFloat(wrap.style.width) / (portrait ? 1 : 2) : 500;
  return Math.min(MAX_CANVAS_W, Math.max(300, Math.round(w * dpr * 1.1)));
}

function pump() {
  if (job) return;
  const tw = targetWidth();
  while (queue.length) {
    const idx = queue.shift();
    ensureLinks(idx);
    const c = cache.get(idx);
    if (c && c.w >= tw * 0.92) { c.t = performance.now(); attach(idx, c.canvas); continue; }
    job = { idx };
    renderPage(idx, tw).catch((e) => {
      if (!e || e.name !== 'RenderingCancelledException') console.warn('[boekviewer] render pagina', idx + 1, e);
    }).finally(() => { job = null; pump(); });
    return;
  }
}

async function renderPage(idx, tw) {
  const page = await pdf.getPage(idx + 1);
  const vp1 = page.getViewport({ scale: 1 });
  if (!pageRatio[idx]) { pageRatio[idx] = vp1.height / vp1.width; const b = pageEls[idx] && pageEls[idx].querySelector('.box'); if (b) placeBox(b, idx); }
  if (!job || job.idx !== idx) return;
  const vp = page.getViewport({ scale: tw / vp1.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
  const task = page.render({ canvas, viewport: vp, background: '#ffffff' });
  job.task = task;
  await task.promise;
  const old = cache.get(idx);
  if (old && old.canvas !== canvas) { old.canvas.remove(); old.canvas.width = 0; }
  cache.set(idx, { canvas, w: canvas.width, px: canvas.width * canvas.height, t: performance.now() });
  attach(idx, canvas);
  evict();
}

function attach(idx, canvas) {
  const el = pageEls[idx]; if (!el) return;
  const box = el.querySelector('.box');
  if (canvas.parentNode !== box) box.insertBefore(canvas, box.firstChild);
  el.classList.add('ready');
}

function evict() {
  let total = 0; for (const c of cache.values()) total += c.px;
  if (total <= PIXEL_BUDGET) return;
  const keep = new Set([...visiblePages(current), ...queue]);
  const order = [...cache.entries()].filter(([i]) => !keep.has(i)).sort((a, b) => a[1].t - b[1].t);
  for (const [i, c] of order) {
    if (total <= PIXEL_BUDGET) break;
    c.canvas.remove(); c.canvas.width = 0; total -= c.px; cache.delete(i);
    if (pageEls[i]) pageEls[i].classList.remove('ready');
  }
}

/* ═════════════ Hyperlinks in de PDF ═════════════ */
function ensureLinks(idx) {
  if (linkLayers.has(idx)) return;
  const p = buildLinks(idx).then((el) => {
    linkLayers.set(idx, el);
    const box = pageEls[idx] && pageEls[idx].querySelector('.box');
    if (el && box) box.appendChild(el);
  }).catch((e) => { console.warn('[boekviewer] links pagina', idx + 1, e); linkLayers.set(idx, null); });
  linkLayers.set(idx, p);
}

async function buildLinks(idx) {
  const page = await pdf.getPage(idx + 1);
  const annots = await page.getAnnotations({ intent: 'display' });
  const links = annots.filter((a) => a.subtype === 'Link' && (a.url || a.unsafeUrl || a.dest || a.action));
  if (!links.length) return null;
  const vp = page.getViewport({ scale: 1 });
  const layer = document.createElement('div');
  layer.className = 'links';
  for (const an of links) {
    const [ta, tb, tc, td, te, tf] = vp.transform;   // PDF-coördinaten -> viewport
    const pt = (x, y) => [ta * x + tc * y + te, tb * x + td * y + tf];
    const r = [...pt(an.rect[0], an.rect[1]), ...pt(an.rect[2], an.rect[3])];
    const x = Math.min(r[0], r[2]), y = Math.min(r[1], r[3]);
    const w = Math.abs(r[2] - r[0]), h = Math.abs(r[3] - r[1]);
    const a = document.createElement('a');
    a.style.left = (x / vp.width * 100) + '%';
    a.style.top = (y / vp.height * 100) + '%';
    a.style.width = (w / vp.width * 100) + '%';
    a.style.height = (h / vp.height * 100) + '%';
    const url = an.url || (an.unsafeUrl && /^(https?:|mailto:|tel:)/i.test(an.unsafeUrl) ? an.unsafeUrl : null);
    if (url) {
      a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.title = url.replace(/^mailto:/, '');
    } else if (an.dest) {
      a.href = '#';
      resolveDest(an.dest).then((pi) => { if (pi != null) { a.href = '#page=' + (pi + 1); a.title = 'Ga naar pagina ' + (pi + 1); a.dataset.page = pi; } });
      a.addEventListener('click', (e) => { e.preventDefault(); if (a.dataset.page) goTo(+a.dataset.page); });
    } else if (an.action) {
      const map = { NextPage: () => step(1), PrevPage: () => step(-1), FirstPage: () => goTo(0), LastPage: () => goTo(n - 1) };
      if (!map[an.action]) continue;
      a.href = '#'; a.addEventListener('click', (e) => { e.preventDefault(); map[an.action](); });
    } else continue;
    // klikken op een link mag het bladeren niet starten
    for (const ev of ['mousedown', 'touchstart', 'pointerdown']) a.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    layer.appendChild(a);
  }
  return layer;
}

async function resolveDest(dest) {
  try {
    const d = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
    if (!d) return null;
    if (typeof d[0] === 'number') return d[0];
    return await pdf.getPageIndex(d[0]);
  } catch (e) { return null; }
}

/* ═════════════ Navigatie ═════════════ */
function step(dir) {
  if (!flip) return;
  if (busy()) { pending = () => step(dir); return; }
  dir > 0 ? flip.flipNext() : flip.flipPrev();
}

function goTo(idx) {
  if (!flip) return;
  idx = Math.max(0, Math.min(idx, n - 1));
  if (visiblePages(current).includes(idx)) { onPage(current); return; }
  if (busy()) { pending = () => goTo(idx); return; }
  flip.flip(idx);                                       // met omslaanimatie
  setTimeout(() => { if (!busy() && !visiblePages(current).includes(idx)) { flip.turnToPage(idx); onPage(flip.getCurrentPageIndex()); } }, 1200);
}

function pageFromHash() {
  const m = location.hash.match(/(?:page|pagina)=(\d+)/i);
  return m ? Math.max(0, Math.min(parseInt(m[1], 10) - 1, n - 1)) : null;
}
addEventListener('hashchange', () => { const p = pageFromHash(); if (p != null) goTo(p); });

$('prev').onclick = $('prev2').onclick = () => step(-1);
$('next').onclick = $('next2').onclick = () => step(1);
$('first').onclick = () => goTo(0);
$('last').onclick = () => goTo(n - 1);

slider.oninput = () => {
  const v = +slider.value;
  $('pageno').textContent = 'Pagina ' + v + ' van ' + n;
  slider.style.setProperty('--p', ((v - 1) / Math.max(n - 1, 1) * 100) + '%');
};
slider.onchange = () => goTo(+slider.value - 1);

pageInput.addEventListener('focus', () => pageInput.select());
pageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const v = parseInt(pageInput.value, 10);
    if (v >= 1 && v <= n) goTo(v - 1);
    else { toast('Kies een pagina tussen 1 en ' + n); current = current; onPageRefresh(); }
    pageInput.blur();
  } else if (e.key === 'Escape') { onPageRefresh(); pageInput.blur(); }
  e.stopPropagation();
});
pageInput.addEventListener('blur', () => setTimeout(onPageRefresh, 0));
function onPageRefresh() { const c = current; current = -1; onPage(c); }

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea')) return;
  if (e.key === 'Escape') { closeToc(); return; }
  if (!flip) return;
  switch (e.key) {
    case 'ArrowRight': case 'PageDown': step(1); break;
    case 'ArrowLeft': case 'PageUp': step(-1); break;
    case 'Home': goTo(0); break;
    case 'End': goTo(n - 1); break;
    case '+': case '=': setZoom(zoomIdx + 1); break;
    case '-': case '_': setZoom(zoomIdx - 1); break;
    case '0': setZoom(0); break;
    case 'f': case 'F': toggleFs(); break;
    default: return;
  }
  e.preventDefault();
});

/* Tikken/klikken op de buitenrand van het boek bladert ook (naast hoeken slepen en vegen). */
function edgeTap(clientX, target) {
  if (!flip || ZOOMS[zoomIdx] !== 1 || (target && target.closest('a, button, input'))) return;
  const r = wrap.getBoundingClientRect();
  const fx = (clientX - r.left) / r.width;
  const dir = fx > 0.82 ? 1 : fx < 0.18 ? -1 : 0;
  if (!dir) return;
  const before = current;
  setTimeout(() => { if (current === before && !busy()) step(dir); }, 80);
}
let tap = null;
wrap.addEventListener('touchstart', (e) => { const t = e.changedTouches[0]; tap = { x: t.clientX, y: t.clientY, t: Date.now() }; }, { passive: true, capture: true });
wrap.addEventListener('touchend', (e) => {
  const t = e.changedTouches[0];
  if (tap && Date.now() - tap.t < 300 && Math.hypot(t.clientX - tap.x, t.clientY - tap.y) < 10) edgeTap(t.clientX, e.target);
  tap = null;
}, { passive: true, capture: true });
let down = null;
wrap.addEventListener('mousedown', (e) => { down = { x: e.clientX, y: e.clientY }; }, true);
wrap.addEventListener('mouseup', (e) => {
  if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) edgeTap(e.clientX, e.target);
  down = null;
}, true);

/* ═════════════ Zoomen ═════════════ */
function setZoom(i) {
  i = Math.max(0, Math.min(i, ZOOMS.length - 1));
  if (i === zoomIdx || !pdf) return;
  if (busy()) { pending = () => setZoom(i); return; }
  const cx = (stage.scrollLeft + stage.clientWidth / 2) / Math.max(stage.scrollWidth, 1);
  const cy = (stage.scrollTop + stage.clientHeight / 2) / Math.max(stage.scrollHeight, 1);
  zoomIdx = i;
  build(current);
  $('zoom-val').textContent = Math.round(ZOOMS[i] * 100) + '%';
  $('zoom-out').disabled = i === 0;
  $('zoom-in').disabled = i === ZOOMS.length - 1;
  requestAnimationFrame(() => {
    stage.scrollLeft = cx * stage.scrollWidth - stage.clientWidth / 2;
    stage.scrollTop = cy * stage.scrollHeight - stage.clientHeight / 2;
  });
}
$('zoom-in').onclick = () => setZoom(zoomIdx + 1);
$('zoom-out').onclick = () => setZoom(zoomIdx - 1);
$('zoom-val').onclick = () => setZoom(0);
$('zoom-out').disabled = true;
stage.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  setZoom(zoomIdx + (e.deltaY < 0 ? 1 : -1));
}, { passive: false });

// ingezoomd: slepen met de muis verschuift het beeld
let pan = null;
stage.addEventListener('mousedown', (e) => {
  if (ZOOMS[zoomIdx] === 1 || e.button !== 0 || e.target.closest('a, button, input')) return;
  pan = { x: e.clientX, y: e.clientY, l: stage.scrollLeft, t: stage.scrollTop };
  stage.classList.add('panning'); e.preventDefault();
});
addEventListener('mousemove', (e) => {
  if (!pan) return;
  stage.scrollLeft = pan.l - (e.clientX - pan.x);
  stage.scrollTop = pan.t - (e.clientY - pan.y);
});
addEventListener('mouseup', () => { pan = null; stage.classList.remove('panning'); });

/* ═════════════ Volledig scherm ═════════════ */
function toggleFs() {
  const d = document;
  if (!d.fullscreenElement) (d.documentElement.requestFullscreen || d.documentElement.webkitRequestFullscreen || (() => {})).call(d.documentElement);
  else (d.exitFullscreen || d.webkitExitFullscreen).call(d);
}
$('fs').onclick = toggleFs;
if (!document.fullscreenEnabled && !document.webkitFullscreenEnabled) $('fs').style.display = 'none';

/* ═════════════ Bladergeluid (gegenereerd) ═════════════ */
let actx;
function setSoundIcon() { $('sound').classList.toggle('off', !soundOn); $('sound').querySelector('.wave').style.display = soundOn ? '' : 'none'; }
setSoundIcon();
$('sound').onclick = () => {
  soundOn = !soundOn; setSoundIcon();
  try { localStorage.setItem('boekviewer:sound', soundOn ? 'on' : 'off'); } catch (e) {}
};
function playFlip() {
  if (!soundOn) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const dur = 0.42, sr = actx.sampleRate, len = Math.floor(sr * dur);
    const buf = actx.createBuffer(1, len, sr), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const env = Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.15)), 2) * (1 - t * 0.6);
      d[i] = (Math.random() * 2 - 1) * env * (0.6 + 0.4 * Math.random());
    }
    const src = actx.createBufferSource(); src.buffer = buf;
    const bp = actx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.7;
    bp.frequency.setValueAtTime(900, actx.currentTime);
    bp.frequency.linearRampToValueAtTime(3200, actx.currentTime + dur);
    const g = actx.createGain(); g.gain.value = 0.15;
    src.connect(bp); bp.connect(g); g.connect(actx.destination); src.start();
  } catch (e) {}
}

/* ═════════════ Inhoudsopgave (uit PDF-bladwijzers) ═════════════ */
let tocLinks = [];
async function buildToc() {
  const toc = $('toc');
  try {
    const outline = await pdf.getOutline();
    if (!outline || !outline.length) { toc.innerHTML = '<div class="empty">Deze PDF bevat geen bladwijzers.</div>'; return; }
    const flat = [];
    (function walk(items, depth) {
      for (const it of items) {
        flat.push({ title: it.title, dest: it.dest, depth, part: depth === 0 && it.items && it.items.length > 0 });
        if (it.items) walk(it.items, depth + 1);
      }
    })(outline, 0);
    const pages = await Promise.all(flat.map((f) => (f.dest ? resolveDest(f.dest) : null)));
    toc.innerHTML = '';
    flat.forEach((f, i) => {
      if (pages[i] == null) return;
      const a = document.createElement('a');
      a.href = '#page=' + (pages[i] + 1);
      a.className = f.part ? 'part' : (f.depth > 0 ? 'sub' : '');
      a.innerHTML = '<span></span><span class="pg"></span>';
      a.firstChild.textContent = f.title;
      a.lastChild.textContent = pages[i] + 1;
      a.dataset.page = pages[i] + 1;
      a.onclick = (e) => { e.preventDefault(); closeToc(); setTimeout(() => goTo(pages[i]), 250); };
      toc.appendChild(a); tocLinks.push(a);
    });
    markToc(visiblePages(current)[0] + 1);
  } catch (e) { toc.innerHTML = '<div class="empty">Inhoudsopgave niet beschikbaar.</div>'; }
}
function markToc(p) {
  let best = null;
  for (const a of tocLinks) { a.classList.remove('active'); if (+a.dataset.page <= p) best = a; }
  if (best) best.classList.add('active');
}
function openToc() {
  $('drawer').classList.add('open'); $('scrim').classList.add('show'); $('toc-btn').setAttribute('aria-expanded', 'true');
  const a = $('toc').querySelector('.active'); if (a) a.scrollIntoView({ block: 'center' });
}
function closeToc() { $('drawer').classList.remove('open'); $('scrim').classList.remove('show'); $('toc-btn').setAttribute('aria-expanded', 'false'); }
$('toc-btn').onclick = () => ($('drawer').classList.contains('open') ? closeToc() : openToc());
$('toc-close').onclick = closeToc;
$('scrim').onclick = closeToc;

/* ═════════════ Melding ═════════════ */
let toastT;
function toast(msg, actionLabel, action) {
  const t = $('toast');
  t.textContent = msg;
  if (actionLabel) {
    const b = document.createElement('button'); b.textContent = actionLabel;
    b.onclick = () => { action(); t.classList.remove('show'); };
    t.appendChild(b);
  }
  t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), actionLabel ? 7000 : 4500);
}

// voor tests / debugging
window.__boek = { get current() { return current; }, get n() { return n; }, visiblePages, get cache() { return cache; }, goTo, setZoom, get flip() { return flip; } };
