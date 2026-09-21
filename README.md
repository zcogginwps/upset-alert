# Quad Box Buddy (QBB)

Personal college-football scoreboard covering FBS, FCS and Division II, ordered so the games
worth watching float to the top. Filter chips: Favorites, Top 25, SEC, Big Ten, Big 12,
ACC, Independents (Notre Dame, UConn), G5, FCS, Div 2. Favorites + Top 25 + Power 4 are
on by default. Hold the Top 25 chip to pick the poll (AP, Coaches, or CFP once the committee
rankings begin); it drives both the filter and the rank numbers on cards.

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

Alerts (flash):
- **Upset alert** (red pulse): a team favored by more than 7 is trailing in the 4th quarter
  or overtime.
- **Close game** (blue pulse): one-score game with under 6:00 to play (or in OT).
- Both at once fade between the two colors.

Watches (soft colored edge, no flash; one color per card in this priority, all badges shown):
1. **Upset watch** (red): favorite by more than 7 trailing any time after the 1st quarter.
2. **Good game watch** (blue): one-score game, both teams ranked, after the 1st quarter.
3. **Comeback watch** (green): a lead has shrunk by 16+ points and the game is within 16;
   drops off if the margin climbs back above the closest tier it reached.
4. **Blowout watch** (yellow): the line was 7 or less and someone is up three scores or more.

Finals get the same treatment: **Upset** (red, an underdog of 7+ won), **Comeback win**
(green, the winner trailed by 3+ scores), **Close call** (blue, a favorite of 3+ scores won by
one score), **Blowout win** (yellow, won by 3+ score-tiers more than the line projected), in
that priority.

Flashing alerts override any edge tint. **Delayed** games (weather etc.) get an orange ring, no
flash, and drop to the bottom of Live. New games sit at the bottom of Live for their first
five minutes; games whose clock reads 0:00 or 15:00 hold their spot through ESPN's
quarter-break glitches.

Data is ESPN's public scoreboard feed. ESPN drops the betting line once a game ends, so the
app remembers each game's pregame spread in localStorage.
