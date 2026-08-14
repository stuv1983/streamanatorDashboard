"""Backups — recency, size, destination capacity and integrity.

Existence is not restorability, so integrity gets equal billing with age. The
verification actions here read whole multi-gigabyte archives, which is why they
are explicit buttons rather than something that happens on every refresh — and
why the result is persisted so the last verdict stays visible afterwards.
"""

from __future__ import annotations

import pandas as pd
import streamlit as st

from components.alerts import alert_card
from components.cards import metric_card, status_card
from components.charts import magnitude_bar
from components.layout import page_header, read_only_notice
from config import get_settings
from core.runtime import get_snapshot, history_store
from core.status import Status
from services.backups import (
    measure_directory_size,
    verify_backup,
    verify_sqlite_in_archive,
)
from utils.formatting import (
    format_timestamp,
    human_age,
    human_bytes,
    human_duration,
)

settings = get_settings()
snapshot = get_snapshot()
backups = snapshot.component("backups")
statuses = snapshot.raw.get("backups", {}).get("jobs", [])

#: This page only observes. Actually running a backup is a control action —
#: it starts a privileged systemd unit — so it lives in the Admin section,
#: same as every other button that changes the system. See read_only_notice()
#: below for the general statement; these two exist because "where do I click
#: to run it" is exactly the question an alert on this page prompts.
TRIGGER_LABELS: dict[str, str] = {
    "sports_data_lab": "Run Sports Data Lab backup now",
    "nightly_system": "Restart Nightly backup (re-runs it now)",
}


def trigger_link(job_key: str) -> None:
    label = TRIGGER_LABELS.get(job_key)
    if label is None:
        return
    # A plain caption, not st.page_link: this page is rendered standalone in
    # tests (no navigation context to resolve a page link against), and in
    # the real app the destination already requires sign-in on arrival.
    st.caption(f":gray[**{label}** — Admin → Admin jobs (sign-in required).]")

page_header(
    "Backups",
    "Backup recency, plausibility and verified integrity",
    snapshot.collected_at,
)

st.info(
    "The RAID array is not a backup. It protects against a single disk failure, "
    "not against deletion, corruption, ransomware or fire — important data needs "
    "a copy that is off this host.",
    icon=":material/info:",
)

age_labels: list[str] = []
age_values: list[float] = []
age_statuses: list[Status] = []
for job, backup_status in zip(settings.backups, statuses):
    if backup_status.age_days is None:
        continue
    age_reading = next(
        (
            reading
            for reading in (backups.readings if backups else [])
            if reading.key == f"backup.{job.key}"
        ),
        None,
    )
    age_labels.append(job.display)
    age_values.append(float(backup_status.age_days))
    age_statuses.append(age_reading.status if age_reading else Status.UNKNOWN)

age_chart = magnitude_bar(
    age_labels,
    age_values,
    "Age",
    " (days)",
    age_statuses,
)
if age_chart is not None:
    st.markdown("### Backup age at a glance")
    st.altair_chart(age_chart, width="stretch")
    st.caption(":gray[Exact timestamps and retention details remain in the cards below.]")

