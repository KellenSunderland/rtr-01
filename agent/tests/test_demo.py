from argus.demo import run_demo


async def test_demo_pickleball():
    lines = []
    r = await run_demo("pickleball_referee", out=lines.append)
    assert r.state["score"] == {"A": 6, "B": 6} and r.state["serving_team"] == "B"
    assert any(e["type"] == "state.snapshot" for e in r.events)
    assert r.sanitized == 1 and r.metrics.total("argus_observations_dropped_total") >= 1
    roles = [x[0] for x in r.transcript]
    assert roles.count("you") == 4 and roles.count("you (voice)") == 1 and roles.count("argus") == 5
    assert any("transcript" in ln for ln in lines)
    ids = [m["utterance_id"] for m in r.messages if m["type"] == "assistant.text" and m["final"]]
    assert ids == [f"u-{i}" for i in range(1, 6)]


async def test_demo_home_monitor():
    r = await run_demo("home_monitor", out=lambda _: None)
    types = [e["type"] for e in r.events]
    assert types == ["person.at_door", "person.entered", "dog.eating", "dog.sleeping", "package.delivered"]
    assert any("Brown" in t or "brown" in t for role, t in r.transcript if role == "argus")
