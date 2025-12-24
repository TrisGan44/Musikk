/* Music Visualizer & Editor — enhanced
 * Fitur:
 * - UI diperbarui (progress bar, volume, speed, info durasi)
 * - Reverse bisa diklik berkali-kali (2x -> balik normal)
 * - Potong (cut) custom dari detik X ke Y
 * - Unduh WAV dari kondisi saat ini (normal/reverse)
 * - Perbaikan state player, visualizer, dan error handling
 */

let audioCtx;
let source = null;
let analyser = null;
let gainNode = null;

let originalBuffer = null;  // buffer asli dari file
let workingBuffer = null;   // buffer setelah edit (cut)
let reversedBuffer = null;  // cache kebalikan dari workingBuffer

let isPlaying = false;
let isReversed = false;
let startStamp = 0;         // audioCtx.currentTime saat start
let pauseOffset = 0;        // detik yang sudah ditempuh saat pause
let rafId = null;

let timelineClips = [];

let vizGain = 1.5;

// Elements
const fileInput   = document.getElementById("fileInput");
const fileMeta    = document.getElementById("fileMeta");
const errorBox    = document.getElementById("error");

const playBtn     = document.getElementById("playBtn");
const stopBtn     = document.getElementById("stopBtn");
const reverseBtn  = document.getElementById("reverseBtn");
const applyCutBtn = document.getElementById("applyCutBtn");
const downloadBtn = document.getElementById("downloadBtn");

const progress    = document.getElementById("progress");
const currentTimeEl = document.getElementById("currentTime");
const durationEl  = document.getElementById("duration");
const volume      = document.getElementById("volume");
const rate        = document.getElementById("rate");
const rateLabel   = document.getElementById("rateLabel");
const vizGainEl   = document.getElementById("vizGain");

const trimStart   = document.getElementById("trimStart");
const trimEnd     = document.getElementById("trimEnd");

const canvas = document.getElementById("visualizer");
const ctx = canvas.getContext("2d");

const timelineRuler = document.getElementById("timelineRuler");
const timelineBody = document.getElementById("timelineBody");
const timelineContent = document.getElementById("timelineContent");
const timelineHover = document.getElementById("timelineHover");
const timelineTrack = document.getElementById("timelineTrack");
const clipTrack = document.getElementById("clipTrack");
const playheadEl = document.getElementById("playhead");
const baseClipEl = document.getElementById("baseClip");
const selectionClip = document.getElementById("selectionClip");
const selectionLabel = document.getElementById("selectionLabel");
const addClipBtn = document.getElementById("addClipBtn");
const addMarkerBtn = document.getElementById("addMarkerBtn");
const zoomInBtn = document.getElementById("zoomInBtn");
const zoomOutBtn = document.getElementById("zoomOutBtn");
const zoomResetBtn = document.getElementById("zoomResetBtn");
const markerLayer = document.getElementById("markerLayer");
const timelineMinimap = document.getElementById("timelineMinimap");

// Helpers
const fmt = s => {
  if (!isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
};

function setError(msg) {
  errorBox.textContent = msg;
  errorBox.hidden = !msg;
}

function enableControls(on) {
  [playBtn, stopBtn, reverseBtn, downloadBtn, progress,
   volume, rate, trimStart, trimEnd, applyCutBtn, addClipBtn,
   zoomInBtn, zoomOutBtn, zoomResetBtn, addMarkerBtn].forEach(el => { if (el) el.disabled = !on; });
}

function resetState() {
  stopPlayback();
  isReversed = false;
  reversedBuffer = null;
  pauseOffset = 0;
  updateReverseBtn();
  updateTimeUI(0, 0);
  setProgress(0);
  timeline.setDuration(getTimelineDuration());
  timeline.updatePlayhead(0, { animate: true });
}

initTimeline();

// File load
fileInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  setError("");
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const arrayBuff = await file.arrayBuffer();
    const decoded = await audioCtx.decodeAudioData(arrayBuff);

    originalBuffer = decoded;
    workingBuffer = decoded;
    reversedBuffer = null;
    timelineClips = [];

    timeline.setDuration(decoded.duration);
    timeline.setClips([]);
    timeline.setSelection(0, Math.min(5, decoded.duration), { syncInputs: true });
    timeline.markers = [];
    timeline.renderMarkers();

    // UI
    fileMeta.hidden = false;
    fileMeta.textContent = `${file.name} — ${(file.size/1024/1024).toFixed(2)} MB • ${decoded.sampleRate} Hz • ${decoded.numberOfChannels} ch`;
    durationEl.textContent = fmt(workingBuffer.duration);
    trimStart.max = decoded.duration.toFixed(2);
    trimEnd.max = decoded.duration.toFixed(2);
    trimEnd.value = Math.min(5, decoded.duration).toFixed(2);

    enableControls(true);
    resetState();
    timeline.updatePlayhead(0);
    timeline.renderSelection();
    timeline.renderRuler();
    timeline.renderMarkers();
    drawVisualizer(); // akan idle sampai analyser dibuat saat playback
    
    // Pindahkan uploader ke bawah setelah file dipilih
    const uploaderSection = document.querySelector('.uploader');
    const container = document.querySelector('.container');
    container.appendChild(uploaderSection);
    
  } catch (err) {
    setError("Gagal memuat audio: " + (err?.message || err));
  }
});

