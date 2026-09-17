/* Quad Box Buddy (QBB) — college football scoreboard that tells you what to watch.
 * Data comes straight from ESPN's public scoreboard feed (no key needed). */

const ESPN_BASE =
  'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?limit=500';
// ESPN "groups": 80 = FBS, 81 = FCS, 35 = Division II. A game involving teams from two
// levels (e.g. an FCS team at a Big Ten school) shows up in both feeds; they are merged by id.
const GROUPS = [
  { id: 80, key: null },
  { id: 81, key: 'fcs' },
  { id: 35, key: 'd2' },
];
// Week selection: {type, week} where type is ESPN's season type (2 regular, 3 postseason).
// null means "whatever ESPN says the current week is". Mirrored into the URL (?week=3 or
// ?week=bowls) so a specific week can be linked to; a plain link always opens the current week.
let selectedWeek = weekFromUrl();
let currentWeek = null; // filled from the first fetch
let calendar = [];      // [{type, week, label}] from ESPN's league calendar

function weekFromUrl() {
  const w = new URLSearchParams(location.search).get('week');
  if (!w) return null;
  if (w === 'bowls') return { type: 3, week: 1 };
  return /^\d+$/.test(w) ? { type: 2, week: Number(w) } : null;
}

function scoreboardUrl(groupId) {
  const week = selectedWeek ? `&seasontype=${selectedWeek.type}&week=${selectedWeek.week}` : '';
  return `${ESPN_BASE}&groups=${groupId}${week}`;
}

// ESPN conference ids -> filter keys. 18 is FBS Independents (Notre Dame, UConn);
// every other FBS conference (American, CUSA, MAC, MWC, Pac-12, Sun Belt) rolls up
// into "remaining FBS". FCS teams get no key, so an FCS-vs-FCS game never shows, but a
// P4/FBS team hosting an FCS opponent still does through its own conference.
const CONF_KEYS = {
  '8': 'sec', '5': 'b1g', '4': 'b12', '1': 'acc', '18': 'ind',
  '151': 'fbs', '12': 'fbs', '15': 'fbs', '17': 'fbs', '9': 'fbs', '37': 'fbs',
};
const FBS_KEYS = ['sec', 'b1g', 'b12', 'acc', 'ind', 'fbs'];
// 'fav' and 'top25' are not conference keys: they match starred games and games with a
// ranked team (in the selected poll) respectively. Chips are OR'd together.
const ALL_FILTERS = ['fav', 'top25', ...FBS_KEYS, 'fcs', 'd2'];
const DEFAULT_FILTERS = ['fav', 'top25', 'sec', 'b1g', 'b12', 'acc']; // Power 4 + ranked (+ starred) until the user opts in

const UPSET_MIN_SPREAD = 7;     // favorite must be laying MORE than this
const CLOSE_MAX_DIFF = 8;       // one-score game
const CLOSE_SECONDS_LEFT = 360; // under 6:00 to go
const TIER_SIZE = 8;
const COMEBACK_CUT = 16;        // lead has shrunk by 2+ scores...
const COMEBACK_MAX_DIFF = 16;   // ...and the game is now within 2 scores
const NEW_GAME_CLOCK = 780;     // first 2:00 of Q1 (clock >= 13:00) sits at the bottom as "new game"
const REORDER_MS = 1500;        // how slowly cards slide when the order changes
const FLASH_MS = 2000;          // one pulse for every alert colour (keep in sync with style.css)

const LIVE_POLL_MS = 15000;
const IDLE_POLL_MS = 60000;

const DEMO = new URLSearchParams(location.search).has('demo');
// ?demo=shuffle also nudges scores every few seconds so the reorder slide can be watched.
const DEMO_SHUFFLE = new URLSearchParams(location.search).get('demo') === 'shuffle';

// Bumped on every deploy (see scripts/bump.sh). GitHub Pages and iOS home-screen apps
// cache aggressively, so each poll also checks version.json and reloads when it changes.
const APP_VERSION = '24';
const VERSION_URL = 'version.json';

// ---------- persistence ----------
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode etc. */ }
  },
};

// The scoreboard feed drops the odds the moment a game kicks off, but ESPN's per-game
// odds endpoint keeps them through the final. Remember every line we see, keyed by game
// id, and backfill missing ones from that endpoint so someone opening the app mid-game
// (or after it ended) still gets the spread and the upset alert.
const spreadCache = store.get('ua_spreads', {});
const ODDS_URL = id =>
  `https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/events/${id}/competitions/${id}/odds`;
const ODDS_RETRY_MS = 10 * 60 * 1000;
const oddsAttempts = new Map(); // game id -> timestamp of last backfill attempt
// Storage key is versioned so changing the chips resets everyone to the defaults.
const FILTER_KEY = 'ua_filters_v5';
let filters = new Set(store.get(FILTER_KEY, DEFAULT_FILTERS).filter(k => ALL_FILTERS.includes(k)));
if (filters.size === 0) filters = new Set(DEFAULT_FILTERS);

// Rankings. ESPN's scoreboard only carries one "curated" rank (AP until the CFP committee
// starts, then CFP); the rankings endpoint has every poll, so the user can pick. Polls we
// offer: AP (1), Coaches (2), CFP (21, appears late October). Cached for 30 minutes.
const RANKINGS_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/rankings';
// Polls the user can pick for FBS teams and the Top 25 chip...
const POLL_IDS = { '1': 'AP Top 25', '2': 'Coaches Poll', '21': 'CFP Rankings', '22': 'CFP Seedings', 'pate': 'JP Poll (Josh Pate)' };
// Josh Pate's JP Poll has no feed; a weekly job on Zane's Mac reads the On3 write-up and
// commits polls/pate.json (see scripts/update_pate.py).
const PATE_URL = 'polls/pate.json';
// ...and the level-specific coaches polls applied automatically to FCS / D-II / D-III teams
// (display only; they never feed the Top 25 chip, which is FBS-only).
const LEVEL_POLLS = { '20': 'FCS Coaches', '11': 'D-II Coaches', '12': 'D-III Coaches' };
const RANKINGS_TTL_MS = 30 * 60 * 1000;
let rankings = store.get('ua_rankings', { at: 0, polls: {} }); // polls: id -> { name, ranks: { teamId: rank } }
let selectedPoll = store.get('ua_poll', '1');

