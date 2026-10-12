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

  function marginFor(d) { return d > 0 ? Math.min(C.MAX_MARGIN, C.MAX_RISK / d) : 0; }

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
    var tp = (l4 && l4 < price) ? l4 : lo, rr = (price - tp) / (stop - price);
    if (rr < C.MIN_RR) return null;
    return { side: "SHORT", status: status, price: price, stop: stop, tp: tp, dist: dist, rr: rr,
      margin: marginFor(dist), note: "rose " + Math.round(100 * (hi / lo - 1)) + "% in 3d to " + fmt(hi) };
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
    for (k = off; k < h4.length; k++) if (h4[k][2] > h4[hiIdx][2]) hiIdx = k;
    if (hiIdx < flip) return null;
    var h60 = h4[hiIdx][2], pull = 1 - price / h60;
    if (pull < 0.03 || pull > 0.12 || price <= line) return null;
    var stop = line * 0.995, dist = 1 - stop / price;
    if (dist < C.MIN_STOP_DIST || dist > 0.12) return null;
    var rr = (h60 - price) / (price - stop);
    if (rr < C.MIN_RR) return null;
    var st1 = supertrend(h1), s1 = st1[st1.length - 1];
    return { side: "LONG", status: (s1 && s1[1]) ? "TRIGGERED" : "WATCH", price: price, stop: stop, tp: h60,
      dist: dist, rr: rr, margin: marginFor(dist), note: Math.round(100 * pull) + "% below 10d high " + fmt(h60) };
  }

  function fmt(x) { return (+x).toPrecision(6).replace(/\.?0+$/, "").replace(/\.?0+e/, "e"); }
  function inr(x) { return "₹" + Math.round(x).toLocaleString("en-IN"); }
  function esc(s) { var d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

  function card(r) {
    var trig = r.status === "TRIGGERED";
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
      '<p class="note">' + esc(r.note) + "</p></article>";
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
      results.innerHTML = found.length ? found.map(card).join("") :
        '<p class="empty">No coins meet the rules right now.<br><strong>That is a valid answer - no trade.</strong></p>';
      var t = new Date().toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
      sub.innerHTML = "<strong>Live scan " + t + " IST</strong> &middot; " + liquid + " liquid of " + pairs.length + " coins";
      var st = document.getElementById("stale"); if (st) st.style.display = "none";
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
    scan(); // run a fresh live scan every time the page opens
  });
})();
