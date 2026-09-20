// main.js — Fieldcraft front end.
// Thin: it owns the DOM and the order of operations. The pipeline lives in
// engine/sampler.js (field -> slabs), engine/voxelize.js (slabs -> cells) and
// engine/blockcore (cells -> blocks -> files).

import { parseBundle, serializeBundle, BundleError } from './engine/bundle.js';
import { loadTestBundle } from './engine/testfields.js';
import { FieldSampler, SamplerError } from './engine/sampler.js';
import { voxelizeSlab, MODE } from './engine/voxelize.js';
import {
  VoxelGrid, BlockPalette, meshGrid, buildMcStructure, splitGrid,
  placementGuide, buildMcPack, ZipWriter, sanitizeId, BLOCKCORE_VERSION,
} from './engine/blockcore/index.js';
import { Preview } from './engine/preview.js';

export const FIELDCRAFT_VERSION = '0.1.0';

const $ = id => document.getElementById(id);
const state = {
  bundle: null,
  grid: null,
  mesh: null,
  split: null,
  res: 256,
  sampler: null,
  preview: null,
  abort: null,
};

// --- logging ---------------------------------------------------------------

function log(msg, cls) {
  const el = $('log');
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = msg;
  el.appendChild(line);
  while (el.childElementCount > 120) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}
function clearLog() { $('log').textContent = ''; }

// --- bundle ----------------------------------------------------------------

function applyBundle(bundle) {
  state.bundle = bundle;
  state.grid = null;
  state.split = null;
  if (state.preview) state.preview.clear();
  $('exportPack').disabled = true;
  $('exportStructure').disabled = true;
  setStats(null);

  const b = bundle.bounds;
  const srcApp = bundle.source && bundle.source.app ? ` · from ${bundle.source.app}` : '';
  $('fieldInfo').textContent =
    `${bundle.name}${srcApp} · ${bundle.glsl.de.signature} · box ` +
    `${b.min.map(n => +n.toFixed(3)).join(', ')} → ${b.max.map(n => +n.toFixed(3)).join(', ')}`;
  $('name').value = sanitizeId(bundle.name, 'field');
  $('iso').value = String(bundle.isoOffset);
  $('isoOut').textContent = bundle.isoOffset.toFixed(3);

  if (bundle.hints && bundle.hints.suggestedRes) {
    setRes(Math.max(16, Math.min(512, bundle.hints.suggestedRes | 0)));
  }
  buildUniformControls(bundle);
  log(`Loaded "${bundle.name}" — ${bundle.uniforms.length} parameter(s).`, 'ok');
}

function buildUniformControls(bundle) {
  const host = $('uniforms');
  host.textContent = '';
  for (const u of bundle.uniforms) {
    const wrap = document.createElement('label');
    const head = document.createElement('div');
    head.className = 'lbl';
    const name = document.createElement('b');
    name.textContent = u.label || u.name;
    const val = document.createElement('i');
    head.append(name, val);
    wrap.append(head);

    const isScalar = u.type === 'float' || u.type === 'int';
    const isBool = u.type === 'bool';

    if (isBool) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!u.value;
      cb.addEventListener('change', () => { u.value = cb.checked; val.textContent = cb.checked ? 'on' : 'off'; });
      val.textContent = u.value ? 'on' : 'off';
      wrap.append(cb);
    } else if (isScalar && u.min !== undefined && u.max !== undefined) {
      const r = document.createElement('input');
      r.type = 'range';
      r.min = u.min; r.max = u.max;
      r.step = u.step !== undefined ? u.step : (u.type === 'int' ? 1 : (u.max - u.min) / 200);
      r.value = Array.isArray(u.value) ? u.value[0] : u.value;
      const show = v => (u.type === 'int' ? String(v | 0) : Number(v).toFixed(3));
      val.textContent = show(r.value);
      r.addEventListener('input', () => {
        u.value = u.type === 'int' ? parseInt(r.value, 10) : parseFloat(r.value);
        val.textContent = show(r.value);
      });
      wrap.append(r);
    } else {
      const arity = Array.isArray(u.value) ? u.value.length : 1;
      val.textContent = u.type;
      const row = document.createElement('div');
      row.className = 'row';
      for (let i = 0; i < arity; i++) {
        const n = document.createElement('input');
        n.type = 'number';
        n.step = 'any';
        n.value = Array.isArray(u.value) ? u.value[i] : u.value;
        n.addEventListener('change', () => {
          const parsed = parseFloat(n.value);
          if (Number.isNaN(parsed)) return;
          if (Array.isArray(u.value)) u.value[i] = parsed;
          else u.value = parsed;
        });
        row.append(n);
      }
      wrap.append(row);
    }
    host.append(wrap);
  }
}