async function loadRankings(force) {
  if (!force && Date.now() - rankings.at < RANKINGS_TTL_MS && Object.keys(rankings.polls).length) return;
  try {
    const res = await fetch(RANKINGS_URL, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    const polls = {};
    for (const r of data.rankings || []) {
      if (!POLL_IDS[String(r.id)] && !LEVEL_POLLS[String(r.id)]) continue;
      const ranks = {};
      for (const x of r.ranks || []) if (x.team && x.current) ranks[String(x.team.id)] = x.current;
      if (Object.keys(ranks).length) polls[String(r.id)] = { name: POLL_IDS[String(r.id)] || LEVEL_POLLS[String(r.id)], ranks };
    }
    try {
      const pr = await fetch(`${PATE_URL}?t=${Date.now()}`, { cache: 'no-store' });
      if (pr.ok) {
        const pate = await pr.json();
        const ranks = {};
        for (const x of pate.ranks || []) ranks[String(x.id)] = x.rank;
        if (Object.keys(ranks).length) polls.pate = { name: `${POLL_IDS.pate} · Wk ${pate.week}`, ranks };
      }
    } catch { /* optional */ }
    if (Object.keys(polls).length) {
      rankings = { at: Date.now(), polls };
      store.set('ua_rankings', rankings);
    }
  } catch { /* keep whatever we had; cards fall back to ESPN's curated rank */ }
  if (!rankings.polls[selectedPoll]) selectedPoll = Object.keys(rankings.polls).find(id => POLL_IDS[id]) || '1';
  renderPollSelect();
  renderGames(games);
}

// Rank in the selected FBS poll; ESPN's curated rank when the poll data is missing.
function fbsRankOf(t) {
  const poll = rankings.polls[selectedPoll];
  if (!poll) return t.curated;
  return poll.ranks[t.id] || null;
}
// Rank shown on the card: the selected poll for FBS teams, otherwise the team's own
// level poll (FCS / D-II / D-III coaches), which needs no picking.
function rankOf(t) {
  const fbs = fbsRankOf(t);
  if (fbs) return fbs;
  if (CONF_KEYS[t.confId]) return null; // FBS team, just unranked
  for (const id of Object.keys(LEVEL_POLLS)) {
    const poll = rankings.polls[id];
    if (poll && poll.ranks[t.id]) return poll.ranks[t.id];
  }
  return null;
}
function isRankedGame(g) { return !!(fbsRankOf(g.home) || fbsRankOf(g.away)); }

// The poll menu pops up when the Top 25 chip is held (or right-clicked).
function renderPollSelect() {
  const menu = byId('poll-menu');
  const ids = Object.keys(POLL_IDS).filter(id => rankings.polls[id]);
  const items = ids.length ? ids : ['1'];
  menu.innerHTML = `<div class="title">Ranking poll</div>` + items.map(id =>
    `<button role="menuitemradio" aria-checked="${id === selectedPoll}" data-poll="${id}">
      <span>${esc((rankings.polls[id] || { name: POLL_IDS[id] }).name)}</span>
      <span class="check">${id === selectedPoll ? '✓' : ''}</span>
    </button>`).join('');
  const short = { '1': 'AP', '2': 'Coaches', '21': 'CFP', '22': 'CFP seeds', 'pate': 'JP Poll' }[selectedPoll] || '';
  byId('poll-hint').textContent = `Hold Top 25 to pick the poll · ${short}`;
}

function openPollMenu() {
  const menu = byId('poll-menu');
  const chip = byId('chip-top25');
  const top = document.querySelector('.top').getBoundingClientRect();
  const r = chip.getBoundingClientRect();
  menu.hidden = false;
  menu.style.top = `${r.bottom - top.top + 6}px`;
  menu.style.left = `${Math.max(0, r.left - top.left)}px`;
  const overflow = menu.getBoundingClientRect().right - (top.right - 4);
  if (overflow > 0) menu.style.left = `${Math.max(0, r.left - top.left - overflow)}px`;
}
function closePollMenu() { byId('poll-menu').hidden = true; }

// Biggest lead seen in each game, for the comeback watch. Seeded from ESPN's per-quarter
// line scores (so someone opening the app mid-game still gets it) and then updated from
// every live score we observe. Persisted so an auto-reload does not forget it.
const peakLeads = store.get('ua_peaks', {}); // game id -> { teamId, lead, at }
function notePeak(g, teamId, lead) {
  const cur = peakLeads[g.id];
  if (!cur || lead > cur.lead) peakLeads[g.id] = { teamId, lead, at: Date.now() };
}
function trackPeakLead(g, homeLines, awayLines) {
  if (g.state === 'pre') return;
  let h = 0, a = 0;
  const n = Math.min(homeLines.length, awayLines.length);
  for (let i = 0; i < n; i++) {
    h += homeLines[i]; a += awayLines[i];
    if (h !== a) notePeak(g, h > a ? g.home.id : g.away.id, Math.abs(h - a));
  }
  if (g.home.score !== g.away.score) {
    notePeak(g, g.home.score > g.away.score ? g.home.id : g.away.id, diff(g));
  }
  if (!peakLeads[g.id]) peakLeads[g.id] = { teamId: null, lead: 0, at: Date.now() };
}
function prunePeaks() {
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  for (const id of Object.keys(peakLeads)) if ((peakLeads[id].at || 0) < cutoff) delete peakLeads[id];
  for (const id of Object.keys(comebackState)) if ((comebackState[id].at || 0) < cutoff) delete comebackState[id];
}

// Favorites come from two places: games starred directly (by ESPN game id) and favorite
// teams (every game they play is starred automatically, week after week). Un-starring a
// game that is only a favorite through its team goes into an exclusion list, so the
// team stays favorited but that one game does not.
const favorites = new Set(store.get('ua_favs', []));
const excludedGames = new Set(store.get('ua_fav_excluded', []));
let favTeams = store.get('ua_fav_teams', []); // [{id, name, full, abbr, logo, conf, cat}]
const favTeamIds = () => new Set(favTeams.map(t => t.id));

function isTeamFavorite(g) {
  const ids = favTeamIds();
  return ids.has(g.home.id) || ids.has(g.away.id);
}
function isFavoriteGame(g) {
  return !excludedGames.has(g.id) && (favorites.has(g.id) || isTeamFavorite(g));
}
function toggleFavorite(id) {
  const g = games.find(x => x.id === id);
  if (!g) return;
  if (isFavoriteGame(g)) {
    favorites.delete(id);
    if (isTeamFavorite(g)) excludedGames.add(id);
  } else {
    excludedGames.delete(id);
    if (!isTeamFavorite(g)) favorites.add(id);
  }
  store.set('ua_favs', [...favorites]);
  store.set('ua_fav_excluded', [...excludedGames]);
  renderGames(games);
}
function saveFavTeams() {
  store.set('ua_fav_teams', favTeams);
  els.favTeamsBtn.classList.toggle('has-teams', favTeams.length > 0);
  renderGames(games);
}

// ---------- parsing ----------
function parseTeam(c, situation) {
  const t = c.team;
  const rank = c.curatedRank && c.curatedRank.current;
  const rec = (c.records || []).find(r => r.type === 'total') || (c.records || [])[0];
  return {
    id: t.id,
    abbr: t.abbreviation,
    name: t.shortDisplayName || t.name,
    full: t.displayName,
    logo: t.logo,
    curated: rank && rank <= 25 ? rank : null, // ESPN's own rank, used only as a fallback
    record: rec ? rec.summary : '',
    score: Number(c.score) || 0,
    confId: t.conferenceId,
    possession: !!(situation && situation.possession === t.id),
    lines: (c.linescores || []).map(l => Number(l.value) || 0), // points per quarter
  };
}

function parseSpread(comp, home, away) {
  return spreadFromOdds((comp.odds || [])[0], home, away);
}

// Shared by the scoreboard's inline odds and the per-game odds endpoint (same shape).
function spreadFromOdds(o, home, away) {
  if (!o || typeof o.spread !== 'number') return null;
  let favId;
  if (o.homeTeamOdds && o.homeTeamOdds.favorite) favId = home.id;
  else if (o.awayTeamOdds && o.awayTeamOdds.favorite) favId = away.id;
  else favId = o.spread < 0 ? home.id : away.id; // spread is home-relative
  const points = Math.abs(o.spread);
  if (points === 0) return { favId: null, points: 0, details: 'PK' };
  return { favId, points, details: o.details || '' };
}

function parseBroadcast(comp) {
  if (comp.broadcast) return comp.broadcast;
  const names = (comp.broadcasts || []).flatMap(b => b.names || []);
  if (names.length) return names.join('/');
  const geo = (comp.geoBroadcasts || []).find(g => g.media && g.media.shortName);
  return geo ? geo.media.shortName : '';
}

function parseEvent(ev, levelKeys) {
  const comp = ev.competitions[0];
  const homeC = comp.competitors.find(c => c.homeAway === 'home');
  const awayC = comp.competitors.find(c => c.homeAway === 'away');
  const home = parseTeam(homeC, comp.situation);
  const away = parseTeam(awayC, comp.situation);

  let spread = parseSpread(comp, home, away);
  if (spread) spreadCache[ev.id] = spread;
  else spread = spreadCache[ev.id] || null;

  const st = ev.status;
  const confKeys = new Set();
  for (const t of [home, away]) {
    if (CONF_KEYS[t.confId]) confKeys.add(CONF_KEYS[t.confId]);
  }
  // Non-FBS teams have no conference mapping; they take the level of whichever
  // feed(s) the game came from (an FCS-vs-FBS game is tagged both ways).
  const nonFbs = [home, away].filter(t => !CONF_KEYS[t.confId]).length;
  if (nonFbs) for (const k of levelKeys) confKeys.add(k);

  const g = {
    id: ev.id,
    date: new Date(ev.date),
    state: st.type.state,           // pre | in | post
    statusName: st.type.name,       // STATUS_SCHEDULED, STATUS_IN_PROGRESS, STATUS_HALFTIME, ...
    statusDetail: st.type.shortDetail || st.type.detail || '',
    period: st.period || 0,
    clock: Number(st.clock) || 0,
    displayClock: st.displayClock || '',
    home, away, spread,
    tv: parseBroadcast(comp),
    confKeys,
  };
  trackPeakLead(g, home.lines, away.lines);
  return g;
}

// ---------- game math ----------
function isLive(g) { return g.state === 'in'; }

function secondsLeft(g) {
  if (g.state === 'post') return 0;
  if (g.state !== 'in' || g.period <= 0) return 3600;
  if (g.period > 4) return 0; // overtime: nothing left on the clock
  if (g.statusName === 'STATUS_HALFTIME') return 1800;
  return (4 - g.period) * 900 + g.clock;
}

function diff(g) { return Math.abs(g.home.score - g.away.score); }
function tier(g) { return Math.max(1, Math.ceil(diff(g) / TIER_SIZE)); }

function favorite(g) {
  if (!g.spread || !g.spread.favId) return null;
  return g.spread.favId === g.home.id ? g.home : g.away;
}
function underdog(g) {
  const f = favorite(g);
  return f ? (f === g.home ? g.away : g.home) : null;
}

function isUpsetAlert(g) {
  if (!isLive(g) || !g.spread || g.spread.points <= UPSET_MIN_SPREAD) return false;
  const fav = favorite(g), dog = underdog(g);
  return !!fav && g.period >= 4 && fav.score < dog.score;
}

function isCloseGame(g) {
  return isLive(g) && diff(g) <= CLOSE_MAX_DIFF && secondsLeft(g) < CLOSE_SECONDS_LEFT;
}

// A team that led by a lot has given most of it back: their lead has shrunk by two scores
// or more (going from ahead to behind counts) and the game is now within two scores.
function comebackQualifies(g) {
  if (!isLive(g) || diff(g) > COMEBACK_MAX_DIFF) return false;
  const peak = peakLeads[g.id];
  if (!peak || !peak.teamId) return false;
  const leadNow = peak.teamId === g.home.id ? g.home.score - g.away.score : g.away.score - g.home.score;
  return peak.lead - leadNow >= COMEBACK_CUT;
}

// The watch switches off if the comeback stalls: once on, the game's tier is tracked and
// the moment it climbs back above the closest tier it reached, the alert is dropped. It
// only re-arms if the game later gets closer than it ever was during the last run.
const comebackState = store.get('ua_cb', {}); // game id -> { on, minTier, at }
function isComebackWatch(g) {
  const st = comebackState[g.id] || { on: false, minTier: Infinity, at: Date.now() };
  const t = tier(g);
  if (!comebackQualifies(g)) {
    st.on = false;
  } else if (st.on) {
    if (t < st.minTier) st.minTier = t;
    else if (t > st.minTier) st.on = false; // stalled: went back up a tier
  } else if (t < st.minTier) {
    st.on = true; st.minTier = t;          // new run, or the game got closer than the last run ever was
  }
  st.at = Date.now();
  comebackState[g.id] = st;
  return st.on;
}

// ESPN sometimes flags a game "in progress" before kickoff, so a brand-new game would
// otherwise rocket to the top as a 0-0 one-score game. Hold it at the bottom of Live for
// the first two minutes of game clock instead.
function isNewGame(g) {
  return isLive(g) && g.period <= 1 && g.clock >= NEW_GAME_CLOCK;
}

// At quarter breaks ESPN's clock flips between 0:00 and 15:00 (and the period number can
// lag or lead), which briefly scrambles the time-left math. Games in that state keep
// whatever spot they already had. Halftime and overtime read 0:00 legitimately.
function isClockUnstable(g) {
  if (!isLive(g) || g.period < 1 || g.period > 4 || g.statusName === 'STATUS_HALFTIME') return false;
  return g.clock === 0 || g.clock === 900;
}

function bestRanks(g) {
  const r = [rankOf(g.home) || 99, rankOf(g.away) || 99].sort((a, b) => a - b);
  return r;
}

function compareGames(a, b) {
  const bucket = g => (g.state === 'in' ? 0 : g.state === 'pre' ? 1 : 2);
  const ba = bucket(a), bb = bucket(b);
  if (ba !== bb) return ba - bb;

  if (ba === 0) {
    // Live: starred games first, then closest tier, then least time left, then raw margin.
    return isFavoriteGame(b) - isFavoriteGame(a)
      || tier(a) - tier(b) || secondsLeft(a) - secondsLeft(b) || diff(a) - diff(b);
  }
  // Starred games lead every non-live bucket too, so before kickoff (and after the final)
  // your games sit at the top of their section; live games still outrank them all.
  const fav = isFavoriteGame(b) - isFavoriteGame(a);
  if (ba === 1) {
    // Upcoming: kickoff, then smallest spread, then better-ranked matchup.
    const sa = a.spread ? a.spread.points : Infinity;
    const sb = b.spread ? b.spread.points : Infinity;
    const [a1, a2] = bestRanks(a), [b1, b2] = bestRanks(b);
    return fav || a.date - b.date || sa - sb || a1 - b1 || a2 - b2;
  }
  // Finals: most recent kickoff first.
  return fav || b.date - a.date;
}

// ---------- rendering ----------
const els = {
  lists: { in: byId('list-live'), pre: byId('list-pre'), post: byId('list-post') },
  groups: { in: byId('group-live'), pre: byId('group-pre'), post: byId('group-post') },
  empty: byId('empty'),
  error: byId('error'),
  updated: byId('updated'),
  weekSelect: byId('week-select'),
  refreshBtn: byId('refresh-btn'),
  chips: Array.from(document.querySelectorAll('.chip[data-conf]')),
  chipAll: byId('chip-all'),
  favTeamsBtn: byId('fav-teams-btn'),
  panel: byId('panel'),
  panelBack: byId('panel-back'),
  panelClose: byId('panel-close'),
  panelTitle: byId('panel-title'),
  panelBody: byId('panel-body'),
  panelFoot: byId('panel-foot'),
};
function byId(id) { return document.getElementById(id); }

const cardEls = new Map(); // game id -> { el, html }

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function fmtKickoff(d) {
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = sameDay ? '' : d.toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' });
  return { time, day };
}

function periodLabel(g) {
  if (g.statusName === 'STATUS_HALFTIME') return 'Half';
  if (g.period > 4) return g.period === 5 ? 'OT' : `${g.period - 4}OT`;
  if (g.statusName === 'STATUS_END_PERIOD') return `End Q${g.period}`;
  return `Q${g.period}`;
}

function statusHtml(g) {
  if (g.state === 'pre') {
    const { time, day } = fmtKickoff(g.date);
    const delayed = /DELAY|POSTPONE|CANCEL/.test(g.statusName) ? `<span class="clock">${esc(g.statusDetail)}</span>` : '';
    return `<span class="q">${esc(time)}</span>${day ? `<span class="day">${esc(day)}</span>` : ''}${delayed}`;
  }
  if (g.state === 'post') {
    const ot = g.period > 4 ? (g.period === 5 ? '/OT' : `/${g.period - 4}OT`) : '';
    return `<span class="q">Final${ot}</span>`;
  }
  const label = periodLabel(g);
  const showClock = !/Half|End/.test(label) && !(g.period > 4 && g.clock === 0);
  return `<span class="q">${esc(label)}</span>${showClock ? `<span class="clock">${esc(g.displayClock)}</span>` : ''}`;
}

function teamHtml(t, g, opponent) {
  const loser = g.state === 'post' && t.score < opponent.score;
  return `<div class="team${loser ? ' loser' : ''}">
    <img src="${esc(t.logo)}" alt="" loading="lazy">
    <span class="rank">${rankOf(t) ? '#' + rankOf(t) : ''}</span>
    <span class="name" title="${esc(t.full)}">${esc(t.name)}</span>
    <span class="rec">${esc(t.record)}</span>
    ${isLive(g) && t.possession ? '<span class="poss" title="Possession"></span>' : ''}
    <span class="score">${t.score}</span>
  </div>`;
}

function tierLabel(g) {
  const t = tier(g);
  return `${t} Score Game`;
}

function spreadText(g) {
  if (!g.spread) return 'No line';
  if (!g.spread.favId) return 'PK';
  const fav = favorite(g);
  return `${fav.abbr} -${g.spread.points}`;
}

const STAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.7l-5.9 3.1 1.2-6.5L2.5 9.7l6.6-.9z"/></svg>';

function cardHtml(g, flags, fav) {
  const badges = [];
  if (flags.upset) badges.push('<span class="badge upset">Upset alert</span>');
  if (flags.close) badges.push('<span class="badge close">Close game</span>');
  if (flags.comeback) badges.push('<span class="badge comeback">Comeback watch</span>');
  if (flags.newGame) badges.push('<span class="badge new">New game</span>');
  return `
    ${badges.length ? `<div class="badges">${badges.join('')}</div>` : ''}
    <button class="star${fav ? ' on' : ''}" aria-label="${fav ? 'Remove from favorites' : 'Add to favorites'}" aria-pressed="${fav}">${STAR_SVG}</button>
    <div class="teams">
      ${teamHtml(g.away, g, g.home)}
      ${teamHtml(g.home, g, g.away)}
    </div>
    <div class="status">${statusHtml(g)}</div>
    <div class="meta">
      <span class="spread">${esc(spreadText(g))}</span>
      ${isLive(g) ? `<span class="tier">${tierLabel(g)}</span>` : ''}
      <span class="tv">${esc(g.tv || 'TV TBD')}</span>
    </div>`;
}

// Live-list order from the previous render, so games with an unstable clock can hold
// their spot, and the on-screen positions of every card, so reorders can be animated.
let prevLiveOrder = new Map(); // game id -> index within the live list
let hasRendered = false;
let suppressNextSlide = false; // set when the tab comes back from the background

function orderLive(live) {
  const newGames = live.filter(isNewGame).sort((a, b) => a.date - b.date);
  const frozen = live.filter(g => !isNewGame(g) && isClockUnstable(g) && prevLiveOrder.has(g.id));
  const rest = live.filter(g => !newGames.includes(g) && !frozen.includes(g)).sort(compareGames);
  // Put frozen games back at the index they held last time (lowest index first so the
  // positions stay meaningful), then park the new games at the bottom.
  for (const g of frozen.sort((a, b) => prevLiveOrder.get(a.id) - prevLiveOrder.get(b.id))) {
    rest.splice(Math.min(prevLiveOrder.get(g.id), rest.length), 0, g);
  }
  return rest.concat(newGames);
}

function renderGames(games) {
  const visible = games.filter(g =>
    [...g.confKeys].some(k => filters.has(k))
    || (filters.has('fav') && isFavoriteGame(g))
    || (filters.has('top25') && isRankedGame(g)));

  const perBucket = { in: [], pre: [], post: [] };
  for (const g of visible) (perBucket[g.state] || perBucket.pre).push(g);
  perBucket.in = orderLive(perBucket.in);
  perBucket.pre.sort(compareGames);
  perBucket.post.sort(compareGames);
  prevLiveOrder = new Map(perBucket.in.map((g, i) => [g.id, i]));

  // Remember where every existing card sits before the DOM changes (FLIP animation).
  const animate = hasRendered && !suppressNextSlide && !document.hidden;
  const before = new Map();
  if (animate) for (const [id, entry] of cardEls) before.set(id, entry.el.getBoundingClientRect());
  suppressNextSlide = false;

  const seen = new Set();
  for (const state of ['in', 'pre', 'post']) {
    const list = els.lists[state];
    for (const g of perBucket[state]) {
      const flags = {
        upset: isUpsetAlert(g), close: isCloseGame(g), comeback: isComebackWatch(g), newGame: isNewGame(g),
      };
      const fav = isFavoriteGame(g);
      const html = cardHtml(g, flags, fav);
      let entry = cardEls.get(g.id);
      if (!entry) {
        const el = document.createElement('article');
        el.dataset.id = g.id;
        entry = { el, html: '' };
        cardEls.set(g.id, entry);
      }
      if (entry.html !== html) { entry.el.innerHTML = html; entry.html = html; }
      // Toggling classes (not rebuilding nodes) keeps the flash animation from restarting on every poll.
      // One alert flashes its own colour; two alternate between both colours; all three fall
      // back to upset + close. Badges still show every alert that applies.
      let active = ['upset', 'close', 'comeback'].filter(k => flags[k]);
      if (active.length === 3) active = ['upset', 'close'];
      const flash = active.length ? ` flash f-${active.join('-')}` : '';
      const wasFlashing = entry.el.classList.contains('flash');
      entry.el.className = `card ${g.state === 'in' ? 'live' : g.state}${flash}${flags.newGame ? ' newgame' : ''}${entry.el.classList.contains('moving') ? ' moving' : ''}`;
      // Every flashing card runs on one shared 2s clock so the pulses stay in step.
      if (flash && !wasFlashing) entry.el.style.animationDelay = `-${Math.round(performance.now() % FLASH_MS)}ms`;
      if (!flash) entry.el.style.animationDelay = '';
      list.appendChild(entry.el); // appendChild moves an existing node, so this also reorders
      seen.add(g.id);
    }
    els.groups[state].hidden = perBucket[state].length === 0;
  }

  for (const [id, entry] of cardEls) {
    if (!seen.has(id)) { entry.el.remove(); cardEls.delete(id); }
  }
  els.empty.hidden = visible.length > 0;
  hasRendered = true;
  if (animate) slideMovedCards(before);
}

// Cards that changed position glide from where they were to where they are now, so a
// reorder is something you can watch rather than a jump cut.
function slideMovedCards(before) {
  for (const [id, entry] of cardEls) {
    const was = before.get(id);
    if (!was) continue; // brand-new card: just appears in place
    const now = entry.el.getBoundingClientRect();
    const dx = was.left - now.left, dy = was.top - now.top;
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) continue;
    const el = entry.el;
    el.style.transition = 'none';
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    el.classList.add('moving');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.style.transition = `transform ${REORDER_MS}ms cubic-bezier(.25, .8, .25, 1)`;
      el.style.transform = '';
    }));
    clearTimeout(el._moveTimer);
    el._moveTimer = setTimeout(() => {
      el.style.transition = ''; el.style.transform = ''; el.classList.remove('moving');
    }, REORDER_MS + 50);
  }
}

