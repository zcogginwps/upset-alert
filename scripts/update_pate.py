#!/usr/bin/env python3
"""Update polls/pate.json (Josh Pate's weekly JP Poll) from a pasted top-25 list.

Usage:
  scripts/update_pate.py --week 3 --source URL --date 2026-09-15 < list.txt
  scripts/update_pate.py --week 3 --source URL --date 2026-09-15 --push < list.txt

stdin: one team per line, e.g. "7. Ole Miss (+2)" or just "Ole Miss". Numbering and
movement notes are ignored; order is what counts. Team names are resolved to ESPN team ids
via ESPN's public teams list. Exits 1 (and writes nothing) if any name cannot be resolved,
if the list is not exactly 25 teams, or if the week is not newer than the current file.
--push also bumps the app build, commits and pushes so phones pick it up.
"""
import argparse, json, re, subprocess, sys, urllib.request, datetime, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'polls', 'pate.json')
TEAMS_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams?limit=1000'
# Names as writers use them -> ESPN displayName fragments that identify the team.
ALIASES = {
    'usc': 'USC Trojans', 'southern cal': 'USC Trojans', 'southern california': 'USC Trojans',
    'ole miss': 'Ole Miss Rebels', 'mississippi': 'Ole Miss Rebels',
    'miami': 'Miami Hurricanes', 'miami (fl)': 'Miami Hurricanes', 'miami (oh)': 'Miami (OH) RedHawks',
    'lsu': 'LSU Tigers', 'byu': 'BYU Cougars', 'smu': 'SMU Mustangs', 'tcu': 'TCU Horned Frogs',
    'ucf': 'UCF Knights', 'ucla': 'UCLA Bruins', 'utsa': 'UTSA Roadrunners', 'unlv': 'UNLV Rebels',
    'pitt': 'Pittsburgh Panthers', 'texas a&m': 'Texas A&M Aggies', 'texas am': 'Texas A&M Aggies',
    'nc state': 'NC State Wolfpack', 'boise': 'Boise State Broncos', 'app state': 'Appalachian State',
    'ohio state': 'Ohio State Buckeyes', 'penn state': 'Penn State Nittany Lions',
    'michigan state': 'Michigan State Spartans', 'oklahoma state': 'Oklahoma State Cowboys',
    'kansas state': 'Kansas State Wildcats', 'iowa state': 'Iowa State Cyclones',
    'florida state': 'Florida State Seminoles', 'mississippi state': 'Mississippi State Bulldogs',
    'arizona state': 'Arizona State Sun Devils', 'washington state': 'Washington State Cougars',
    'oregon state': 'Oregon State Beavers', 'colorado state': 'Colorado State Rams',
    'san diego state': 'San Diego State Aztecs', 'fresno state': 'Fresno State Bulldogs',
    'james madison': 'James Madison Dukes', 'jmu': 'James Madison Dukes',
    'georgia tech': 'Georgia Tech Yellow Jackets', 'virginia tech': 'Virginia Tech Hokies',
    'texas tech': 'Texas Tech Red Raiders', 'louisiana tech': 'Louisiana Tech Bulldogs',
    'south florida': 'South Florida Bulls', 'usf': 'South Florida Bulls',
    'notre dame': 'Notre Dame Fighting Irish', 'army': 'Army Black Knights', 'navy': 'Navy Midshipmen',
    'air force': 'Air Force Falcons', 'memphis': 'Memphis Tigers', 'tulane': 'Tulane Green Wave',
}

def norm(s):
    return re.sub(r'[^a-z0-9& ()]', '', s.lower()).strip()

def load_teams():
    with urllib.request.urlopen(TEAMS_URL, timeout=30) as r:
        data = json.load(r)
    teams = []
    for t in data['sports'][0]['leagues'][0]['teams']:
        t = t['team']
        teams.append({'id': str(t['id']), 'display': t['displayName'], 'location': t.get('location', ''),
                      'short': t.get('shortDisplayName', ''), 'abbr': t.get('abbreviation', ''),
                      'nick': t.get('name', '')})
    return teams

def resolve(name, teams):
    n = norm(name)
    if n in ALIASES:
        target = ALIASES[n].lower()
        for t in teams:
            if t['display'].lower().startswith(target) or t['display'].lower() == target:
                return t
    exact = [t for t in teams if norm(t['location']) == n or norm(t['short']) == n or norm(t['display']) == n]
    if len(exact) == 1: return exact[0]
    if n.isupper() or len(n) <= 5:
        ab = [t for t in teams if t['abbr'].lower() == n]
        if len(ab) == 1: return ab[0]
    starts = [t for t in teams if norm(t['display']).startswith(n + ' ')]
    if len(starts) == 1: return starts[0]
    return None

def parse_lines(text):
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line: continue
        line = re.sub(r'^\d{1,2}[\.\)]\s*', '', line)      # "7. "
        line = re.sub(r'\s*\((\+|-)?\d+\)\s*$', '', line)     # " (+2)"
        line = re.sub(r'\s*\((NR|new|↑|↓)[^)]*\)\s*$', '', line, flags=re.I)
        line = re.sub(r'\s+[-–—]\s+.*$', '', line)             # trailing " - comment"
        if line: out.append(line)
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--week', type=int, required=True)
    ap.add_argument('--source', required=True)
    ap.add_argument('--date', default=datetime.date.today().isoformat())
    ap.add_argument('--push', action='store_true', help='bump build, commit and push')
    ap.add_argument('--force', action='store_true', help='allow same/older week')
    a = ap.parse_args()

    names = parse_lines(sys.stdin.read())
    if len(names) != 25:
        sys.exit(f'expected 25 teams, got {len(names)}: {names}')
    current = json.load(open(OUT)) if os.path.exists(OUT) else {'week': 0}
    if not a.force and a.week <= current.get('week', 0):
        sys.exit(f'week {a.week} is not newer than the current file (week {current.get("week")}); nothing to do')

    teams = load_teams()
    ranks, missing = [], []
    for i, name in enumerate(names, 1):
        t = resolve(name, teams)
        if t: ranks.append({'rank': i, 'team': t['short'] or t['location'], 'id': t['id']})
        else: missing.append(name)
    if missing:
        sys.exit(f'could not resolve: {missing} (add an alias in scripts/update_pate.py)')

    json.dump({'poll': 'JP Poll (Josh Pate)', 'week': a.week, 'updated': a.date, 'source': a.source,
               'ranks': ranks}, open(OUT, 'w'), indent=2)
    print(f'wrote {OUT}: week {a.week}, ' + ', '.join(f"{r['rank']} {r['team']}" for r in ranks))

    if a.push:
        cur = int(re.search(r"APP_VERSION = '(\d+)'", open(os.path.join(ROOT, 'app.js')).read()).group(1))
        subprocess.run([os.path.join(ROOT, 'scripts', 'bump.sh'), str(cur + 1)], check=True, cwd=ROOT,
                       stdout=subprocess.DEVNULL)
        subprocess.run(['git', 'add', '-A'], check=True, cwd=ROOT)
        subprocess.run(['git', 'commit', '-q', '-m',
                        f"Josh Pate JP Poll: week {a.week}\n\nSource: {a.source}\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>"],
                       check=True, cwd=ROOT)
        subprocess.run(['git', 'push', '-q', 'origin', 'main'], check=True, cwd=ROOT)
        print(f'pushed as build {cur + 1}')

if __name__ == '__main__':
    main()
