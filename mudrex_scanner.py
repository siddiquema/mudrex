#!/usr/bin/env python3
"""
Mudrex rule scanner - READ-ONLY.

Scans every Mudrex futures coin against your rulebook setups and prints
candidates. It only sends GET requests: it cannot place or change orders.

Setups checked
  SPIKE SHORT  - coin rose 40%+ within 3 days, then stalls.
                 TRIGGERED = 1h Supertrend has turned red.
                 WATCH     = lower high forming, 1h Supertrend still green.
                 Skipped if funding < -0.1% (shorts crowded).
  TREND LONG   - 4h Supertrend green, price pulled back 3-12% from the
                 10-day high and holding above the Supertrend line.
                 TRIGGERED = 1h Supertrend green again (pullback holding).
                 WATCH     = still pulling back.

For each candidate it prints entry, stop, TP and the margin that keeps the
loss at Rs.120 (capped at Rs.1,200).

Run:   python mudrex_scanner.py
Key:   read from mudrex_key.txt in the same folder (same as mudrex_review.py).

Always check the chart yourself and look up token unlocks before trading.
This is a filter to save you time, not a signal to trade.
"""

import json
import os
import sys
import time
import urllib.parse
import urllib.request

BASE = "https://trade.mudrex.com/fapi/v1"

# Rulebook settings
MAX_RISK = 120
MAX_MARGIN = 1200
FUNDING_FLOOR = -0.1          # % per settlement; below this, skip shorts
MIN_USD_VOL_24H = 2_000_000   # skip illiquid coins
SPIKE_MIN_RISE = 0.40         # 40% rise within 3 days
MAX_STOP_DIST = 0.25          # skip if stop would be >25% away
MIN_RR = 1.5                  # reward must be >= 1.5x risk
MIN_STOP_DIST = 0.02          # stops under 2% get hit by noise; also filters slow TradFi contracts

# Crypto only: skip tokenized stocks, commodities and FX contracts
NON_CRYPTO = {"XAU", "XAG", "CL", "BZ", "NG", "HG", "XPT", "XPD", "EUR", "GBP", "JPY",
              "USDBRL", "SPX", "NDX", "DJI", "NVDL", "TSLL", "DDOG", "TEAM", "MDB", "ZS",
              "GTLB", "HUT", "OKLO", "TEM", "MSFU", "CGNX", "4STOCK"}


def is_crypto(base):
    return base not in NON_CRYPTO and not base.endswith("STOCK")


# ---------- HTTP (GET only) ----------

def load_key():
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(here, "mudrex_key.txt")
    if not os.path.exists(path):
        sys.exit("Put your API secret in mudrex_key.txt next to this script.")
    with open(path, encoding="utf-8") as f:
        key = f.read().strip()
    if len(key) < 20:
        sys.exit("mudrex_key.txt looks empty or incomplete.")
    return key


def http_get(url, key=None):
    headers = {"X-Authentication": key} if key else {}
    req = urllib.request.Request(url, method="GET", headers=headers)
    for _ in range(4):
        try:
            with urllib.request.urlopen(req, timeout=25) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(int(e.headers.get("Retry-After", "3")))
                continue
            if e.code == 401:
                sys.exit("Mudrex rejected the key (401). Check mudrex_key.txt.")
            raise
        except urllib.error.URLError:
            time.sleep(2)
    sys.exit("Could not reach Mudrex after several tries.")


def num(x, d=0.0):
    try:
        return float(x)
    except (TypeError, ValueError):
        return d


# ---------- Data ----------

def fetch_assets(key):
    out, offset = [], 0
    while True:
        q = urllib.parse.urlencode({"sort": "volume", "order": "desc", "offset": offset, "limit": 100})
        body = http_get(f"{BASE}/futures?{q}", key)
        page = body.get("data") or []
        if isinstance(page, dict):
            page = next((v for v in page.values() if isinstance(v, list)), [])
        if not page:
            break
        out.extend(page)
        offset += len(page)
        if len(page) < 100 or offset > 2000:
            break
    return out


def pair(symbol):
    return symbol[:-4] + "/USDT" if symbol.endswith("USDT") else None