function renderFilters() {
  for (const chip of els.chips) chip.classList.toggle('on', filters.has(chip.dataset.conf));
  els.chipAll.classList.toggle('on', filters.size === ALL_FILTERS.length);
}

// ---------- fetching ----------
let games = [];
let lastFetched = null;
let pollTimer = null;
let inflight = false;
let refetchWanted = false; // week changed while a fetch was in flight

async function checkForNewBuild() {
  try {
    const res = await fetch(`${VERSION_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const { v } = await res.json();
    if (!v || v === APP_VERSION) return;
    if (sessionStorage.getItem('ua_reloaded_for') === v) return; // one attempt per build, never a loop
    sessionStorage.setItem('ua_reloaded_for', v);
    // Not location.reload(): the iOS home-screen app can answer that from its cached copy of
    // index.html, which still points at the old script. A new query string forces a real fetch.
    const url = new URL(location.href);
    url.searchParams.set('v', v);
    location.replace(url);
  } catch { /* offline or blocked: ignore */ }
}

async function backfillSpreads(list) {
  const now = Date.now();
  // Pregame lines still arrive through the scoreboard itself, and Division II games are
  // never priced, so only chase live/final games at FBS or FCS level.
  const missing = list.filter(g => !g.spread && g.state !== 'pre'
    && [...g.confKeys].some(k => k !== 'd2')
    && now - (oddsAttempts.get(g.id) || 0) > ODDS_RETRY_MS);
  if (!missing.length) return;
  for (const g of missing) oddsAttempts.set(g.id, now);
  let found = false;
  const CHUNK = 6;
  for (let i = 0; i < missing.length; i += CHUNK) {
    await Promise.allSettled(missing.slice(i, i + CHUNK).map(async g => {
      const res = await fetch(ODDS_URL(g.id), { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status);
      const items = (await res.json()).items || [];
      const o = items.find(it => it.provider && it.provider.id === '100') || items[0]; // prefer DraftKings
      const spread = spreadFromOdds(o, g.home, g.away);
      if (spread) { spreadCache[g.id] = spread; g.spread = spread; found = true; }
    }));
  }
  if (found) {
    store.set('ua_spreads', spreadCache);
    renderGames(games);
  }
}

async function refresh() {
  if (inflight) { refetchWanted = true; return; }
  inflight = true;
  els.refreshBtn.classList.add('spin');
  checkForNewBuild();
  try {
    const requested = selectedWeek;
    loadRankings(false); // async; the next render picks it up
    const feeds = await Promise.all(GROUPS.map(async grp => {
      const res = await fetch(scoreboardUrl(grp.id), { cache: 'no-store' });
      if (!res.ok) throw new Error(`ESPN responded ${res.status}`);
      return { grp, data: await res.json() };
    }));
    if (requested !== selectedWeek) return; // user changed weeks while this was in flight
    const data = feeds[0].data; // FBS feed carries the week/calendar info
    const merged = new Map(); // event id -> { ev, levelKeys }
    for (const { grp, data: d } of feeds) {
      for (const ev of d.events || []) {
        const entry = merged.get(ev.id) || { ev, levelKeys: new Set() };
        if (grp.key) entry.levelKeys.add(grp.key);
        merged.set(ev.id, entry);
      }
    }
    games = [...merged.values()].map(({ ev, levelKeys }) => parseEvent(ev, levelKeys))
      .filter(g => g.confKeys.size > 0);
    if (DEMO) games = applyDemo(games);
    store.set('ua_spreads', spreadCache);
    prunePeaks();
    store.set('ua_peaks', peakLeads);
    store.set('ua_cb', comebackState);
    lastFetched = new Date();
    if (!currentWeek && data.week && data.season) {
      currentWeek = { type: data.season.type, week: data.week.number };
    }
    if (!calendar.length) buildCalendar(data);
    renderWeekSelect();
    byId('demo-badge').hidden = !DEMO;
    els.error.hidden = true;
    renderGames(games);
    backfillSpreads(games); // async; re-renders when lines arrive
  } catch (err) {
    els.error.textContent = `Could not load scores: ${err.message}`;
    els.error.hidden = false;
  } finally {
    inflight = false;
    els.refreshBtn.classList.remove('spin');
    updateStamp();
    schedule();
    if (refetchWanted) { refetchWanted = false; refresh(); }
  }
}

// ---------- week picker ----------
function buildCalendar(data) {
  const league = (data.leagues || [])[0];
  for (const block of (league && league.calendar) || []) {
    const type = Number(block.value);
    if (type === 2) {
      for (const e of block.entries || []) calendar.push({ type, week: Number(e.value), label: e.label });
    } else if (type === 3) {
      calendar.push({ type, week: 1, label: 'Bowls & Playoff' });
    }
  }
}

function sameWeek(a, b) { return !!a && !!b && a.type === b.type && a.week === b.week; }

function renderWeekSelect() {
  const sel = els.weekSelect;
  const active = selectedWeek || currentWeek;
  if (!calendar.length) {
    sel.innerHTML = `<option>${active ? `Week ${active.week}` : 'This week'}</option>`;
    return;
  }
  sel.innerHTML = calendar.map(c => {
    const value = c.type === 3 ? 'bowls' : String(c.week);
    return `<option value="${value}"${sameWeek(c, active) ? ' selected' : ''}>${esc(c.label)}</option>`;
  }).join('');
}

function onWeekChange() {
  const v = els.weekSelect.value;
  const pick = v === 'bowls' ? { type: 3, week: 1 } : { type: 2, week: Number(v) };
  selectedWeek = sameWeek(pick, currentWeek) ? null : pick; // current week keeps a clean URL
  const url = new URL(location.href);
  if (selectedWeek) url.searchParams.set('week', v); else url.searchParams.delete('week');
  history.replaceState(null, '', url);
  games = [];
  els.updated.textContent = 'Loading…';
  refresh();
}

function schedule() {
  clearTimeout(pollTimer);
  const anyLive = games.some(isLive);
  pollTimer = setTimeout(refresh, anyLive ? LIVE_POLL_MS : IDLE_POLL_MS);
}

function updateStamp() {
  if (!lastFetched) return;
  const secs = Math.round((Date.now() - lastFetched) / 1000);
  els.updated.textContent = secs < 5 ? 'Updated just now' : `Updated ${secs}s ago`;
}
setInterval(updateStamp, 1000);

// ---------- demo mode (?demo) ----------
// Fakes a mid-afternoon slate so sorting and the alert animations can be seen
// without waiting for a Saturday. Real games/lines are used; only states change.
function applyDemo(list) {
  const out = list.map(g => ({ ...g, home: { ...g.home }, away: { ...g.away } }));
  const pre = out.filter(g => g.state === 'pre');
  const scripts = [
    // [period, clockSeconds, statusName, awayScore, homeScore]
    [4, 210, 'STATUS_IN_PROGRESS', 24, 27],  // close game, favorite may be behind
    [4, 95,  'STATUS_IN_PROGRESS', 31, 28],
    [4, 700, 'STATUS_IN_PROGRESS', 17, 20],
    [3, 420, 'STATUS_IN_PROGRESS', 14, 35],
    [2, 0,   'STATUS_HALFTIME',    10, 13],
    [5, 0,   'STATUS_IN_PROGRESS', 38, 38],
    [1, 300, 'STATUS_IN_PROGRESS', 0, 7],
    [3, 800, 'STATUS_IN_PROGRESS', 3, 45],
    [4, 40,  'STATUS_IN_PROGRESS', 21, 21],
    [2, 500, 'STATUS_IN_PROGRESS', 28, 7],
    [3, 600, 'STATUS_IN_PROGRESS', 24, 27],  // comeback watch: home led 27-3, now 27-24
    [1, 870, 'STATUS_IN_PROGRESS', 0, 0],    // new game: 14:30 in Q1
    [2, 0,   'STATUS_END_PERIOD',  10, 14],  // unstable clock: end of Q2, holds its spot
  ];
  pre.slice(0, scripts.length).forEach((g, i) => {
    const [period, clock, statusName, a, h] = scripts[i];
    g.state = 'in'; g.period = period; g.clock = clock; g.statusName = statusName;
    g.displayClock = `${Math.floor(clock / 60)}:${String(clock % 60).padStart(2, '0')}`;
    // Put the underdog ahead in the first two so an upset alert shows if the line is big enough.
    const fav = favorite(g);
    if (i < 2 && fav) {
      const dogIsHome = fav === g.away;
      g.home.score = dogIsHome ? Math.max(a, h) : Math.min(a, h);
      g.away.score = dogIsHome ? Math.min(a, h) : Math.max(a, h);
    } else { g.away.score = a; g.home.score = h; }
    g.home.possession = i % 2 === 0; g.away.possession = !g.home.possession;
    if (i === 10) peakLeads[g.id] = { teamId: g.home.id, lead: 24, at: Date.now() };
  });
  pre.slice(scripts.length, scripts.length + 3).forEach(g => {
    g.state = 'post'; g.period = 4; g.statusName = 'STATUS_FINAL';
    g.away.score = 17; g.home.score = 31;
  });
  return out;
}

// ---------- Favorite Teams panel ----------
// Team lists come from ESPN's standings endpoint, one request per conference group,
// walked recursively because some conferences (Sun Belt, SWAC, all of D-II) nest divisions.
const STANDINGS_URL = g => `https://site.web.api.espn.com/apis/v2/sports/football/college-football/standings?group=${g}&level=3`;
const TEAM_CATEGORIES = [
  { key: 'sec', label: 'SEC', groups: [8] },
  { key: 'b1g', label: 'Big Ten', groups: [5] },
  { key: 'b12', label: 'Big 12', groups: [4] },
  { key: 'acc', label: 'ACC', groups: [1] },
  { key: 'ind', label: 'Independent', groups: [18] },
  { key: 'fbs', label: 'Remaining FBS', groups: [151, 12, 15, 17, 9, 37] },
  { key: 'fcs', label: 'FCS', groups: [81] },
  { key: 'd2', label: 'Div 2', groups: [35] },
];
const TEAMS_TTL_MS = 7 * 24 * 3600 * 1000;
const teamCache = new Map(); // cat key -> [{conf, teams:[...]}]

function walkStandings(node, out, confName) {
  const entries = (node.standings && node.standings.entries) || [];
  const name = node.name || confName || '';
  if (entries.length) {
    out.push({
      conf: name,
      teams: entries.map(e => e.team).map(t => ({
        id: String(t.id),
        name: t.shortDisplayName || t.displayName,
        full: t.displayName,
        abbr: t.abbreviation || '',
        logo: (t.logos && t.logos[0] && t.logos[0].href) || '',
        conf: name,
      })).sort((a, b) => a.name.localeCompare(b.name)),
    });
  }
  for (const child of node.children || []) walkStandings(child, out, name);
}

async function loadCategory(cat) {
  if (teamCache.has(cat.key)) return teamCache.get(cat.key);
  const cached = store.get(`ua_teams_${cat.key}`, null);
  if (cached && Date.now() - cached.at < TEAMS_TTL_MS) {
    teamCache.set(cat.key, cached.sections);
    return cached.sections;
  }
  const sections = [];
  const docs = await Promise.all(cat.groups.map(g => fetch(STANDINGS_URL(g)).then(r => {
    if (!r.ok) throw new Error(`ESPN responded ${r.status}`);
    return r.json();
  })));
  for (const doc of docs) walkStandings(doc, sections);
  teamCache.set(cat.key, sections);
  store.set(`ua_teams_${cat.key}`, { at: Date.now(), sections });
  return sections;
}

let panelView = 'list';   // list | cats | teams
let panelCat = null;
let panelQuery = '';

function openPanel() {
  showPanelView('list');
  els.panel.hidden = false;
  document.body.classList.add('panel-open');
}
function closePanel() {
  els.panel.hidden = true;
  document.body.classList.remove('panel-open');
}

function showPanelView(view, cat) {
  panelView = view;
  if (cat) panelCat = cat;
  els.panelBack.hidden = view === 'list';
  els.panelTitle.textContent = view === 'list' ? 'Favorite Teams'
    : view === 'cats' ? 'Add New Favorite Team' : panelCat.label;
  els.panelFoot.innerHTML = view === 'list'
    ? '<button class="btn-primary" id="add-team-btn">Add New Favorite Team</button>' : '';
  els.panelBody.scrollTop = 0;
  if (view === 'list') renderFavList();
  else if (view === 'cats') renderCategories();
  else renderTeamPicker();
}

function teamRow(t, starred) {
  return `<li data-team="${esc(t.id)}">
    <img src="${esc(t.logo)}" alt="" loading="lazy">
    <div class="grow"><span class="t-name">${esc(t.full || t.name)}</span><span class="t-conf">${esc(t.conf)}</span></div>
    <button class="star inline${starred ? ' on' : ''}" aria-pressed="${starred}" aria-label="${starred ? 'Remove favorite' : 'Add favorite'}">${STAR_SVG}</button>
  </li>`;
}

function renderFavList() {
  if (!favTeams.length) {
    els.panelBody.innerHTML = `<p class="panel-empty">No favorite teams yet.<br>Games your favorite teams play are starred automatically every week and jump to the top while live.</p>`;
    return;
  }
  const sorted = [...favTeams].sort((a, b) => a.name.localeCompare(b.name));
  els.panelBody.innerHTML = `<p class="panel-note">Their games are starred automatically each week.</p>
    <ul class="team-list">${sorted.map(t => teamRow(t, true)).join('')}</ul>`;
}

function renderCategories() {
  const counts = {};
  for (const t of favTeams) counts[t.cat] = (counts[t.cat] || 0) + 1;
  els.panelBody.innerHTML = `<div class="cat-list">${TEAM_CATEGORIES.map(c =>
    `<button class="cat-btn" data-cat="${c.key}"><span>${esc(c.label)}</span><span>${counts[c.key] ? `<span class="count">${counts[c.key]} ★</span>` : ''}<span class="chev">›</span></span></button>`
  ).join('')}</div>`;
}

async function renderTeamPicker() {
  const cat = panelCat;
  els.panelBody.innerHTML = `<input class="search" id="team-search" type="search" placeholder="Search teams" value="${esc(panelQuery)}" autocomplete="off">
    <p class="panel-empty">Loading teams…</p>`;
  let sections;
  try { sections = await loadCategory(cat); }
  catch (err) {
    els.panelBody.querySelector('.panel-empty').textContent = `Could not load teams: ${err.message}`;
    return;
  }
  if (panelView !== 'teams' || panelCat !== cat) return; // user navigated away meanwhile
  const ids = favTeamIds();
  const q = panelQuery.trim().toLowerCase();
  const html = sections.map(sec => {
    const teams = q ? sec.teams.filter(t => (t.full + ' ' + t.abbr).toLowerCase().includes(q)) : sec.teams;
    if (!teams.length) return '';
    return `${sections.length > 1 ? `<h3>${esc(sec.conf)}</h3>` : ''}${teams.map(t => teamRow(t, ids.has(t.id))).join('')}`;
  }).join('');
  const list = els.panelBody.querySelector('.panel-empty');
  list.outerHTML = html ? `<ul class="team-list">${html}</ul>` : '<p class="panel-empty">No teams match.</p>';
  const search = byId('team-search');
  search.addEventListener('input', () => { panelQuery = search.value; renderTeamPicker(); });
  if (q) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
}

function toggleFavTeam(id) {
  const existing = favTeams.find(t => t.id === id);
  if (existing) {
    favTeams = favTeams.filter(t => t.id !== id);
  } else {
    const sections = teamCache.get(panelCat && panelCat.key) || [];
    const t = sections.flatMap(sec => sec.teams).find(x => x.id === id);
    if (!t) return;
    favTeams.push({ ...t, cat: panelCat.key });
  }
  saveFavTeams();
}

els.favTeamsBtn.addEventListener('click', openPanel);
els.panelClose.addEventListener('click', closePanel);
els.panelBack.addEventListener('click', () => showPanelView(panelView === 'teams' ? 'cats' : 'list'));
els.panel.addEventListener('click', e => {
  if (e.target.closest('#add-team-btn')) { panelQuery = ''; showPanelView('cats'); return; }
  const catBtn = e.target.closest('.cat-btn');
  if (catBtn) { panelQuery = ''; showPanelView('teams', TEAM_CATEGORIES.find(c => c.key === catBtn.dataset.cat)); return; }
  const star = e.target.closest('.star.inline');
  if (star) {
    const id = star.closest('li').dataset.team;
    toggleFavTeam(id);
    if (panelView === 'list') renderFavList();
    else { const on = favTeamIds().has(id); star.classList.toggle('on', on); star.setAttribute('aria-pressed', on); }
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !els.panel.hidden) closePanel(); });
els.favTeamsBtn.classList.toggle('has-teams', favTeams.length > 0);

// Demo shuffle: every few seconds one live game scores or its clock runs, so the cards
// visibly trade places.
if (DEMO_SHUFFLE) {
  setInterval(() => {
    const live = games.filter(g => isLive(g) && !isNewGame(g) && g.period <= 4);
    if (live.length < 2) return;
    const g = live[Math.floor(Math.random() * live.length)];
    if (Math.random() < 0.5) {
      const team = Math.random() < 0.5 ? g.home : g.away;
      team.score += Math.random() < 0.7 ? 7 : 3;
    } else {
      g.clock = Math.max(1, g.clock - 300);
      g.displayClock = `${Math.floor(g.clock / 60)}:${String(g.clock % 60).padStart(2, '0')}`;
    }
    renderGames(games);
  }, 6000);
}

// ---------- wiring ----------
for (const chip of els.chips) {
  chip.addEventListener('click', () => {
    const k = chip.dataset.conf;
    if (filters.has(k)) filters.delete(k); else filters.add(k);
    if (filters.size === 0) filters = new Set(DEFAULT_FILTERS); // never leave an empty board
    store.set(FILTER_KEY, [...filters]);
    renderFilters();
    renderGames(games);
  });
}
els.chipAll.addEventListener('click', () => {
  filters = new Set(ALL_FILTERS);
  store.set(FILTER_KEY, [...filters]);
  renderFilters();
  renderGames(games);
});
els.refreshBtn.addEventListener('click', refresh);
byId('board').addEventListener('click', e => {
  const star = e.target.closest('.star');
  if (star) toggleFavorite(star.closest('.card').dataset.id);
});
els.weekSelect.addEventListener('change', onWeekChange);
// Top 25 chip: tap toggles the filter, hold (~450ms) or right-click opens the poll menu.
{
  const chip = byId('chip-top25');
  let holdTimer = null, held = false;
  const start = () => { held = false; clearTimeout(holdTimer); holdTimer = setTimeout(() => { held = true; openPollMenu(); }, 450); };
  const cancel = () => clearTimeout(holdTimer);
  chip.addEventListener('pointerdown', start);
  chip.addEventListener('pointerup', cancel);
  chip.addEventListener('pointerleave', cancel);
  chip.addEventListener('pointercancel', cancel);
  chip.addEventListener('click', e => { if (held) { e.stopImmediatePropagation(); e.preventDefault(); held = false; } }, true);
  chip.addEventListener('contextmenu', e => { e.preventDefault(); openPollMenu(); });
  byId('poll-menu').addEventListener('click', e => {
    const b = e.target.closest('button[data-poll]');
    if (!b) return;
    selectedPoll = b.dataset.poll;
    store.set('ua_poll', selectedPoll);
    renderPollSelect();
    closePollMenu();
    renderGames(games);
  });
  document.addEventListener('pointerdown', e => {
    if (!byId('poll-menu').hidden && !e.target.closest('#poll-menu') && !e.target.closest('#chip-top25')) closePollMenu();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closePollMenu(); });
}
renderPollSelect();
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { suppressNextSlide = true; refresh(); } // coming back counts as a fresh look, no slide show
});

renderFilters();
{ // drop the cache-busting ?v= once the matching build is running
  const url = new URL(location.href);
  if (url.searchParams.get('v') === APP_VERSION) { url.searchParams.delete('v'); history.replaceState(null, '', url); }
}
refresh();
