# Mudrex rule scanner (phone version)

Runs every hour on GitHub using **public price data only** (no API key) and publishes
the results as a phone-friendly page via GitHub Pages.

- `scanner_web.py` - builds `site/index.html` from the rules in `mudrex_scanner.py`
- `mudrex_scanner.py` - the desktop scanner (needs `mudrex_key.txt`, which is never committed)
- `coins.txt` - list of coins to scan; refresh it from the desktop scanner now and then
- `.github/workflows/scan.yml` - the hourly job

Not checked on the phone version: funding rate, and positions you already hold.
