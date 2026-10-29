"""Same-host, same-boot transactional coordination; no TTL release of live work."""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from .config import Limits

_PATH_LOCKS = {}
_PATH_LOCK_GUARD = threading.Lock()


class AdmissionError(RuntimeError):
    @property
    def code(self):
        text = str(self).lower()
        if "budget" in text or "ceiling" in text:
            return "LOGICAL_BUDGET_EXHAUSTED"
        if "deadline" in text:
            return "DEADLINE_EXCEEDED"
        if "capacity" in text or "slots" in text:
            return "WAITING_CAPACITY"
        if "one-shot" in text:
            return "ONCE_ALREADY_SPENT"
        if "stopped" in text:
            return "DISPATCH_STOPPED"
        return "ADMISSION_UNAVAILABLE"


class DeadlineExceeded(AdmissionError):
    pass


@dataclass(frozen=True)
class Item:
    id: str
    started: float
    deadline: float


@dataclass(frozen=True)
class Lease:
    id: str
    item_id: str
    deadline: float
    kind: str


SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
 id TEXT PRIMARY KEY, boot TEXT NOT NULL, version TEXT NOT NULL, config TEXT NOT NULL,
 started REAL NOT NULL, wall REAL NOT NULL, deadline REAL NOT NULL,
 calls INTEGER NOT NULL DEFAULT 0, cooldown REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS items (
 id TEXT PRIMARY KEY, run TEXT NOT NULL REFERENCES runs(id), item_key TEXT NOT NULL,
 problem_hash TEXT NOT NULL, started REAL NOT NULL, deadline REAL NOT NULL,
 status TEXT NOT NULL, final TEXT, snapshot TEXT, reserved INTEGER NOT NULL DEFAULT 2,
 owner_pid INTEGER NOT NULL DEFAULT 0,
 UNIQUE(run,item_key));
