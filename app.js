// Live scan in the browser - same rules as mudrex_scanner.py, public data only.
(function () {
  "use strict";
  var BASE = "https://trade.mudrex.com/fapi/v1/price/kline";
  var C = null; // config from coins.json

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function klines(pairs, agg, bars, secs) {
    var end = Math.floor(Date.now() / 1000), start = end - bars * secs, out = {};
    for (var i = 0; i < pairs.length; i += 25) {
      var chunk = pairs.slice(i, i + 25).join(",");
      var url = BASE + "?assets=" + chunk + "&aggregation=" + agg + "&start_time=" + start + "&end_time=" + end;
      var res = await fetch(url, { cache: "no-store" });
      if (res.status === 429) { await sleep(3000); i -= 25; continue; }
      if (!res.ok) throw new Error("Mudrex returned HTTP " + res.status);
      var body = await res.json();
      var ticks = (body.data && body.data.asset_ticks) || {};
      Object.keys(ticks).forEach(function (k) {
        out[k.toUpperCase()] = ticks[k].slice().sort(function (a, b) { return a[0] - b[0]; })
          .map(function (r) { return [r[0], +r[1], +r[2], +r[3], +r[4], +r[5]]; });
      });
      progress(agg, Math.min(i + 25, pairs.length), pairs.length);
    }
    return out;
  }

  // Supertrend(10,3), Wilder ATR - mirrors the Python version
  function supertrend(c, period, mult) {
    period = period || 10; mult = mult || 3;
    var n = c.length; if (n < period + 2) return [];
    var tr = c.map(function (x, i) {
      if (i === 0) return x[2] - x[3];
      var pc = c[i - 1][4];
      return Math.max(x[2] - x[3], Math.abs(x[2] - pc), Math.abs(x[3] - pc));
    });
    var atr = new Array(n).fill(null), s = 0;
    for (var i = 0; i < period; i++) s += tr[i];
    atr[period - 1] = s / period;
    for (i = period; i < n; i++) atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
    var out = new Array(n).fill(null), fu = null, fl = null, green = true;
    for (i = period - 1; i < n; i++) {
      var h = c[i][2], l = c[i][3], cl = c[i][4], mid = (h + l) / 2;
      var bu = mid + mult * atr[i], bl = mid - mult * atr[i];
      var prev = i > 0 ? c[i - 1][4] : cl;
      fu = (fu === null || bu < fu || prev > fu) ? bu : fu;
      fl = (fl === null || bl > fl || prev < fl) ? bl : fl;
      if (green && cl < fl) green = false; else if (!green && cl > fu) green = true;
      out[i] = [green ? fl : fu, green];
    }
    return out;
  }

  var LOG_KEY = "mudrexScanLog", LOG_DAYS = 14, LOG_MAX = 600;
  var TAKEN_KEY = "mudrexTaken", TAKEN_DAYS = 60, TAKEN_SHOW_DAYS = 7;
  var lastFound = [], lastScan = 0;
  function cfgNum(k, d) { return (C && typeof C[k] === "number") ? C[k] : d; }
  function holdHours() { return cfgNum("TIME_STOP_HOURS", 24); }

  // Shorts are sized larger than longs (rulebook 11 Nov); falls back to the long limits on an old coins.json
  function marginFor(d, side) {
    var short = side === "SHORT";
    var risk = short ? cfgNum("MAX_RISK_SHORT", C.MAX_RISK) : C.MAX_RISK;
    var cap = short ? cfgNum("MAX_MARGIN_SHORT", C.MAX_MARGIN) : C.MAX_MARGIN;
    return d > 0 ? Math.min(cap, risk / d) : 0;
  }

  function checkShort(h1, h4) {
    if (h4.length < 20 || h1.length < 30) return null;
    var w = h4.slice(-18), lo_i = 0, hi_i = 0;
    w.forEach(function (x, i) { if (x[3] < w[lo_i][3]) lo_i = i; if (x[2] > w[hi_i][2]) hi_i = i; });
    var lo = w[lo_i][3], hi = w[hi_i][2];
    if (hi_i <= lo_i || lo <= 0 || hi / lo - 1 < C.SPIKE_MIN_RISE) return null;
    var price = h1[h1.length - 1][4], st1 = supertrend(h1);
    if (!st1.length || !st1[st1.length - 1]) return null;
    var recentHigh = Math.max.apply(null, h1.slice(-6).map(function (x) { return x[2]; }));
    var status;
    if (st1[st1.length - 1][1] === false) status = "TRIGGERED";
    else if (recentHigh < hi * 0.98 && price < hi * 0.95) status = "WATCH";
    else return null;
    var stop = hi * 1.005, dist = stop / price - 1;
    if (dist < C.MIN_STOP_DIST || dist > C.MAX_STOP_DIST) return null;
    var st4 = supertrend(h4), l4 = st4.length && st4[st4.length - 1] ? st4[st4.length - 1][0] : null;
    var loClose = Math.min.apply(null, w.slice(0, hi_i + 1).map(function (x) { return x[4]; }));
    var tp = (l4 && l4 < price) ? l4 : loClose, rr = (price - tp) / (stop - price);
    if (rr < C.MIN_RR) return null;
    return { side: "SHORT", status: status, price: price, stop: stop, tp: tp, dist: dist, rr: rr,
      margin: marginFor(dist, "SHORT"), note: "rose " + Math.round(100 * (hi / lo - 1)) + "% in 3d to " + fmt(hi) };
  }

  function checkLong(h1, h4) {
    if (h4.length < 30 || h1.length < 30) return null;
    var st4 = supertrend(h4), last = st4[st4.length - 1];
    if (!last || !last[1]) return null;
    var line = last[0], price = h4[h4.length - 1][4];
    for (var k = st4.length - 6; k < st4.length; k++) if (!st4[k] || !st4[k][1]) return null;
    var flip = st4.length - 1;
    while (flip > 0 && st4[flip - 1] && st4[flip - 1][1]) flip--;
    var off = Math.max(0, h4.length - 60), hiIdx = off;
    for (k = off; k < h4.length; k++) if (h4[k][4] > h4[hiIdx][4]) hiIdx = k; // highest CLOSE, not wick
    if (hiIdx < flip) return null;
    var h60 = h4[hiIdx][4], pull = 1 - price / h60;
    if (pull < 0.03 || pull > 0.12 || price <= line) return null;
    var stop = line * 0.995, dist = 1 - stop / price;
    if (dist < C.MIN_STOP_DIST || dist > 0.12) return null;
    var rr = (h60 - price) / (price - stop);
    if (rr < C.MIN_RR) return null;
    var st1 = supertrend(h1), s1 = st1[st1.length - 1];
    return { side: "LONG", status: (s1 && s1[1]) ? "TRIGGERED" : "WATCH", price: price, stop: stop, tp: h60,
      dist: dist, rr: rr, margin: marginFor(dist), note: Math.round(100 * pull) + "% below 10d closing high " + fmt(h60) };
  }

  function fmt(x) { return (+x).toPrecision(6).replace(/\.?0+$/, "").replace(/\.?0+e/, "e"); }
  function inr(x) { return "₹" + Math.round(x).toLocaleString("en-IN"); }
  function esc(s) { var d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

  // Times are always shown in IST, whatever the device is set to
  function when(ms) {
    return new Date(ms).toLocaleString("en-IN", { weekday: "short", day: "2-digit", month: "short",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Kolkata" });
  }
  function istHour(ms) {
    return +new Date(ms).toLocaleString("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: "Asia/Kolkata" });
  }

  // ---- Past flags, kept in this browser ----
  function loadLog() {
    try { var a = JSON.parse(localStorage.getItem(LOG_KEY) || "[]"); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function saveLog(found, now) {
    var log = loadLog().filter(function (x) { return x && x.t >= now - LOG_DAYS * 864e5; });
    found.forEach(function (r) {
      // reopening the page within the hour must not log the same flag again
      var dup = log.some(function (x) {
        return x.symbol === r.symbol && x.side === r.side && x.status === r.status && now - x.t < 3600e3;
      });
      if (!dup) log.push({ t: now, status: r.status, side: r.side, symbol: r.symbol, price: r.price,
        stop: r.stop, tp: r.tp, dist: r.dist, rr: r.rr, margin: r.margin });
    });
    if (log.length > LOG_MAX) log = log.slice(-LOG_MAX);
    try { localStorage.setItem(LOG_KEY, JSON.stringify(log)); return true; } catch (e) { return false; }
  }
  function renderHistory(saved) {
    var box = document.getElementById("hist-list"); if (!box) return;
    var f = document.getElementById("hist-filter"), cnt = document.getElementById("hist-count");
    var q = ((f && f.value) || "").trim().toUpperCase(), now = Date.now(), H = holdHours();
    var all = loadLog();
    var log = all.filter(function (x) { return !q || String(x.symbol).toUpperCase().indexOf(q) === 0; })
      .sort(function (a, b) { return b.t - a.t; });
    if (cnt) cnt.textContent = all.length ? "(" + all.length + ")" : "";
    if (saved === false) { box.innerHTML = '<p class="note">This browser is not saving history (storage is blocked or full).</p>'; return; }
    if (!log.length) {
      box.innerHTML = '<p class="note">' + (q ? "No past flags for " + esc(q) + "." : "Nothing saved yet. Flags appear here after a live scan finds a candidate.") + "</p>";
      return;
    }
    box.innerHTML = log.map(function (x) {
      var cb = x.t + H * 3600e3, left = (cb - now) / 3600e3;
      var leftTxt = left >= 1 ? Math.round(left) + "h left" : left > 0 ? "under 1h left" :
        "time stop passed " + Math.max(1, Math.round(-left)) + "h ago";
      var trig = x.status === "TRIGGERED";
      return '<div class="hrow' + (left > 0 ? "" : " past") + '"><div class="htop">' +
        '<span class="side ' + (x.side === "LONG" ? "long" : "short") + '">' + esc(x.side) + "</span>" +
        "<strong>" + esc(x.symbol) + "</strong>" +
        '<span class="badge ' + (trig ? "b-trig" : "b-watch") + '">' + esc(x.status) + "</span>" +
        '<span class="hwhen">flagged ' + when(x.t) + "</span></div>" +
        '<div class="hbody">Entry ' + fmt(x.price) + " &middot; Stop " + fmt(x.stop) + " &middot; TP " + fmt(x.tp) +
        " &middot; Margin " + inr(x.margin) + "</div>" +
        '<div class="hbody">Close by <strong>' + when(cb) + " IST</strong> &middot; " + leftTxt + "</div></div>";
    }).join("");
  }

  // ---- Trades I took (ticked on a card), kept in this browser ----
  function loadTaken() {
    try { var a = JSON.parse(localStorage.getItem(TAKEN_KEY) || "[]"); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function sameOpen(x, r, now) { // the same coin and side, ticked within the time-stop window
    return x && x.symbol === r.symbol && x.side === r.side && now - x.t < holdHours() * 3600e3;
  }
  function isTaken(r, now) { return loadTaken().some(function (x) { return sameOpen(x, r, now); }); }
  function storeTaken(a) {
    try { localStorage.setItem(TAKEN_KEY, JSON.stringify(a)); return true; } catch (e) { return false; }
  }
  function setTaken(r, on) {
    var now = Date.now();
    var a = loadTaken().filter(function (x) { return x && now - x.t < TAKEN_DAYS * 864e5; });
    if (on) {
      if (!a.some(function (x) { return sameOpen(x, r, now); }))
        a.push({ t: now, flagged: lastScan, status: r.status, side: r.side, symbol: r.symbol, price: r.price,
          stop: r.stop, tp: r.tp, dist: r.dist, rr: r.rr, margin: r.margin });
    } else {
      a = a.filter(function (x) { return !sameOpen(x, r, now); });
    }
    return storeTaken(a);
  }
  function takenText() {
    var rows = loadTaken().sort(function (a, b) { return a.t - b.t; }).map(function (x) {
      return [when(x.t), x.side, x.symbol, x.status, fmt(x.price), fmt(x.stop), fmt(x.tp), Math.round(x.margin)].join(" | ");
    });
    return ["Mudrex scanner picks I took (times in IST)",
      "ticked | side | coin | status | price | stop | TP | margin Rs"].concat(rows).join("\n");
  }
  function renderTaken() {
    var sec = document.getElementById("taken"), box = document.getElementById("taken-list");
    if (!sec || !box) return;
    var now = Date.now(), H = holdHours(), all = loadTaken();
    var show = all.filter(function (x) { return x && now - x.t < TAKEN_SHOW_DAYS * 864e5; })
      .sort(function (a, b) { return b.t - a.t; });
    sec.style.display = all.length ? "block" : "none";
    var cnt = document.getElementById("taken-count");
    if (cnt) cnt.textContent = all.length ? "(" + all.length + ")" : "";
    box.innerHTML = show.length ? show.map(function (x) {
      var cb = x.t + H * 3600e3, left = (cb - now) / 3600e3;
      var leftTxt = left >= 1 ? Math.round(left) + "h left" : left > 0 ? "under 1h left" :
        "time stop passed " + Math.max(1, Math.round(-left)) + "h ago";
      return '<div class="hrow mine' + (left > 0 ? "" : " past") + '"><div class="htop">' +
        '<span class="side ' + (x.side === "LONG" ? "long" : "short") + '">' + esc(x.side) + "</span>" +
        "<strong>" + esc(x.symbol) + "</strong>" +
        '<span class="hwhen">ticked ' + when(x.t) + "</span></div>" +
        '<div class="hbody">Entry ' + fmt(x.price) + " &middot; Stop " + fmt(x.stop) + " &middot; TP " + fmt(x.tp) +
        " &middot; Margin " + inr(x.margin) + "</div>" +
        '<div class="hbody">Close by <strong>' + when(cb) + " IST</strong> &middot; " + leftTxt + "</div>" +
        '<button type="button" class="took-remove" data-t="' + x.t + '" data-s="' + esc(x.symbol) + '">Remove</button></div>';
    }).join("") : '<p class="note">Nothing ticked in the last ' + TAKEN_SHOW_DAYS + " days. Older ticks are still in Copy for review.</p>";
  }

  function card(r, now, i) {
    var trig = r.status === "TRIGGERED", H = holdHours();
    return '<article class="card ' + (trig ? "trig" : "") + '"><div class="top">' +
      '<span class="badge ' + (trig ? "b-trig" : "b-watch") + '">' + r.status + "</span>" +
      '<span class="side ' + (r.side === "LONG" ? "long" : "short") + '">' + r.side + "</span>" +
      '<span class="coin">' + esc(r.symbol) + "</span></div><dl>" +
      "<div><dt>Price</dt><dd>" + fmt(r.price) + "</dd></div>" +
      "<div><dt>Stop</dt><dd>" + fmt(r.stop) + " <small>(" + (100 * r.dist).toFixed(1) + "%)</small></dd></div>" +
      "<div><dt>TP</dt><dd>" + fmt(r.tp) + "</dd></div>" +
      "<div><dt>R:R</dt><dd>" + r.rr.toFixed(1) + "</dd></div>" +
      "<div><dt>Margin</dt><dd>" + inr(r.margin) + "</dd></div>" +
      "<div><dt>Risk</dt><dd>" + inr(r.margin * r.dist) + "</dd></div></dl>" +
      '<p class="hold">Time stop: close by <strong>' + when(now + H * 3600e3) + " IST</strong> if you enter now (" + H + "h)</p>" +
      '<p class="note">' + esc(r.note) + "</p>" +
      '<label class="took"><input type="checkbox" class="took-box" data-i="' + i + '"' + (isTaken(r, now) ? " checked" : "") +
      "> I took this trade</label></article>";
  }

  var btn, statusEl, results, sub;
  function progress(agg, done, total) {
    statusEl.textContent = "Scanning " + (agg === "1h" ? "1h" : "4h") + " candles… " + done + "/" + total;
  }

  async function scan() {
    btn.disabled = true; btn.textContent = "Scanning…";
    try {
      if (!C) C = await (await fetch("coins.json", { cache: "no-store" })).json();
      var pairs = C.pairs;
      var h1 = await klines(pairs, "1h", 72, 3600);
      var h4 = await klines(pairs, "4h", 60, 14400);
      var found = [], liquid = 0;
      pairs.forEach(function (p) {
        var a = h1[p] || [], b = h4[p] || [];
        if (a.length < 24) return;
        var vol = a.slice(-24).reduce(function (s, x) { return s + x[4] * x[5]; }, 0);
        if (vol < C.MIN_USD_VOL_24H) return;
        liquid++;
        [checkShort(a, b), checkLong(a, b)].forEach(function (r) {
          if (r) { r.symbol = p.replace("/USDT", ""); found.push(r); }
        });
      });
      found.sort(function (x, y) {
        return (x.status !== "TRIGGERED") - (y.status !== "TRIGGERED") || y.rr - x.rr;
      });
      var now = Date.now();
      lastFound = found; lastScan = now;
      results.innerHTML = found.length ? found.map(function (r, i) { return card(r, now, i); }).join("") :
        '<p class="empty">No coins meet the rules right now.<br><strong>That is a valid answer - no trade.</strong></p>';
      var t = new Date().toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
      sub.innerHTML = "<strong>Live scan " + t + " IST</strong> &middot; " + liquid + " liquid of " + pairs.length + " coins";
      var st = document.getElementById("stale"); if (st) st.style.display = "none";
      renderHistory(found.length ? saveLog(found, now) : undefined);
      renderTaken();
      statusEl.textContent = "";
    } catch (e) {
      statusEl.textContent = "Live scan failed: " + e.message + ". Showing the last server scan.";
    }
    btn.disabled = false; btn.textContent = "↻ Scan now";
  }

  document.addEventListener("DOMContentLoaded", function () {
    btn = document.getElementById("scan-btn");
    statusEl = document.getElementById("scan-status");
    results = document.getElementById("results");
    sub = document.getElementById("sub");
    btn.addEventListener("click", scan);
    var h = istHour(Date.now()), night = document.getElementById("night");
    if (night && (h >= 22 || h < 7)) night.style.display = "block";
    results.addEventListener("change", function (e) {
      var el = e.target;
      if (!el || !el.classList || !el.classList.contains("took-box")) return;
      var r = lastFound[+el.getAttribute("data-i")];
      if (!r) return;
      if (!setTaken(r, el.checked)) {
        el.checked = !el.checked;
        statusEl.textContent = "Could not save the tick: this browser is blocking storage.";
      }
      renderTaken();
    });
    var takenList = document.getElementById("taken-list");
    if (takenList) takenList.addEventListener("click", function (e) {
      var el = e.target;
      if (!el || !el.classList || !el.classList.contains("took-remove")) return;
      var t = +el.getAttribute("data-t"), sym = el.getAttribute("data-s");
      storeTaken(loadTaken().filter(function (x) { return !(x.t === t && x.symbol === sym); }));
      renderTaken();
      var now = Date.now(); // untick the matching card if it is on screen
      Array.prototype.forEach.call(results.querySelectorAll(".took-box"), function (b) {
        var r = lastFound[+b.getAttribute("data-i")]; if (r) b.checked = isTaken(r, now);
      });
    });
    var copyBtn = document.getElementById("copy-taken");
    if (copyBtn) copyBtn.addEventListener("click", function () {
      var text = takenText(), st = document.getElementById("copy-status"), ta = document.getElementById("copy-box");
      function shown() { ta.value = text; ta.style.display = "block"; ta.focus(); ta.select(); st.textContent = "Select and copy the text below."; }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { st.textContent = "Copied. Paste it into the review chat."; }, shown);
      } else shown();
    });
    renderTaken();
    var filter = document.getElementById("hist-filter");
    if (filter) filter.addEventListener("input", function () { renderHistory(); });
    renderHistory();
    scan(); // run a fresh live scan every time the page opens
  });
})();
