"""Tests for the unpaced pacer, which a stub run uses so that it never waits on provider limits."""

import asyncio
import unittest

from ordeal import limiter


class UnpacedPacerTests(unittest.TestCase):
    """A pacer with paced=False admits every call at once, because nothing is sent to a provider."""

    def test_unpaced_pacer_never_sleeps_however_many_calls(self) -> None:
        """Two hundred calls to one model, with no limits set, make no sleeps when pacing is off."""
        sleeps: list[float] = []

        async def record_sleep(seconds: float) -> None:
            # Records any wait the pacer asks for, so the test can check that none happened.
            sleeps.append(seconds)

        pacer = limiter.Pacer(table={}, sleep=record_sleep, paced=False)

        async def scenario() -> None:
            for _ in range(200):
                estimate = await pacer.admit("stub", input_tokens=10)
                pacer.finish_call("stub", estimate, seconds=0.1)

        asyncio.run(scenario())
        self.assertEqual(sleeps, [])


if __name__ == "__main__":
    unittest.main()
