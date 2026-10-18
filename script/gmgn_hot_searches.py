#!/usr/bin/env python3
"""Ambil list "hot searches" dari GMGN.AI.

Endpoint internal (dipakai halaman https://gmgn.ai/trend):
    POST https://gmgn.ai/rrs/api/v1/hot_searches

Cloudflare bot-management blokir curl/requests biasa (HTTP 403) karena cek
TLS/JA3 fingerprint. Script ini pakai curl_cffi dengan impersonate Chrome
supaya fingerprint-nya sama kayak browser asli.

Install:  pip install curl_cffi

Contoh:
    python3 gmgn_hot_searches.py                 # SOL, interval 1h
    python3 gmgn_hot_searches.py --chain sol --interval 5m
    python3 gmgn_hot_searches.py --json          # output JSON mentah
    python3 gmgn_hot_searches.py --response      # seluruh response API (meta + tokens)
    python3 gmgn_hot_searches.py --min-mc 100 --max-mc 200 --min-age 10 --max-age 600
    #   ^ MC dalam ribu USD (100 = $100K), age dalam menit (600 = 10 jam)
"""
import argparse
import json
import sys
import time

from curl_cffi import requests

ENDPOINT = "https://gmgn.ai/rrs/api/v1/hot_searches"

# Query param metadata app (opsional menurut tes, tapi dikirim halaman aslinya)
COMMON_QUERY = {
    "from_app": "gmgn",
    "os": "web",
    "worker": "0",
    "tz_name": "Asia/Jakarta",
    "tz_offset": "25200",
    "app_lang": "en-US",
}

LAUNCHPAD_PLATFORM = [
    "Pump.fun", "pump_mayhem", "letsbonk", "bonkers", "bags_v2", "bags",
    "stonkfun", "stonkfun_cc", "hookedpad", "hookd", "tren_ch", "virtuals",
    "stoxes", "kickstart", "orynth", "swarms", "memoo", "liquid", "bankr",
    "zora", "surge", "anoncoin", "moonshot_app", "wendotdev", "heaven",
    "sugar", "token_mill", "believe", "trendsfun", "trends_fun", "jup_studio",
    "Moonshot", "boop", "ray_launchpad", "xstocks", "meteora_virtual_curve",
]


def _age_str(minutes: int) -> str:
    """API pakai format '<n>m' (menit) untuk created/age filter."""
    return f"{int(minutes)}m"


def build_body(chain, interval, limit, min_mc, max_mc, min_age, max_age) -> dict:
    flt = {
        "filters": ["frozen"],
        "limit": limit,
        "launchpad_platform": LAUNCHPAD_PLATFORM,
    }
    # MC dikirim raw USD (input UI dalam K -> dikali 1000)
    if min_mc is not None:
        flt["min_marketcap"] = int(min_mc) * 1000
    if max_mc is not None:
        flt["max_marketcap"] = int(max_mc) * 1000
    # Age dikirim sebagai string menit, mis. "10m" / "600m"
    if min_age is not None:
        flt["min_created"] = _age_str(min_age)
    if max_age is not None:
        flt["max_created"] = _age_str(max_age)

    return {
        "meta": {},
        "params": [
            {
                "label": "hot-search",
                "chain": chain,
                "interval": interval,
                "filter": flt,
            }
        ],
    }


def fetch_response(chain="sol", interval="1h", limit=500,
                   min_mc=None, max_mc=None, min_age=None, max_age=None) -> dict:
    body = build_body(chain, interval, limit, min_mc, max_mc, min_age, max_age)
    r = requests.post(
        ENDPOINT,
        params=COMMON_QUERY,
        json=body,
        impersonate="chrome",
        timeout=30,
    )
    r.raise_for_status()
    data = r.json()
    if data.get("code") != 0:
        raise RuntimeError(f"API error: {data.get('message')}")
    return data


def fetch_hot(*args, **kwargs) -> list:
    return fetch_response(*args, **kwargs)["data"][0]["tokens"]


def _fmt_age(token: dict) -> str:
    ct = token.get("ct")
    if not ct:
        return "?"
    mins = (time.time() - ct) / 60
    if mins < 60:
        return f"{mins:.0f}m"
    if mins < 1440:
        return f"{mins/60:.1f}h"
    return f"{mins/1440:.1f}d"


def main() -> int:
    ap = argparse.ArgumentParser(description="GMGN hot searches")
    ap.add_argument("--chain", default="sol", help="chain (default: sol)")
    ap.add_argument("--interval", default="1h", help="interval 1m/5m/1h/6h/24h (default: 1h)")
    ap.add_argument("--limit", type=int, default=500, help="jumlah token (default: 500)")
    ap.add_argument("--min-mc", type=int, default=None, help="market cap minimum, dalam ribu USD (mis. 100 = $100K)")
    ap.add_argument("--max-mc", type=int, default=None, help="market cap maksimum, dalam ribu USD")
    ap.add_argument("--min-age", type=int, default=None, help="umur minimum, dalam MENIT (mis. 10)")
    ap.add_argument("--max-age", type=int, default=None, help="umur maksimum, dalam MENIT (mis. 600 = 10 jam)")
    ap.add_argument("--json", action="store_true", help="print JSON mentah (list token saja)")
    ap.add_argument("--response", action="store_true", help="print seluruh response API apa adanya")
    args = ap.parse_args()

    try:
        response = fetch_response(args.chain, args.interval, args.limit,
                                  args.min_mc, args.max_mc, args.min_age, args.max_age)
    except Exception as e:
        print(f"gagal ambil data: {e}", file=sys.stderr)
        return 1

    if args.response:
        print(json.dumps(response, ensure_ascii=False))
        return 0
    tokens = response["data"][0]["tokens"]
    if args.json:
        print(json.dumps(tokens, ensure_ascii=False, indent=2))
        return 0

    print(f"{len(tokens)} token hot-search | {args.chain} {args.interval}\n")
    print(f"{'#':>2}  {'SYM':<10} {'NAME':<22} {'MC':>12} {'AGE':>6} {'CHG1H':>9} {'VOL':>12}")
    for i, t in enumerate(tokens, 1):
        print(
            f"{i:>2}  {str(t.get('s'))[:10]:<10} {str(t.get('nm'))[:22]:<22} "
            f"{t.get('mc', 0):>12,.0f} {_fmt_age(t):>6} {t.get('pcp1h', 0):>8.1f}% {t.get('v', 0):>12,.0f}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
