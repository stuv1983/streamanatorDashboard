"""Service probes: which endpoints are checked, and what counts as healthy.

A probe answers "is this application working?", which is a different question
from "is the container running?" — a Sonarr that returns 500 to every request
is a healthy container and a broken service.

Built-in probes come from configuration and can be retargeted or disabled but
never deleted, so the overlay cannot silently drop coverage of a service the
dashboard knows should exist. A disabled probe is visible; a missing one is not.
"""

from __future__ import annotations

import streamlit as st

from admin import probes_config as probes
from components.admin_ui import require_admin, session_bar
from components.layout import page_header
from core.runtime import audit_log

current = require_admin("Service probes")
audit = audit_log()

page_header("Service probes", "What the dashboard checks, and what it expects back")
session_bar(current)
st.divider()

try:
    definitions = probes.effective_probes()
except probes.OverlayCorruptError as exc:
    st.error(
        f"**The probe overlay cannot be read.** {exc} No probe changes are "
        "possible until it is repaired. Over SSH, restore or delete "
        "`var/probes.json` — deleting it reverts to the built-in probes.",
        icon=":material/report:",
    )
    st.stop()

# ---------------------------------------------------------------------------
# Run them all
# ---------------------------------------------------------------------------

summary, action = st.columns([3, 1], vertical_alignment="center")
with summary:
    enabled = [d for d in definitions if d.enabled]
    public = [d for d in enabled if probes.classify_target(d.url).is_public]
    st.markdown(
        f"**{len(enabled)} enabled** of {len(definitions)} probes"
        + (f" · {len(public)} external" if public else "")
    )
with action:
    test_all = st.button(
        "Test all now", icon=":material/play_arrow:", width="stretch"
    )

if test_all:
    results: dict[str, probes.ProbeResult] = {}
    progress = st.progress(0.0, "Probing…")
    for index, definition in enumerate(enabled, start=1):
        results[definition.key] = probes.run_probe(definition)
        progress.progress(index / max(1, len(enabled)), f"Probing {definition.label}…")
    progress.empty()
    st.session_state["_probe_results"] = results
    audit.record(
        "probes.test_all", current.username, current.role, "success",
        detail=f"{len(results)} probes run", breakglass=current.breakglass,
    )

results = st.session_state.get("_probe_results", {})

st.divider()

# ---------------------------------------------------------------------------
# Existing probes
# ---------------------------------------------------------------------------

for definition in definitions:
    verdict = probes.classify_target(definition.url)
    result = results.get(definition.key)

    with st.container(border=True):
        title, state = st.columns([3, 1], vertical_alignment="center")
        with title:
            badges = []
            if definition.builtin:
                badges.append(":blue-badge[built-in]")
            if definition.critical:
                badges.append(":orange-badge[critical]")
            if verdict.is_public:
                badges.append(":red-badge[external]")
            st.markdown(f"#### {definition.label} {' '.join(badges)}")
            st.caption(f"`{definition.method} {definition.url}`")
            if definition.hosting:
                st.caption(f":gray[{definition.hosting}]")
        with state:
            if result is None:
                st.markdown(":gray-badge[not tested]")
            elif result.ok:
                st.markdown(
                    f":green-badge[:material/check: {result.detail}]"
                    + (f" {result.latency_ms:.0f} ms" if result.latency_ms else "")
                )
            else:
                st.markdown(f":red-badge[:material/close: {result.detail}]")

        with st.expander("Edit", expanded=False):
            with st.form(f"probe_{definition.key}"):
                label = st.text_input("Name", value=definition.label)
                url = st.text_input("URL", value=definition.url)
                columns = st.columns([1, 2, 1])
                with columns[0]:
                    method = st.selectbox(
                        "Method",
                        probes.ALLOWED_METHODS,
                        index=probes.ALLOWED_METHODS.index(definition.method),
                    )
                with columns[1]:
                    statuses = st.text_input(
                        "Accepted statuses",
                        value=", ".join(str(s) for s in definition.expect_status),
                        help="Comma separated. Some services answer 401 or 403 "
                        "without credentials and that still proves they are up.",
                    )
                with columns[2]:
                    enabled_now = st.checkbox("Enabled", value=definition.enabled)

                acknowledged = definition.external_acknowledged
                target = probes.classify_target(url) if url else verdict
                if target.is_public:
                    acknowledged = st.checkbox(
                        "This host is mine and I want it probed on a timer",
                        value=definition.external_acknowledged,
                        help=f"Resolves to {target.resolved}.",
                    )

                saved = st.form_submit_button("Save", icon=":material/save:")

            if saved:
                try:
                    expect = tuple(
                        int(s.strip()) for s in statuses.split(",") if s.strip()
                    )
                except ValueError:
                    expect = ()
                    st.error(
                        "Accepted statuses must be numbers.", icon=":material/error:"
                    )
                if expect:
                    candidate = probes.ProbeDefinition(
                        key=definition.key,
                        label=label,
                        url=url.strip(),
                        expect_status=expect,
                        method=method,
                        enabled=enabled_now,
                        critical=definition.critical,
                        external_acknowledged=acknowledged,
                    )
                    problems = probes.validate_definition(
                        candidate, [d for d in definitions if d.key != definition.key]
                    )
                    if problems:
                        for problem in problems:
                            st.error(problem, icon=":material/error:")
                    else:
                        probes.upsert(candidate)
                        audit.record(
                            "probes.update", current.username, current.role,
                            "success", severity="notice", target=definition.key,
                            detail=f"{method} {candidate.url} expect "
                            f"{'/'.join(str(s) for s in expect)}"
                            + (" [external]" if target.is_public else ""),
                            breakglass=current.breakglass,
                        )
                        st.success("Saved.", icon=":material/check_circle:")
                        st.rerun()

            if not definition.builtin:
                if st.button(
                    "Delete probe",
                    key=f"del_{definition.key}",
                    icon=":material/delete:",
                ):
                    probes.remove(definition.key)
                    audit.record(
                        "probes.delete", current.username, current.role, "success",
                        severity="warning", target=definition.key,
                        breakglass=current.breakglass,
                    )
                    st.rerun()
            else:
                st.caption(
                    ":gray[Built-in probes can be disabled but not deleted — a "
                    "disabled probe is visible on this page, a deleted one "
                    "would just be missing coverage.]"
                )

