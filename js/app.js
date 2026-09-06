/* mix&match - app.js
   Bootstrap: connects UI, state, and audio engine. Owns the playback
   clock, upload flow, view switching, modals and the export process.
*/
(function () {
  window.MMix = window.MMix || {};
  const state = MMix.state;
  const store = MMix.store;
  const audio = MMix.Audio;
  const Waveform = MMix.Waveform;
  const fmt = (s) => Waveform.fmt(s);

  const $ = (sel, root) => (root || document).querySelector(sel);

  /* ---------- DOM refs ---------- */
  let landingView, emptyView, editorView, controlBar;
  let dropZone, fileInput, browseBtn, emptyAdd, addMoreBtn;
  let playBtn, scrubber, cbCurrent, cbTotal, exportBtn, trackList;
  let exportOverlay, exportProgressState, exportDoneState, exportBar, downloadBtn, exportCloseBtn;

  /* ---------- playback state ---------- */
  let mixPlayback = null;   // { partsById, total, fromTime }
  let playing = false;
  let playheadTime = 0;
  let raf = null;
  let soloSrc = null;
  let soloStartWall = 0;

  /* =========================================================
     VIEW SWITCHING
  ========================================================= */
  function syncViews() {
    const n = store.tracks.length;
    document.body.classList.toggle("editor-open", n > 0);

    if (n === 0) {
      editorView.classList.add("hidden");
      controlBar.classList.add("hidden");
      if (store.hasUploaded) {
        landingView.classList.add("hidden");
        emptyView.classList.remove("hidden");
      } else {
        emptyView.classList.add("hidden");
        landingView.classList.remove("hidden");
      }
    } else {
      emptyView.classList.add("hidden");
      landingView.classList.add("hidden");
      editorView.classList.remove("hidden");
      controlBar.classList.remove("hidden");
    }
  }

  /* =========================================================
     UPLOAD / DECODE
  ========================================================= */
  const AUDIO_EXT = ["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "webm", "opus", "aiff", "aif", "caf"];
  function isAudioFile(f) {
    if (f.type && f.type.indexOf("audio") === 0) return true;
    const ext = (f.name.split(".").pop() || "").toLowerCase();
    return AUDIO_EXT.includes(ext);
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []).filter(isAudioFile);
    if (!files.length) { toast("Those files don't look like audio."); return; }

    toast("Uploading " + files.length + " file" + (files.length > 1 ? "s" : "") + "...");
    let added = 0;
    for (const f of files) {
      try {
        const buffer = await audio.decodeFile(f);
        const tr = state.addTrack(f, buffer);
        tr.peaks = Waveform.computePeaks(buffer, 900);
        added++;
      } catch (err) {
        console.error(err);
        toast(err.message);
      }
    }

    if (added > 0) {
      MMix.UI.renderEditor();
      syncViews();
      MMix.UI.refreshWaveforms();
      updateControlBar();
      toast("Added " + added + " track" + (added > 1 ? "s" : "") + ".");
    } else {
      toast("Nothing could be added.");
    }
  }

  function openFilePicker() {
    fileInput.value = "";
    fileInput.click();
  }

  function wireUpload() {
    browseBtn.addEventListener("click", openFilePicker);
    emptyAdd.addEventListener("click", openFilePicker);
    addMoreBtn.addEventListener("click", openFilePicker);
    fileInput.addEventListener("change", (e) => handleFiles(e.target.files));

    dropZone.addEventListener("click", (e) => {
      if (e.target.closest("#browse-btn")) return;
      openFilePicker();
    });
    dropZone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openFilePicker(); }
    });

    // window-level drag & drop so files can land anywhere
    let dragDepth = 0;
    const setDragHighlight = (on) => {
      dropZone.classList.toggle("drag-over", on);
      document.body.classList.toggle("is-filedragging", on);
    };
    window.addEventListener("dragenter", (e) => {
      e.preventDefault();
      dragDepth++;
      setDragHighlight(true);
    });
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("dragleave", (e) => {
      e.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setDragHighlight(false);
    });
    window.addEventListener("drop", (e) => {
      e.preventDefault();
      dragDepth = 0;
      setDragHighlight(false);
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        handleFiles(e.dataTransfer.files);
      }
    });
  }

  /* =========================================================
     CONTROL BAR / PLAYBACK
  ========================================================= */
  function updateControlBar() {
    const tl = audio.buildTimeline(store);
    const total = tl.total || 0;
    playheadTime = Math.min(playheadTime, total);
    scrubber.max = total;
    scrubber.value = playheadTime;
    cbTotal.textContent = fmt(total);
    cbCurrent.textContent = fmt(playheadTime);
    exportBtn.disabled = store.tracks.length === 0;
    updatePlayheadUI();
  }

  function setPlayButton(isPlaying) {
    playBtn.classList.toggle("is-playing", isPlaying);
    $(".ic-play", playBtn).classList.toggle("hidden", isPlaying);
    $(".ic-pause", playBtn).classList.toggle("hidden", !isPlaying);
    playBtn.setAttribute("aria-label", isPlaying ? "Pause whole mix" : "Play whole mix");
  }

  function playMix(fromTime) {
    stopSolo();
    audio.stopAll();
    const res = audio.playMix(store, fromTime);
    if (!res) return false;
    mixPlayback = res;
    scrubber.max = res.total;
    scrubber.value = fromTime;
    playing = true;
    store.playing = true;
    setPlayButton(true);
    startClock();
    return true;
  }

  function pauseMix() {
    audio.stopAll();
    playing = false;
    store.playing = false;
    setPlayButton(false);
    stopClock();
    updatePlayheadUI();
  }

  function togglePlay() {
    if (playing) { pauseMix(); return; }
    if (!store.tracks.length) return;
    if (playheadTime >= (mixPlayback ? mixPlayback.total : 0)) playheadTime = 0;
    playMix(playheadTime);
  }

  // After a trim (or any timeline mutation) happens while the mix is playing,
  // re-schedule playback from the current position so the audio follows the
  // adjusted (trimmed) song in real time instead of continuing the old range.
  function rescheduleIfPlaying() {
    if (!store.playing) return;
    const tl = audio.buildTimeline(store);
    if (tl.total <= 0.001) { pauseMix(); return; }
    const from = Math.min(playheadTime, Math.max(0, tl.total - 0.02));
    if (!playMix(from)) {
      pauseMix();
      playheadTime = tl.total;
      updateControlBar();
    }
  }

  /* clock */
  function startClock() {
    stopClock();
    const tick = () => {
      const pos = audio.getLiveClock();
      playheadTime = Math.min(pos, mixPlayback.total);
      updatePlayheadUI();
      if (pos >= mixPlayback.total) {
        pauseMix();
        playheadTime = mixPlayback.total;
        cbCurrent.textContent = fmt(mixPlayback.total);
        scrubber.value = mixPlayback.total;
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  function stopClock() {
    if (raf) cancelAnimationFrame(raf);
    raf = null;
  }

  function updatePlayheadUI() {
    cbCurrent.textContent = fmt(playheadTime);
    scrubber.value = playheadTime;
    const tl = audio.buildTimeline(store);
    for (const part of tl.parts) {
      const tr = state.getTrack(part.trackId);
      if (!tr) continue;
      const cards = trackList.querySelectorAll('.track-card[data-id="' + part.trackId + '"]');
      const card = cards.length ? cards[0] : null;
      if (!card) continue;
      const head = $(".wave-playhead", card);
      const local = playheadTime - part.start;
      if (local >= 0 && local <= part.duration) {
        // canvas maps 0..full duration, so use absolute position in the track
        const posInTrack = (part.trimStart + local) / tr.duration;
        head.style.left = Math.max(0, Math.min(100, posInTrack * 100)) + "%";
        head.style.opacity = "1";
      } else {
        head.style.opacity = "0";
      }
    }
  }

  /* ---------- draggable playhead (seek from waveform) ---------- */
  // Map a 0..1 position across a track's waveform to the matching mix time.
  function mixTimeFromTrackX(part, track, xRatio) {
    const trackTime = Math.max(0, Math.min(1, xRatio)) * track.duration;
    const local = Math.max(0, Math.min(part.duration, trackTime - part.trimStart));
    return part.start + local;
  }

  function onPlayheadDrag(trackId, xRatio) {
    const tl = audio.buildTimeline(store);
    const part = tl.parts.find(p => p.trackId === trackId);
    const tr = state.getTrack(trackId);
    if (!part || !tr) return;
    playheadTime = mixTimeFromTrackX(part, tr, xRatio);
    scrubber.max = tl.total || 0;
    scrubber.value = playheadTime;
    cbCurrent.textContent = fmt(playheadTime);
    updatePlayheadUI();
  }

  function onPlayheadDrop(trackId, xRatio) {
    onPlayheadDrag(trackId, xRatio);
    if (!store.tracks.length) return;
    playMix(playheadTime);
  }

  function wireControlBar() {
    playBtn.addEventListener("click", togglePlay);

    scrubber.addEventListener("pointerdown", () => {
      if (playing) pauseMix();
    });
    scrubber.addEventListener("input", () => {
      playheadTime = parseFloat(scrubber.value) || 0;
      cbCurrent.textContent = fmt(playheadTime);
      updatePlayheadUI();
    });

    document.addEventListener("keydown", (e) => {
      if (e.code === "Space" && !e.target.closest("input, button, textarea, select")) {
        e.preventDefault();
        togglePlay();
      }
    });
  }

  /* =========================================================
     SOLO (per-track preview)
  ========================================================= */
  function toggleSolo(trackId) {
    if (store.soloTrackId === trackId) { stopSolo(); return; }
    pauseMix();
    const tr = state.getTrack(trackId);
    if (!tr) return;
    const ctx = audio.ensureContext();
    const src = ctx.createBufferSource();
    src.buffer = tr.audioBuffer;
    const g = ctx.createGain();
    g.gain.value = tr.volume / 100;
    src.connect(g);
    g.connect(ctx.destination);
    const when = ctx.currentTime + 0.05;
    src.start(when, tr.start, tr.end - tr.start);
    store.soloTrackId = trackId;
    soloSrc = src;
    audio.registerLiveGain(trackId, g);
    soloStartWall = performance.now() + 50;
    MMix.UI.refreshSolo();
    soloTick(trackId, tr);
  }

  function soloTick(trackId, tr) {
    const card = MMix.UI.getCard(trackId);
    if (card) {
      const head = $(".wave-playhead", card);
      const local = (performance.now() - soloStartWall) / 1000;
      if (local <= tr.end - tr.start) {
        const posInTrack = (tr.start + local) / tr.duration;
        head.style.left = Math.max(0, Math.min(100, posInTrack * 100)) + "%";
        head.style.opacity = "1";
        if (store.soloTrackId === trackId) requestAnimationFrame(() => soloTick(trackId, tr));
      } else {
        head.style.opacity = "0";
        stopSolo();
      }
    }
  }

  function stopSolo() {
    if (store.soloTrackId) audio.registerLiveGain(store.soloTrackId, null);
    if (soloSrc) {
      try { soloSrc.stop(); } catch (e) {}
      soloSrc = null;
    }
    if (store.soloTrackId) {
      const card = MMix.UI.getCard(store.soloTrackId);
      if (card && $(".wave-playhead", card)) $(".wave-playhead", card).style.opacity = "0";
      store.soloTrackId = null;
      MMix.UI.refreshSolo();
    }
  }

  /* =========================================================
     TRACK MUTATIONS
  ========================================================= */
  function removeTrackById(id) {
    if (store.soloTrackId === id) stopSolo();
    state.removeTrack(id);
    MMix.UI.renderEditor();
    syncViews();
    updateControlBar();
    MMix.UI.closeTransitionPopover();
    if (store.tracks.length === 0) playheadTime = 0;
  }

  /* =========================================================
     EXPORT
  ========================================================= */
  function openExportOverlay() {
    exportOverlay.classList.remove("hidden");
    document.body.classList.add("is-busy");
  }
  function closeExportOverlay() {
    exportOverlay.classList.add("hidden");
    document.body.classList.remove("is-busy");
  }

  async function exportMix() {
    if (!store.tracks.length || exportBtn.disabled) return;
    pauseMix();
    stopSolo();

    exportProgressState.classList.remove("hidden");
    exportDoneState.classList.add("hidden");
    exportBar.style.width = "0%";
    openExportOverlay();

    // animate progress while the offline renderer works
    const progTimer = trickleProgress();
    try {
      const buffer = await audio.renderMix(store, (p) => { exportBar.style.width = Math.round(p * 78) + "%"; });
      clearTimeout(progTimer);
      const enc = await audio.encode(buffer, "wav");
      exportBar.style.width = "100%";
      await new Promise(r => setTimeout(r, 260)); // let the bar visually finish

      downloadBlob(enc.blob, "mix-and-match." + enc.ext);
      exportProgressState.classList.add("hidden");
      exportDoneState.classList.remove("hidden");
    } catch (err) {
      clearTimeout(progTimer);
      console.error(err);
      toast(err.message);
      closeExportOverlay();
    }
  }

  function trickleProgress() {
    let p = 0;
    return setInterval(() => {
      p = Math.min(72, p + Math.random() * 6);
      exportBar.style.width = p + "%";
    }, 160);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function wireExport() {
    exportBtn.addEventListener("click", exportMix);
    downloadBtn.addEventListener("click", () => {
      // blob kept client-side; download happens inside exportMix
      closeExportOverlay();
    });
    exportCloseBtn.addEventListener("click", closeExportOverlay);
    exportOverlay.addEventListener("click", (e) => {
      if (e.target === exportOverlay) closeExportOverlay();
    });
  }

  /* =========================================================
     MODALS (How it works / About)
  ========================================================= */
  function wireModals() {
    document.querySelectorAll(".nav-link[data-modal]").forEach(btn => {
      btn.addEventListener("click", () => {
        const m = document.getElementById("modal-" + btn.dataset.modal);
        if (m) m.classList.remove("hidden");
      });
    });
    document.querySelectorAll("[data-close]").forEach(btn => {
      btn.addEventListener("click", () => {
        const m = document.getElementById("modal-" + btn.dataset.close);
        if (m) m.classList.add("hidden");
      });
    });
    document.querySelectorAll(".overlay").forEach(ov => {
      ov.addEventListener("click", (e) => {
        if (e.target === ov) ov.classList.add("hidden");
      });
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        document.querySelectorAll(".overlay.openable:not(.hidden)").forEach(o => o.classList.add("hidden"));
        exportOverlay.classList.add("hidden");
        document.body.classList.remove("is-busy");
      }
    });
  }

  /* =========================================================
     TOAST
  ========================================================= */
  let toastEl = null, toastTimer = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "toast";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2600);
  }

  /* =========================================================
     INIT
  ========================================================= */
  function init() {
    landingView = $("#landing-view");
    emptyView = $("#empty-view");
    editorView = $("#editor-view");
    controlBar = $("#control-bar");
    dropZone = $("#drop-zone");
    fileInput = $("#file-input");
    browseBtn = $("#browse-btn");
    emptyAdd = $("#empty-add-btn");
    addMoreBtn = $("#add-more-btn");
    playBtn = $("#play-btn");
    scrubber = $("#scrubber");
    cbCurrent = $("#cb-current");
    cbTotal = $("#cb-total");
    exportBtn = $("#export-btn");
    trackList = $("#track-list");
    exportOverlay = $("#export-overlay");
    exportProgressState = $("#export-progress-state");
    exportDoneState = $("#export-done-state");
    exportBar = $(".export-track i");
    downloadBtn = $("#download-btn");
    exportCloseBtn = $("#export-close-btn");

    wireUpload();
    wireControlBar();
    wireExport();
    wireModals();

    MMix.UI.wire(trackList);
    syncViews();
    updateControlBar();
  }

  document.addEventListener("DOMContentLoaded", init);

  MMix.App = {
    toggleSolo,
    removeTrackById,
    pausePlayback: pauseMix,
    updateControlBar,
    syncViews,
    onPlayheadDrag,
    onPlayheadDrop,
    rescheduleIfPlaying
  };
})();