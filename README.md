# Upset Alert

Personal college-football scoreboard: every game involving a Power 4 team (SEC, Big Ten,
Big 12, ACC) or Notre Dame, ordered so the games worth watching float to the top.

## Run it

Plain static files, no build step. From this folder:

```bash
python3 -m http.server 8765
```

then open http://localhost:8765. Add `?demo` to the URL to see fake live games and the
alert animations on a non-game day.

## How the board is ordered

- **Live** games first, ranked by margin tier (1–8 pts, 9–16, 17–24, …), then by least
  time left, then by raw margin.
- **Upcoming** games next: kickoff time, then smallest spread, then the better-ranked
  matchup.
- **Final** games at the bottom.

Alerts:
- **Upset alert** (blinking red): a team favored by more than 7 is trailing in the 4th
  quarter or overtime.
- **Close game** (flashing blue/green): one-score game with under 6:00 to play (or in OT).

Data is ESPN's public scoreboard feed. ESPN drops the betting line once a game ends, so the
app remembers each game's pregame spread in localStorage.
