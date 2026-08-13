"""Prometheus/Grafana probe labels must track actual deployment.

These two endpoints once carried a hard-coded `hosting="NOT DEPLOYED as of
13 Aug 2026"`. After the monitoring stack was deployed and `deploy.sh` set the
URLs, the probe page still showed "NOT DEPLOYED" — a label frozen on a survey
date. The hosting text is now derived from whether the URL is configured, and
these assertions keep it that way.

The tests drive `config._ENV` (the effective-environment snapshot that env_*
reads) directly and restore it, rather than reloading the module — a reload
would hand other already-imported modules a different `config.Settings` class
and cause spooky failures later in the suite.
"""

from __future__ import annotations

from contextlib import contextmanager

import config


@contextmanager
def _env(**overrides):
    saved = dict(config._ENV)
    try:
        for key in ("PROMETHEUS_URL", "GRAFANA_URL"):
            config._ENV.pop(key, None)
        for key, value in overrides.items():
            if value is not None:
                config._ENV[key] = value
        yield {e.key: e for e in config._build_service_endpoints()}
    finally:
        config._ENV.clear()
        config._ENV.update(saved)


def test_undeployed_shows_a_deploy_hint_not_a_stale_date():
    with _env() as eps:
        for key in ("prometheus", "grafana"):
            assert eps[key].url == "", f"{key} should have no probe URL when undeployed"
            assert "deploy.sh" in eps[key].hosting
            assert "13 Aug 2026" not in eps[key].hosting


def test_deployed_shows_the_live_location():
    with _env(
        PROMETHEUS_URL="http://127.0.0.1:9090", GRAFANA_URL="http://127.0.0.1:3000"
    ) as eps:
        assert eps["prometheus"].url == "http://127.0.0.1:9090/-/healthy"
        assert "9090" in eps["prometheus"].hosting
        assert "NOT DEPLOYED" not in eps["prometheus"].hosting.upper()
        assert eps["grafana"].url == "http://127.0.0.1:3000/api/health"
        assert "3000" in eps["grafana"].hosting


def test_no_endpoint_carries_the_frozen_survey_date():
    """Nothing should hard-code 'NOT DEPLOYED as of 13 Aug 2026' any more."""
    with _env(
        PROMETHEUS_URL="http://127.0.0.1:9090", GRAFANA_URL="http://127.0.0.1:3000"
    ) as eps:
        for endpoint in eps.values():
            assert "NOT DEPLOYED as of 13 Aug 2026" not in endpoint.hosting
