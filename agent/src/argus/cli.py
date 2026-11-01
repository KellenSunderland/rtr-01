"""``argus`` command line."""

from __future__ import annotations

import asyncio
import ipaddress
from pathlib import Path
from typing import Annotated

import typer

from argus.settings import Settings, setup_logging

app = typer.Typer(no_args_is_help=True, help="Argus agent service.")
packs_app = typer.Typer(no_args_is_help=True, help="Scenario packs.")
app.add_typer(packs_app, name="packs")


def _is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


@app.command()
def serve(
    host: Annotated[
        str, typer.Option(help="Bind address (internal endpoints: keep on localhost).")
    ] = "127.0.0.1",
    port: int = 8090,
    providers: Annotated[
        Path | None, typer.Option(help="providers.yaml path (default: env ARGUS_PROVIDERS)")
    ] = None,
    db: Annotated[str | None, typer.Option(help="memory.db path (default: env ARGUS_DB)")] = None,
) -> None:
    """Run the agent (internal session WS + /v1/scenarios + /v1/history + /metrics)."""
    import uvicorn

    from argus.app import create_app

    s = Settings.from_env()
    if providers:
        s.providers_path = str(providers)
    if db:
        s.db_path = db
    setup_logging(s.log_level)
    if not _is_loopback(host) and not s.internal_token:
        raise typer.BadParameter("refusing to bind a non-loopback address without ARGUS_INTERNAL_TOKEN")
    uvicorn.run(create_app(s), host=host, port=port, ws_max_size=256 * 1024, log_config=None)


@packs_app.command("list")
def packs_list() -> None:
    """List discovered scenario packs (and any that failed validation)."""
    from argus.scenarios.registry import PackRegistry

    reg = PackRegistry()
    for p in reg.all():
        typer.echo(
            f"{p.name}\tv{p.version}\t{len(p.event_types)} event types\ttools={','.join(p.tool_names()) or '-'}\t{p.description}"
        )
    for name, err in reg.errors.items():
        typer.echo(f"{name}\tINVALID\t{err}", err=True)


@app.command()
def demo(pack: str = "pickleball_referee") -> None:
    """Run a full session against pack fixtures (no gateway) and print the transcript."""
    from argus.demo import run_demo

    asyncio.run(run_demo(pack))


if __name__ == "__main__":
    app()