// Playback core
function playFromOffset(offset = 0) {
  stopNode(source);
  source = audioCtx.createBufferSource();
  source.buffer = isReversed ? getReversedBuffer() : workingBuffer;

  // nodes
  gainNode = audioCtx.createGain();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;

  // chain
  source.connect(gainNode);
  gainNode.connect(analyser);
  analyser.connect(audioCtx.destination);

  // params
  gainNode.gain.value = parseFloat(volume.value || "1");
  source.playbackRate.value = parseFloat(rate.value || "1");

  // start
  startStamp = audioCtx.currentTime;
  source.start(0, Math.max(0, Math.min(offset, source.buffer.duration)));
  isPlaying = true;
  playBtn.textContent = "⏸ Jeda";

  source.onended = () => {
    // Jika berakhir alami (bukan stop manual), reset ke awal
    if (isPlaying) {
      isPlaying = false;
      pauseOffset = 0;
      playBtn.textContent = "▶ Putar";
      cancelAnimationFrame(rafId);
      drawFrame(); // render final frame
      setProgress(0);
      updateTimeUI(0, source.buffer.duration);
    }
  };

  drawVisualizer();
  tick();
}

function stopPlayback() {
  if (!audioCtx) return;
  stopNode(source);
  isPlaying = false;
  pauseOffset = 0;
  playBtn.textContent = "▶ Putar";
  cancelAnimationFrame(rafId);
}

function pausePlayback() {
  if (!isPlaying) return;
  pauseOffset = getCurrentOffset();
  stopNode(source);
  isPlaying = false;
  playBtn.textContent = "▶ Lanjut";
  cancelAnimationFrame(rafId);
}

function resumePlayback() {
  playFromOffset(pauseOffset);
}

function stopNode(node) {
  try { node?.stop(0); } catch {}
  try { node?.disconnect(); } catch {}
}

// Timing & UI
function getActiveBuffer() { return isReversed ? getReversedBuffer() : workingBuffer; }

function getCurrentOffset() {
  if (!isPlaying) return pauseOffset;
  const elapsed = audioCtx.currentTime - startStamp;
  const currentRate = source?.playbackRate?.value || parseFloat(rate.value || "1");
  return pauseOffset + elapsed * currentRate;
}

function updateTimeUI(cur, dur) {
  currentTimeEl.textContent = fmt(cur);
  durationEl.textContent = fmt(dur);
}

function setProgress(p01) {
  progress.value = Math.round(p01 * 1000);
}

function updateReverseBtn() {
  reverseBtn.textContent = `🔄 Reverse: ${isReversed ? "ON" : "OFF"}`;
}

// Timeline
class TimelineController {
  constructor(opts) {
    this.duration = 0;
    this.zoom = 1;
    this.minZoom = 1;
    this.maxZoom = 12;
    this.playhead = 0;
    this.selection = { start: 0, end: 0 };
    this.clips = [];
    this.markers = [];
    this.hoverLabel = null;
    this.activeClipId = null;
    this.dragState = null;
    this.snapThreshold = 0.12; // seconds
    this.opts = opts;
    this.init();
  }

  init() {
    const { content, hover, ruler, playhead, selectionEl } = this.opts;
    if (hover) {
      const label = document.createElement("div");
      label.className = "hover-label";
      hover.appendChild(label);
      this.hoverLabel = label;
    }

    if (playhead) {
      playhead.setAttribute("role", "slider");
      playhead.setAttribute("aria-valuemin", "0");
      playhead.addEventListener("pointerdown", (e) => this.startPlayheadDrag(e));
    }

    if (selectionEl) {
      selectionEl.querySelectorAll(".handle").forEach((h) => {
        h.addEventListener("pointerdown", (e) => this.startHandleDrag(e, h.dataset.handle));
      });
    }

    this.bindBodyEvents();
    this.setZoom(1);
  }

