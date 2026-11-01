import uuid

from argus.protocol import SceneEvent
from argus.scenarios.pickleball_referee.state import State  # noqa: F401  (builtin path import)


def ev(t, ts=0, **attrs):
    return SceneEvent(
        id=str(uuid.uuid4()),
        stream_id="c",
        ts_ms=ts,
        wall_ms=ts,
        type=t,
        confidence=1,
        summary="x",
        scenario="pickleball_referee",
        attrs=attrs,
    )


def win(s, team, n=1):
    for _ in range(n):
        s.apply(ev("point.won", team=team))


def test_initial_first_server_exception():
    s = State()
    assert (s.serving, s.server_num) == ("A", 2)
    win(s, "B")  # server (A, #2 at game start) loses -> immediate side out
    assert (s.serving, s.server_num, s.score) == ("B", 1, {"A": 0, "B": 1})


def test_serve_rotation_two_server_rule():
    s = State()
    win(s, "A", 2)  # serving team scores, keeps serve
    assert (s.serving, s.server_num) == ("A", 2)
    win(s, "B")  # side out to B server 1
    win(s, "A")  # B server1 loses -> B server 2
    assert (s.serving, s.server_num) == ("B", 2)
    win(s, "A")  # B server 2 loses -> side out to A server 1
    assert (s.serving, s.server_num) == ("A", 1)
    win(s, "B")  # A server 1 loses -> A server 2
    assert (s.serving, s.server_num) == ("A", 2)


def test_win_by_two_and_match():
    s = State()
    win(s, "A", 10)
    win(s, "B", 10)
    win(s, "A")  # 11-10 not enough
    assert s.games == {"A": 0, "B": 0} and s.game == 1
    win(s, "B")  # 11-11
    win(s, "B")  # 11-12
    assert s.game == 1
    win(s, "B")  # 11-13 -> B wins game 1
    assert s.games == {"A": 0, "B": 1} and s.game == 2 and s.score == {"A": 0, "B": 0}
    assert s.first_server == "B" and (s.serving, s.server_num) == ("B", 2)
    assert s.sides == {"A": "far", "B": "near"}  # swapped between games
    win(s, "B", 11)
    assert s.match_winner == "B" and s.games["B"] == 2
    before = s.snapshot()
    win(s, "A")
    assert s.snapshot() == before  # match over: ignored


def test_side_switch_at_6_in_game_3_only():
    s = State()
    win(s, "A", 11)  # game 1
    win(s, "B", 11)  # game 2
    assert s.game == 3 and s.side_switches == 2
    sides = dict(s.sides)
    win(s, "A", 5)
    assert s.sides == sides
    win(s, "A")
    assert s.sides != sides and s.side_switches == 3
    win(s, "B", 6)  # second team reaching 6 does not switch again
    assert s.side_switches == 3
    # game 1 never switches mid-game
    g1 = State()
    win(g1, "A", 7)
    assert g1.side_switches == 0


def test_attrs_and_faults():
    s = State()
    s.apply(ev("rally.start", server_team="B"))
    assert (s.serving, s.server_num) == ("B", 1)
    s.apply(ev("ball.bounce", court_side="A", in_bounds=False))
    s.apply(ev("fault.kitchen", ts=5000, team="B"))
    s.apply(ev("point.won", ts=6000, team="A"))
    snap = s.snapshot()
    assert snap["last_point"]["reason"] == "fault.kitchen" and snap["last_bounce"]["in_bounds"] is False
    s.apply(ev("point.won", team="Z"))
    assert s.ignored == 1 and s.score == {"A": 1, "B": 0}
    s.apply(ev("point.won", ts=9000, team="B", reason="double_bounce"))
    assert s.snapshot()["last_point"]["reason"] == "double_bounce"