def fetch_klines(pairs, agg, bars, bar_secs):
    end = int(time.time())
    start = end - bars * bar_secs
    result = {}
    for i in range(0, len(pairs), 25):
        chunk = pairs[i:i + 25]
        q = (f"assets={','.join(chunk)}&aggregation={agg}"
             f"&start_time={start}&end_time={end}")
        body = http_get(f"{BASE}/price/kline?{q}")
        ticks = (body.get("data") or {}).get("asset_ticks") or {}
        for k, rows in ticks.items():
            rows = sorted(rows, key=lambda r: r[0])
            result[k.upper()] = [(r[0], num(r[1]), num(r[2]), num(r[3]), num(r[4]), num(r[5])) for r in rows]
        time.sleep(0.25)
    return result


def fetch_open_symbols(key):
    held = set()
    for cur in ("INR", "USDT"):
        body = http_get(f"{BASE}/futures/positions?trade_currency={cur}&limit=100", key)
        for p in body.get("data") or []:
            held.add(p.get("symbol"))
    return held


# ---------- Indicators ----------

def supertrend(candles, period=10, mult=3.0):
    """Returns list of (line, is_green). Wilder ATR, like TradingView's default."""
    n = len(candles)
    if n < period + 2:
        return []
    trs = []
    for i, c in enumerate(candles):
        _, o, h, l, cl, _ = c
        if i == 0:
            trs.append(h - l)
        else:
            pc = candles[i - 1][4]
            trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    atr = [None] * n
    atr[period - 1] = sum(trs[:period]) / period
    for i in range(period, n):
        atr[i] = (atr[i - 1] * (period - 1) + trs[i]) / period
    out = [None] * n
    fu = fl = None
    green = True
    for i in range(period - 1, n):
        h, l, cl = candles[i][2], candles[i][3], candles[i][4]
        mid = (h + l) / 2
        bu, bl = mid + mult * atr[i], mid - mult * atr[i]
        prev_close = candles[i - 1][4] if i > 0 else cl
        fu = bu if fu is None or bu < fu or prev_close > fu else fu
        fl = bl if fl is None or bl > fl or prev_close < fl else fl
        if green and cl < fl:
            green = False
        elif not green and cl > fu:
            green = True
        out[i] = (fl if green else fu, green)
    return out


# ---------- Setups ----------

def margin_for(dist):
    return min(MAX_MARGIN, MAX_RISK / dist) if dist > 0 else 0


def check_short(c1h, c4h, funding):
    if len(c4h) < 20 or len(c1h) < 30:
        return None
    last18 = c4h[-18:]
    lo_i = min(range(len(last18)), key=lambda i: last18[i][3])
    hi_i = max(range(len(last18)), key=lambda i: last18[i][2])
    lo, hi = last18[lo_i][3], last18[hi_i][2]
    if hi_i <= lo_i or lo <= 0 or hi / lo - 1 < SPIKE_MIN_RISE:
        return None
    if funding < FUNDING_FLOOR:
        return None
    price = c1h[-1][4]
    st1 = supertrend(c1h)
    if not st1 or st1[-1] is None:
        return None
    recent_high = max(c[2] for c in c1h[-6:])
    lower_high = recent_high < hi * 0.98
    if st1[-1][1] is False:
        status = "TRIGGERED"
    elif lower_high and price < hi * 0.95:
        status = "WATCH"
    else:
        return None
    stop = hi * 1.005
    dist = stop / price - 1
    if dist < MIN_STOP_DIST or dist > MAX_STOP_DIST:
        return None
    st4 = supertrend(c4h)
    line4 = st4[-1][0] if st4 and st4[-1] else None
    # TP = first support: the 4h Supertrend line if it's below price, else the pre-spike low
    tp = line4 if line4 and line4 < price else lo
    rr = (price - tp) / (stop - price)
    if rr < MIN_RR:
        return None
    return {"side": "SHORT", "status": status, "price": price, "stop": stop, "tp": tp,
            "dist": dist, "rr": rr, "margin": margin_for(dist),
            "note": f"rose {100*(hi/lo-1):.0f}% in 3d to {hi:.6g}"}