for job, status in zip(settings.backups, statuses):
    reading = next(
        (r for r in (backups.readings if backups else []) if r.key == f"backup.{job.key}"),
        None,
    )
    integrity_reading = next(
        (
            r
            for r in (backups.readings if backups else [])
            if r.key == f"backup.integrity.{job.key}"
        ),
        None,
    )

    with st.container(border=True):
        st.markdown(f"### {job.display}")
        st.caption(f"{status.directory} · scheduled {job.schedule}")

        if status.error:
            st.error(status.error, icon=":material/error:")

        summary, facts = st.columns([1, 2])
        with summary:
            if reading is not None:
                status_card(
                    label="Backup age",
                    status=reading.status,
                    value=str(reading.value or "no backup"),
                    detail=reading.detail,
                    threshold=reading.threshold,
                    source=reading.source,
                )

        with facts:
            columns = st.columns(4)
            with columns[0]:
                metric_card(
                    "Last backup",
                    format_timestamp(status.latest.modified_at)
                    if status.latest
                    else "—",
                )
            with columns[1]:
                if status.latest is None:
                    size_text = "—"
                elif status.latest.size_known:
                    size_text = human_bytes(status.latest.size_bytes)
                else:
                    size_text = "not measured"
                metric_card(
                    "Size",
                    size_text,
                    help_text=(
                        "This job writes a directory per run. Measuring the tree "
                        "is too slow for a page render, so it is done on demand."
                        if status.latest is not None and not status.latest.size_known
                        else ""
                    ),
                )
            with columns[2]:
                metric_card("Retained", str(status.retained_count))
            with columns[3]:
                metric_card(
                    "Destination free",
                    human_bytes(status.destination_free_bytes)
                    if status.destination_free_bytes is not None
                    else "—",
                    help_text=(
                        f"{status.destination_used_percent:.0f}% used"
                        if status.destination_used_percent is not None
                        else ""
                    ),
                )

            if status.growth_bytes is not None:
                st.caption(
                    f":gray[Size change vs previous backup: "
                    f"{human_bytes(status.growth_bytes)}]"
                )

            if status.latest is not None and not status.latest.size_known:
                if st.button(
                    "Measure latest backup size",
                    key=f"measure_{job.key}",
                    icon=":material/straighten:",
                ):
                    with st.spinner(f"Walking {status.latest.name}…"):
                        measured, complete = measure_directory_size(status.latest.path)
                    if complete:
                        st.success(
                            f"{status.latest.name}: {human_bytes(measured)}",
                            icon=":material/check_circle:",
                        )
                    else:
                        st.warning(
                            f"{status.latest.name}: at least {human_bytes(measured)} "
                            f"(measurement hit its time or entry limit, so this is "
                            f"a floor, not a total).",
                            icon=":material/warning:",
                        )

        # ---- Integrity ------------------------------------------------
        st.markdown("**Integrity**")
        if integrity_reading is not None:
            if integrity_reading.status is Status.HEALTHY:
                st.success(integrity_reading.detail, icon=":material/verified:")
            elif integrity_reading.status is Status.CRITICAL:
                st.error(integrity_reading.detail, icon=":material/error:")
            else:
                st.warning(integrity_reading.detail, icon=":material/help:")
            checked_at = integrity_reading.extra.get("checked_at")
            if checked_at:
                st.caption(f":gray[Last verified {human_age(checked_at)}]")

        if status.latest is not None:
            quick, deep = st.columns(2)
            with quick:
                if st.button(
                    "Verify archive (gzip -t)",
                    key=f"verify_quick_{job.key}",
                    icon=":material/fact_check:",
                    width="stretch",
                ):
                    with st.spinner(
                        f"Reading {human_bytes(status.latest.size_bytes)} — this "
                        f"takes a few minutes…"
                    ):
                        result = verify_backup(status.latest.path)
                    history_store().put_state(
                        f"backup.{job.key}.integrity",
                        "ok" if result.ok else result.detail[:200],
                    )
                    if result.ok:
                        st.success(
                            f"{result.method}: ok ({human_duration(result.duration_seconds)})",
                            icon=":material/check_circle:",
                        )
                    else:
                        st.error(f"{result.method}: {result.detail}", icon=":material/error:")

            with deep:
                if st.button(
                    "Restore test (extract + integrity_check)",
                    key=f"verify_deep_{job.key}",
                    icon=":material/restore:",
                    width="stretch",
                    help=(
                        "Extracts one database from the archive to a temporary "
                        "directory and runs PRAGMA integrity_check on it, then "
                        "deletes the extraction. Proves the backup is restorable, "
                        "not merely decompressible."
                    ),
                ):
                    with st.spinner("Extracting and verifying…"):
                        result = verify_sqlite_in_archive(status.latest.path)
                    history_store().put_state(
                        f"backup.{job.key}.integrity",
                        "ok" if result.ok else result.detail[:200],
                    )
                    if result.ok:
                        st.success(f"Restore test passed — {result.detail}", icon=":material/verified:")
                    else:
                        st.error(f"Restore test failed — {result.detail}", icon=":material/error:")

        trigger_link(job.key)

        # ---- Retained files -------------------------------------------
        if status.retained_count:
            with st.expander(f"Retained backups ({status.retained_count})"):
                st.caption(f"Total {human_bytes(status.total_bytes)}")
                if status.latest:
                    rows = [
                        {
                            "File": status.latest.name,
                            "Size": human_bytes(status.latest.size_bytes),
                            "Modified": format_timestamp(status.latest.modified_at),
                            "Age": human_age(status.latest.modified_at),
                        }
                    ]
                    if status.previous:
                        rows.append(
                            {
                                "File": status.previous.name,
                                "Size": human_bytes(status.previous.size_bytes),
                                "Modified": format_timestamp(status.previous.modified_at),
                                "Age": human_age(status.previous.modified_at),
                            }
                        )
                    st.dataframe(pd.DataFrame(rows), hide_index=True, width="stretch")

st.divider()

st.markdown("### Backup alerts")
backup_alerts = [a for a in snapshot.alerts if a.key.startswith("backup.")]
if not backup_alerts:
    st.success("No backup problems detected.", icon=":material/check_circle:")
for alert in backup_alerts:
    alert_card(alert)
    # Every backup alert key ends in the job key (e.g. "backup.size.<job>"),
    # so this reaches the right trigger regardless of which check fired.
    trigger_link(alert.key.rsplit(".", 1)[-1])

read_only_notice()
