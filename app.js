/* Upset Alert — FBS college football scoreboard.
 * Data comes straight from ESPN's public scoreboard feed (no key needed). */

const ESPN_URL =
  'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?groups=80&limit=300';

// ESPN conference ids -> filter keys. 18 is FBS Independents (Notre Dame, UConn);
// every other FBS conference (American, CUSA, MAC, MWC, Pac-12, Sun Belt) rolls up
// into "remaining FBS". FCS teams get no key, so an FCS-vs-FCS game never shows, but a
// P4/FBS team hosting an FCS opponent still does through its own conference.
const CONF_KEYS = {
  '8': 'sec', '5': 'b1g', '4': 'b12', '1': 'acc', '18': 'ind',
  '151': 'fbs', '12': 'fbs', '15': 'fbs', '17': 'fbs', '9': 'fbs', '37': 'fbs',
};
const ALL_FILTERS = ['sec', 'b1g', 'b12', 'acc', 'ind', 'fbs'];

const UPSET_MIN_SPREAD = 7;     // favorite must be laying MORE than this
const CLOSE_MAX_DIFF = 8;       // one-score game
const CLOSE_SECONDS_LEFT = 360; // under 6:00 to go
const TIER_SIZE = 8;

const LIVE_POLL_MS = 15000;
const IDLE_POLL_MS = 60000;

const DEMO = new URLSearchParams(location.search).has('demo');

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

// ESPN removes the odds once a game ends (and sometimes mid-game), so remember
// every pregame line we see, keyed by game id.
const spreadCache = store.get('ua_spreads', {});
// Storage key is versioned so adding a filter key resets everyone to "all on".
const FILTER_KEY = 'ua_filters_v2';
let filters = new Set(store.get(FILTER_KEY, ALL_FILTERS).filter(k => ALL_FILTERS.includes(k)));
if (filters.size === 0) filters = new Set(ALL_FILTERS);

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
    rank: rank && rank <= 25 ? rank : null,
    record: rec ? rec.summary : '',
    score: Number(c.score) || 0,
    confId: t.conferenceId,
    possession: !!(situation && situation.possession === t.id),
  };
}

