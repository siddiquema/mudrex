# Mudrex rule scanner (phone version)

Runs every hour on GitHub using **public price data only** (no API key) and publishes
the results as a phone-friendly page via GitHub Pages.

- `scanner_web.py` - builds `site/index.html` from the rules in `mudrex_scanner.py`
- `mudrex_scanner.py` - the desktop scanner (needs `mudrex_key.txt`, which is never committed)
- `coins.txt` - list of coins to scan; refresh it from the desktop scanner now and then
- `.github/workflows/scan.yml` - the hourly job

Not checked on the phone version: funding rate, and positions you already hold.

Each candidate shows a close-by time (the 24-hour time stop). Shorts are sized at
Rs.240 risk (margin cap Rs.2,400), longs at Rs.120 (cap Rs.1,200).

"Past flags on this device" keeps the candidates from live scans for 14 days in the
browser's own storage, so the phone and the computer each have their own list.
