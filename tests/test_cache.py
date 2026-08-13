"""Tests for the TTL cache used to keep collection inside the page budget.

The uncached collectors cost ~7s per snapshot on the live host, almost all of
it network-bound (ICMP, the WAN IP lookup, the Gluetun exec, HTTP probes,
smartctl subprocesses). These tests pin the behaviour the page budget relies
on — including that cached *failures* are not retried, since a refused
smartctl call is exactly as slow as a successful one.
"""

from __future__ import annotations

import time

import pytest

from utils.cache import clear_all, ttl_cache


class TestTtlCache:
    def test_result_is_cached(self):
        calls = []

        @ttl_cache(seconds=60)
        def expensive(x):
            calls.append(x)
            return x * 2

        assert expensive(3) == 6
        assert expensive(3) == 6
        assert calls == [3]

    def test_distinct_arguments_are_cached_separately(self):
        calls = []

        @ttl_cache(seconds=60)
        def f(x):
            calls.append(x)
            return x

        f(1), f(2), f(1)
        assert calls == [1, 2]

    def test_expiry_recomputes(self):
        calls = []

        @ttl_cache(seconds=0.05)
        def f():
            calls.append(1)
            return len(calls)

        assert f() == 1
        time.sleep(0.08)
        assert f() == 2

    def test_exceptions_are_cached_and_reraised(self):
        """A slow failing call must not be retried on every render."""
        calls = []

        @ttl_cache(seconds=60)
        def failing():
            calls.append(1)
            raise RuntimeError("permission denied")

        with pytest.raises(RuntimeError, match="permission denied"):
            failing()
        with pytest.raises(RuntimeError, match="permission denied"):
            failing()
        assert len(calls) == 1

    def test_unhashable_arguments_fall_back_to_uncached(self):
        calls = []

        @ttl_cache(seconds=60)
        def f(items):
            calls.append(1)
            return len(items)

        assert f(["a"]) == 1
        assert f(["a"]) == 1
        assert len(calls) == 2  # ran both times rather than failing

    def test_cache_clear(self):
        calls = []

        @ttl_cache(seconds=60)
        def f():
            calls.append(1)
            return 1

        f()
        f.cache_clear()
        f()
        assert len(calls) == 2

    def test_clear_all_clears_registered_caches(self):
        calls = []

        @ttl_cache(seconds=60)
        def f():
            calls.append(1)
            return 1

        f()
        clear_all()
        f()
        assert len(calls) == 2

    def test_max_entries_bounds_growth(self):
        @ttl_cache(seconds=60, max_entries=3)
        def f(x):
            return x

        for i in range(10):
            f(i)
        # Nothing to assert beyond "did not raise and stayed bounded"; the
        # point is that an unbounded cache would grow with every distinct key.
        assert f(9) == 9

    def test_stats_are_reported(self):
        @ttl_cache(seconds=60)
        def f():
            return 1

        f()
        f()
        stats = f.cache_stats()
        assert stats["hits"] >= 1
        assert stats["misses"] >= 1
