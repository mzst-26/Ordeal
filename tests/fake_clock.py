"""A fake clock for tests that run the paced model calls. No real time passes and no real waiting is done.

Why this exists: the runner paces each model with the real clock and the shipped limits. A stub run that makes
a few hundred calls then waits for minutes in real time. Tests that check what a run saves do not care about
the waiting, so they run the pacer on this clock instead. The clock moves only when the pacer sleeps.
The same run also writes its rate snapshot, so the results folder is moved to a temporary one for the run.
"""

import contextlib
from collections.abc import Iterator
from pathlib import Path
from unittest import mock

from ordeal import core
from ordeal import limiter


class FakeClock:
    """A clock that only moves when code sleeps, so the waits can be read exactly afterwards."""

    def __init__(self) -> None:
        """Start at time zero."""
        self.now = 0.0

    def __call__(self) -> float:
        """Return the fake time."""
        return self.now

    async def sleep(self, seconds: float) -> None:
        """Move the fake time forward by the wait, instead of waiting."""
        self.now += seconds


@contextlib.contextmanager
def isolated_run(results_dir: Path) -> Iterator[FakeClock]:
    """Make a runner.main run wait for nothing and write its results folder into 'results_dir'.

    runner.main and run_all build their pacer with limiter.Pacer(), so patching that name is enough to cover them.
    The table is empty, so every model uses the low default limits, the same as an unknown model in a real run.
    The real Pacer class is saved before the patch, so the factory can still build a real pacer.
    The results folder is moved, so the rate snapshot of the run never lands in the project's real results/.
    Yields the fake clock, so a test can read how long the pacer wanted to wait.
    """
    clock = FakeClock()
    real_pacer = limiter.Pacer

    def make_pacer() -> limiter.Pacer:
        """Build a real pacer that uses the fake clock and never really waits."""
        return real_pacer(table={}, clock=clock, sleep=clock.sleep)

    with mock.patch.object(limiter, "Pacer", make_pacer), mock.patch.object(core, "RESULTS_DIR", results_dir):
        yield clock
