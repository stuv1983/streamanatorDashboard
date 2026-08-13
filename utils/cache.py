"""Thread-safe TTL memoisation for slow collectors.

Why this exists rather than `st.cache_data`: the collectors must stay testable
and runnable outside Streamlit (the background sampler and the CLI smoke tests
both call them with no script context). This is a plain in-process cache with
the same effect.

What it is used for: the collectors that cost real wall-clock time are all
network-bound — ICMP probes, the WAN IP lookup, the VPN exit-IP check inside
the Gluetun namespace, HTTP probes, and smartctl subprocesses. Left uncached
they cost several seconds on *every* page render, which blows the sub-second
refresh budget. Cached with a TTL shorter than the fastest refresh interval,
they cost that once and are free thereafter, while never showing a value older
than its TTL.

Failures are cached too, deliberately: seven smartctl calls that each fail on
permission denied are just as slow as seven that succeed, and retrying them on
every render helps nobody.
"""

from __future__ import annotations

import functools
import threading
import time
from typing import Any, Callable, TypeVar

F = TypeVar("F", bound=Callable[..., Any])

#: Registry of every cache created, so they can be cleared together on a
#: manual refresh.
_REGISTRY: list["_TtlCache"] = []


class _TtlCache:
    def __init__(self, ttl: float, max_entries: int) -> None:
        self.ttl = ttl
        self.max_entries = max_entries
        self._lock = threading.Lock()
        #: key -> (expires_at, value, exception)
        self._entries: dict[Any, tuple[float, Any, BaseException | None]] = {}
        self.hits = 0
        self.misses = 0

    def get(self, key: Any) -> tuple[bool, Any, BaseException | None]:
        with self._lock:
            entry = self._entries.get(key)
            if entry is None or entry[0] < time.monotonic():
                self.misses += 1
                return False, None, None
            self.hits += 1
            return True, entry[1], entry[2]

    def put(self, key: Any, value: Any, error: BaseException | None) -> None:
        with self._lock:
            if len(self._entries) >= self.max_entries:
                # Evict the soonest-to-expire entry; this cache is small and
                # short-lived, so exact LRU is not worth the bookkeeping.
                oldest = min(self._entries, key=lambda k: self._entries[k][0])
                self._entries.pop(oldest, None)
            self._entries[key] = (time.monotonic() + self.ttl, value, error)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()


def ttl_cache(seconds: float, max_entries: int = 64) -> Callable[[F], F]:
    """Memoise a function's result (and exception) for `seconds`.

    Arguments must be hashable. Exceptions are re-raised from cache so a slow
    failing call is not repeated on every render.
    """

    def decorator(func: F) -> F:
        cache = _TtlCache(seconds, max_entries)
        _REGISTRY.append(cache)

        @functools.wraps(func)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            key = (args, tuple(sorted(kwargs.items())))
            try:
                hit, value, error = cache.get(key)
            except TypeError:
                # Unhashable argument — run uncached rather than failing.
                return func(*args, **kwargs)
            if hit:
                if error is not None:
                    raise error
                return value
            try:
                result = func(*args, **kwargs)
            except Exception as exc:  # noqa: BLE001 - cached and re-raised
                cache.put(key, None, exc)
                raise
            cache.put(key, result, None)
            return result

        wrapper.cache_clear = cache.clear  # type: ignore[attr-defined]
        wrapper.cache_stats = lambda: {  # type: ignore[attr-defined]
            "hits": cache.hits,
            "misses": cache.misses,
            "ttl": cache.ttl,
        }
        return wrapper  # type: ignore[return-value]

    return decorator


def clear_all() -> None:
    """Drop every TTL cache — used by the manual refresh button."""
    for cache in _REGISTRY:
        cache.clear()