  bindBodyEvents() {
    const { body } = this.opts;
    body.addEventListener("pointermove", (e) => this.onHoverMove(e));
    body.addEventListener("pointerleave", () => this.clearHover());
    body.addEventListener("click", (e) => this.onBodyClick(e));
    body.addEventListener("dblclick", (e) => this.onAddMarker(e));
    body.addEventListener("wheel", (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.setZoom(this.zoom + (e.deltaY > 0 ? -0.5 : 0.5));
    }, { passive: false });
  }

  setDuration(dur) {
    this.duration = dur || 0;
    this.selection.end = Math.min(this.selection.end, this.duration);
    this.selection.start = Math.min(this.selection.start, this.selection.end);
    this.markers = this.markers
      .filter((m) => m.time <= this.duration)
      .map((m) => ({ ...m, time: Math.min(m.time, this.duration) }));
    this.renderRuler();
    this.renderSelection();
    this.renderClips();
    this.renderMarkers();
    this.updatePlayhead(this.playhead);
    this.updateBaseLabel();
    this.updateMinimap();
  }

  updateBaseLabel() {
    if (baseClipEl) baseClipEl.textContent = `Audio • ${fmt(this.duration)}`;
  }

  setSelection(start, end, { syncInputs = false } = {}) {
    this.selection = {
      start: Math.max(0, Math.min(this.duration, start)),
      end: Math.max(0, Math.min(this.duration, end))
    };
    if (this.selection.end < this.selection.start) this.selection.end = this.selection.start;
    if (syncInputs) {
      trimStart.value = this.selection.start.toFixed(2);
      trimEnd.value = this.selection.end.toFixed(2);
    }
    this.renderSelection();
  }

  setClips(clips) {
    this.clips = clips || [];
    timelineClips = this.clips;
    this.renderClips();
  }

  setMarkers(markers) {
    this.markers = markers || [];
    this.renderMarkers();
  }

  updatePlayhead(time, { animate = false } = {}) {
    this.playhead = Math.max(0, Math.min(this.duration, time || 0));
    const { playhead: ph } = this.opts;
    if (!ph) return;
    ph.style.transition = animate ? "left 0.12s ease" : "none";
    ph.style.left = `${this.timeToPercent(this.playhead)}%`;
    ph.dataset.time = `${fmt(this.playhead)} | ${this.toTimecode(this.playhead)}`;
    ph.setAttribute("aria-valuenow", this.playhead.toFixed(2));
    ph.setAttribute("aria-valuemax", this.duration.toFixed(2));
    this.highlightRuler();
    this.updateMinimap();
  }

