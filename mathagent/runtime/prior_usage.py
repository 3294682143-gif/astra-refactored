"""Read-only frozen reservations for expired same-host/same-boot ledgers.

This is a finite-run integration guard, not an automatic provider-wide discovery
service. The runner must inventory all earlier ledgers and serialize participating
sessions. Expired prior runs cannot dispatch under their original coordinator;
their unknown permits are conservatively reserved for the entire new batch.
"""

from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path

from .adapter import RequestNotDispatched
from .config import fingerprint


@dataclass(frozen=True)
class PriorLedger:
    path: str
    run_fingerprint: str
    unknown: tuple[str, ...]


def read_prior(path, *, boot, now):
    path = Path(path).resolve(strict=True)
    db = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=1)
    db.row_factory = sqlite3.Row
    try:
        db.execute("BEGIN")
        runs = [dict(row) for row in db.execute("SELECT * FROM runs ORDER BY id")]
        if not runs or any(row["boot"] != boot for row in runs):
            raise ValueError("prior ledger is not expired under the same boot")
        has_stops = db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='dispatch_stops'"
        ).fetchone()
        for row in runs:
            if row["deadline"] > now and not (
                has_stops
                and db.execute(
                    "SELECT 1 FROM dispatch_stops WHERE run=? AND item='' AND reason IN "
                    "('RUN_FINISHED','EVALUATION_FAILED','DIAGNOSTIC_FAILED','DIAGNOSTIC_COMPLETE','USER_AUTHORIZED_RETIREMENT')",
                    (row["id"],),
                ).fetchone()
            ):
                raise ValueError(
                    "prior ledger is neither expired nor explicitly retired"
                )
        unknown = tuple(
            row[0]
            for row in db.execute(
                "SELECT id FROM requests WHERE status='IN_FLIGHT' ORDER BY id"
            )
        )
        # Request settlements may legitimately change; run identity/calls/deadline may not.
        return PriorLedger(str(path), fingerprint(runs), unknown)
    finally:
        db.close()


class PriorUsage:
    def __init__(self, paths, *, boot=None, clock=time.monotonic):
        self.boot = (
            boot
            or Path("/proc/sys/kernel/random/boot_id")
            .read_text(encoding="utf-8")
            .strip()
        )
        self.clock = clock
        unique = {}
        for path in paths:
            resolved = Path(path).resolve(strict=True)
            stat = resolved.stat()
            unique.setdefault((stat.st_dev, stat.st_ino), resolved)
        self.ledgers = tuple(
            read_prior(path, boot=self.boot, now=clock())
            for path in sorted(unique.values())
        )
        self.reserved = sum(len(row.unknown) for row in self.ledgers)
        if self.reserved >= 8:
            raise ValueError("prior unknown requests leave no safe API capacity")

    def validate(self):
        for frozen in self.ledgers:
            actual = read_prior(frozen.path, boot=self.boot, now=self.clock())
            if actual.run_fingerprint != frozen.run_fingerprint or not set(
                actual.unknown
            ) <= set(frozen.unknown):
                raise ValueError("prior run changed or gained uncertain requests")

    def wrap(self, client):
        usage = self

        class GuardedClient:
            model = getattr(client, "model", None)

            def chat(self, **kwargs):
                try:
                    usage.validate()
                except Exception:  # noqa: BLE001 - prove this local invocation was not dispatched
                    raise RequestNotDispatched() from None
                return client.chat(**kwargs)

        return GuardedClient()
