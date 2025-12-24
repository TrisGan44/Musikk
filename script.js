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
const timelineTrack = document.getElementById("timelineTrack");
const clipTrack = document.getElementById("clipTrack");
const playheadEl = document.getElementById("playhead");
const baseClipEl = document.getElementById("baseClip");
const selectionClip = document.getElementById("selectionClip");
const addClipBtn = document.getElementById("addClipBtn");

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
   volume, rate, trimStart, trimEnd, applyCutBtn, addClipBtn].forEach(el => { el.disabled = !on; });
}

function resetState() {
  stopPlayback();
  isReversed = false;
  reversedBuffer = null;
  pauseOffset = 0;
  updateReverseBtn();
  updateTimeUI(0, 0);
  setProgress(0);
}

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

    // UI
    fileMeta.hidden = false;
    fileMeta.textContent = `${file.name} — ${(file.size/1024/1024).toFixed(2)} MB • ${decoded.sampleRate} Hz • ${decoded.numberOfChannels} ch`;
    durationEl.textContent = fmt(workingBuffer.duration);
    trimStart.max = decoded.duration.toFixed(2);
    trimEnd.max = decoded.duration.toFixed(2);
    trimEnd.value = Math.min(5, decoded.duration).toFixed(2);

    enableControls(true);
    resetState();
    renderTimeline();
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
  return pauseOffset + elapsed * (parseFloat(rate.value || "1"));
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

// Timeline helpers
function getTimelineDuration() {
  return getActiveBuffer()?.duration || 0;
}

function timeToPercent(time, duration) {
  if (!duration) return 0;
  const clamped = Math.max(0, Math.min(duration, time));
  return (clamped / duration) * 100;
}

function renderRuler(duration) {
  if (!timelineRuler) return;
  timelineRuler.innerHTML = "";
  if (!duration) return;

  const segments = Math.min(12, Math.max(6, Math.floor(duration)));
  const step = duration / segments;
  const frag = document.createDocumentFragment();
  for (let i = 0; i <= segments; i++) {
    const mark = document.createElement("span");
    mark.textContent = `${(i * step).toFixed(0)}s`;
    frag.appendChild(mark);
  }
  timelineRuler.appendChild(frag);
}

function renderSelectionClip() {
  if (!selectionClip) return;
  const dur = getTimelineDuration();
  const start = parseFloat(trimStart.value) || 0;
  const end = parseFloat(trimEnd.value) || 0;
  if (!dur || end <= start || start >= dur) {
    selectionClip.hidden = true;
    return;
  }
  selectionClip.hidden = false;
  selectionClip.textContent = `Trim ${fmt(start)} - ${fmt(Math.min(end, dur))}`;
  selectionClip.style.left = `${timeToPercent(start, dur)}%`;
  selectionClip.style.width = `${timeToPercent(end - start, dur)}%`;
}

function renderClips(duration) {
  if (!clipTrack) return;
  clipTrack.innerHTML = "";
  timelineClips.forEach((clip, idx) => {
    const el = document.createElement("div");
    el.className = "clip";
    el.textContent = clip.label || `Klip ${idx + 1}`;
    el.style.left = `${timeToPercent(clip.start, duration)}%`;
    el.style.width = `${timeToPercent(clip.duration, duration)}%`;
    clipTrack.appendChild(el);
  });
}

function renderTimeline() {
  const dur = getTimelineDuration();
  renderRuler(dur);
  if (baseClipEl) baseClipEl.textContent = `Audio • ${fmt(dur)}`;
  renderSelectionClip();
  renderClips(dur);
  updatePlayheadPosition(getCurrentOffset(), dur);
}

function updatePlayheadPosition(cur, dur) {
  if (!playheadEl) return;
  const p = timeToPercent(cur, dur || getTimelineDuration());
  playheadEl.style.left = `${p}%`;
}

// Animator
function tick() {
  const buf = getActiveBuffer();
  const dur = buf?.duration || 0;
  const cur = Math.min(getCurrentOffset(), dur);
  setProgress(dur ? cur / dur : 0);
  updateTimeUI(cur, dur);
  updatePlayheadPosition(cur, dur);
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
  updatePlayheadPosition(0, getActiveBuffer()?.duration || 0);
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
  renderTimeline();
});

progress.addEventListener("input", () => {
  const buf = getActiveBuffer();
  const dur = buf?.duration || 0;
  const frac = parseInt(progress.value, 10) / 1000;
  const cur = dur * frac;
  updateTimeUI(cur, dur);
  updatePlayheadPosition(cur, dur);
});

progress.addEventListener("change", () => {
  const buf = getActiveBuffer();
  const dur = buf?.duration || 0;
  const frac = parseInt(progress.value, 10) / 1000;
  pauseOffset = dur * frac;
  updatePlayheadPosition(pauseOffset, dur);
  if (isPlaying) playFromOffset(pauseOffset);
});

volume.addEventListener("input", () => {
  const v = parseFloat(volume.value || "1");
  if (gainNode) gainNode.gain.value = v;
});

rate.addEventListener("input", () => {
  const r = parseFloat(rate.value || "1");
  rateLabel.textContent = `${r.toFixed(2)}×`;
  if (source) source.playbackRate.value = r;
});

vizGainEl.addEventListener("input", () => {
  vizGain = parseFloat(vizGainEl.value || "1.5");
});

[trimStart, trimEnd].forEach(el => {
  el.addEventListener("input", () => {
    renderSelectionClip();
  });
});

timelineBody.addEventListener("click", (e) => {
  const dur = getTimelineDuration();
  if (!dur) return;
  const rect = timelineBody.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  pauseOffset = dur * frac;
  setProgress(frac);
  updateTimeUI(pauseOffset, dur);
  updatePlayheadPosition(pauseOffset, dur);
  if (isPlaying) playFromOffset(pauseOffset);
});

addClipBtn.addEventListener("click", () => {
  if (!workingBuffer || !audioCtx) return;
  const start = Math.max(0, parseFloat(trimStart.value) || 0);
  const end = Math.max(0, parseFloat(trimEnd.value) || 0);
  const dur = workingBuffer.duration;
  if (start >= end || start >= dur) return setError("Rentang klip tidak valid.");
  setError("");
  timelineClips.push({
    start,
    duration: Math.min(end, dur) - start,
    label: `Klip ${timelineClips.length + 1}`
  });
  renderClips(dur);
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
  if (e.code === "Space") {
    e.preventDefault();
    playBtn.click();
  } else if (e.key.toLowerCase() === "r") {
    reverseBtn.click();
  }
});
