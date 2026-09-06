/* mix&match - waveform.js
   Peak computation + canvas drawing for track waveforms.
*/
(function () {
  window.MMix = window.MMix || {};

  const COLORS = {
    base: "#e9dcc2",        // faint full-track bars (tan-ish, light)
    region: "#3f2b1d",      // selected/trimmed region (espresso)
    line: "#d9c4a3",        // trim boundary lines
    head: "#ac4a3c"         // playhead
  };

  // Downsample an AudioBuffer into a fixed number of min/max pairs.
  function computePeaks(buffer, buckets) {
    buckets = Math.max(1, buckets || 600);
    const ch = 0; // stereo mixes are summarized from the first two channels
    const data0 = buffer.getChannelData(ch);
    const data1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
    const n = data0.length;
    const step = Math.max(1, Math.floor(n / buckets));
    const peaks = [];

    for (let i = 0; i < buckets; i++) {
      const start = i * step;
      const end = Math.min(n, start + step);
      let min = 0, max = 0, idx = start;
      for (; idx < end; idx++) {
        let v = data0[idx];
        if (data1) v = (v + data1[idx]) / 2;
        if (v < min) min = v;
        else if (v > max) max = v;
      }
      peaks.push({ min, max });
    }
    return peaks;
  }

  function fmt(s) {
    s = Math.max(0, Math.round(s * 10) / 10);
    const m = Math.floor(s / 60);
    const ss = s - m * 60;
    return m + ":" + (ss < 10 ? "0" : "") + ss.toFixed(ss % 1 ? 1 : 0);
  }

  function fmtShort(s) {
    s = Math.max(0, s);
    const m = Math.floor(s / 60);
    const ss = Math.floor(s - m * 60);
    return m + ":" + (ss < 10 ? "0" : "") + ss;
  }

  // Draw the full waveform with the trimmed selection highlighted.
  //  canvas  : <canvas> (already sized to its layout box)
  //  track   : state track {peaks, duration, start, end}
  //  opts    : { playing, playhead (time in track seconds or null) }
  function drawWaveform(canvas, track, opts) {
    opts = opts || {};
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const W = Math.max(1, rect.width);
    const H = Math.max(1, rect.height);
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const peaks = track.peaks;
    if (!peaks || !peaks.length) return;

    const dur = track.duration || 1;
    const mid = H / 2;
    const barW = Math.max(1, W / peaks.length);

    const xOf = (t) => Math.min(W, (t / dur) * W);

    // 1) full waveform, faint
    ctx.fillStyle = COLORS.base;
    for (let i = 0; i < peaks.length; i++) {
      const x = (i / peaks.length) * W;
      const top = mid - peaks[i].max * mid;
      const h = Math.max(1.4, (peaks[i].max - peaks[i].min) * mid);
      ctx.fillRect(x, top, barW + 0.5, h);
    }

    // 2) selected region, espresso
    const xStart = xOf(track.start);
    const xEnd = xOf(track.end);
    ctx.fillStyle = COLORS.region;
    ctx.beginPath();
    ctx.rect(xStart, 0, xEnd - xStart, H);
    ctx.save();
    ctx.clip();
    for (let i = 0; i < peaks.length; i++) {
      const x = (i / peaks.length) * W;
      const top = mid - peaks[i].max * mid;
      const h = Math.max(1.6, (peaks[i].max - peaks[i].min) * mid);
      ctx.fillRect(x, top, barW + 0.5, h);
    }
    ctx.restore();

    // 3) trim boundary lines
    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(xStart + 0.5, 2);
    ctx.lineTo(xStart + 0.5, H - 2);
    ctx.moveTo(xEnd + 0.5, 2);
    ctx.lineTo(xEnd + 0.5, H - 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // 4) playhead
    if (opts.playhead != null) {
      const px = xOf(opts.playhead);
      ctx.fillStyle = COLORS.head;
      ctx.fillRect(px - 0.5, 0, 2, H);
    }
  }

  MMix.Waveform = {
    computePeaks,
    draw: drawWaveform,
    fmt,
    fmtShort
  };
})();