function setRes(v) {
  state.res = v;
  $('res').value = String(Math.round(v / 16) * 16);
  $('resOut').textContent = `${v}³`;
}

// --- build -----------------------------------------------------------------

const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));

async function build() {
  if (!state.bundle) return;
  clearLog();
  $('build').disabled = true;
  $('cancel').disabled = false;
  $('exportPack').disabled = true;
  $('exportStructure').disabled = true;
  state.abort = new AbortController();

  const started = performance.now();
  const res = state.res;
  const mode = $('mode').value === 'shell' ? MODE.SHELL : MODE.SOLID;
  const thickness = parseInt($('thickness').value, 10);
  const budget = Math.max(1000, parseInt($('budget').value, 10) || 1e6);
  const grid = new VoxelGrid({ budget });

  try {
    if (!state.sampler) state.sampler = new FieldSampler();
    log(`Sampling ${res}³ …`);
    let inside = 0;

    const layout = await state.sampler.sample(
      state.bundle,
      { res, isoOffset: parseFloat($('iso').value), signal: state.abort.signal },
      async (pixels, lay, slab, i) => {
        const r = voxelizeSlab(grid, pixels, lay, slab, { mode, shellThickness: thickness });
        inside += r.inside;
        if (i % 2 === 0 || i === lay.slabs.length - 1) {
          setStats({ cells: grid.size, note: `slab ${i + 1}/${lay.slabs.length}` });
          await nextFrame();
        }
        if (grid.truncated) throw new SamplerError(`Cell budget of ${budget.toLocaleString()} reached`);
      });

    log(`Atlas ${layout.atlasW}×${layout.atlasH}, ${layout.slabs.length} slab(s), ${layout.perSlab} slices each.`);
    log(`${inside.toLocaleString()} cells inside the surface, ${grid.size.toLocaleString()} kept.`);

    state.grid = grid;
    const palette = currentPalette();
    const mesh = meshGrid(grid, { palette });
    state.mesh = mesh;
    const bounds = grid.bounds();
    state.preview.setMesh(mesh, bounds);

    const chunk = parseInt($('chunk').value, 10);
    state.split = splitGrid(grid, { chunk: [chunk, chunk, chunk] });

    setStats({
      cells: grid.size,
      faces: mesh.quadCount,
      bounds,
      pieces: state.split.chunks.length,
      note: `${((performance.now() - started) / 1000).toFixed(2)}s`,
    });
    log(`Merged mesh: ${mesh.quadCount.toLocaleString()} quads.`, 'ok');
    $('exportPack').disabled = grid.size === 0;
    $('exportStructure').disabled = grid.size === 0;
  } catch (e) {
    if (e instanceof SamplerError && /cancel/i.test(e.message)) log('Cancelled.');
    else log(String(e.message || e), 'err');
    if (e && e.stack && !(e instanceof SamplerError || e instanceof BundleError)) console.error(e);
  } finally {
    $('build').disabled = false;
    $('cancel').disabled = true;
    state.abort = null;
  }
}

function currentPalette() {
  return new BlockPalette({ flattened: $('flattened').value === '1' });
}

function setStats(s) {
  $('sCells').textContent = s && s.cells !== undefined ? s.cells.toLocaleString() : '—';
  $('sFaces').textContent = s && s.faces !== undefined ? s.faces.toLocaleString() : '—';
  $('sBounds').textContent = s && s.bounds ? s.bounds.size.join(' × ') : '—';
  $('sPieces').textContent = s && s.pieces !== undefined ? String(s.pieces) : '—';
  const note = $('sNote');
  note.textContent = s && s.note ? s.note : '';
  note.className = s && s.warn ? 'warn' : '';
}

// --- export ----------------------------------------------------------------

