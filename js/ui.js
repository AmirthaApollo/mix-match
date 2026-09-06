/* mix&match - ui.js
   Renders track cards + transitions into #track-list, wires trimming,
   reordering, per-track playback, volume and the transition popover.
   All event handling is delegated on the container so re-renders stay cheap.
*/
(function () {
  window.MMix = window.MMix || {};

  /* ---------- helpers ---------- */
  const fmt = (s) => MMix.Waveform.fmt(s);
  const fmtShort = (s) => MMix.Waveform.fmtShort(s);

  // Accept either plain seconds ("12.5") or a clock-style value ("0:12").
  function parseTimeInput(v) {
    v = String(v == null ? "" : v).trim();
    if (!v) return null;
    const m = v.match(/^(\d+):([0-9]{1,2}(?:[.,]\d+)?)$/);
    if (m) return parseInt(m[1], 10) * 60 + parseFloat(m[2].replace(",", "."));
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }

  const svgNS = "http://www.w3.org/2000/svg";
  function sym(pathD) {
    const ns = document.createElementNS(svgNS, "svg");
    ns.setAttribute("viewBox", "0 0 24 24");
    const p = document.createElementNS(svgNS, "path");
    p.setAttribute("d", pathD);
    ns.appendChild(p);
    return ns;
  }

  const ICONS = {
    grip: "M8 6h.01M16 6h.01M8 12h.01M16 12h.01M8 18h.01M16 18h.01",
    play: "M8 5.5v13l11-6.5z",
    pause: "M7 5h3.2v14H7zM13.8 5H17v14h-3.2z",
    trash: "M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M10 11v6M14 11v6",
    vol: "M11 5 6.5 9H2v6h4.5L11 19zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"
  };

  function iconBtn(id, label) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = id;
    b.title = label;
    b.setAttribute("aria-label", label);
    return b;
  }

  /* ---------- state cache (avoid rebuilding each frame) ---------- */
  let trackEls = new Map(); // id -> root element (only during a render cycle)

  function emptyStateTrackEls() { trackEls = new Map(); }

  /* ---------- main render ---------- */
  function renderEditor() {
    const list = document.getElementById("track-list");
    if (!list) return;
    const state = MMix.store;
    const tracks = state.tracks;
    emptyStateTrackEls();
    list.innerHTML = "";

    if (!tracks.length) {
      renderEmpty(list);
      return;
    }

    tracks.forEach((tr, i) => {
      const card = buildTrackCard(tr, i);
      list.appendChild(card);
      trackEls.set(tr.id, card);
      if (i < tracks.length - 1) {
        list.appendChild(buildTransitionRow(tr, tracks[i + 1], i));
      }
    });
  }

  function renderEmpty(container) {
    const div = document.createElement("div");
    div.className = "list-empty";
    div.textContent = "Add audio to begin building your mix.";
    container.appendChild(div);
  }

  /* ---------- track card ---------- */
  function buildTrackCard(tr, index) {
    const card = document.createElement("div");
    card.className = "track-card";
    card.dataset.id = tr.id;

    const meta = document.createElement("div");
    meta.className = "track-meta";
    const grip = document.createElement("div");
    grip.className = "track-grip";
    const gripSvg = sym(ICONS.grip);
    gripSvg.setAttribute("stroke", "currentColor");
    gripSvg.setAttribute("stroke-width", "1.6");
    gripSvg.setAttribute("stroke-linecap", "round");
    gripSvg.setAttribute("fill", "none");
    grip.appendChild(gripSvg);
    grip.title = "Drag to reorder";
    grip.setAttribute("aria-label", "Drag to reorder");

    const num = document.createElement("span");
    num.className = "track-num";
    num.textContent = index + 1;

    const name = document.createElement("span");
    name.className = "track-name";
    name.textContent = tr.name;
    name.title = tr.name;

    const dur = document.createElement("span");
    dur.className = "track-dur";
    dur.textContent = fmtShort(tr.duration);

    meta.appendChild(grip);
    meta.appendChild(num);
    meta.appendChild(name);
    meta.appendChild(dur);

    const actions = document.createElement("div");
    actions.className = "track-actions";

    const playBtn = iconBtn("icon-btn play-track-btn", stateStore().soloTrackId === tr.id ? "Pause track" : "Play track");
    const playSvg = sym(ICONS.play);
    playSvg.setAttribute("fill", "currentColor");
    playBtn.appendChild(playSvg);
    playBtn.dataset.action = "play";
    if (stateStore().soloTrackId === tr.id) markSoloPlaying(playBtn, true);

    const volWrap = document.createElement("div");
    volWrap.className = "vol";

    const volDown = document.createElement("button");
    volDown.type = "button";
    volDown.className = "vol-btn";
    volDown.dataset.action = "vol-down";
    volDown.innerHTML = "-";
    volDown.setAttribute("aria-label", "Decrease volume");
    volWrap.appendChild(volDown);

    const volSvg = sym(ICONS.vol);
    volSvg.setAttribute("fill", "none");
    volSvg.setAttribute("stroke", "currentColor");
    volSvg.setAttribute("stroke-width", "1.6");
    volSvg.setAttribute("stroke-linecap", "round");
    volSvg.setAttribute("stroke-linejoin", "round");
    volWrap.appendChild(volSvg);

    const volInput = document.createElement("input");
    volInput.type = "range";
    volInput.min = "0"; volInput.max = "100"; volInput.value = tr.volume;
    volInput.step = "1";
    volInput.dataset.action = "volume";
    volInput.setAttribute("aria-label", "Volume");
    volWrap.appendChild(volInput);

    const volUp = document.createElement("button");
    volUp.type = "button";
    volUp.className = "vol-btn";
    volUp.dataset.action = "vol-up";
    volUp.innerHTML = "+";
    volUp.setAttribute("aria-label", "Increase volume");
    volWrap.appendChild(volUp);

    const delBtn = iconBtn("icon-btn delete-btn", "Remove track");
    delBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M10 11v6M14 11v6"/></svg>';
    delBtn.dataset.action = "delete";

    actions.appendChild(playBtn);
    actions.appendChild(volWrap);
    actions.appendChild(delBtn);

    const main = document.createElement("div");
    main.className = "track-main";
    main.appendChild(meta);
    main.appendChild(actions);
    card.appendChild(main);

    // waveform + trim handles
    const waveWrap = document.createElement("div");
    waveWrap.className = "wave-wrap";
    const canvas = document.createElement("canvas");
    canvas.className = "wave";
    waveWrap.appendChild(canvas);

    const head = document.createElement("button");
    head.type = "button";
    head.className = "wave-playhead";
    head.innerHTML = '<span class="head-line"></span><span class="head-knob"></span>';
    head.setAttribute("aria-label", "Playback position. Drag to seek.");
    waveWrap.appendChild(head);

    const handleL = makeTrimHandle("l");
    const handleR = makeTrimHandle("r");
    waveWrap.appendChild(handleL);
    waveWrap.appendChild(handleR);

    // selection masks (shade trimmed-out parts)
    const maskL = document.createElement("div");
    maskL.className = "trim-region-l";
    maskL.style.width = "0%";
    maskL.style.left = "0";
    const maskR = document.createElement("div");
    maskR.className = "trim-region-r";
    maskR.style.width = "0%";
    maskR.style.right = "0";
    waveWrap.appendChild(maskL);
    waveWrap.appendChild(maskR);

    card.appendChild(waveWrap);

    const meta2 = document.createElement("div");
    meta2.className = "trim-meta";

    const mkField = (label, cls, aria) => {
      const wrap = document.createElement("label");
      wrap.className = "trim-field";
      wrap.appendChild(document.createTextNode(label + " "));
      const inp = document.createElement("input");
      inp.type = "text";
      inp.inputMode = "decimal";
      inp.className = "trim-input " + cls;
      inp.dataset.action = "trim-meta-" + cls;
      inp.setAttribute("autocomplete", "off");
      inp.setAttribute("aria-label", aria);
      wrap.appendChild(inp);
      const unit = document.createElement("span");
      unit.className = "trim-unit";
      unit.textContent = "s";
      wrap.appendChild(unit);
      return wrap;
    };

    meta2.appendChild(mkField("Start", "start", "Trim start time in seconds"));
    meta2.appendChild(mkField("End", "end", "Trim end time in seconds"));

    const durSpan = document.createElement("span");
    durSpan.className = "trim-dur";
    durSpan.innerHTML = 'Duration <strong class="trim-dur-val"></strong>';
    meta2.appendChild(durSpan);

    card.appendChild(meta2);

    // initial geometry
    updateWaveGeometry(card, tr);

    return card;
  }

  function makeTrimHandle(side) {
    const h = document.createElement("div");
    h.className = "trim-handle handle-" + side;
    h.dataset.action = "trim-" + side;
    const cap = document.createElement("div");
    cap.className = "trim-cap";
    for (let i = 0; i < 2; i++) {
      const bar = document.createElement("span");
      bar.className = "trim-grip";
      cap.appendChild(bar);
    }
    h.appendChild(cap);
    h.setAttribute("aria-hidden", "true");
    return h;
  }

  function stateStore() { return MMix.store; }

  /* ---------- waveform layout updates ---------- */
  // Reposition masks/handles and redraw the canvas for a card.
  function updateWaveGeometry(card, tr) {
    const wrap = card.querySelector(".wave-wrap");
    if (!wrap) return;
    const cardRect = wrap.getBoundingClientRect();
    const dur = tr.duration;
    const xStart = (tr.start / dur) * 100;
    const xEnd = (tr.end / dur) * 100;

    const maskL = card.querySelector(".trim-region-l");
    const maskR = card.querySelector(".trim-region-r");
    if (maskL && maskR) {
      maskL.style.width = xStart + "%";
      maskR.style.width = (100 - xEnd) + "%";
      maskR.style.left = xEnd + "%";
    }
    const hl = card.querySelector(".handle-l");
    const hr = card.querySelector(".handle-r");
    // center the 15px-wide handle boxes on the trim boundaries
    if (hl) hl.style.left = "calc(" + xStart + "% - 7.5px)";
    if (hr) hr.style.left = "calc(" + xEnd + "% - 7.5px)";

    const canvas = card.querySelector("canvas.wave");
    if (canvas) {
      MMix.Waveform.draw(canvas, tr, { playhead: null });
    }

    const meta = card.querySelector(".trim-meta");
    if (meta) {
      const sel = tr.end - tr.start;
      const startInp = meta.querySelector(".trim-input.start");
      const endInp = meta.querySelector(".trim-input.end");
      const durVal = meta.querySelector(".trim-dur-val");
      if (startInp) startInp.max = tr.duration;
      if (endInp) endInp.max = tr.duration;
      if (durVal) durVal.textContent = fmt(sel);
      // avoid clobbering the field the user is typing into
      if (startInp && document.activeElement !== startInp) startInp.value = fmt(tr.start);
      if (endInp && document.activeElement !== endInp) endInp.value = fmt(tr.end);
    }
  }

  /* ---------- transition row ---------- */
  function buildTransitionRow(a, b, index) {
    const state = stateStore();
    const trans = state.getTransition(a, b);

    const row = document.createElement("div");
    row.className = "transition-row";
    row.dataset.between = a.id + "|" + b.id;

    row.appendChild(transLabel(a, index));

    const ctl = document.createElement("div");
    ctl.className = "transition-ctl";

    const sel = document.createElement("select");
    sel.className = "transition-select";
    sel.dataset.action = "transition-type";
    sel.dataset.between = a.id + "|" + b.id;
    sel.setAttribute("aria-label", "Transition type");
    state.TRANSITION_TYPES.forEach(t => {
      const o = document.createElement("option");
      o.value = t.id;
      o.textContent = t.label;
      if (t.id === trans.type) o.selected = true;
      sel.appendChild(o);
    });

    const durSel = document.createElement("select");
    durSel.className = "transition-dur-select";
    durSel.dataset.action = "transition-dur";
    durSel.dataset.between = a.id + "|" + b.id;
    durSel.setAttribute("aria-label", "Transition duration");
    if (trans.type === "none") durSel.disabled = true;
    state.TRANSITION_DURATIONS.forEach(d => {
      const o = document.createElement("option");
      o.value = d;
      o.textContent = num(d) + "s";
      if (d === trans.duration && trans.type !== "none") o.selected = true;
      durSel.appendChild(o);
    });

    ctl.appendChild(sel);
    ctl.appendChild(durSel);
    row.appendChild(ctl);

    row.appendChild(transLabel(b, index + 1));
    return row;
  }

  function transLabel(tr, index) {
    const label = document.createElement("span");
    label.className = "transition-label";
    label.textContent = "Track ";
    const b = document.createElement("b");
    b.textContent = (index + 1);
    label.appendChild(b);
    return label;
  }

  function transLabelText(trans) {
    const map = {
      none: "None",
      crossfade: "Crossfade",
      "fadeout-fadein": "Fade out → Fade in"
    };
    return map[trans.type] || "Transition";
  }

  function num(n) { return String(n).replace(/\.0+$/, ""); }

  /* ---------- transition popover ---------- */
  let _pop = null;
  let _popAlloc = null;

  function openTransitionPopover(btn, idA, idB) {
    closeTransitionPopover();
    const state = stateStore();
    const trans = state.getTransition(state.getTrack(idA), state.getTrack(idB));
    const pop = document.getElementById("transition-popover");
    pop.classList.remove("hidden");
    pop.innerHTML = "";

    const title = document.createElement("div");
    title.className = "tp-title";
    title.textContent = "Transition between tracks";
    pop.appendChild(title);

    state.TRANSITION_TYPES.forEach(t => {
      const opt = document.createElement("button");
      opt.type = "button";
      opt.className = "tp-option" + (trans.type === t.id ? " active" : "");
      opt.dataset.val = t.id;
      opt.textContent = t.label;
      pop.appendChild(opt);
    });

    const sep = document.createElement("div");
    sep.className = "tp-sep";
    pop.appendChild(sep);

    const durTitle = document.createElement("div");
    durTitle.className = "tp-title";
    durTitle.textContent = "Duration";
    pop.appendChild(durTitle);

    const durs = document.createElement("div");
    durs.className = "tp-durs";
    state.TRANSITION_DURATIONS.forEach(d => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "tp-dur" + (trans.duration === d && trans.type !== "none" ? " active" : "");
      chip.dataset.val = d;
      chip.textContent = num(d) + "s";
      durs.appendChild(chip);
    });
    pop.appendChild(durs);
    if (trans.type === "none") {
      durs.classList.add("hidden");
    } else {
      durs.classList.remove("hidden");
    }

    _popAlloc = { idA, idB };
    positionPopover(pop, btn);
  }

  function positionPopover(pop, anchor) {
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth || 250;
    let left = r.left + r.width / 2 - w / 2;
    const right = left + w;
    left = Math.max(12, left);
    if (right > window.innerWidth - 12) left = window.innerWidth - 12 - w;
    pop.style.left = left + "px";
    pop.style.top = (r.bottom + 8) + "px";
  }

  function closeTransitionPopover() {
    const pop = document.getElementById("transition-popover");
    if (pop) pop.classList.add("hidden");
    _popAlloc = null;
    document.querySelectorAll(".transition-btn.open").forEach(b => b.classList.remove("open"));
  }

  function updatePopoverActive() {
    const pop = document.getElementById("transition-popover");
    if (!pop || !_popAlloc) return;
    const state = stateStore();
    const trans = state.getTransition(state.getTrack(_popAlloc.idA), state.getTrack(_popAlloc.idB));
    pop.querySelectorAll(".tp-option").forEach(o => o.classList.toggle("active", o.dataset.val === trans.type));
    const durs = pop.querySelector(".tp-durs");
    pop.querySelectorAll(".tp-dur").forEach(c => c.classList.toggle("active", c.dataset.val == trans.duration));
    if (trans.type === "none") durs.classList.add("hidden");
    else durs.classList.remove("hidden");
  }

  function inPopover(el) {
    const pop = document.getElementById("transition-popover");
    return pop && !pop.classList.contains("hidden") && (el === pop || pop.contains(el));
  }

  /* ---------- reorder dragging ---------- */
  let _drag = null;

  function startDrag(startEvent, card) {
    const state = stateStore();
    const tracks = state.tracks;
    if (tracks.length < 2) return;
    if (_drag) return;

    window.MMix.App && MMix.App.pausePlayback && MMix.App.pausePlayback();

    const rect = card.getBoundingClientRect();
    const ghost = document.getElementById("drag-ghost");
    ghost.innerHTML =
      '<div class="ghost-bar"></div><div class="ghost-bar"></div><div class="ghost-name"></div>';
    ghost.querySelector(".ghost-name").textContent = card.querySelector(".track-name").textContent;
    ghost.style.width = rect.width + "px";
    ghost.style.background = "var(--card)";
    ghost.style.padding = "1rem";
    ghost.classList.remove("hidden");

    card.classList.add("dragging");

    const grip = card.querySelector(".track-grip");
    const grabOffsetY = startEvent.clientY - rect.top;

    _drag = {
      card,
      fromIndex: tracks.findIndex(t => t.id === card.dataset.id),
      ghost,
      grabOffsetY,
      overIndex: null,
      moved: false
    };
    try { grip.setPointerCapture(startEvent.pointerId); grip._pc = startEvent.pointerId; } catch (e) {}

    moveGhostTo(startEvent.clientX, startEvent.clientY);
  }

  function moveGhostTo(x, y) {
    const g = _drag.ghost;
    g.style.left = (x - 40) + "px";
    g.style.top = (y - _drag.grabOffsetY + 10) + "px";
  }

  function computeDropIndex(clientY) {
    const state = stateStore();
    const cards = Array.from(document.querySelectorAll(".track-card"));
    let idx = cards.length; // default: drop after the last card
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) { idx = i; break; }
    }
    // When moving down, the final index collapses by one after removing the dragged card.
    if (idx > _drag.fromIndex) idx -= 1;
    return Math.max(0, Math.min(state.tracks.length - 1, idx));
  }

  function updateDropHighlight() {
    const cards = Array.from(document.querySelectorAll(".track-card"));
    cards.forEach(c => c.classList.remove("drop-above", "drop-below"));
    if (!_drag) return;
    const target = computeDropIndex(_drag.lastY);
    if (target === _drag.fromIndex) return;
    const tcard = cards[target];
    if (tcard) tcard.classList.add(target < _drag.fromIndex ? "drop-above" : "drop-below");
  }

  function finishDrag() {
    if (!_drag) return;
    const state = stateStore();
    const from = _drag.fromIndex;
    let moved = false;
    if (_drag.moved) {
      const to = computeDropIndex(_drag.lastY);
      moved = state.moveTrack(from, to);
    }
    _drag.card.classList.remove("dragging");
    _drag.ghost.classList.add("hidden");
    _drag = null;
    document.querySelectorAll(".track-card").forEach(c => c.classList.remove("drop-above", "drop-below"));
    if (moved) {
      renderEditor();
      window.dispatchEvent(new CustomEvent("mm:orderchanged"));
      if (window.MMix && MMix.App && MMix.App.updateControlBar) MMix.App.updateControlBar();
      scheduleRescheduleIfPlaying(0);
    }
  }

  /* ---------- delegation wiring ---------- */
  function wire(listEl) {
    listEl.addEventListener("click", onListClick);
    listEl.addEventListener("input", onListInput);
    listEl.addEventListener("change", onListChange);
    listEl.addEventListener("pointerdown", onListPointerDown);
    listEl.addEventListener("pointermove", onListPointerMove);
    listEl.addEventListener("pointerup", onListPointerUp);
    listEl.addEventListener("pointercancel", onListPointerUp);
    document.addEventListener("click", onDocumentClick);
    window.addEventListener("resize", onResize);
    window.addEventListener("mm:orderchanged", onResize);
  }

  function trackFromEl(el) {
    const card = el.closest(".track-card");
    return card ? stateStore().getTrack(card.dataset.id) : null;
  }

  function cardFromEl(el) {
    return el.closest(".track-card");
  }

  function trackOf(id) { return stateStore().getTrack(id); }

  // Popover lives outside the list, so its clicks are handled at document level.
  function onDocumentClick(e) {
    const opt = e.target.closest(".tp-option");
    if (opt && _popAlloc) {
      const { idA, idB } = _popAlloc;
      const state = stateStore();
      const cur = trackOf(idA), nxt = trackOf(idB);
      if (!cur || !nxt) return;
      state.setTransition(idA, idB, {
        type: opt.dataset.val,
        duration: (opt.dataset.val === "none" ? 0 : state.getTransition(cur, nxt).duration)
      });
      updateAll();
      return;
    }
    const chip = e.target.closest(".tp-dur");
    if (chip && _popAlloc) {
      const { idA, idB } = _popAlloc;
      const state = stateStore();
      const cur = trackOf(idA), nxt = trackOf(idB);
      if (!cur || !nxt) return;
      state.setTransition(idA, idB, {
        type: state.getTransition(cur, nxt).type === "none" ? "crossfade" : state.getTransition(cur, nxt).type,
        duration: parseFloat(chip.dataset.val)
      });
      updateAll();
      return;
    }
    if (!_popAlloc || inPopover(e.target)) return;
    if (!e.target.closest(".transition-btn")) closeTransitionPopover();
  }

  /* click */
  function onListClick(e) {
    const actionBtn = e.target.closest("[data-action]");
    if (actionBtn) {
      const action = actionBtn.dataset.action;
      if (action === "transition") {
        const [a, b] = actionBtn.dataset.between.split("|");
        document.querySelectorAll(".transition-btn").forEach(x => x.classList.remove("open"));
        actionBtn.classList.add("open");
        openTransitionPopover(actionBtn, a, b);
        return;
      }
      if (action === "play") {
        const tr = trackFromEl(actionBtn);
        if (tr) MMix.App.toggleSolo(tr.id);
        return;
      }
      if (action === "delete") {
        const tr = trackFromEl(actionBtn);
        if (tr) MMix.App.removeTrackById(tr.id);
        return;
      }
      if (action === "vol-up" || action === "vol-down") {
        const tr = trackFromEl(actionBtn);
        if (!tr) return;
        const delta = action === "vol-up" ? 10 : -10;
        const next = Math.max(0, Math.min(100, Math.round(tr.volume + delta)));
        MMix.state.setVolume(tr.id, next);
        const inp = actionBtn.closest(".vol") ? actionBtn.closest(".vol").querySelector("input[type=range]") : null;
        if (inp) inp.value = next;
        MMix.Audio.setLiveGain(tr.id, tr.volume);
        return;
      }
    }
    const outside = !inPopover(e.target) && !e.target.closest(".transition-btn");
    if (outside) closeTransitionPopover();
  }

  /* input (range sliders) */
  function onListInput(e) {
    const el = e.target;
    if (!el.dataset || !el.dataset.action) return;
    if (el.dataset.action === "volume") {
      const tr = trackFromEl(el);
      if (!tr) return;
      MMix.state.setVolume(tr.id, parseInt(el.value, 10));
      MMix.Audio.setLiveGain(tr.id, tr.volume);
      return;
    }
    if (el.dataset.action === "trim-meta-start" || el.dataset.action === "trim-meta-end") {
      const tr = trackFromEl(el);
      const card = cardFromEl(el);
      const v = parseTimeInput(el.value);
      if (!tr || !card || v == null || isNaN(v)) return;
      if (el.dataset.action === "trim-meta-start") MMix.state.setTrim(tr.id, v, tr.end);
      else MMix.state.setTrim(tr.id, tr.start, v);
      updateWaveGeometry(card, tr);
      MMix.App.updateControlBar && MMix.App.updateControlBar();
      scheduleRescheduleIfPlaying(180);
    }
  }

  /* change (selects + blur commit of trim fields) */
  function onListChange(e) {
    const el = e.target;
    if (!el.dataset || !el.dataset.action) return;

    if (el.dataset.action === "trim-meta-start" || el.dataset.action === "trim-meta-end") {
      const tr = trackFromEl(el);
      const card = cardFromEl(el);
      if (!tr || !card) return;
      updateWaveGeometry(card, tr);
      MMix.App.updateControlBar && MMix.App.updateControlBar();
      scheduleRescheduleIfPlaying(0);
      return;
    }

    if (el.dataset.action === "transition-type") {
      const [a, b] = el.dataset.between.split("|");
      const state = stateStore();
      const cur = trackOf(a), nxt = trackOf(b);
      if (!cur || !nxt) return;
      state.setTransition(a, b, {
        type: el.value,
        duration: el.value === "none" ? 0 : state.getTransition(cur, nxt).duration
      });
      updateAll();
      return;
    }

    if (el.dataset.action === "transition-dur") {
      const [a, b] = el.dataset.between.split("|");
      const state = stateStore();
      const cur = trackOf(a), nxt = trackOf(b);
      if (!cur || !nxt) return;
      const type = state.getTransition(cur, nxt).type === "none" ? "crossfade" : state.getTransition(cur, nxt).type;
      state.setTransition(a, b, { type, duration: parseFloat(el.value) });
      updateAll();
    }
  }

  /* pointer: drag handles + grip + playhead seek */
  let _trimDrag = null;
  let _seekDrag = null;
  let _trimResched = null;
  let _trimLiveLast = 0;
  // Re-sync running playback to the latest trim, debounced for live typing.
  function scheduleRescheduleIfPlaying(delay) {
    if (!window.MMix || !MMix.App || !MMix.App.rescheduleIfPlaying) return;
    clearTimeout(_trimResched);
    _trimResched = setTimeout(MMix.App.rescheduleIfPlaying, delay == null ? 160 : delay);
  }
  // During a trim-handle drag, restart playback from the live position at a
  // throttled cadence so the audio tracks the handle in real time.
  function rescheduleLiveDuringTrim() {
    if (!window.MMix || !MMix.App || !MMix.App.rescheduleIfPlaying) return;
    const now = performance.now();
    if (now - _trimLiveLast < 90) return;
    _trimLiveLast = now;
    clearTimeout(_trimResched);
    MMix.App.rescheduleIfPlaying();
  }

  function onListPointerDown(e) {
    const grip = e.target.closest(".track-grip");
    if (grip) {
      e.preventDefault();
      const card = cardFromEl(grip);
      if (card) startDrag(e, card);
      return;
    }

    const handle = e.target.closest(".trim-handle");
    if (handle) {
      const card = cardFromEl(handle);
      if (!card) return;
      const tr = stateStore().getTrack(card.dataset.id);
      if (!tr) return;
      e.preventDefault();
      const side = handle.classList.contains("handle-l") ? "l" : "r";
      const wrap = card.querySelector(".wave-wrap");
      const rect = wrap.getBoundingClientRect();
      const xToTime = (clientX) => Math.max(0, Math.min(tr.duration, ((clientX - rect.left) / rect.width) * tr.duration));

      _trimDrag = { card, tr, side, xToTime, wrap };
      try { handle.setPointerCapture(e.pointerId); } catch (err) {}
      return;
    }

    // whole waveform is a scrub bar: drag (or click) to move the playhead
    const wrapHit = e.target.closest(".wave-wrap");
    if (wrapHit) {
      e.preventDefault();
      const card = cardFromEl(wrapHit);
      if (!card) return;
      const tr = stateStore().getTrack(card.dataset.id);
      if (!tr) return;
      const rect = wrapHit.getBoundingClientRect();
      const xToRatio = (clientX) => Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      if (MMix.App && MMix.App.pausePlayback) MMix.App.pausePlayback();
      _seekDrag = { trackId: tr.id, xToRatio, ratio: xToRatio(e.clientX) };
      if (MMix.App.onPlayheadDrag) MMix.App.onPlayheadDrag(_seekDrag.trackId, _seekDrag.ratio);
      return;
    }
  }

  function onListPointerMove(e) {
    if (_seekDrag) {
      _seekDrag.ratio = _seekDrag.xToRatio(e.clientX);
      if (MMix.App.onPlayheadDrag) MMix.App.onPlayheadDrag(_seekDrag.trackId, _seekDrag.ratio);
      return;
    }
    if (_trimDrag) {
      const t = _trimDrag.xToTime(e.clientX);
      applyTrimDrag(t);
      updateSingleGeometry(_trimDrag.card, _trimDrag.tr);
      rescheduleLiveDuringTrim();
      return;
    }
    if (_drag) {
      _drag.lastY = e.clientY;
      _drag.moved = true;
      moveGhostTo(e.clientX, e.clientY);
      updateDropHighlight();
    }
  }

  function applyTrimDrag(t) {
    const { tr, side } = _trimDrag;
    const min = 0.05;
    if (side === "l") {
      const start = Math.max(0, Math.min(t, tr.end - min));
      MMix.state.setTrim(tr.id, start, tr.end);
    } else {
      const end = Math.min(tr.duration, Math.max(t, tr.start + min));
      MMix.state.setTrim(tr.id, tr.start, end);
    }
    if (MMix.App && MMix.App.updateControlBar) MMix.App.updateControlBar();
  }

  function onListPointerUp(e) {
    if (_seekDrag) {
      const { trackId, ratio } = _seekDrag;
      _seekDrag = null;
      // always play from the dropped position, whether it was playing or paused
      if (MMix.App.onPlayheadDrop) MMix.App.onPlayheadDrop(trackId, ratio);
      return;
    }
    if (_trimDrag) {
      _trimDrag = null;
      scheduleRescheduleIfPlaying(0);
      return;
    }
    if (_drag) {
      finishDrag();
    }
  }

  function updateSingleGeometry(card, tr) {
    updateWaveGeometry(card, tr);
  }

  /* refresh utilities */
  function updateAll() {
    renderEditor();
    updatePopoverActive();
    MMix.App.updateControlBar && MMix.App.updateControlBar();
    scheduleRescheduleIfPlaying(120);
  }

  function onResize() {
    stateStore().tracks.forEach(tr => {
      const card = trackEls.get(tr.id);
      if (card) updateWaveGeometry(card, tr);
    });
  }

  function refreshWaveforms() {
    onResize();
  }

  function markSoloPlaying(btn, on) {
    btn.classList.toggle("solo-playing", on);
    btn.title = on ? "Pause track" : "Play track";
    btn.innerHTML =
      on
        ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h3.2v14H7zM13.8 5H17v14h-3.2z"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>';
  }

  // Reflect the active solo track across cards without a full re-render.
  function refreshSolo() {
    const soloId = stateStore().soloTrackId;
    stateStore().tracks.forEach(tr => {
      const card = trackEls.get(tr.id);
      if (!card) return;
      const inSolo = tr.id === soloId;
      card.classList.toggle("solo-playing", inSolo);
      if (inSolo) card.querySelectorAll(".solo-playing").forEach(el => el.classList.remove("solo-playing"));
      const btn = card.querySelector(".play-track-btn");
      if (btn) markSoloPlaying(btn, inSolo);
    });
  }

  MMix.UI = {
    renderEditor,
    updateAll,
    refreshWaveforms,
    refreshPopover: updatePopoverActive,
    closeTransitionPopover,
    getCard: (id) => trackEls.get(id),
    markSoloPlaying,
    refreshSolo,
    wire,
    updateWaveGeometry
  };
})();