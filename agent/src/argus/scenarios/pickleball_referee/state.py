"""Pickleball scoring state machine (simplified rules, documented).

Rules implemented
-----------------
* Rally scoring: every ``point.won {team}`` scores for that team (no side-out-only scoring).
* Game to 11, win by 2; match is best of 3 games.
* Serve rotation (two-server rule): the serving team keeps serving while it wins rallies. When the
  serving team loses a rally, server 1 -> server 2 of the same team; server 2 -> side-out (other team
  serves as server 1). First-server exception: the team serving at the start of a game starts as
  server 2, so its first lost rally is an immediate side-out.
* The team that did not serve first in the previous game serves first in the next game.
* Side switch: teams swap ends between games, and in game 3 once when the first team reaches 6 points.
  (Real-rules mid-game switching details such as left/right court position of individual players are
  not modelled.)
* ``rally.start`` may carry ``server_team``; if it disagrees with the tracked server, the observation
  wins (the camera sees the actual server) and server number resets to 1.
* Faults (``fault.kitchen``, ``fault.serve``) are recorded but do not score by themselves; the vision
  model emits a ``point.won`` for the fault's opponent.
"""

from __future__ import annotations

from typing import Any

from argus.protocol import SceneEvent
from argus.scenarios.base import ScenarioState

TARGET = 11
WIN_BY = 2
GAMES_TO_WIN = 2
DECIDER_SWITCH_AT = 6


def other(team: str) -> str:
    return "B" if team == "A" else "A"


class State(ScenarioState):
    def __init__(self) -> None:
        self.game = 1
        self.score = {"A": 0, "B": 0}
        self.games = {"A": 0, "B": 0}
        self.first_server = "A"  # team that served first this game
        self.serving = "A"
        self.server_num = 2  # first-server exception: starts as server 2
        self.sides = {"A": "near", "B": "far"}
        self.switched_this_game = False
        self.side_switches = 0
        self.match_winner: str | None = None
        self.last_point: dict[str, Any] | None = None
        self.last_fault: dict[str, Any] | None = None
        self.last_bounce: dict[str, Any] | None = None
        self.rally_active = False
        self.history: list[dict[str, Any]] = []
        self.ignored = 0

    def apply(self, event: SceneEvent) -> None:
        if self.match_winner is not None:
            return
        t = event.type
        a = event.attrs
        if t == "rally.start":
            self.rally_active = True
            st = a.get("server_team")
            if st in ("A", "B") and st != self.serving:
                self.serving, self.server_num = st, 1
        elif t == "ball.bounce":
            self.last_bounce = {
                "court_side": a.get("court_side"),
                "in_bounds": a.get("in_bounds"),
                "ts_ms": event.ts_ms,
            }
        elif t in ("fault.kitchen", "fault.serve"):
            self.last_fault = {"type": t, "team": a.get("team"), "ts_ms": event.ts_ms}
        elif t == "point.won":
            team = a.get("team")
            if team in ("A", "B"):
                self._award(team, event)
            else:
                self.ignored += 1

    def _award(self, team: str, event: SceneEvent) -> None:
        self.rally_active = False
        server_before = (self.serving, self.server_num)
        self.score[team] += 1
        if team != self.serving:  # serving team lost the rally -> rotate
            if self.server_num == 1:
                self.server_num = 2
            else:
                self.serving, self.server_num = other(self.serving), 1
        self.last_point = {
            "team": team,
            "game": self.game,
            "score": dict(self.score),
            "ts_ms": event.ts_ms,
            "server_before": {"team": server_before[0], "server_number": server_before[1]},
            "reason": self.last_fault["type"]
            if self.last_fault and self.last_fault.get("ts_ms", -1) >= event.ts_ms - 15000
            else None,
        }
        self.history.append(self.last_point)
        if self._game_won(team):
            self.games[team] += 1
            if self.games[team] >= GAMES_TO_WIN:
                self.match_winner = team
                return
            self.game += 1
            self.score = {"A": 0, "B": 0}
            self.first_server = other(self.first_server)
            self.serving, self.server_num = self.first_server, 2
            self.sides = {"A": self.sides["B"], "B": self.sides["A"]}
            self.side_switches += 1
            self.switched_this_game = False
        elif self.game == 3 and not self.switched_this_game and max(self.score.values()) >= DECIDER_SWITCH_AT:
            self.sides = {"A": self.sides["B"], "B": self.sides["A"]}
            self.side_switches += 1
            self.switched_this_game = True

    def _game_won(self, team: str) -> bool:
        return self.score[team] >= TARGET and self.score[team] - self.score[other(team)] >= WIN_BY

    def snapshot(self) -> dict[str, Any]:
        return {
            "game": self.game,
            "score": dict(self.score),
            "games_won": dict(self.games),
            "serving_team": self.serving,
            "server_number": self.server_num,
            "sides": dict(self.sides),
            "side_switches": self.side_switches,
            "match_winner": self.match_winner,
            "rally_active": self.rally_active,
            "last_point": self.last_point,
            "last_fault": self.last_fault,
            "last_bounce": self.last_bounce,
        }