function parseSpread(comp, home, away) {
  const o = (comp.odds || [])[0];
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

function parseEvent(ev) {
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

  return {
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

function bestRanks(g) {
  const r = [g.home.rank || 99, g.away.rank || 99].sort((a, b) => a - b);
  return r;
}

function compareGames(a, b) {
  const bucket = g => (g.state === 'in' ? 0 : g.state === 'pre' ? 1 : 2);
  const ba = bucket(a), bb = bucket(b);
  if (ba !== bb) return ba - bb;

  if (ba === 0) {
    // Live: closest tier first, then least time left, then raw margin.
    return tier(a) - tier(b) || secondsLeft(a) - secondsLeft(b) || diff(a) - diff(b);
  }
  if (ba === 1) {
    // Upcoming: kickoff, then smallest spread, then better-ranked matchup.
    const sa = a.spread ? a.spread.points : Infinity;
    const sb = b.spread ? b.spread.points : Infinity;
    const [a1, a2] = bestRanks(a), [b1, b2] = bestRanks(b);
    return a.date - b.date || sa - sb || a1 - b1 || a2 - b2;
  }
  // Finals: most recent kickoff first.
  return b.date - a.date;
}

// ---------- rendering ----------
const els = {
  lists: { in: byId('list-live'), pre: byId('list-pre'), post: byId('list-post') },
  groups: { in: byId('group-live'), pre: byId('group-pre'), post: byId('group-post') },
  empty: byId('empty'),
  error: byId('error'),
  updated: byId('updated'),
  week: byId('week-label'),
  refreshBtn: byId('refresh-btn'),
  chips: Array.from(document.querySelectorAll('.chip[data-conf]')),
  chipAll: byId('chip-all'),
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
  const day = sameDay ? '' : d.toLocaleDateString([], { weekday: 'short' });
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
    <span class="rank">${t.rank ? '#' + t.rank : ''}</span>
    <span class="name" title="${esc(t.full)}">${esc(t.name)}</span>
    <span class="rec">${esc(t.record)}</span>
    ${isLive(g) && t.possession ? '<span class="poss" title="Possession"></span>' : ''}
    <span class="score">${t.score}</span>
  </div>`;
}

function spreadText(g) {
  if (!g.spread) return 'No line';
  if (!g.spread.favId) return 'PK';
  const fav = favorite(g);
  return `${fav.abbr} -${g.spread.points}`;
}

function cardHtml(g, upset, close) {
  const badges = [];
  if (upset) badges.push('<span class="badge upset">Upset alert</span>');
  if (close) badges.push('<span class="badge close">Close game</span>');
  return `
    ${badges.length ? `<div class="badges">${badges.join('')}</div>` : ''}
    <div class="teams">
      ${teamHtml(g.away, g, g.home)}
      ${teamHtml(g.home, g, g.away)}
    </div>
    <div class="status">${statusHtml(g)}</div>
    <div class="meta">
      <span class="spread">${esc(spreadText(g))}</span>
      ${isLive(g) ? `<span class="tier">Tier ${tier(g)}</span>` : ''}
      <span class="tv">${esc(g.tv || 'TV TBD')}</span>
    </div>`;
}

function renderGames(games) {
  const visible = games.filter(g => [...g.confKeys].some(k => filters.has(k)));
  visible.sort(compareGames);

  const seen = new Set();
  const perBucket = { in: [], pre: [], post: [] };
  for (const g of visible) (perBucket[g.state] || perBucket.pre).push(g);

  for (const state of ['in', 'pre', 'post']) {
    const list = els.lists[state];
    for (const g of perBucket[state]) {
      const upset = isUpsetAlert(g), close = isCloseGame(g);
      const html = cardHtml(g, upset, close);
      let entry = cardEls.get(g.id);
      if (!entry) {
        const el = document.createElement('article');
        el.dataset.id = g.id;
        entry = { el, html: '' };
        cardEls.set(g.id, entry);
      }
      if (entry.html !== html) { entry.el.innerHTML = html; entry.html = html; }
      // Toggling classes (not rebuilding nodes) keeps the blink animation from restarting on every poll.
      entry.el.className = `card ${g.state === 'in' ? 'live' : g.state}${upset ? ' upset' : ''}${close ? ' close' : ''}`;
      list.appendChild(entry.el); // appendChild moves an existing node, so this also reorders
      seen.add(g.id);
    }
    els.groups[state].hidden = perBucket[state].length === 0;
  }

  for (const [id, entry] of cardEls) {
    if (!seen.has(id)) { entry.el.remove(); cardEls.delete(id); }
  }
  els.empty.hidden = visible.length > 0;
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

async function refresh() {
  if (inflight) return;
  inflight = true;
  els.refreshBtn.classList.add('spin');
  try {
    const res = await fetch(ESPN_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`ESPN responded ${res.status}`);
    const data = await res.json();
    games = (data.events || []).map(parseEvent).filter(g => g.confKeys.size > 0);
    if (DEMO) games = applyDemo(games);
    store.set('ua_spreads', spreadCache);
    lastFetched = new Date();
    const wk = data.week && data.week.number;
    els.week.textContent = `${wk ? `Week ${wk} · ` : ''}FBS scoreboard${DEMO ? ' · DEMO DATA' : ''}`;
    els.error.hidden = true;
    renderGames(games);
  } catch (err) {
    els.error.textContent = `Could not load scores: ${err.message}`;
    els.error.hidden = false;
  } finally {
    inflight = false;
    els.refreshBtn.classList.remove('spin');
    updateStamp();
    schedule();
  }
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
  });
  pre.slice(scripts.length, scripts.length + 3).forEach(g => {
    g.state = 'post'; g.period = 4; g.statusName = 'STATUS_FINAL';
    g.away.score = 17; g.home.score = 31;
  });
  return out;
}

// ---------- wiring ----------
for (const chip of els.chips) {
  chip.addEventListener('click', () => {
    const k = chip.dataset.conf;
    if (filters.has(k)) filters.delete(k); else filters.add(k);
    if (filters.size === 0) filters = new Set(ALL_FILTERS); // never leave an empty board
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
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

renderFilters();
refresh();
