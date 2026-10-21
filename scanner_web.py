#!/usr/bin/env python3
"""
Phone version of the Mudrex rule scanner.

Runs on GitHub every hour using PUBLIC price data only (no API key).
Reads the coin list from coins.txt, applies the same rules as
mudrex_scanner.py, and writes a phone-friendly page to site/index.html.

Differences from the desktop scanner (because there is no key here):
  - funding rate is NOT checked -> check it on the coin page before a short
  - positions you hold are NOT marked
"""

import html
import json
import os
import shutil
import sys
import time
from datetime import datetime, timedelta, timezone

import mudrex_scanner as s

IST = timezone(timedelta(hours=5, minutes=30))
OUT_DIR = "site"


def load_coins():
    with open("coins.txt", encoding="utf-8") as f:
        coins = [c.strip().upper() for c in f if c.strip() and not c.startswith("#")]
    return [f"{c}/USDT" for c in coins if s.is_crypto(c)]


def scan():
    pairs = load_coins()
    c1h = s.fetch_klines(pairs, "1h", 72, 3600)
    c4h = s.fetch_klines(pairs, "4h", 60, 14400)
    found, liquid = [], 0
    for p in pairs:
        h1, h4 = c1h.get(p, []), c4h.get(p, [])
        if len(h1) < 24:
            continue
        if sum(c[4] * c[5] for c in h1[-24:]) < s.MIN_USD_VOL_24H:
            continue
        liquid += 1
        for check in (s.check_short, s.check_long):
            r = check(h1, h4, 0.0)  # funding unknown without a key
            if r:
                r["symbol"] = p.replace("/USDT", "")
                r["risk"] = r["margin"] * r["dist"]
                found.append(r)
    found.sort(key=lambda r: (r["status"] != "TRIGGERED", -r["rr"]))
    return {"coins": len(pairs), "liquid": liquid, "found": found, "fetched": len(c1h)}


def fmt_price(x):
    return f"{x:.6g}"


def render(result, error=None):
    now = datetime.now(IST)
    stamp = now.strftime("%d %b %Y, %I:%M %p IST")
    epoch = int(now.timestamp())
    rows = ""
    if result:
        for r in result["found"]:
            trig = r["status"] == "TRIGGERED"
            side_cls = "long" if r["side"] == "LONG" else "short"
            rows += f"""
      <article class="card {'trig' if trig else ''}">
        <div class="top">
          <span class="badge {'b-trig' if trig else 'b-watch'}">{r['status']}</span>
          <span class="side {side_cls}">{r['side']}</span>
          <span class="coin">{html.escape(r['symbol'])}</span>
        </div>
        <dl>
          <div><dt>Price</dt><dd>{fmt_price(r['price'])}</dd></div>
          <div><dt>Stop</dt><dd>{fmt_price(r['stop'])} <small>({100*r['dist']:.1f}%)</small></dd></div>
          <div><dt>TP</dt><dd>{fmt_price(r['tp'])}</dd></div>
          <div><dt>R:R</dt><dd>{r['rr']:.1f}</dd></div>
          <div><dt>Margin</dt><dd>&#8377;{r['margin']:,.0f}</dd></div>
          <div><dt>Risk</dt><dd>&#8377;{r['risk']:,.0f}</dd></div>
        </dl>
        <p class="note">{html.escape(r['note'])}</p>
      </article>"""
    if error:
        body = f'<p class="empty err">Scan failed this hour: {html.escape(error)}<br>It will retry next hour.</p>'
    elif not result["found"]:
        body = '<p class="empty">No coins meet the rules right now.<br><strong>That is a valid answer - no trade.</strong></p>'
    else:
        body = rows
    meta = "" if not result else f"{result['liquid']} liquid of {result['coins']} coins scanned"

    return f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mudrex Scanner</title>