st.divider()

# ---------------------------------------------------------------------------
# Add a probe
# ---------------------------------------------------------------------------

st.markdown("### Add a probe")

with st.form("new_probe", clear_on_submit=False):
    columns = st.columns([1, 2])
    with columns[0]:
        new_key = st.text_input("Key", placeholder="my_service")
    with columns[1]:
        new_label = st.text_input("Name", placeholder="My Service")
    new_url = st.text_input("URL", placeholder="http://10.0.40.100:9000/health")
    options = st.columns([1, 2, 1])
    with options[0]:
        new_method = st.selectbox("Method", probes.ALLOWED_METHODS)
    with options[1]:
        new_statuses = st.text_input("Accepted statuses", value="200")
    with options[2]:
        new_critical = st.checkbox("Critical", value=False)

    new_external = st.checkbox(
        "This host is mine and I want it probed on a timer",
        value=False,
        help="Only needed for targets outside the private address ranges.",
    )
    added = st.form_submit_button("Add probe", icon=":material/add:", type="primary")

if added:
    try:
        expect = tuple(int(s.strip()) for s in new_statuses.split(",") if s.strip())
    except ValueError:
        expect = ()
        st.error("Accepted statuses must be numbers.", icon=":material/error:")
    if expect:
        candidate = probes.ProbeDefinition(
            key=new_key.strip(),
            label=new_label.strip() or new_key.strip(),
            url=new_url.strip(),
            expect_status=expect,
            method=new_method,
            critical=new_critical,
            external_acknowledged=new_external,
        )
        if any(d.key == candidate.key for d in definitions):
            st.error(
                f"A probe named `{candidate.key}` already exists.",
                icon=":material/error:",
            )
        else:
            problems = probes.validate_definition(candidate, definitions)
            if problems:
                for problem in problems:
                    st.error(problem, icon=":material/error:")
            else:
                probes.upsert(candidate)
                audit.record(
                    "probes.create", current.username, current.role, "success",
                    severity="notice", target=candidate.key,
                    detail=f"{candidate.method} {candidate.url}"
                    + (" [external]" if new_external else ""),
                    breakglass=current.breakglass,
                )
                result = probes.run_probe(candidate)
                if result.ok:
                    st.success(
                        f"Added and tested: {result.detail}",
                        icon=":material/check_circle:",
                    )
                else:
                    st.warning(
                        f"Added, but the first probe failed: {result.detail}",
                        icon=":material/warning:",
                    )
                st.rerun()

with st.expander("Why external targets need a tick"):
    st.markdown(
        f"""
Probes at private, loopback and link-local addresses are unrestricted — that
is your own network.

A probe aimed at a public address is different in kind. A URL field attached
to a timer is a scanner, and one running unattended on someone's home server
is a scanner nobody is watching. So public targets need an explicit
acknowledgement that the host is yours, are capped at
{probes.MAX_PUBLIC_TARGETS} at a time, and are recorded in the audit log with
the target named.

Hostnames are resolved before the probe is accepted, not at request time, so a
name that points somewhere unexpected is caught before any traffic is sent.

For plain "is the Internet up?" checks, use the existing reachability check on
the Network page rather than adding a probe here.
"""
    )
