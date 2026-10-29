"""Common fixtures and helpers for math asset migration tests (Stage U4)."""

from __future__ import annotations

import pytest


@pytest.fixture
def base_context():
    return {
        "sessionId": "test-session-u4",
        "problemHash": "c" * 64,
        "contractVersion": 1,
        "taskId": "task-migration-u4",
        "goalId": "goal-1",
        "scopeId": "scope-1",
        "sourceRequestId": "model-1",
    }