def check_long(c1h, c4h, funding):
    if len(c4h) < 30 or len(c1h) < 30:
        return None
    st4 = supertrend(c4h)
    if not st4 or not st4[-1] or not st4[-1][1]:
        return None
    line = st4[-1][0]
    price = c4h[-1][4]
    # Trend must be established: 4h Supertrend green for at least 6 candles (1 day)
    if any(s is None or not s[1] for s in st4[-6:]):
        return None
    # ...and the 10-day high must have been made while the trend was green
    # (filters out bounces inside a downtrend, like XCN on 11 Oct)
    flip = len(st4) - 1
    while flip > 0 and st4[flip - 1] is not None and st4[flip - 1][1]:
        flip -= 1
    window = c4h[-60:]
    offset = len(c4h) - len(window)
    hi_idx = offset + max(range(len(window)), key=lambda i: window[i][2])
    if hi_idx < flip:
        return None
    h60 = c4h[hi_idx][2]
    pullback = 1 - price / h60
    if not (0.03 <= pullback <= 0.12) or price <= line:
        return None
    stop = line * 0.995
    dist = 1 - stop / price
    if dist < MIN_STOP_DIST or dist > 0.12:
        return None
    tp = h60
    rr = (tp - price) / (price - stop)
    if rr < MIN_RR:
        return None
    st1 = supertrend(c1h)
    status = "TRIGGERED" if st1 and st1[-1] and st1[-1][1] else "WATCH"
    return {"side": "LONG", "status": status, "price": price, "stop": stop, "tp": tp,
            "dist": dist, "rr": rr, "margin": margin_for(dist),
            "note": f"{100*pullback:.0f}% below 10d high {h60:.6g}"}


# ---------- Main ----------

def main():
    key = load_key()
    print("\nMUDREX RULE SCANNER  |", time.strftime("%d %b %Y %H:%M"), "\n")
    assets = fetch_assets(key)
    print(f"Listed coins: {len(assets)}")
    info = {}
    for a in assets:
        p = pair(a.get("symbol", ""))
        if p and is_crypto(p.split("/")[0].upper()):
            info[p.upper()] = a
    pairs = list(info.keys())

    # Save the coin list for the phone version (no key needed there).
    try:
        here = os.path.dirname(os.path.abspath(__file__))
        with open(os.path.join(here, "coins.txt"), "w", encoding="utf-8") as f:
            f.write("\n".join(sorted(p.split("/")[0] for p in pairs)) + "\n")
    except OSError:
        pass

    c1h = fetch_klines(pairs, "1h", 72, 3600)
    c4h = fetch_klines(pairs, "4h", 60, 14400)
    held = fetch_open_symbols(key)

    found, liquid = [], 0
    for p in pairs:
        h1, h4 = c1h.get(p, []), c4h.get(p, [])
        if len(h1) < 24:
            continue
        usd_vol = sum(c[4] * c[5] for c in h1[-24:])
        if usd_vol < MIN_USD_VOL_24H:
            continue
        liquid += 1
        funding = 100 * num(info[p].get("funding_fee_perc"))  # API gives a fraction (0.00005 = 0.005%)
        for check in (check_short, check_long):
            r = check(h1, h4, funding)
            if r:
                r["symbol"] = p.replace("/USDT", "")
                r["funding"] = funding
                r["funding_raw"] = f"{funding:.3f}%"
                r["held"] = info[p].get("symbol") in held
                found.append(r)

    print(f"Liquid enough to scan (24h volume >= ${MIN_USD_VOL_24H/1e6:.0f}M): {liquid}\n")
    if not found:
        print("No coins meet the rules right now. That's a valid answer - no trade.\n")
        return

    found.sort(key=lambda r: (r["status"] != "TRIGGERED", -r["rr"]))
    for r in found:
        r["risk"] = r["margin"] * r["dist"]
    hdr = f"{'STATUS':<10}{'SIDE':<6}{'COIN':<10}{'PRICE':>11}{'STOP':>11}{'TP':>11}{'STOP%':>7}{'R:R':>6}{'MARGIN':>9}{'RISK':>7}{'FUNDING':>10}  NOTE"
    print(hdr)
    print("-" * len(hdr))
    for r in found:
        tag = "  (already held)" if r["held"] else ""
        print(f"{r['status']:<10}{r['side']:<6}{r['symbol']:<10}{r['price']:>11.6g}{r['stop']:>11.6g}"
              f"{r['tp']:>11.6g}{100*r['dist']:>6.1f}%{r['rr']:>6.1f}  Rs{r['margin']:>6,.0f}  Rs{r['risk']:>3.0f}{r['funding_raw']:>10}  {r['note']}{tag}")
    print("\nBefore any trade: open the chart, confirm the setup by eye, check for a token")
    print("unlock in the next 3 days, and check the open-position limit (5) and daily loss limit (Rs.350).\n")


if __name__ == "__main__":
    main()