  toTimecode(t) {
    const total = Math.max(0, t || 0);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = (total % 60).toFixed(2).padStart(5, "0");
    return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.padStart(5, "0")}`;
  }

  renderRuler() {
    const { ruler } = this.opts;
    if (!ruler) return;
    ruler.innerHTML = "";
    if (!this.duration) return;

    const segments = Math.min(20, Math.max(6, Math.ceil(this.duration)));
    const step = this.duration / segments;
    const frag = document.createDocumentFragment();
    for (let i = 0; i <= segments; i++) {
      const mark = document.createElement("span");
      const t = i * step;
      mark.textContent = `${fmt(t)} / ${this.toTimecode(t)}`;
      mark.dataset.time = t.toFixed(2);
      frag.appendChild(mark);
    }
    ruler.appendChild(frag);
  }

  renderSelection() {
    const { selectionEl, selectionLabel } = this.opts;
    if (!selectionEl) return;
    const { start, end } = this.selection;
    if (!this.duration || end <= start) {
      selectionEl.hidden = true;
      return;
    }
    selectionEl.hidden = false;
    selectionEl.style.left = `${this.timeToPercent(start)}%`;
    selectionEl.style.width = `${this.timeToPercent(end - start)}%`;
    if (selectionLabel) selectionLabel.textContent = `Trim ${fmt(start)} - ${fmt(Math.min(end, this.duration))}`;
  }

  renderClips() {
    const { clipTrack } = this.opts;
    if (!clipTrack) return;
    clipTrack.innerHTML = "";
    this.clips.forEach((clip, idx) => {
      const el = document.createElement("div");
      el.className = "clip";
      el.dataset.id = clip.id ?? idx;
      el.dataset.start = clip.start;
      el.dataset.duration = clip.duration;
      el.dataset.selected = this.activeClipId === clip.id;
      el.style.left = `${this.timeToPercent(clip.start)}%`;
      el.style.width = `${this.timeToPercent(clip.duration)}%`;
      const label = document.createElement("span");
      label.className = "clip-label";
      label.textContent = `${clip.label || `Klip ${idx + 1}`} (${fmt(clip.duration)})`;
      const del = document.createElement("button");
      del.className = "delete-btn";
      del.type = "button";
      del.textContent = "✕";
      del.title = "Hapus klip";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        this.removeClip(el.dataset.id);
      });
      el.appendChild(label);
      el.appendChild(del);
      el.addEventListener("pointerdown", (e) => this.startClipDrag(e, el));
      el.addEventListener("click", (e) => this.selectClip(el.dataset.id, e));
      clipTrack.appendChild(el);
    });
  }

  renderMarkers() {
    const { markerLayer } = this.opts;
    if (!markerLayer) return;
    markerLayer.innerHTML = "";
    this.markers.forEach((m) => {
      const el = document.createElement("div");
      el.className = "marker";
      el.dataset.label = m.label || fmt(m.time);
      el.style.left = `${this.timeToPercent(m.time)}%`;
      el.addEventListener("click", (evt) => {
        evt.stopPropagation();
        this.opts.onSeek?.(m.time, { animate: true });
      });
      markerLayer.appendChild(el);
    });
  }

  updateMinimap() {
    const { minimap } = this.opts;
    if (!minimap) return;
    minimap.innerHTML = "";
    const windowEl = document.createElement("div");
    windowEl.className = "minimap-window";
    const scrollable = Math.max(1, (this.opts.content.scrollWidth || 1) - (this.opts.body.clientWidth || 1));
    const scrollFrac = (this.opts.body.scrollLeft || 0) / scrollable;
    windowEl.style.left = `${scrollFrac * 100}%`;
    const viewFrac = (this.opts.body.clientWidth || 1) / (this.opts.content.scrollWidth || 1);
    windowEl.style.width = `${Math.max(5, viewFrac * 100)}%`;

    const ph = document.createElement("div");
    ph.className = "minimap-playhead";
    ph.style.left = `${this.timeToPercent(this.playhead)}%`;
    minimap.appendChild(windowEl);
    minimap.appendChild(ph);
  }

  setZoom(z) {
    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, z));
    this.opts.content.style.setProperty("--timeline-zoom", `${this.zoom * 100}%`);
    this.updateMinimap();
    this.opts.onZoomChange?.(this.zoom);
  }

  timeToPercent(time) {
    if (!this.duration) return 0;
    const clamped = Math.max(0, Math.min(this.duration, time));
    return (clamped / this.duration) * 100;
  }

  percentToTime(p) { return (p / 100) * (this.duration || 0); }

  timeFromClient(e) {
    const { content, body } = this.opts;
    const rect = content.getBoundingClientRect();
    const x = e.clientX - rect.left + body.scrollLeft;
    const frac = Math.max(0, Math.min(1, x / rect.width));
    return frac * this.duration;
  }

  onHoverMove(e) {
    if (!this.duration) return;
    const t = this.timeFromClient(e);
    if (this.hoverLabel) {
      this.hoverLabel.textContent = `${fmt(t)} (${this.toTimecode(t)})`;
      this.hoverLabel.style.left = `${((e.clientX - this.opts.body.getBoundingClientRect().left) + this.opts.body.scrollLeft)}px`;
    }
    this.opts.hover.classList.add("show");
    this.opts.hover.style.setProperty("--hover-pos", `${this.timeToPercent(t)}%`);
    this.opts.hover.style.setProperty("--hover-client", `${(e.clientX - this.opts.body.getBoundingClientRect().left) + this.opts.body.scrollLeft}px`);
  }

  clearHover() {
    this.opts.hover?.classList.remove("show");
  }

  onBodyClick(e) {
    const t = this.timeFromClient(e);
    this.opts.onSeek?.(t, { animate: true });
  }

  onAddMarker(e) {
    if (!this.duration) return;
    const t = this.timeFromClient(e);
    this.markers.push({ time: t, label: `Mark ${this.markers.length + 1}` });
    this.renderMarkers();
  }

  startHandleDrag(e, handle) {
    if (!this.duration) return;
    e.preventDefault();
    const start = this.selection.start;
    const end = this.selection.end;
    this.dragState = { type: "handle", handle, start, end };
    window.addEventListener("pointermove", this.handleDragMove);
    window.addEventListener("pointerup", this.handleDragEnd);
  }

  handleDragMove = (e) => {
    if (!this.dragState || this.dragState.type !== "handle") return;
    const time = this.timeFromClient(e);
    const snap = Math.abs(time - this.playhead) < this.snapThreshold ? this.playhead : time;
    let { start, end } = this.dragState;
    if (this.dragState.handle === "start") start = Math.min(snap, end);
    else end = Math.max(snap, start);
    this.setSelection(start, end, { syncInputs: true });
    this.opts.onSelectionChange?.(this.selection);
  };

  handleDragEnd = () => {
    this.dragState = null;
    window.removeEventListener("pointermove", this.handleDragMove);
    window.removeEventListener("pointerup", this.handleDragEnd);
  };

  startPlayheadDrag(e) {
    e.preventDefault();
    this.resumeAfterDrag = isPlaying;
    if (isPlaying) pausePlayback();
    this.dragState = { type: "playhead" };
    window.addEventListener("pointermove", this.playheadDragMove);
    window.addEventListener("pointerup", this.playheadDragEnd);
  }

  playheadDragMove = (e) => {
    const t = this.timeFromClient(e);
    this.updatePlayhead(t);
    this.opts.onSeek?.(t, { animate: false, live: true });
  };

  playheadDragEnd = (e) => {
    const t = this.timeFromClient(e);
    this.opts.onSeek?.(t, { animate: false });
    this.dragState = null;
    window.removeEventListener("pointermove", this.playheadDragMove);
    window.removeEventListener("pointerup", this.playheadDragEnd);
    if (this.resumeAfterDrag) {
      playFromOffset(pauseOffset);
      this.resumeAfterDrag = false;
    }
  };

  startClipDrag(e, el) {
    e.preventDefault();
    const id = el.dataset.id;
    const clip = this.clips.find((c) => `${c.id ?? c.index}` === `${id}`);
    if (!clip) return;
    this.activeClipId = clip.id ?? this.clips.indexOf(clip);
    const startX = e.clientX;
    const initialStart = clip.start;
    const rect = this.opts.content.getBoundingClientRect();
    const factor = this.duration / rect.width;
    this.dragState = { type: "clip", id, startX, initialStart, factor };
    window.addEventListener("pointermove", this.clipDragMove);
    window.addEventListener("pointerup", this.clipDragEnd);
    this.renderClips();
  }

  clipDragMove = (e) => {
    if (!this.dragState || this.dragState.type !== "clip") return;
    const deltaPx = e.clientX - this.dragState.startX;
    const deltaTime = deltaPx * this.dragState.factor;
    const target = this.clips.find((c) => `${c.id ?? this.clips.indexOf(c)}` === `${this.dragState.id}`);
    if (!target) return;
    target.start = Math.max(0, Math.min(this.duration - target.duration, this.dragState.initialStart + deltaTime));
    this.renderClips();
  };

  clipDragEnd = () => {
    this.dragState = null;
    window.removeEventListener("pointermove", this.clipDragMove);
    window.removeEventListener("pointerup", this.clipDragEnd);
    this.opts.onClipsChange?.(this.clips);
  };

  selectClip(id) {
    this.activeClipId = id;
    this.renderClips();
  }

  removeClip(id) {
    this.clips = this.clips.filter((c, idx) => `${c.id ?? idx}` !== `${id}`);
    this.opts.onClipsChange?.(this.clips);
    this.renderClips();
  }

  highlightRuler() {
    const { ruler } = this.opts;
    if (!ruler) return;
    const marks = [...ruler.querySelectorAll("span")];
    marks.forEach((m) => m.classList.remove("active"));
    const closest = marks.reduce((acc, el) => {
      const t = parseFloat(el.dataset.time || "0");
      const diff = Math.abs(t - this.playhead);
      if (!acc || diff < acc.diff) return { el, diff };
      return acc;
    }, null);
    closest?.el?.classList.add("active");
  }
}

let timeline;

function initTimeline() {
  timeline = new TimelineController({
    body: timelineBody,
    content: timelineContent,
    hover: timelineHover,
    ruler: timelineRuler,
    playhead: playheadEl,
    selectionEl: selectionClip,
    selectionLabel,
    clipTrack,
    markerLayer,
    minimap: timelineMinimap,
    onSeek: (time, { animate, live } = {}) => {
      seekTo(time, { animate, keepPlaying: !live });
    },
    onSelectionChange: ({ start, end }) => {
      trimStart.value = start.toFixed(2);
      trimEnd.value = end.toFixed(2);
    },
    onClipsChange: (clips) => {
      timelineClips = clips;
    },
    onZoomChange: () => {
      timeline.updateMinimap();
    }
  });
  timeline.setDuration(0);
}

function getTimelineDuration() {
  return timeline?.duration || getActiveBuffer()?.duration || 0;
}

function seekTo(time, { animate = true, keepPlaying = true } = {}) {
  const dur = getTimelineDuration();
  pauseOffset = Math.max(0, Math.min(dur, time));
  setProgress(dur ? pauseOffset / dur : 0);
  updateTimeUI(pauseOffset, dur);
  timeline.updatePlayhead(pauseOffset, { animate });
  if (isPlaying && keepPlaying) playFromOffset(pauseOffset);
}

// Animator
function tick() {
  const buf = getActiveBuffer();
  const dur = buf?.duration || 0;
  const cur = Math.min(getCurrentOffset(), dur);
  setProgress(dur ? cur / dur : 0);
  updateTimeUI(cur, dur);
  timeline.updatePlayhead(cur);
  rafId = requestAnimationFrame(tick);
}

// Visualizer
function drawVisualizer() {
  if (!analyser) { drawFrame(true); return; }
  const dataArray = new Uint8Array(analyser.frequencyBinCount);

  function loop() {
    rafId = requestAnimationFrame(loop);
    analyser.getByteFrequencyData(dataArray);
    drawBars(dataArray);
  }
  loop();
}

function drawFrame(idle=false) {
  const w = canvas.width, h = canvas.height;
  // bg - konsisten hitam
  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, w, h);

  if (idle) {
    ctx.fillStyle = "#22304b";
    ctx.font = "14px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto";
    ctx.fillText("Unggah audio untuk mulai ▶", 16, 24);
    return;
  }
}

function drawBars(arr) {
  const w = canvas.width, h = canvas.height;
  drawFrame(); // background

  const barCount = Math.floor(arr.length / 2); // ambil setengah agar bar tidak terlalu padat
  const barW = (w / barCount) * 0.85;
  let x = 0;

  for (let i = 0; i < barCount; i++) {
    const v = arr[i] / 255;
    const barH = Math.pow(v, 1.5) * h * (vizGain || 1.5);

    // bar
    ctx.fillStyle = "#00ff88";
    ctx.fillRect(x, h - barH, barW, barH);

    // glow top
    const grad = ctx.createLinearGradient(0, h - barH, 0, h);
    grad.addColorStop(0, "rgba(0,255,136,.6)");
    grad.addColorStop(1, "rgba(0,255,136,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(x, h - barH - 8, barW, 8);

    x += (w / barCount);
  }
}

// Reverse util
function getReversedBuffer() {
  if (!workingBuffer) return null;
  if (reversedBuffer && reversedBuffer.length === workingBuffer.length) return reversedBuffer;

  const b = workingBuffer;
  const newBuf = audioCtx.createBuffer(b.numberOfChannels, b.length, b.sampleRate);
  for (let ch = 0; ch < b.numberOfChannels; ch++) {
    const src = b.getChannelData(ch);
    const dst = new Float32Array(src.length);
    for (let i = 0, j = src.length - 1; i < src.length; i++, j--) dst[i] = src[j];
    newBuf.copyToChannel(dst, ch);
  }
  reversedBuffer = newBuf;
  return reversedBuffer;
}

// Event handlers
playBtn.addEventListener("click", () => {
  if (!workingBuffer || !audioCtx) return;
  if (!isPlaying) {
    if (pauseOffset === 0) playFromOffset(0);
    else resumePlayback();
  } else {
    pausePlayback();
  }
});

stopBtn.addEventListener("click", () => {
  if (!workingBuffer || !audioCtx) return;
  stopPlayback();
  pauseOffset = 0;
  setProgress(0);
  updateTimeUI(0, getActiveBuffer()?.duration || 0);
  timeline.updatePlayhead(0, { animate: true });
});

reverseBtn.addEventListener("click", () => {
  if (!workingBuffer || !audioCtx) return;
  // hitung posisi relatif sekarang
  const curBuf = getActiveBuffer();
  const dur = curBuf.duration || 0;
  const cur = Math.min(getCurrentOffset(), dur);
  const frac = dur ? cur / dur : 0;

  isReversed = !isReversed;
  updateReverseBtn();

  // ganti buffer aktif, mulai dari posisi fraksional yang sama
  const newBuf = getActiveBuffer();
  const newDur = newBuf?.duration || 0;
  const newOffset = newDur * frac;

  timeline.setDuration(newDur);
  timeline.updatePlayhead(newOffset, { animate: true });

  if (isPlaying) playFromOffset(newOffset);
  else pauseOffset = newOffset;
});

downloadBtn.addEventListener("click", () => {
  if (!workingBuffer) return;
  const buf = getActiveBuffer() || workingBuffer;
  const wav = audioBufferToWav(buf);
  const blob = new Blob([wav], { type: "audio/wav" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = isReversed ? "output_reversed.wav" : "output.wav";
  a.click();
  URL.revokeObjectURL(url);
});

applyCutBtn.addEventListener("click", () => {
  if (!workingBuffer || !audioCtx) return;
  const start = Math.max(0, parseFloat(trimStart.value) || 0);
  const end = Math.max(0, parseFloat(trimEnd.value) || 0);
  const dur = workingBuffer.duration;

  if (start >= end) return setError("Rentang potong tidak valid (start harus < end).");
  if (start >= dur) return setError("Start berada di luar durasi audio.");
  if (end > dur + 1e-6) return setError("End melebihi durasi audio.");

  setError("");

  const length = Math.max(1, Math.floor((end - start) * workingBuffer.sampleRate));
  const cut = audioCtx.createBuffer(workingBuffer.numberOfChannels, length, workingBuffer.sampleRate);
  for (let ch = 0; ch < workingBuffer.numberOfChannels; ch++) {
    const src = workingBuffer.getChannelData(ch).slice(
      Math.floor(start * workingBuffer.sampleRate),
      Math.floor(end * workingBuffer.sampleRate)
    );
    cut.copyToChannel(src, ch);
  }

  workingBuffer = cut;
  reversedBuffer = null; // invalidasi cache
  timelineClips = timelineClips
    .filter(c => c.start < workingBuffer.duration)
    .map(c => ({
      ...c,
      duration: Math.min(c.duration, workingBuffer.duration - c.start)
    }));
  // reset playback ke awal
  pauseOffset = 0;
  stopPlayback();
  durationEl.textContent = fmt(workingBuffer.duration);
  setProgress(0);
  updateTimeUI(0, workingBuffer.duration);
  // sesuaikan batas input
  trimStart.max = workingBuffer.duration.toFixed(2);
  trimEnd.max = workingBuffer.duration.toFixed(2);
  trimStart.value = 0;
  trimEnd.value = Math.min(5, workingBuffer.duration).toFixed(2);
  timeline.setDuration(workingBuffer.duration);
  timeline.setSelection(0, Math.min(5, workingBuffer.duration), { syncInputs: true });
  timeline.setClips(timelineClips);
  timeline.updatePlayhead(0, { animate: true });
});

progress.addEventListener("input", () => {
  const buf = getActiveBuffer();
  const dur = buf?.duration || 0;
  const frac = parseInt(progress.value, 10) / 1000;
  const cur = dur * frac;
  seekTo(cur, { animate: true, keepPlaying: false });
});

progress.addEventListener("change", () => {
  const buf = getActiveBuffer();
  const dur = buf?.duration || 0;
  const frac = parseInt(progress.value, 10) / 1000;
  seekTo(dur * frac, { animate: true });
});

volume.addEventListener("input", () => {
  const v = parseFloat(volume.value || "1");
  if (gainNode) gainNode.gain.value = v;
});

rate.addEventListener("input", () => {
  const r = parseFloat(rate.value || "1");
  rateLabel.textContent = `${r.toFixed(2)}×`;
  const cur = getCurrentOffset();
  pauseOffset = Math.min(cur, getTimelineDuration());
  startStamp = audioCtx?.currentTime || 0;
  if (source) source.playbackRate.value = r;
  if (isPlaying) playFromOffset(pauseOffset);
});

vizGainEl.addEventListener("input", () => {
  vizGain = parseFloat(vizGainEl.value || "1.5");
});

timelineBody.addEventListener("scroll", () => {
  timeline.updateMinimap();
});

zoomInBtn.addEventListener("click", () => timeline.setZoom(timeline.zoom + 0.5));
zoomOutBtn.addEventListener("click", () => timeline.setZoom(timeline.zoom - 0.5));
zoomResetBtn.addEventListener("click", () => timeline.setZoom(1));

addMarkerBtn.addEventListener("click", () => {
  const time = Math.min(pauseOffset, getTimelineDuration());
  timeline.markers.push({ time, label: `Mark ${timeline.markers.length + 1}` });
  timeline.renderMarkers();
});

[trimStart, trimEnd].forEach(el => {
  el.addEventListener("input", () => {
    const start = Math.max(0, parseFloat(trimStart.value) || 0);
    const end = Math.max(start, parseFloat(trimEnd.value) || 0);
    timeline.setSelection(start, end);
  });
});

addClipBtn.addEventListener("click", () => {
  if (!workingBuffer || !audioCtx) return;
  const start = Math.max(0, parseFloat(trimStart.value) || 0);
  const end = Math.max(0, parseFloat(trimEnd.value) || 0);
  const dur = workingBuffer.duration;
  if (start >= end || start >= dur) return setError("Rentang klip tidak valid.");
  setError("");
  const clip = {
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${timelineClips.length}`,
    start,
    duration: Math.min(end, dur) - start,
    label: `Klip ${timelineClips.length + 1}`
  };
  timelineClips.push(clip);
  timeline.setClips(timelineClips);
});

