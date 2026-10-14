"""Netron, served by the tracking server so model artifacts open in its viewer.

Netron's browser app ships inside the ``netron`` pip package, an optional
dependency: without it the routes answer 404 and everything else keeps
working. The files are served under ``/netron/``; the UI opens
``netron/index.html?url=<artifact download URL>&identifier=<file name>`` and
Netron fetches the model from this same origin.

The page is changed through switches Netron itself reads: it carries the
development version ``0.0.0`` (only release builds send telemetry), no build
date (a build dated over 180 days ago demands an update) and a ``consent``
cookie (the cookie notice concerns only that telemetry).

Sections: Files, Handlers, Routes.

Naming table: ``find_*`` locates the package, ``build_*`` rewrites the page,
``handle_*`` serves a request and ``register_*`` attaches routes.
"""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path
from typing import Callable, Optional

from flask import Flask, Response, abort, send_from_directory

# ===== Files =====

ROUTE_PREFIX = "/netron/"
# The package also holds Python modules, which are not part of the app.
SERVED_SUFFIXES = frozenset({".js", ".json", ".css", ".ico", ".png"})
_VERSION_META = re.compile(r'<meta name="version" content="[^"]*">')
_DATE_META = re.compile(r'<meta name="date" content="[^"]*">\n?')


def find_netron_directory() -> Optional[Path]:
    """Return the installed ``netron`` package directory, or None if it is not installed."""
    spec = importlib.util.find_spec("netron")
    if spec is None or spec.origin is None:
        return None
    return Path(spec.origin).parent


def build_index(html: str) -> str:
    """Mark Netron's page as a development build without a build date."""
    html = _VERSION_META.sub('<meta name="version" content="0.0.0">', html)
    return _DATE_META.sub("", html)


# ===== Handlers =====


def handle_netron_index() -> Response:
    """Serve Netron's page with telemetry, the update demand and the cookie notice off."""
    from mlflow.server.handlers import _add_static_prefix

    directory = find_netron_directory()
    if directory is None:
        abort(404, "netron is not installed in the tracking server environment")
    html = build_index((directory / "index.html").read_text(encoding="utf-8"))
    response = Response(html, mimetype="text/html")
    response.headers["Cache-Control"] = "no-cache"
    response.set_cookie(
        "consent", "1", max_age=10 * 365 * 24 * 3600, path=_add_static_prefix(ROUTE_PREFIX)
    )
    return response


def handle_netron_file(path: str) -> Response:
    """Serve one script, stylesheet, metadata file or icon of the app."""
    directory = find_netron_directory()
    if directory is None or Path(path).suffix not in SERVED_SUFFIXES:
        abort(404)
    return send_from_directory(directory, path)


# ===== Routes =====

ROUTES: tuple[tuple[str, Callable[..., Response]], ...] = (
    (ROUTE_PREFIX, handle_netron_index),
    (ROUTE_PREFIX + "index.html", handle_netron_index),
    (ROUTE_PREFIX + "<path:path>", handle_netron_file),
)


def register_netron_routes(app: Flask) -> None:
    """Attach the Netron app routes below the server's static prefix.

    Args:
        app: The MLflow tracking server application.
    """
    from mlflow.server.handlers import _add_static_prefix

    for path, handler in ROUTES:
        app.add_url_rule(
            _add_static_prefix(path),
            handler.__name__,
            handler,
            methods=["GET"],
        )