<style>
:root{{--bg:#0f1115;--card:#181b22;--line:#262a33;--text:#e7e9ee;--muted:#8b93a3;
--green:#2bb673;--red:#e5484d;--amber:#e8a33d}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--text);
font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:16px;max-width:720px;margin:auto}}
h1{{font-size:20px;margin:4px 0}}.sub{{color:var(--muted);font-size:13px;margin-bottom:14px}}
.stale{{display:none;background:#3a2a10;color:var(--amber);padding:8px 10px;border-radius:8px;margin-bottom:12px;font-size:13px}}
.card{{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:10px}}
.card.trig{{border-color:var(--green)}}
.top{{display:flex;gap:8px;align-items:center;margin-bottom:8px}}
.badge{{font-size:11px;font-weight:700;padding:3px 7px;border-radius:6px}}
.b-trig{{background:var(--green);color:#06140c}}.b-watch{{background:var(--line);color:var(--muted)}}
.side{{font-size:12px;font-weight:700}}.long{{color:var(--green)}}.short{{color:var(--red)}}
.coin{{font-size:17px;font-weight:700;margin-left:auto}}
dl{{display:grid;grid-template-columns:repeat(3,1fr);gap:6px 10px;margin:0}}
dt{{color:var(--muted);font-size:11px}}dd{{margin:0;font-variant-numeric:tabular-nums}}
small{{color:var(--muted)}}.note{{color:var(--muted);font-size:13px;margin:8px 0 0}}
.empty{{background:var(--card);border-radius:12px;padding:18px;text-align:center}}.err{{color:var(--amber)}}
.bar{{display:flex;align-items:center;gap:10px;margin-bottom:12px}}#scan-btn{{background:var(--green);color:#06140c;border:0;border-radius:10px;padding:10px 16px;font:700 15px system-ui,sans-serif;cursor:pointer}}#scan-btn:disabled{{opacity:.6}}#scan-status{{color:var(--muted);font-size:13px}}
.rules{{border-top:1px solid var(--line);margin-top:18px;padding-top:10px;color:var(--muted);font-size:13px}}
.rules li{{margin:3px 0}}
</style></head><body>
<h1>Mudrex Rule Scanner</h1>
<div class="sub" id="sub">Last server scan {stamp} &middot; {meta}</div>
<div class="bar"><button id="scan-btn">&#8635; Scan now</button><span id="scan-status"></span></div>
<div class="stale" id="stale">Server scan is over 2 hours old &mdash; tap Scan now for live results.</div>
<div id="results">{body}</div>
<div class="rules"><strong>Before any trade</strong><ul>
<li>Open the chart and confirm the setup by eye</li>
<li><strong>Shorts: check funding</strong> on the coin page (skip if below &minus;0.05%) &mdash; not checked here</li>
<li>Check for a token unlock in the next 3 days</li>
<li>Max 5 open positions &middot; daily loss limit &#8377;350</li></ul></div>
<script>
var t={epoch};if(Date.now()/1000-t>7200)document.getElementById('stale').style.display='block';
</script>
<script src="app.js"></script>
</body></html>
"""


def write_live_assets():
    """Coin list + rule constants for the in-browser Scan now button (app.js)."""
    cfg = {"pairs": load_coins(), "MAX_RISK": s.MAX_RISK, "MAX_MARGIN": s.MAX_MARGIN,
           "MIN_USD_VOL_24H": s.MIN_USD_VOL_24H, "SPIKE_MIN_RISE": s.SPIKE_MIN_RISE,
           "MAX_STOP_DIST": s.MAX_STOP_DIST, "MIN_RR": s.MIN_RR, "MIN_STOP_DIST": s.MIN_STOP_DIST}
    with open(os.path.join(OUT_DIR, "coins.json"), "w", encoding="utf-8") as f:
        json.dump(cfg, f)
    shutil.copy("app.js", os.path.join(OUT_DIR, "app.js"))


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    result, error = None, None
    try:
        result = scan()
        if result["fetched"] == 0:
            error = "Mudrex returned no price data (it may be blocking GitHub's servers)"
    except SystemExit as e:
        error = str(e)
    except Exception as e:  # keep publishing a page even if the scan fails
        error = f"{type(e).__name__}: {e}"
    with open(os.path.join(OUT_DIR, "index.html"), "w", encoding="utf-8") as f:
        f.write(render(result, error))
    write_live_assets()
    with open(os.path.join(OUT_DIR, "results.json"), "w", encoding="utf-8") as f:
        json.dump({"updated": int(time.time()), "error": error,
                   "found": result["found"] if result else []}, f)
    print("error:" if error else "ok:", error or f"{len(result['found'])} candidates")


if __name__ == "__main__":
    main()
