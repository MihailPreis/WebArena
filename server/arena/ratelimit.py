import time
from collections.abc import Callable

# Forget idle keys once the table grows past this, so it cannot grow without bound.
_PRUNE_ABOVE = 10_000


class RateLimiter:
    """Token bucket per key: `burst` actions at once, refilled at `rate` per second."""

    def __init__(
        self, rate: float, burst: float, clock: Callable[[], float] = time.monotonic
    ) -> None:
        self.rate = rate
        self.burst = burst
        self._clock = clock
        self._buckets: dict[str, tuple[float, float]] = {}

    def allow(self, key: str) -> bool:
        if self.rate <= 0:
            return True  # Disabled.
        now = self._clock()
        tokens, updated = self._buckets.get(key, (self.burst, now))
        tokens = min(tokens + (now - updated) * self.rate, self.burst)
        if tokens < 1:
            self._buckets[key] = (tokens, now)
            return False
        self._buckets[key] = (tokens - 1, now)
        if len(self._buckets) > _PRUNE_ABOVE:
            self._prune(now)
        return True

    def _prune(self, now: float) -> None:
        full_after = self.burst / self.rate
        self._buckets = {
            key: bucket for key, bucket in self._buckets.items() if now - bucket[1] < full_after
        }