// Utils
function audioBufferToWav(buffer) {
  const numOfChan = buffer.numberOfChannels;
  const length = buffer.length * numOfChan * 2 + 44;
  const bufferArray = new ArrayBuffer(length);
  const view = new DataView(bufferArray);
  const channels = [];
  let sample;
  let offset = 0;
  let pos = 0;

  setUint32(0x46464952); // "RIFF"
  setUint32(length - 8);
  setUint32(0x45564157); // "WAVE"

  setUint32(0x20746d66); // "fmt "
  setUint32(16);
  setUint16(1);
  setUint16(numOfChan);
  setUint32(buffer.sampleRate);
  setUint32(buffer.sampleRate * 2 * numOfChan);
  setUint16(numOfChan * 2);
  setUint16(16);

  setUint32(0x61746164); // "data"
  setUint32(length - pos - 4);

  for (let i = 0; i < numOfChan; i++) channels.push(buffer.getChannelData(i));

  while (pos < length) {
    for (let i = 0; i < numOfChan; i++) {
      sample = Math.max(-1, Math.min(1, channels[i][offset] || 0));
      sample = (sample * 0x7fff) | 0;
      view.setInt16(pos, sample, true);
      pos += 2;
    }
    offset++;
  }
  return bufferArray;

  function setUint16(data) {
    view.setUint16(pos, data, true);
    pos += 2;
  }
  function setUint32(data) {
    view.setUint32(pos, data, true);
    pos += 4;
  }
}

