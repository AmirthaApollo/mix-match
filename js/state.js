/* mix&match - state.js
   Central store for tracks, transitions, trimming and playback flags.
   UI and audio engine read from and mutate this store.
*/
(function () {
  window.MMix = window.MMix || {};

  const DEFAULT_TRANSITION = { type: "crossfade", duration: 2 };
  const TRANSITION_TYPES = [
    { id: "none", label: "None" },
    { id: "crossfade", label: "Crossfade" },
    { id: "fadeout-fadein", label: "Fade out → Fade in" }
  ];
  const TRANSITION_DURATIONS = [0.5, 1, 2, 3, 5];

  let idCounter = 0;
  const nextId = () => "trk-" + ++idCounter;

  const store = {
    tracks: [],            // [{id,name,file,audioBuffer,peaks,duration,start,end,volume,decoded}]
    transitions: {},       // key "idA|idB" -> {type,duration}
    hasUploaded: false,
    previewTime: 0,        // seconds into the whole mix (paused position)
    playing: false,
    soloTrackId: null,     // id of track playing solo, if any

    DEFAULT_TRANSITION,
    TRANSITION_TYPES,
    TRANSITION_DURATIONS
  };

  // Track args may be passed as id strings OR track objects; normalize both.
  const idOf = (x) => (typeof x === "string" ? x : x && typeof x.id === "string" ? x.id : "");
  const key = (a, b) => idOf(a) + "|" + idOf(b);

  /* ---------- tracks ---------- */
  function addTrack(file, audioBuffer) {
    const t = {
      id: nextId(),
      name: file ? file.name : "untitled",
      file: file || null,
      audioBuffer,
      peaks: null,
      duration: audioBuffer.duration,
      start: 0,            // trim start (s)
      end: audioBuffer.duration, // trim end (s)
      volume: 100          // 0..100
    };
    store.tracks.push(t);
    store.hasUploaded = true;
    return t;
  }

  function removeTrack(id) {
    const idx = store.tracks.findIndex(t => t.id === id);
    if (idx < 0) return;
    store.tracks.splice(idx, 1);
    cleanTransitionKeys();
    if (store.soloTrackId === id) store.soloTrackId = null;
  }

  // Move from/fromIdx -> toIdx (bounded). Returns true when order changed.
  function moveTrack(fromIdx, toIdx) {
    if (fromIdx === toIdx) return false;
    if (fromIdx < 0 || fromIdx >= store.tracks.length) return false;
    const t = store.tracks.splice(fromIdx, 1)[0];
    const clamped = Math.max(0, Math.min(store.tracks.length, toIdx));
    store.tracks.splice(clamped, 0, t);
    return true;
  }

  function getTrack(id) {
    return store.tracks.find(t => t.id === id) || null;
  }

  function setTrim(id, start, end) {
    const t = getTrack(id);
    if (!t) return;
    const min = 0.05; // keep at least 50ms
    start = Math.max(0, start);
    end = Math.min(t.duration, end);
    if (end - start < min) {
      // keep minimum window centered on the moving edge
      if (start === null || typeof start === "undefined") start = end - min;
      else end = start + min;
    }
    t.start = Math.max(0, Math.min(start, t.duration - min));
    t.end = Math.min(t.duration, Math.max(end, min));
  }

  function setVolume(id, vol) {
    const t = getTrack(id);
    if (t) t.volume = Math.max(0, Math.min(100, vol));
  }

  /* ---------- transitions ---------- */
  // Transition between two adjacent tracks (by their current order).
  function getTransition(trackA, trackB) {
    if (!trackA || !trackB) return DEFAULT_TRANSITION;
    const hit = store.transitions[key(trackA, trackB)];
    return hit ? hit : { ...DEFAULT_TRANSITION };
  }

  function setTransition(trackA, trackB, cfg) {
    if (!trackA || !trackB) return;
    store.transitions[key(trackA, trackB)] = {
      type: cfg.type || DEFAULT_TRANSITION.type,
      duration: cfg.duration != null ? cfg.duration : DEFAULT_TRANSITION.duration
    };
  }

  // Drop keys that no longer reference two existing track ids.
  function cleanTransitionKeys() {
    const ids = new Set(store.tracks.map(t => t.id));
    for (const k of Object.keys(store.transitions)) {
      const [a, b] = k.split("|");
      if (!ids.has(a) || !ids.has(b)) delete store.transitions[k];
    }
  }

  function reset() {
    store.tracks = [];
    store.transitions = {};
    store.playing = false;
    store.soloTrackId = null;
    store.previewTime = 0;
  }

  // Attach the actions directly onto the store so both MMix.store and
  // MMix.state expose the same, unified API.
  store.addTrack = addTrack;
  store.removeTrack = removeTrack;
  store.moveTrack = moveTrack;
  store.getTrack = getTrack;
  store.setTrim = setTrim;
  store.setVolume = setVolume;
  store.getTransition = getTransition;
  store.setTransition = setTransition;
  store.reset = reset;

  MMix.store = store;
  MMix.state = store;
})();