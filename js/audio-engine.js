/* mix&match - audio-engine.js
   Web Audio API core: decoding, timeline building, live preview mixing,
   offline rendering and WAV encoding. Kept modular so additional encoders
   (e.g. an llav-wasm MP3 encoder) can be plugged in later.
*/
(function () {
  window.MMix = window.MMix || {};

  const LEAD = 0.07; // schedule a little ahead for tight sync

  let _ctx = null;
  let _masterGain = null;
  let _liveSources = [];
  let _liveGains = {};   // trackId -> gain node (for live volume changes)
  let _playStartWall = 0;
  let _playFrom = 0;

  function ensureContext() {
    if (!_ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error("Web Audio API is not supported in this browser.");
      _ctx = new AC({ latencyHint: "interactive" });
      _masterGain = _ctx.createGain();
      _masterGain.gain.value = 1;
      _masterGain.connect(_ctx.destination);
    }
    if (_ctx.state === "suspended") _ctx.resume();
    return _ctx;
  }

  /* ---------- decode ---------- */
  async function decodeFile(file) {
    ensureContext();
    const arrayBuffer = await file.arrayBuffer();
    try {
      return await _ctx.decodeAudioData(arrayBuffer);
    } catch (err) {
      throw new Error("Could not decode " + (file.name || "audio") + ". The format may not be supported.");
    }
  }

  /* ---------- timeline ---------- */
  // Build ordered playout with absolute start offsets + fade envelope info.
  //  - "crossfade"      : track B starts dur seconds BEFORE track A ends
  //  - "fadeout-fadein" : A fades out, then B fades in (no overlap)
  function buildTimeline(state) {
    const tracks = state.tracks;
    const N = tracks.length;
    const parts = [];
    let t = 0;

    for (let i = 0; i < N; i++) {
      const tr = tracks[i];
      const dur = tr.end - tr.start;
      if (i > 0) {
        const prev = tracks[i - 1];
        const trans = state.getTransition(prev, tr);
        if (trans.type === "crossfade") {
          // overlap can never exceed the previous track's trimmed length,
          // otherwise the next track would start before the previous one
          t -= Math.min(trans.duration, prev.end - prev.start);
        }
      }
      parts.push({
        trackId: tr.id,
        start: t,
        trimStart: tr.start,
        duration: dur,
        volume: tr.volume / 100,
        fadeIn: 0,
        fadeOut: 0
      });
      t += dur;
    }

    for (let i = 0; i < N; i++) {
      const p = parts[i];
      if (i > 0) {
        const trans = state.getTransition(tracks[i - 1], tracks[i]);
        if (trans.type !== "none") p.fadeIn = trans.duration;
      }
      if (i < N - 1) {
        const trans = state.getTransition(tracks[i], tracks[i + 1]);
        if (trans.type !== "none") p.fadeOut = trans.duration;
      }
    }

    return { parts, total: t };
  }

  /* ---------- envelope ---------- */
  // Schedule a volume envelope; times are relative to the source start.
  function applyEnvelope(param, when, dur, volume, fadeIn, fadeOut) {
    fadeIn = fadeIn && fadeIn > 0 ? Math.min(fadeIn, dur) : 0;
    fadeOut = fadeOut && fadeOut > 0 ? Math.min(fadeOut, dur) : 0;
    const target = Math.max(0, Math.min(1, volume));

    param.cancelScheduledValues(when);
    param.setValueAtTime(0, when);

    const plateauAt = when + (fadeIn > 0 ? fadeIn : 0.002);
    param.linearRampToValueAtTime(target, plateauAt);

    const fadeStart = when + dur - fadeOut;
    if (fadeOut > 0) {
      if (fadeStart > plateauAt) param.setValueAtTime(target, fadeStart);
      else param.setValueAtTime(target, plateauAt);
      param.linearRampToValueAtTime(0, when + dur);
    } else {
      param.setValueAtTime(target, when + dur);
    }
  }

  /* ---------- live preview ---------- */
  function stopAll() {
    for (const s of _liveSources) {
      try { s.stop(); } catch (e) {}
      try { s.disconnect(); } catch (e) {}
    }
    _liveSources = [];
    _liveGains = {};
    _playFrom = 0;
    _playStartWall = 0;
  }

  function isCtxUsable() {
    return !!_ctx && (_ctx.state === "running" || _ctx.state === "suspended");
  }

  // Schedule the whole mix on the live context starting at `fromTime`.
  // Returns { partsById, total, fromTime } or null when nothing plays.
  function playMix(state, fromTime) {
    stopAll();
    ensureContext();
    const tl = buildTimeline(state);
    if (!tl.parts.length) return null;

    const ctx = _ctx;
    const when = ctx.currentTime + LEAD;
    const partsById = {};
    let scheduled = 0;

    for (const part of tl.parts) {
      const tr = state.getTrack(part.trackId);
      if (!tr) continue;
      if (part.start + part.duration <= fromTime) continue; // already passed
      const off = Math.max(0, fromTime - part.start);
      const dur = part.duration - off;
      if (dur <= 0.001) continue;

      // Each part plays at its own position in the timeline (matching the
      // offline render). A part joined mid-mix starts immediately; a future
      // part is delayed to its absolute start time so crossfade overlaps are
      // exactly the configured duration.
      const startAt = when + Math.max(0, part.start - fromTime);

      const src = ctx.createBufferSource();
      src.buffer = tr.audioBuffer;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(g);
      g.connect(_masterGain);
      src.start(startAt, part.trimStart + off, dur);

      const fadeIn = off > 0 ? 0 : part.fadeIn; // skip fade-in if we joined mid-fade
      applyEnvelope(g.gain, startAt, dur, part.volume, fadeIn, part.fadeOut);

      _liveSources.push(src);
      _liveGains[tr.id] = g;
      partsById[tr.id] = { ...part, localStarted: off };
      scheduled++;
    }

    if (!scheduled) return null;
    _playStartWall = performance.now();
    _playFrom = fromTime;
    return { partsById, total: tl.total, fromTime };
  }

  // Live volume variation for an individually scheduled track.
  function setLiveGain(trackId, volume) {
    const g = _liveGains[trackId];
    if (g && _ctx) {
      const t = _ctx.currentTime;
      try { g.gain.cancelScheduledValues(0); } catch (e) {}
      g.gain.setValueAtTime(Math.max(0, Math.min(1, volume / 100)), t);
    }
  }

  // Register/unregister an arbitrary gain node (e.g. a solo source) so that
  // changing a track's volume takes effect while it is auditioned solo.
  function registerLiveGain(trackId, gainNode) {
    if (gainNode) _liveGains[trackId] = gainNode;
    else delete _liveGains[trackId];
  }

  // Seconds elapsed into the scheduled timeline, relative to _playFrom.
  function getLiveClock() {
    if (!_playStartWall && !_playFrom) return 0;
    const wall = (performance.now() - _playStartWall) / 1000;
    return _playFrom + Math.max(0, wall - LEAD);
  }

  /* ---------- offline render ---------- */
  // Render the full mix to a new AudioBuffer (identical math to preview,
  // but computed offline so it can be encoded to a file).
  async function renderMix(state, onProgress) {
    onProgress = onProgress || (() => {});
    const tl = buildTimeline(state);
    if (!tl.parts.length) throw new Error("No tracks to mix.");

    const SR = 44100;
    const sampleCount = Math.max(1, Math.ceil(tl.total * SR) + 1);
    const ctx = new OfflineAudioContext(2, sampleCount, SR);
    const dest = ctx.destination;

    for (const part of tl.parts) {
      const tr = state.getTrack(part.trackId);
      if (!tr) continue;
      const src = ctx.createBufferSource();
      src.buffer = tr.audioBuffer;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(g);
      g.connect(dest);
      src.start(part.start, part.trimStart, part.duration);
      applyEnvelope(g.gain, part.start, part.duration, part.volume, part.fadeIn, part.fadeOut);
    }

    try {
      onProgress(0.4);
      const rendered = await ctx.startRendering();
      onProgress(1);
      return rendered;
    } catch (err) {
      throw new Error("Rendering failed: " + err.message);
    }
  }

  /* ---------- WAV encoding ----------
     Pluggable encoder map: an "mp3" entry can be added later using an
     llav-wasm / FFmpeg build without touching the rest of the code. */
  function encodeWav(buffer) {
    const numChans = 2;
    const sampleRate = buffer.sampleRate;
    const length = buffer.length;
    const bytesPerSample = 2;
    const blockAlign = numChans * bytesPerSample;
    const dataSize = length * blockAlign;
    const ab = new ArrayBuffer(44 + dataSize);
    const view = new DataView(ab);

    function writeStr(off, s) {
      for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    }

    writeStr(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);          // PCM chunk size
    view.setUint16(20, 1, true);           // PCM (linear) format
    view.setUint16(22, numChans, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bytesPerSample * 8, true);
    writeStr(36, "data");
    view.setUint32(40, dataSize, true);

    const l = buffer.getChannelData(0);
    const r = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : l;
    let offset = 44;
    for (let i = 0; i < length; i++) {
      const sl = Math.max(-1, Math.min(1, l[i]));
      const sr = Math.max(-1, Math.min(1, r[i]));
      view.setInt16(offset, sl < 0 ? sl * 0x8000 : sl * 0x7FFF, true);
      view.setInt16(offset + 2, sr < 0 ? sr * 0x8000 : sr * 0x7FFF, true);
      offset += 4;
    }
    return new Blob([ab], { type: "audio/wav" });
  }

  /* ---------- MP3 encoding ----------
     Pure-JS LAME port (js/vendor/lame.all.js). Converts the rendered
     Float32 AudioBuffer to Int16 and feeds it frame-by-frame. */
  function encodeMp3(buffer, kbps) {
    const LameJs = window.lamejs;
    if (!LameJs || typeof LameJs.Mp3Encoder !== "function") {
      throw new Error("MP3 encoder could not be loaded.");
    }
    kbps = kbps || 192;
    const channels = buffer.numberOfChannels > 1 ? 2 : 1;
    const sampleRate = Math.round(buffer.sampleRate);
    const l = buffer.getChannelData(0);
    const r = channels > 1 ? buffer.getChannelData(1) : l;

    const enc = new LameJs.Mp3Encoder(channels, sampleRate, kbps);
    const to16 = (f) => {
      f = Math.max(-1, Math.min(1, f));
      return f < 0 ? Math.round(f * 0x8000) : Math.round(f * 0x7FFF);
    };

    const BLOCK = 1152;
    const out = [];
    let i = 0;
    while (i < l.length) {
      const n = Math.min(BLOCK, l.length - i);
      const lb = new Int16Array(n);
      const rb = new Int16Array(n);
      for (let j = 0; j < n; j++) {
        lb[j] = to16(l[i + j]);
        rb[j] = to16(r[i + j]);
      }
      const chunk = enc.encodeBuffer(lb, rb);
      if (chunk && chunk.length) out.push(chunk);
      i += n;
    }
    const tail = enc.flush();
    if (tail && tail.length) out.push(tail);
    return new Blob(out, { type: "audio/mpeg" });
  }

  const encoders = {
    wav: { label: "WAV", ext: "wav", mime: "audio/wav", encode: (buf) => Promise.resolve(encodeWav(buf)) },
    mp3: { label: "MP3", ext: "mp3", mime: "audio/mpeg", encode: (buf) => Promise.resolve(encodeMp3(buf)) }
  };

  async function encode(buffer, format) {
    format = format || "mp3";
    const enc = encoders[format];
    if (!enc) throw new Error("Unknown export format: " + format);
    const blob = await enc.encode(buffer);
    return { blob, ext: enc.ext, mime: enc.mime, format };
  }

  function supportedFormats() {
    return Object.keys(encoders).map(f => ({
      id: f,
      label: encoders[f].label,
      ext: encoders[f].ext
    }));
  }

  MMix.Audio = {
    ensureContext,
    decodeFile,
    buildTimeline,
    playMix,
    stopAll,
    setLiveGain,
    registerLiveGain,
    getLiveClock,
    isCtxUsable,
    renderMix,
    encode,
    encoders,
    supportedFormats
  };
})();