// Ensure canvas resolution matches CSS size (for HiDPI)
function resizeCanvasToDisplaySize() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}
window.addEventListener("resize", resizeCanvasToDisplaySize);
resizeCanvasToDisplaySize();

// Keyboard shortcuts
window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  const frameStep = e.shiftKey ? 0.5 : 1 / 30;
  const dur = getTimelineDuration();
  if (e.code === "Space") {
    e.preventDefault();
    playBtn.click();
  } else if (e.key.toLowerCase() === "r") {
    reverseBtn.click();
  } else if (e.code === "ArrowRight") {
    e.preventDefault();
    seekTo(Math.min(dur, pauseOffset + frameStep), { keepPlaying: false });
  } else if (e.code === "ArrowLeft") {
    e.preventDefault();
    seekTo(Math.max(0, pauseOffset - frameStep), { keepPlaying: false });
  } else if (e.key.toLowerCase() === "i") {
    e.preventDefault();
    timeline.setSelection(pauseOffset, timeline.selection.end || pauseOffset + 0.1, { syncInputs: true });
  } else if (e.key.toLowerCase() === "o") {
    e.preventDefault();
    timeline.setSelection(timeline.selection.start, pauseOffset, { syncInputs: true });
  } else if (e.key === "Delete") {
    if (timeline.activeClipId) timeline.removeClip(timeline.activeClipId);
  } else if (e.key === "[") {
    const prev = [...timeline.clips].filter(c => c.start < pauseOffset).sort((a,b)=>b.start-a.start)[0];
    if (prev) seekTo(prev.start, { animate: true });
  } else if (e.key === "]") {
    const next = [...timeline.clips].filter(c => c.start > pauseOffset).sort((a,b)=>a.start-b.start)[0];
    if (next) seekTo(next.start, { animate: true });
  }
});
