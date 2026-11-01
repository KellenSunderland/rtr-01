"""Pickleball pack tools."""

from __future__ import annotations

from typing import Any

from argus.scenarios.base import ScenarioTool, ToolContext


async def current_score(ctx: ToolContext, **_: Any) -> str:
    s = ctx.snapshot()
    sc = s["score"]
    txt = (
        f"Game {s['game']}: A {sc['A']} - B {sc['B']}. Serving: team {s['serving_team']}, "
        f"server {s['server_number']}. Games won A {s['games_won']['A']} - B {s['games_won']['B']}. "
        f"Team A is on the {s['sides']['A']} side."
    )
    if s["match_winner"]:
        txt += f" Match won by team {s['match_winner']}."
    return txt


async def last_point(ctx: ToolContext, **_: Any) -> str:
    lp = ctx.snapshot().get("last_point")
    if not lp:
        return "No point has been played yet."
    why = f" (after {lp['reason']})" if lp.get("reason") else ""
    return (
        f"Team {lp['team']} won the last point{why} at {lp['ts_ms'] // 1000}s, making it "
        f"A {lp['score']['A']} - B {lp['score']['B']} in game {lp['game']}."
    )


TOOLS = [
    ScenarioTool(
        name="current_score",
        description="Current score, serving team/server number, games won and court sides.",
        input_schema={"type": "object", "properties": {}, "additionalProperties": False},
        handler=current_score,
    ),
    ScenarioTool(
        name="last_point",
        description="Who won the most recent point, the resulting score and any fault that caused it.",
        input_schema={"type": "object", "properties": {}, "additionalProperties": False},
        handler=last_point,
    ),
]