CREATE TABLE IF NOT EXISTS requests (
 id TEXT PRIMARY KEY, run TEXT NOT NULL REFERENCES runs(id), item TEXT NOT NULL REFERENCES items(id),
 kind TEXT NOT NULL, dispatched REAL NOT NULL, settled REAL, status TEXT NOT NULL,
 outcome TEXT, owner_pid INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS queue (
 ticket INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
 run TEXT NOT NULL, item TEXT NOT NULL, priority INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS once_flags (
 item TEXT NOT NULL REFERENCES items(id), flag TEXT NOT NULL, request TEXT,
 PRIMARY KEY(item,flag));
CREATE INDEX IF NOT EXISTS request_active ON requests(run,status,item);
CREATE TABLE IF NOT EXISTS dispatch_stops (
 run TEXT NOT NULL, item TEXT NOT NULL, reason TEXT NOT NULL,
 PRIMARY KEY(run,item));
CREATE TABLE IF NOT EXISTS public_dispatches (
 request TEXT PRIMARY KEY REFERENCES requests(id), started REAL NOT NULL);
CREATE TABLE IF NOT EXISTS run_call_caps (
 run TEXT PRIMARY KEY REFERENCES runs(id), ceiling INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS request_observers (
 request TEXT PRIMARY KEY REFERENCES requests(id) ON UPDATE CASCADE, active INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS run_public_totals (
 run TEXT PRIMARY KEY REFERENCES runs(id), total INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS item_final_receipts (
 item TEXT PRIMARY KEY REFERENCES items(id), saved_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS provider_policies (run TEXT PRIMARY KEY REFERENCES runs(id), policy TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS provider_admissions (
 request TEXT PRIMARY KEY REFERENCES requests(id), run TEXT NOT NULL, at REAL NOT NULL, tokens INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS provider_window ON provider_admissions(run,at);
CREATE TABLE IF NOT EXISTS request_facts (
 request TEXT NOT NULL REFERENCES requests(id), fact TEXT NOT NULL,
 value INTEGER NOT NULL, at REAL NOT NULL, PRIMARY KEY(request,fact));
CREATE TABLE IF NOT EXISTS request_profiles (run TEXT PRIMARY KEY REFERENCES runs(id), profile TEXT NOT NULL);
"""


class GlobalCoordinator:
    def __init__(
        self,
        path: str | Path,
        run_id: str,
        *,
        limits=None,
        version="development",
        clock=time.monotonic,
        wall=time.time,
        boot_id=None,
        started=None,
        wall_started=None,
        generation_margin=0,
        known_total=None,
        provider_rate_policy=None,
    ):
        if not run_id or not run_id.strip():
            raise ValueError("explicit shared run_id required")
        self.path = Path(path)
        with _PATH_LOCK_GUARD:
            self._thread_lock = _PATH_LOCKS.setdefault(
                str(self.path.resolve()), threading.RLock()
            )
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.run_id, self.limits, self.clock = run_id, limits or Limits(), clock
        if not 0 <= generation_margin < self.limits.problem_seconds:
            raise ValueError("invalid generation save margin")
        self.generation_margin = generation_margin
        self.boot = (
            boot_id
            or Path("/proc/sys/kernel/random/boot_id")
            .read_text(encoding="utf-8")
            .strip()
        )
        with self._thread_lock, self._connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript(SCHEMA)
            if "owner_pid" not in {
                r[1] for r in db.execute("PRAGMA table_info(items)")
            }:
                db.execute(
                    "ALTER TABLE items ADD COLUMN owner_pid INTEGER NOT NULL DEFAULT 0"
                )
        db.close()
        with self.transaction() as db:
            now = clock()
            db.execute(
                "INSERT OR IGNORE INTO runs(id,boot,version,config,started,wall,deadline) "
                "VALUES(?,?,?,?,?,?,?)",
                (
                    run_id,
                    self.boot,
                    version,
                    self.limits.digest,
                    now if started is None else started,
                    wall() if wall_started is None else wall_started,
                    (now if started is None else started) + self.limits.run_seconds,
                ),
            )
            row = db.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
            if (row["boot"], row["version"], row["config"]) != (
                self.boot,
                version,
                self.limits.digest,
            ):
                raise AdmissionError(
                    "run identity/version/boot/config mismatch; never reset an existing run"
                )
            if started is not None and row["started"] != started:
                raise AdmissionError("original run start mismatch")
            if wall_started is not None and row["wall"] != wall_started:
                raise AdmissionError("original run wall start mismatch")
            from .provider_rate import validate_policy

            if provider_rate_policy is not None:
                if (
                    row["calls"]
                    and not db.execute(
                        "SELECT 1 FROM provider_policies WHERE run=?", (run_id,)
                    ).fetchone()
                ):
                    raise AdmissionError(
                        "provider policy cannot be retrofitted after dispatch"
                    )
                policy = json.dumps(
                    validate_policy(provider_rate_policy), sort_keys=True
                )
                db.execute(
                    "INSERT OR IGNORE INTO provider_policies VALUES(?,?)",
                    (run_id, policy),
                )
            saved_policy = db.execute(
                "SELECT policy FROM provider_policies WHERE run=?", (run_id,)
            ).fetchone()
            self.provider_rate_policy = (
                json.loads(saved_policy[0]) if saved_policy else None
            )
            if (
                provider_rate_policy is not None
                and self.provider_rate_policy != provider_rate_policy
            ):
                raise AdmissionError("frozen provider rate policy changed")
            if known_total is not None:
                if type(known_total) is not int or known_total < 1:
                    raise ValueError("positive frozen public total required")
                db.execute(
                    "INSERT OR IGNORE INTO run_public_totals VALUES(?,?)",
                    (run_id, known_total),
                )
                if (
                    db.execute(
                        "SELECT total FROM run_public_totals WHERE run=?", (run_id,)
                    ).fetchone()[0]
                    != known_total
                ):
                    raise AdmissionError("frozen public total changed")

    def _connect(self):
        db = sqlite3.connect(self.path, timeout=5, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA busy_timeout=5000")
        db.execute("PRAGMA synchronous=FULL")
        return db

    @contextmanager
    def transaction(self):
        with self._thread_lock:
            db = self._connect()
            try:
                db.execute("BEGIN IMMEDIATE")
                yield db
                db.execute("COMMIT")
            except BaseException:
                db.execute("ROLLBACK")
                raise
            finally:
                db.close()

    def register_item(
        self, item_key: str, problem_hash: str, *, started=None
    ) -> tuple[Item, dict | None]:
        """Clock starts before local admission. Duplicate active lifecycles fail closed."""
        with self.transaction() as db:
            run = db.execute("SELECT * FROM runs WHERE id=?", (self.run_id,)).fetchone()
            previous = db.execute(
                "SELECT * FROM items WHERE run=? AND item_key=?",
                (self.run_id, item_key),
            ).fetchone()
            if previous:
                if previous["problem_hash"] != problem_hash:
                    raise AdmissionError("same item identity with changed problem")
                if previous["final"] is not None:
                    return Item(
                        previous["id"], previous["started"], previous["deadline"]
                    ), json.loads(previous["final"])
                raise AdmissionError(
                    "active/interrupted item requires explicit recovery, not a second solve"
                )
            # A committed final is a read, not dispatch. Identity is checked
            # first; stops still forbid every path that could create new work.
            self._check_dispatch_stop(db)
            now = self.clock()
            if now >= run["deadline"]:
                raise DeadlineExceeded("run deadline")
            began = now if started is None else min(started, now)
            item = Item(
                uuid.uuid4().hex,
                began,
                min(began + self.limits.problem_seconds, run["deadline"]),
            )
            db.execute(
                "INSERT INTO items(id,run,item_key,problem_hash,started,deadline,status) "
                "VALUES(?,?,?,?,?,?,'WAITING')",
                (
                    item.id,
                    self.run_id,
                    item_key,
                    problem_hash,
                    item.started,
                    item.deadline,
                ),
            )
            db.execute(
                "UPDATE items SET owner_pid=? WHERE id=?", (os.getpid(), item.id)
            )
            return item, None

    def recover_item(self, item_key: str, problem_hash: str):
        """Explicit recovery only: dead local owner and zero uncertain/live requests.

        A running provider may outlive a process. No live permit is ever reclaimed
        by this operation, and the original start/deadline/once flags survive.
        """
        with self.transaction() as db:
            row = db.execute(
                "SELECT * FROM items WHERE run=? AND item_key=?",
                (self.run_id, item_key),
            ).fetchone()
            if row is None or row["problem_hash"] != problem_hash:
                raise AdmissionError("missing or mismatched recovery item")
            item = Item(row["id"], row["started"], row["deadline"])
            if row["final"] is not None:
                return item, json.loads(row["final"]), None
            active = db.execute(
                "SELECT COUNT(*) FROM requests WHERE item=? AND status='IN_FLIGHT'",
                (item.id,),
            ).fetchone()[0]
            if active:
                raise AdmissionError(
                    "cannot recover while remote work is uncertain/in flight"
                )
            try:
                os.kill(row["owner_pid"], 0)
            except ProcessLookupError:
                pass
            else:
                raise AdmissionError("previous solve owner still exists")
            db.execute(
                "UPDATE items SET owner_pid=? WHERE id=?", (os.getpid(), item.id)
            )
            return item, None, json.loads(row["snapshot"]) if row["snapshot"] else None

    def admit_item(self, item: Item, *, wait=True):
        while True:
            with self.transaction() as db:
                now = self.clock()
                row = self._item(db, item.id)
                self._check_dispatch_stop(db, item.id)
                if now >= row["deadline"]:
                    raise DeadlineExceeded("item admission deadline")
                if row["status"] == "OPEN":
                    return
                if row["status"] != "WAITING":
                    raise AdmissionError("closed item")
                count = db.execute(
                    "SELECT COUNT(*) FROM items WHERE run=? AND status='OPEN'",
                    (self.run_id,),
                ).fetchone()[0]
                first = db.execute(
                    "SELECT id FROM items WHERE run=? AND status='WAITING' "
                    "ORDER BY started,id LIMIT 1",
                    (self.run_id,),
                ).fetchone()
                if count < self.limits.problems and first[0] == item.id:
                    db.execute("UPDATE items SET status='OPEN' WHERE id=?", (item.id,))
                    return
            if not wait:
                raise AdmissionError("problem slots busy")
            time.sleep(0.01)

    def _item(self, db, item_id):
        row = db.execute(
            "SELECT * FROM items WHERE id=? AND run=?", (item_id, self.run_id)
        ).fetchone()
        if row is None:
            raise AdmissionError("item belongs to another run")
        return row

    def _logical_capacity(self, db, run, *, final=False):
        reserved = db.execute(
            "SELECT COALESCE(SUM(reserved),0) FROM items WHERE run=? "
            "AND status IN ('WAITING','OPEN','DRAINING')",
            (self.run_id,),
        ).fetchone()[0]
        phase = db.execute(
            "SELECT ceiling FROM run_call_caps WHERE run=?", (self.run_id,)
        ).fetchone()
        ceiling = min(
            self.limits.logical_requests,
            phase[0] if phase else self.limits.logical_requests,
        )
        threshold = ceiling - (0 if final else reserved)
        total = db.execute(
            "SELECT total FROM run_public_totals WHERE run=?", (self.run_id,)
        ).fetchone()
        future = 0
        if total:
            begun = db.execute(
                "SELECT COUNT(*) FROM items WHERE run=? AND item_key NOT LIKE 'diagnostic:%'",
                (self.run_id,),
            ).fetchone()[0]
            future = 2 * max(0, total[0] - begun)
            threshold = min(
                threshold,
                self.limits.logical_requests - future - (0 if final else reserved),
            )
        return {
            "logical_remaining": max(0, self.limits.logical_requests - run["calls"]),
            "effective_remaining": max(0, threshold - run["calls"]),
            "phase_ceiling": ceiling,
            "protected_closeout": reserved,
            "protected_future": future,
        }

    def scheduling_capacity(self, item, *, deadline=None, final=False):
        """Read-only planning view; acquire rechecks atomically at dispatch."""
        with self.transaction() as db:
            row = self._item(db, item.id)
            run = db.execute("SELECT * FROM runs WHERE id=?", (self.run_id,)).fetchone()
            capacity = self._logical_capacity(db, run, final=final)
            reason = None
            try:
                self._check_dispatch_stop(db, item.id)
            except AdmissionError as exc:
                reason = exc.code
            if row["status"] != "OPEN":
                reason = "ITEM_NOT_OPEN"
            end = min(
                row["deadline"],
                run["deadline"],
                self.generation_cutoff(item),
                deadline if deadline is not None else item.deadline,
            )
            if self.clock() >= end:
                reason = "ORIGINAL_DEADLINE"
            if reason:
                capacity["effective_remaining"] = 0
            return {**capacity, "reason": reason, "reserves_lease": False}

    def acquire(
        self,
        item: Item,
        kind: str,
        *,
        deadline=None,
        once=None,
        final=False,
        wait=True,
        priority=10,
        reserved_tokens=None,
    ) -> Lease:
        request_id = uuid.uuid4().hex
        if self.provider_rate_policy is not None and (
            type(reserved_tokens) is not int
            or not 1
            <= reserved_tokens
            <= self.provider_rate_policy["tokens_per_minute"]
        ):
            raise AdmissionError(
                "valid bounded token reservation required before provider dispatch"
            )
        deadline = min(
            deadline if deadline is not None else item.deadline,
            self.generation_cutoff(item),
        )
        with self.transaction() as db:
            self._item(db, item.id)
            db.execute(
                "INSERT INTO queue(id,run,item,priority) VALUES(?,?,?,?)",
                (request_id, self.run_id, item.id, priority),
            )
        try:
            while True:
                with self.transaction() as db:
                    now = self.clock()
                    row = self._item(db, item.id)
                    self._check_dispatch_stop(db, item.id)
                    run = db.execute(
                        "SELECT * FROM runs WHERE id=?", (self.run_id,)
                    ).fetchone()
                    if now >= min(deadline, row["deadline"], run["deadline"]):
                        raise DeadlineExceeded("dispatch deadline")
                    if row["status"] != "OPEN":
                        raise AdmissionError("item is not open")
                    if (
                        once
                        and db.execute(
                            "SELECT 1 FROM once_flags WHERE item=? AND flag=?",
                            (item.id, once),
                        ).fetchone()
                    ):
                        raise AdmissionError("one-shot generation already attempted")
                    if (
                        self._logical_capacity(db, run, final=final)[
                            "effective_remaining"
                        ]
                        <= 0
                    ):
                        raise AdmissionError(
                            "logical budget exhausted or reserved for closeout"
                        )
                    active = dict(
                        db.execute(
                            "SELECT item,COUNT(*) FROM requests WHERE run=? "
                            "AND status='IN_FLIGHT' GROUP BY item",
                            (self.run_id,),
                        ).fetchall()
                    )
                    count = sum(active.values())
                    if count >= self.limits.in_flight:
                        observing = db.execute(
                            "SELECT COUNT(*) FROM requests r LEFT JOIN request_observers o ON r.id=o.request "
                            "WHERE r.run=? AND r.status='IN_FLIGHT' AND COALESCE(o.active,1)=1",
                            (self.run_id,),
                        ).fetchone()[0]
                        if not observing:
                            raise AdmissionError(
                                "unsettled_remote_capacity_no_local_observer"
                            )
                    pending = db.execute(
                        "SELECT q.* FROM queue q JOIN items i ON q.item=i.id "
                        "WHERE q.run=? AND i.status='OPEN' ORDER BY q.priority,q.ticket",
                        (self.run_id,),
                    ).fetchall()
                    entitled = [
                        q
                        for q in pending
                        if active.get(q["item"], 0) < self.limits.normal_per_problem
                    ]
                    selected = (entitled or pending)[0] if pending else None
                    selected_request = selected and (
                        selected["id"] == request_id
                        or (
                            not wait
                            and selected["item"] == item.id
                            and selected["priority"] == priority
                        )
                    )
                    rate_ready = True
                    if self.provider_rate_policy is not None:
                        policy = self.provider_rate_policy
                        used = db.execute(
                            "SELECT COUNT(*),COALESCE(SUM(tokens),0),MAX(at) FROM provider_admissions "
                            "WHERE run=? AND at>?",
                            (self.run_id, now - 60),
                        ).fetchone()
                        rate_ready = (
                            used[0] < policy["requests_per_minute"]
                            and used[1] + reserved_tokens <= policy["tokens_per_minute"]
                            and (
                                used[2] is None
                                or now >= used[2] + policy["min_interval_seconds"]
                            )
                        )
                    # Nonblocking callers of the same problem/priority are an
                    # equivalent fairness class. Two transactions (enqueue then
                    # admit) must not spuriously reject free capacity just because
                    # another identical caller inserted its ticket a moment first.
                    if (
                        now >= run["cooldown"]
                        and count < self.limits.in_flight
                        and selected_request
                        and rate_ready
                    ):
                        if once:
                            db.execute(
                                "INSERT INTO once_flags(item,flag,request) VALUES(?,?,?)",
                                (item.id, once, request_id),
                            )
                        db.execute(
                            "UPDATE runs SET calls=calls+1 WHERE id=?", (self.run_id,)
                        )
                        if final:
                            db.execute(
                                "UPDATE items SET reserved=MAX(0,reserved-1) WHERE id=?",
                                (item.id,),
                            )
                        db.execute(
                            "INSERT INTO requests VALUES(?,?,?,?,?,NULL,'IN_FLIGHT',NULL,?)",
                            (request_id, self.run_id, item.id, kind, now, os.getpid()),
                        )
                        db.execute(
                            "INSERT INTO request_observers VALUES(?,1)", (request_id,)
                        )
                        if self.provider_rate_policy is not None:
                            db.execute(
                                "INSERT INTO provider_admissions VALUES(?,?,?,?)",
                                (request_id, self.run_id, now, reserved_tokens),
                            )
                        db.execute("DELETE FROM queue WHERE id=?", (request_id,))
                        return Lease(request_id, item.id, deadline, kind)
                if not wait:
                    raise AdmissionError("API slots busy or rate cooldown")
                time.sleep(0.05 if self.provider_rate_policy is not None else 0.005)
        finally:
            with self.transaction() as db:
                db.execute("DELETE FROM queue WHERE id=?", (request_id,))

    def finish(
        self,
        lease: Lease,
        *,
        status: str,
        detail="",
        confirmed_ended=True,
        local_worker_ended=False,
    ):
        """Uncertain/cancelled future alone is not proof that generation ended."""
        with self.transaction() as db:
            self._item(db, lease.item_id)
            row = db.execute(
                "SELECT * FROM requests WHERE id=? AND run=? AND item=?",
                (lease.id, self.run_id, lease.item_id),
            ).fetchone()
            if row is None:
                raise AdmissionError("unknown lease")
            if local_worker_ended or confirmed_ended:
                db.execute(
                    "INSERT OR REPLACE INTO request_observers VALUES(?,0)", (lease.id,)
                )
            if row["status"] != "IN_FLIGHT":
                return
            if not confirmed_ended:
                # Persist why the permit remains occupied, without a settlement,
                # refund, TTL, or a new state that the in-flight query could omit.
                db.execute(
                    "UPDATE requests SET outcome=? WHERE id=?", (detail, lease.id)
                )
                return
            db.execute(
                "UPDATE requests SET status=?,settled=?,outcome=? WHERE id=?",
                (status, self.clock(), detail, lease.id),
            )
            active = db.execute(
                "SELECT COUNT(*) FROM requests WHERE item=? AND status='IN_FLIGHT'",
                (lease.item_id,),
            ).fetchone()[0]
            if not active:
                db.execute(
                    "UPDATE items SET status='CLOSED' WHERE id=? AND status='DRAINING'",
                    (lease.item_id,),
                )

    def _check_dispatch_stop(self, db, item_id=""):
        if db.execute(
            "SELECT 1 FROM dispatch_stops WHERE run=? AND item IN ('',?)",
            (self.run_id, item_id),
        ).fetchone():
            raise AdmissionError("dispatch stopped under original lifecycle")

    def stop_dispatch(self, reason, *, item=None):
        """Durable stop only; never cancel, refund or reclaim remote work."""
        with self.transaction() as db:
            if item is not None:
                self._item(db, item.id)
            db.execute(
                "INSERT OR IGNORE INTO dispatch_stops VALUES(?,?,?)",
                (self.run_id, item.id if item else "", reason),
            )

    def may_dispatch(self, lease):
        """One public invocation per lease, atomically rechecked before calling."""
        with self.transaction() as db:
            row = self._item(db, lease.item_id)
            request = db.execute(
                "SELECT * FROM requests WHERE id=? AND run=? AND item=?",
                (lease.id, self.run_id, lease.item_id),
            ).fetchone()
            if request is None or request["owner_pid"] != os.getpid():
                raise AdmissionError("unknown or foreign lease")
            try:
                self._check_dispatch_stop(db, lease.item_id)
            except AdmissionError:
                return False
            run = db.execute(
                "SELECT deadline FROM runs WHERE id=?", (self.run_id,)
            ).fetchone()
            if (
                row["status"] != "OPEN"
                or request["status"] != "IN_FLIGHT"
                or self.clock() >= min(lease.deadline, row["deadline"], run[0])
            ):
                return False
            if db.execute(
                "SELECT 1 FROM public_dispatches WHERE request=?", (lease.id,)
            ).fetchone():
                raise AdmissionError("logical request already publicly dispatched")
            db.execute(
                "INSERT INTO public_dispatches VALUES(?,?)", (lease.id, self.clock())
            )
            return True

    def cooldown(self, seconds: float):
        if not 0 <= seconds <= self.limits.run_seconds:
            raise ValueError("invalid public retry-after")
        with self.transaction() as db:
            db.execute(
                "UPDATE runs SET cooldown=MAX(cooldown,?) WHERE id=?",
                (self.clock() + seconds, self.run_id),
            )

    def generation_cutoff(self, item):
        return item.deadline - self.generation_margin

    def reserve_closeout(self, item, requested):
        """Reserve available calls, not additional quota or a promise beyond it."""
        if type(requested) is not int or requested < 0:
            raise ValueError("nonnegative closeout intent required")
        with self.transaction() as db:
            row = self._item(db, item.id)
            if row["status"] != "OPEN":
                return {"requested": requested, "protected": 0, "shortfall": requested}
            run = db.execute(
                "SELECT calls FROM runs WHERE id=?", (self.run_id,)
            ).fetchone()
            phase = db.execute(
                "SELECT ceiling FROM run_call_caps WHERE run=?", (self.run_id,)
            ).fetchone()
            ceiling = min(
                self.limits.logical_requests,
                phase[0] if phase else self.limits.logical_requests,
            )
            others = db.execute(
                "SELECT COALESCE(SUM(reserved),0) FROM items WHERE run=? AND id!=? "
                "AND status IN ('WAITING','OPEN')",
                (self.run_id, item.id),
            ).fetchone()[0]
            total = db.execute(
                "SELECT total FROM run_public_totals WHERE run=?", (self.run_id,)
            ).fetchone()
            future = 0
            if total:
                begun = db.execute(
                    "SELECT COUNT(*) FROM items WHERE run=? AND item_key NOT LIKE 'diagnostic:%'",
                    (self.run_id,),
                ).fetchone()[0]
                future = 2 * max(0, total[0] - begun)
            available = max(
                0,
                min(ceiling - run[0], self.limits.logical_requests - run[0] - future)
                - others,
            )
            protected = min(requested, available)
            db.execute("UPDATE items SET reserved=? WHERE id=?", (protected, item.id))
            return {
                "requested": requested,
                "protected": protected,
                "shortfall": requested - protected,
            }

    def set_call_ceiling(self, ceiling):
        if type(ceiling) is not int or not 1 <= ceiling <= self.limits.logical_requests:
            raise ValueError("phase ceiling cannot exceed original run budget")
        with self.transaction() as db:
            calls = db.execute(
                "SELECT calls FROM runs WHERE id=?", (self.run_id,)
            ).fetchone()[0]
            if calls > ceiling:
                raise AdmissionError("phase ceiling is below already spent calls")
            db.execute(
                "INSERT OR REPLACE INTO run_call_caps VALUES(?,?)",
                (self.run_id, ceiling),
            )

    def note_local_owner_exit(self, pid):
        """Parent supervisor has reaped this owned process. NO remote settlement."""
        with self.transaction() as db:
            db.execute(
                "UPDATE request_observers SET active=0 WHERE request IN "
                "(SELECT id FROM requests WHERE run=? AND owner_pid=? AND status='IN_FLIGHT')",
                (self.run_id, pid),
            )

    def estimated_call_seconds(self):
        """Visible completed-call latency only; not a provider performance claim."""
        with self.transaction() as db:
            values = [
                r[0]
                for r in db.execute(
                    "SELECT settled-dispatched FROM requests WHERE run=? AND settled IS NOT NULL AND status IN ('FINISHED','COMPLETED') "
                    "ORDER BY settled DESC LIMIT 16",
                    (self.run_id,),
                )
                if r[0] >= 0
            ]
        return 1.25 * sum(values) / len(values) if values else 0

    def record_request_fact(self, lease, fact, value=1):
        if fact not in {
            "dispatch_attempted",
            "provider_response_observed",
            "protocol_valid",
            "task_delivered",
        } and not (
            fact.startswith("transport_attempt:") and fact.split(":")[-1].isdigit()
        ):
            raise ValueError("unsupported request fact")
        if type(value) is not int or not 1 <= value <= 8192:
            raise ValueError("invalid observed fact value")
        with self.transaction() as db:
            if not db.execute(
                "SELECT 1 FROM requests WHERE id=? AND item=? AND run=?",
                (lease.id, lease.item_id, self.run_id),
            ).fetchone():
                raise ValueError("unbound request fact")
            previous = db.execute(
                "SELECT value FROM request_facts WHERE request=? AND fact=?",
                (lease.id, fact),
            ).fetchone()
            if previous and previous[0] != value:
                raise ValueError("conflicting request observation")
            db.execute(
                "INSERT OR IGNORE INTO request_facts VALUES(?,?,?,?)",
                (lease.id, fact, value, self.clock()),
            )

    def bind_request_profile(self, profile):
        from ..request_policy import PROFILES

        if profile not in PROFILES:
            raise ValueError("unknown request profile")
        with self.transaction() as db:
            previous = db.execute(
                "SELECT profile FROM request_profiles WHERE run=?", (self.run_id,)
            ).fetchone()
            calls = db.execute(
                "SELECT calls FROM runs WHERE id=?", (self.run_id,)
            ).fetchone()[0]
            if (previous and previous[0] != profile) or (
                not previous and calls and profile != "fixed_8192"
            ):
                raise AdmissionError(
                    "cannot change output policy after run creation/dispatch"
                )
            db.execute(
                "INSERT OR IGNORE INTO request_profiles VALUES(?,?)",
                (self.run_id, profile),
            )

    def call_accounting(self):
        from ..resource_accounting import counts

        with self.transaction() as db:
            return counts(db, self.run_id)

    def request_states(self, item):
        """Observe this run/item only; never settle, release or clear a lease."""
        with self._thread_lock:
            db = self._connect()
            try:
                db.execute("PRAGMA query_only=ON")
                rows = [
                    dict(row)
                    for row in db.execute(
                        "SELECT id,status,settled FROM requests WHERE run=? AND item=? ORDER BY dispatched,id",
                        (self.run_id, item.id),
                    )
                ]
            finally:
                db.close()
        return {
            "available": True,
            "run": self.run_id,
            "item": item.id,
            "observed_at": self.clock(),
            "requests": rows,
            "current_remote_unknown": sum(r["status"] == "IN_FLIGHT" for r in rows),
        }

    def checkpoint(self, item: Item, snapshot: dict):
        data = json.dumps(snapshot, ensure_ascii=False, allow_nan=False)
        with self.transaction() as db:
            row = self._item(db, item.id)
            if row["status"] != "OPEN" or self.clock() >= row["deadline"]:
                return False
            db.execute("UPDATE items SET snapshot=? WHERE id=?", (data, item.id))
            return True

    def close_item(self, item: Item, result: dict, *, snapshot=None):
        data = json.dumps(result, ensure_ascii=False, allow_nan=False)
        saved = (
            json.dumps(snapshot, ensure_ascii=False, allow_nan=False)
            if snapshot is not None
            else None
        )
        with self.transaction() as db:
            row = self._item(db, item.id)
            if row["final"] is not None:
                return json.loads(row["final"])
            active = db.execute(
                "SELECT COUNT(*) FROM requests WHERE item=? AND status='IN_FLIGHT'",
                (item.id,),
            ).fetchone()[0]
            db.execute(
                "UPDATE items SET final=?,status=?,reserved=0 WHERE id=?",
                (data, "DRAINING" if active else "CLOSED", item.id),
            )
            db.execute(
                "INSERT INTO item_final_receipts VALUES(?,?)", (item.id, self.clock())
            )
            if saved is not None:
                db.execute("UPDATE items SET snapshot=? WHERE id=?", (saved, item.id))
            return json.loads(data)

    def suggested_soft_seconds(self, item: Item, *, known_total=None):
        now = self.clock()
        with self.transaction() as db:
            run = db.execute("SELECT * FROM runs WHERE id=?", (self.run_id,)).fetchone()
            if known_total is None:
                remaining = max(0, run["deadline"] - now)
                spent = max(0, now - item.started)
                competitors = db.execute(
                    "SELECT COUNT(*) FROM items WHERE run=? AND status IN ('WAITING','OPEN','DRAINING')",
                    (self.run_id,),
                ).fetchone()[0]
                durations = [
                    row[0]
                    for row in db.execute(
                        "SELECT MAX(q.settled)-i.started FROM items i JOIN requests q ON q.item=i.id "
                        "WHERE i.run=? AND i.status='CLOSED' AND q.settled IS NOT NULL GROUP BY i.id ORDER BY i.started DESC LIMIT 16",
                        (self.run_id,),
                    )
                    if row[0] is not None and row[0] > 0
                ]
                latencies = [
                    row[0]
                    for row in db.execute(
                        "SELECT settled-dispatched FROM requests WHERE run=? AND settled IS NOT NULL ORDER BY settled DESC LIMIT 32",
                        (self.run_id,),
                    )
                    if row[0] >= 0
                ]
                share = (
                    remaining
                    * self.limits.problems
                    / max(self.limits.problems, competitors)
                )
                window = item.deadline - item.started
                if len(durations) >= 2:
                    mean_call = sum(latencies) / len(latencies) if latencies else 0
                    estimate = max(
                        window / 4, 2 * sum(durations) / len(durations), 30 * mean_call
                    )
                    window = min(window, max(spent, estimate))
                return min(window, spent + share)
            if type(known_total) is not int or known_total < 1:
                raise ValueError("total count must come from explicit public run input")
            completed = db.execute(
                "SELECT COUNT(*) FROM items WHERE run=? AND final IS NOT NULL AND item_key NOT LIKE 'diagnostic:%'",
                (self.run_id,),
            ).fetchone()[0]
            remaining = max(1, known_total - completed)
            share = max(0, run["deadline"] - now) * self.limits.problems / remaining
            return min(item.deadline - item.started, max(0, now - item.started) + share)

    def metrics(self):
        with self.transaction() as db:
            run = dict(
                db.execute("SELECT * FROM runs WHERE id=?", (self.run_id,)).fetchone()
            )
            run["in_flight"] = db.execute(
                "SELECT COUNT(*) FROM requests WHERE run=? AND status='IN_FLIGHT'",
                (self.run_id,),
            ).fetchone()[0]
            run["active_local_observers"] = db.execute(
                "SELECT COUNT(*) FROM requests r JOIN request_observers o ON r.id=o.request "
                "WHERE r.run=? AND r.status='IN_FLIGHT' AND o.active=1",
                (self.run_id,),
            ).fetchone()[0]
            run["open_items"] = db.execute(
                "SELECT COUNT(*) FROM items WHERE run=? AND status IN ('OPEN','DRAINING')",
                (self.run_id,),
            ).fetchone()[0]
            return run