function download(filename, data, type) {
  const blob = new Blob([data], { type: type || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function buildPieces() {
  const palette = currentPalette();
  const baseName = sanitizeId($('name').value, 'field');
  const split = state.split;
  const pieces = [];
  for (const c of split.chunks) {
    const s = buildMcStructure(c.grid, { palette });
    pieces.push({
      name: split.chunks.length > 1 ? `${baseName}_${String(c.index).padStart(3, '0')}` : baseName,
      bytes: s.bytes,
      size: s.size,
      blocks: s.blocks,
      chunk: c,
    });
  }
  return { pieces, baseName, split };
}

function exportPack() {
  if (!state.grid) return;
  try {
    const { pieces, baseName, split } = buildPieces();
    const guide = placementGuide(split, { namespace: 'fieldcraft', baseName });
    const pack = buildMcPack({
      name: `Fieldcraft — ${baseName}`,
      description: `${state.bundle.name}, ${state.grid.size.toLocaleString()} blocks, built with Fieldcraft ${FIELDCRAFT_VERSION}`,
      namespace: 'fieldcraft',
      structures: pieces,
      extraFiles: [{ path: 'placement-guide.txt', data: guide }],
    });
    download(`${baseName}-v${FIELDCRAFT_VERSION}.mcpack`, pack.bytes);
    log(`Wrote ${pieces.length} structure(s) into the pack. Load with:`, 'ok');
    log(`/structure load fieldcraft:${pieces[0].name} ~ ~ ~`);
    if (pieces.length > 1) log('placement-guide.txt inside the pack lists every offset.');
  } catch (e) {
    log(String(e.message || e), 'err');
  }
}

function exportStructure() {
  if (!state.grid) return;
  try {
    const { pieces, baseName, split } = buildPieces();
    if (pieces.length === 1) {
      download(`${baseName}-v${FIELDCRAFT_VERSION}.mcstructure`, pieces[0].bytes);
      log(`Wrote ${baseName}.mcstructure — ${pieces[0].size.join('×')}, ${pieces[0].blocks.toLocaleString()} blocks.`, 'ok');
      return;
    }
    const zip = new ZipWriter();
    for (const p of pieces) zip.add(`${p.name}.mcstructure`, p.bytes);
    zip.add('placement-guide.txt', placementGuide(split, { namespace: 'fieldcraft', baseName }));
    download(`${baseName}-v${FIELDCRAFT_VERSION}-pieces.zip`, zip.build(), 'application/zip');
    log(`Wrote ${pieces.length} pieces plus the placement guide.`, 'ok');
  } catch (e) {
    log(String(e.message || e), 'err');
  }
}

// --- input -----------------------------------------------------------------

async function loadFile(file) {
  try {
    const bundle = parseBundle(await file.text());
    applyBundle(bundle);
    const opt = $('customOption');
    opt.textContent = file.name;
    opt.hidden = false;
    opt.disabled = false;
    $('fieldSelect').value = '';
  } catch (e) {
    log(`${file.name}: ${e.message}`, 'err');
  }
}

function wire() {
  $('build').addEventListener('click', build);
  $('cancel').addEventListener('click', () => { if (state.abort) state.abort.abort(); });

  $('fieldSelect').addEventListener('change', e => {
    if (!e.target.value) return;
    applyBundle(loadTestBundle(e.target.value));
  });

  $('loadBundle').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', e => {
    if (e.target.files[0]) loadFile(e.target.files[0]);
    e.target.value = '';
  });
  $('saveBundle').addEventListener('click', () => {
    if (!state.bundle) return;
    download(`${sanitizeId(state.bundle.name)}.fieldbundle.json`,
      serializeBundle(state.bundle), 'application/json');
  });

  $('res').addEventListener('input', e => setRes(parseInt(e.target.value, 10)));
  $('iso').addEventListener('input', e => { $('isoOut').textContent = parseFloat(e.target.value).toFixed(3); });
  $('thickness').addEventListener('input', e => {
    $('thickOut').textContent = `${e.target.value} cell${e.target.value === '1' ? '' : 's'}`;
  });
  $('chunk').addEventListener('input', e => { $('chunkOut').textContent = `${e.target.value}³`; });
  $('mode').addEventListener('change', e => {
    $('thickWrap').classList.toggle('hidden', e.target.value !== 'shell');
  });
  $('thickWrap').classList.add('hidden');

  $('exportPack').addEventListener('click', exportPack);
  $('exportStructure').addEventListener('click', exportStructure);

  const stop = e => { e.preventDefault(); e.stopPropagation(); };
  window.addEventListener('dragover', e => { stop(e); document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', e => { stop(e); if (!e.relatedTarget) document.body.classList.remove('dragging'); });
  window.addEventListener('drop', e => {
    stop(e);
    document.body.classList.remove('dragging');
    const f = e.dataTransfer.files[0];
    if (f) loadFile(f);
  });
}

// --- boot ------------------------------------------------------------------

function boot() {
  document.title = `Fieldcraft ${FIELDCRAFT_VERSION}`;
  $('buildStamp').textContent = `v${FIELDCRAFT_VERSION} · blockcore ${BLOCKCORE_VERSION}`;

  try {
    state.preview = new Preview($('view'));
  } catch (e) {
    log(String(e.message || e), 'err');
  }
  wire();
  setRes(256);
  applyBundle(loadTestBundle('sphere'));
  log('Ready. Built-in sphere loaded; pick Menger sponge to exercise the spliced path.');
}

boot();
