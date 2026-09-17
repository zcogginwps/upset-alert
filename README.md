# Quad Box Buddy (QBB)

Personal college-football scoreboard covering FBS, FCS and Division II, ordered so the games
worth watching float to the top. Filter chips: Favorites, Top 25, SEC, Big Ten, Big 12,
ACC, Independents (Notre Dame, UConn), other FBS, FCS, Div 2. Favorites + Top 25 + Power 4 are
on by default. The Top 25 chip and the rank numbers on cards follow the poll picked under the
chips (AP, Coaches, or CFP once the committee rankings begin).

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
- **Upcoming** games next: starred games first, then kickoff time, smallest spread, and the
  better-ranked matchup.
- **Final** games at the bottom, starred games first.

Alerts:
- **Upset alert** (red pulse): a team favored by more than 7 is trailing in the 4th
  quarter or overtime.
- **Close game** (blue pulse): one-score game with under 6:00 to play (or in OT).
- **Comeback watch** (yellow pulse): a lead has shrunk by 16+ points and the game is now
  within 16. Drops off if the margin climbs back above the closest tier it reached.
- Two alerts at once fade between both colors; three fall back to upset + close. New games
  sit at the bottom of Live for their first two minutes; games whose clock reads 0:00 or
  15:00 hold their spot through ESPN's quarter-break glitches.

Data is ESPN's public scoreboard feed. ESPN drops the betting line once a game ends, so the
app remembers each game's pregame spread in localStorage.
