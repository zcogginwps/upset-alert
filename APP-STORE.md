# App Store submission checklist — Quad Box Buddy

Working notes for getting QBB (college football) onto the App Store. Shared conventions here
apply to the NCAAM app and the Fantasy Tracker app too — one $99/yr membership covers all three.

---

## Status

| Item | State |
|---|---|
| 1024×1024 App Store icon | **Done** — `icons/icon-1024.png` (square corners, no alpha, RGB) |
| Privacy policy page | **Done** — `privacy.html`, needs a support email filled in |
| Listing copy | **Draft below** — needs Zane's sign-off |
| Apple Developer Program ($99/yr) | Not yet — Zane signs up when all three apps are ready |
| Xcode | **Blocked** — needs ~40 GB free; Mac is at 94% |
| Capacitor native shell | Blocked on Xcode |
| Native feature for Guideline 4.2 | **Decision needed** — widget vs Live Activity |
| ESPN data layer isolation | Not started — recommended before monetizing |
| Screenshots | Deferred — generate from the Simulator once Xcode exists |

---

## Listing copy (draft)

**App name** (30 char limit)
```
Quad Box Buddy
```

**Subtitle** (30 char limit)
```
College football, ranked
```
Alternatives: `Never miss a close game` (23) · `The games worth watching` (24)

**Promotional text** (170 char, changeable without review)
```
Saturday's board, sorted by what's actually worth watching. Close games rise to the top,
upsets flash red, and blowouts sink. Built for anyone running a quad box.
```

**Description**
```
Quad Box Buddy is a college football scoreboard that answers one question: what should I be
watching right now?

Instead of a fixed list, the board constantly re-sorts itself. Live games come first, closest
games at the top, ordered by how little time is left — so the game about to be decided is
always the one you see first. Finished games drop to the bottom.

WHAT IT FLAGS

• Upset Alert — a team favored by more than a touchdown is losing in the fourth quarter
• Close Game — a one-score game inside the last six minutes
• Upset Watch — the favorite is trailing after the first quarter
• Ranked 1-Score Game — two ranked teams separated by a single score
• Comeback Watch — a big lead has been cut to within two scores
• Blowout Watch — a game the books called close that is anything but

Final scores get their own tags: Upset, Comeback Win, Close Call, and Blowout Win.

PICK YOUR GAMES

Filter by SEC, Big Ten, Big 12, ACC, Independents, the Group of 5, FCS, or Division II. Star
any game to pin it to the top, or save favorite teams and every game they play is starred
automatically, all season.

RANKINGS, YOUR WAY

Switch between the AP Poll, the Coaches Poll, the College Football Playoff rankings, Josh
Pate's JP Poll, and the SP+, FPI and Elo computer ratings. Your choice drives both the rankings
shown on each card and which games count as "ranked."

Live scores, betting lines, records, and TV channels for every FBS, FCS and Division II game.
No account. No tracking. Nothing to sign up for.

Not affiliated with ESPN, the NCAA, or any school or conference.
```

**Keywords** (100 char, comma-separated, no spaces after commas)
```
college,football,scores,ncaa,cfb,live,scoreboard,upset,saturday,rankings,spread,redzone
```

**Category:** Primary `Sports`. Secondary `News`.

**Age rating:** 4+ — but note the app displays betting lines (point spreads). Apple's
questionnaire asks about "Contests" and gambling. Spreads shown as information, with no
wagering and no link to a sportsbook, is normally 4+ — but answer the questionnaire honestly
and expect a possible 17+ if a reviewer treats spreads as gambling content.

**Support URL:** needs to exist. Simplest option is a plain page on the same GitHub Pages site.

**Privacy policy URL:** `https://zcogginwps.github.io/upset-alert/privacy.html`

**App Privacy questionnaire:** answer **Data Not Collected** for everything. True today — the
app has no analytics, no accounts, and no server. If ads are ever added this must change.

---

## Guideline 4.2 — "minimum functionality"

Apple rejects apps that are just a website in a wrapper. The web app alone will not pass.
Options, in rising order of effort:

1. **Home-screen widget (WidgetKit)** — shows the top games to watch. Apple refreshes widgets
   on its own schedule, realistically every 15–30 minutes. Self-contained, no server. This is
   the cheapest way to clear 4.2.
2. **Live Activity** (lock screen / Dynamic Island) — real-time, what the ESPN app does. Only
   updates on its own via push notifications, which means running a small server (~$5–7/month).
   Much more compelling, meaningfully more work and the first infrastructure this app needs.

Either one is Swift code sitting alongside the Capacitor shell — Capacitor cannot generate it.

---

## Guideline 4.3 — shipping NCAAF and NCAAM as separate apps

Apple's spam rule says not to create multiple Bundle IDs of the same app, and names sports as
an example. Two apps sharing most of their code with identical UI is the shape reviewers flag.
Decision (Zane, 2026-11-02): ship them as **two separate apps**, and differentiate deliberately:

- Different names and different icons (not the same icon with a different ball).
- At least one feature each the other does not have. Basketball has seeds and bracket rounds;
  football has the quad-box/TV-channel angle.
- Different subtitles and descriptions, not search-and-replace copies.

---

## The ESPN dependency

The app reads ESPN's undocumented, unlicensed public endpoints. Scores are facts and facts are
not copyrightable, but ESPN's terms prohibit automated access for commercial purposes. Free
personal use has been fine; a monetized App Store listing is more exposed. Realistic worst case
is a takedown demand that darkens the app, not a lawsuit.

**Mitigation before submitting:** put every ESPN-specific call and field name behind a single
data-layer module, so a licensed feed (CollegeFootballData's paid tier, SportsDataIO, etc.,
roughly $10–50/month at this scale) can be swapped in without touching the app's logic.

---

## Build order once Xcode exists

1. `npm install @capacitor/core @capacitor/cli && npx cap init` — point `webDir` at the repo root.
2. `npx cap add ios`, then run in the Simulator and confirm the app behaves identically.
3. Add the WidgetKit extension (or Live Activity).
4. Regenerate screenshots from the Simulator at 6.7" (1290×2796) — required sizes change, so
   check App Store Connect at the time.
5. Archive, upload, TestFlight to Zane's phone, then submit.
