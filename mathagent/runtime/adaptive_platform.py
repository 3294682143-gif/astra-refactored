"""Budget visibility via a trusted public port; unknown resources stay unknown."""
from statistics import median
from .coordinator import AdmissionError
from .platform_coordinator import PlatformItemCoordinator


class BudgetAwareCoordinator(PlatformItemCoordinator):
    def __init__(self, *, budget_snapshot=None, **kwargs):
        super().__init__(**kwargs)
        self.budget_snapshot = budget_snapshot
        self.observed_latencies = []

    def reserve_closeout(self, item, requested):
        self._check_item(item)
        if type(requested) is not int or requested < 0:
            raise ValueError('invalid closeout reserve')
        with self.condition:
            self.reserved = min(requested, max(0, self.limits.logical_requests - self.calls))
            return {'requested': requested, 'protected': self.reserved,
                    'shortfall': requested - self.reserved,
                    'scope': 'local; global protection belongs to public transport'}

    def scheduling_capacity(self, item, *, deadline=None):
        self._check_item(item)
        with self.condition:
            local = max(0, self.limits.logical_requests - self.calls)
            reserve = self.reserved
        shared = None
        if self.budget_snapshot is not None:
            shared = self.budget_snapshot()
            if not isinstance(shared, dict) or shared.get('schema') != 'rc-public-budget-v1':
                raise AdmissionError('invalid public budget snapshot')
            for key in ('logical_remaining', 'http_remaining', 'effective_remaining'):
                if type(shared.get(key)) is not int or shared[key] < 0:
                    raise AdmissionError('invalid public budget value')
        logical = min(local, shared['logical_remaining']) if shared else local
        effective = min(max(0, local - reserve), shared['effective_remaining']) if shared else max(0, local - reserve)
        return {'logical_remaining': logical, 'effective_remaining': effective,
                'http_remaining': shared['http_remaining'] if shared else None,
                'local_remaining': local, 'closeout_reserved_local': reserve,
                'source': 'injected_public_budget' if shared else 'local_guard_only',
                'snapshot_is_not_atomic_reservation': True}

    def acquire(self, item, kind, **options):
        capacity = self.scheduling_capacity(item)
        if not options.get('final') and capacity['effective_remaining'] <= 0:
            raise AdmissionError('budget protected for outstanding closeout obligations')
        lease = super().acquire(item, kind, **options)
        with self.condition:
            self.requests[lease.id].update(started_at=self.clock(), final=bool(options.get('final')))
        return lease

    def attach_work_context(self, lease, value):
        with self.condition:
            if self.requests.get(lease.id, {}).get('lease') is not lease:
                raise AdmissionError('foreign work context')
            self.requests[lease.id]['work_context'] = dict(value)

    def public_request_metadata(self, lease):
        with self.condition:
            row = self.requests[lease.id]
            return {'kind': lease.kind, 'final': row.get('final', False),
                    'deadline': lease.deadline, 'lease_id': lease.id,
                    **row.get('work_context', {})}

    def settle_public_call(self, lease, **receipt):
        super().settle_public_call(lease, **receipt)
        with self.condition:
            self.observed_latencies.append(max(0, self.clock() - self.requests[lease.id]['started_at']))
            self.observed_latencies = self.observed_latencies[-16:]

    def estimated_call_seconds(self):
        with self.condition:
            return median(self.observed_latencies) if self.observed_latencies else 0.0
