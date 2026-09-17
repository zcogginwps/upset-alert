#!/usr/bin/env python3
"""Publish CollegeFootballData ratings (SP+, FPI, SRS, Elo) as top-25 polls for the app.

Usage:
  scripts/update_ratings.py            # writes polls/ratings.json
  scripts/update_ratings.py --push     # also bumps the app build, commits and pushes

Needs a CFBD API key (free at https://collegefootballdata.com/key) in the environment as
CFBD_KEY or in ~/.config/qbb/cfbd_key. The key stays on this machine; only the derived
rankings are published. Team names are resolved to ESPN team ids with the same matcher as
update_pate.py. Exits 1 without writing if any rating list cannot be fetched.
"""
import argparse, datetime, json, os, re, subprocess, sys, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from update_pate import load_teams, resolve, ROOT  # noqa: E402

OUT = os.path.join(ROOT, 'polls', 'ratings.json')
API = 'https://api.collegefootballdata.com'
YEAR = datetime.date.today().year if datetime.date.today().month >= 7 else datetime.date.today().year - 1
# key -> (label, endpoint, field holding the rating; higher is better for all four)
RATINGS = {
    'sp':  ('SP+ (Connelly)', '/ratings/sp',  'rating'),
    'fpi': ('ESPN FPI',       '/ratings/fpi', 'fpi'),
    'srs': ('SRS',            '/ratings/srs', 'rating'),
    'elo': ('Elo',            '/ratings/elo', 'elo'),
}
TOP_N = 25

def key():
    k = os.environ.get('CFBD_KEY')
    if not k:
        p = os.path.expanduser('~/.config/qbb/cfbd_key')
        if os.path.exists(p): k = open(p).read().strip()
    if not k: sys.exit('no CFBD key: set CFBD_KEY or write it to ~/.config/qbb/cfbd_key')
    return k

def fetch(path, k):
    req = urllib.request.Request(f'{API}{path}?year={YEAR}', headers={'Authorization': f'Bearer {k}', 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--push', action='store_true')
    a = ap.parse_args()
    k = key()
    teams = load_teams()
    polls, unresolved = {}, set()
    for pid, (label, path, field) in RATINGS.items():
        rows = fetch(path, k)
        rows = [r for r in rows if isinstance(r.get(field), (int, float)) and r.get('team')]
        if not rows:  # e.g. SRS is not published until a few weeks into the season
            print(f'{label}: nothing published for {YEAR} yet, skipping'); continue
        if pid == 'sp':  # SP+ includes a "nationalAverages" row and FCS teams; keep FBS only
            rows = [r for r in rows if r.get('conference')]
        rows.sort(key=lambda r: -r[field])
        ranks = []
        for r in rows:
            t = resolve(r['team'], teams)
            if not t: unresolved.add(r['team']); continue
            ranks.append({'rank': len(ranks) + 1, 'team': t['short'] or t['location'], 'id': t['id'], 'value': round(r[field], 1)})
            if len(ranks) == TOP_N: break
        if len(ranks) < TOP_N: sys.exit(f'{label}: only {len(ranks)} teams resolved; unresolved so far: {sorted(unresolved)}')
        polls[pid] = {'name': label, 'ranks': ranks}
    if not polls: sys.exit('no ratings available at all; nothing written')
    json.dump({'updated': datetime.date.today().isoformat(), 'year': YEAR, 'source': 'collegefootballdata.com',
               'polls': polls}, open(OUT, 'w'), indent=1)
    for pid, p in polls.items():
        print(f"{p['name']}: " + ', '.join(f"{r['rank']} {r['team']}" for r in p['ranks'][:5]) + ' …')
    if unresolved: print('note: unresolved (outside top 25 anyway):', sorted(unresolved))

    if a.push:
        cur = int(re.search(r"APP_VERSION = '(\d+)'", open(os.path.join(ROOT, 'app.js')).read()).group(1))
        subprocess.run([os.path.join(ROOT, 'scripts', 'bump.sh'), str(cur + 1)], check=True, cwd=ROOT, stdout=subprocess.DEVNULL)
        subprocess.run(['git', 'add', '-A'], check=True, cwd=ROOT)
        subprocess.run(['git', 'commit', '-q', '-m', f"Ratings update: SP+, FPI, SRS, Elo ({datetime.date.today().isoformat()})\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>"], check=True, cwd=ROOT)
        subprocess.run(['git', 'push', '-q', 'origin', 'main'], check=True, cwd=ROOT)
        print(f'pushed as build {cur + 1}')

if __name__ == '__main__':
    main()
