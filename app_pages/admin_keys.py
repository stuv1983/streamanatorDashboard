"""API keys and integration credentials.

Each credential is saved to `.env` (0600, gitignored, backed up), the process
environment is updated, and the settings singleton is rebuilt — so a key added
here works on the next render rather than after a restart.

Values are never displayed once saved. A stored key shows its length and an
eight-character fingerprint, which answers "is this the same key I set last
week?" without putting the key back on screen where a screenshot or a shoulder
can collect it.
"""

from __future__ import annotations

import streamlit as st

from admin import credentials as cred
from admin.env_file import (
    file_mode,
    read_env_file,
    secure_permissions,
    update_env_file,
)
from auth.crypto import fingerprint
from components.admin_ui import require_admin, session_bar
from components.layout import page_header
from config import get_settings
from core.runtime import audit_log, reload_configuration

current = require_admin("API keys")
settings = get_settings()
audit = audit_log()
env_path = settings.auth.env_file

page_header("API keys", "Credentials for UniFi, Plex and the media applications")
session_bar(current)
st.divider()

# ---------------------------------------------------------------------------
# File posture
# ---------------------------------------------------------------------------

mode = file_mode(env_path)
if mode is None:
    st.info(
        f"No `.env` yet — it will be created at `{env_path}` when you save "
        "the first credential.",
        icon=":material/note_add:",
    )
elif mode != 0o600:
    st.warning(
        f"`.env` is mode {mode:o}, which is readable by other local accounts.",
        icon=":material/lock_open:",
    )
    if st.button("Tighten to 0600", icon=":material/lock:"):
        if secure_permissions(env_path):
            audit.record(
                "config.chmod", current.username, current.role, "success",
                severity="warning", target=str(env_path),
                detail=f"{mode:o} -> 600", breakglass=current.breakglass,
            )
            st.rerun()

with st.expander("Where these are stored, and what that does and does not protect"):
    st.markdown(
        f"""
Credentials are written to `{env_path}` with permissions `0600`, owned by the
account the dashboard runs as. That file is in `.gitignore`, and the three
previous versions are kept alongside it as `.env.bak*` so a bad edit is
recoverable.

**What that protects against:** other local users reading the file, and keys
reaching the git repository.

**What it does not protect against:** anything already running as the service
account. The dashboard has to be able to read these keys in order to use them,
so encryption with a key stored on the same host would be theatre — the
decryption key would sit next to the ciphertext. If you want defence beyond
file permissions, the real answer is a secrets manager the dashboard
authenticates to, which is a different piece of work.

Keys are never written to the application log or the audit log. Both record
only the key *name* and a fingerprint.
"""
    )

st.divider()

# ---------------------------------------------------------------------------
# Credential forms
# ---------------------------------------------------------------------------

stored = read_env_file(env_path)
groups = cred.by_service()

st.caption(
    f"{len([c for c in cred.CREDENTIALS if stored.get(c.env_key)])} of "
    f"{len(cred.CREDENTIALS)} credentials configured. "
    "Services you asked for first, then the rest."
)

for service, items in groups.items():
    configured = sum(1 for c in items if stored.get(c.env_key))
    icon = ":material/check_circle:" if configured == len(items) else ":material/pending:"
    with st.expander(
        f"{service} — {configured}/{len(items)} configured", expanded=configured == 0
    ):
        url_credential = next((c for c in items if c.url_key), None)

        # -- Base URL -----------------------------------------------------
        if url_credential and url_credential.url_key:
            url_key = url_credential.url_key
            from config import env_str

            current_url = stored.get(url_key) or env_str(
                url_key, url_credential.url_default
            )
            new_url = st.text_input(
                f"{service} URL",
                value=current_url,
                key=f"url_{url_key}",
                help=f"Environment variable `{url_key}`.",
                placeholder=url_credential.url_default or "http://host:port",
            )
        else:
            url_key, new_url, current_url = None, None, None

        for credential in items:
            existing = stored.get(credential.env_key)
            st.markdown(f"**{credential.label}**")
            st.caption(credential.where_to_find)
            if credential.note:
                st.caption(f":gray[{credential.note}]")

            if existing:
                st.markdown(
                    f":green-badge[:material/check: configured] "
                    f"`{len(existing)} chars` · fingerprint "
                    f"`{fingerprint(existing)}`"
                )

            entered = st.text_input(
                credential.label,
                value="" if credential.is_secret else (existing or ""),
                type="password" if credential.is_secret else "default",
                key=f"input_{credential.env_key}",
                placeholder=(
                    "unchanged — leave blank to keep" if existing else "not set"
                ),
                label_visibility="collapsed",
                help=f"Environment variable `{credential.env_key}`.",
            )

            problem = credential.shape_problem(entered)
            if problem:
                st.caption(f":orange[{problem}]")

            save, test, clear = st.columns([1, 1, 1])
            with save:
                do_save = st.button(
                    "Save",
                    key=f"save_{credential.env_key}",
                    icon=":material/save:",
                    width="stretch",
                    disabled=not entered and not (url_key and new_url != current_url),
                )
            with test:
                do_test = st.button(
                    "Test",
                    key=f"test_{credential.env_key}",
                    icon=":material/network_check:",
                    width="stretch",
                    disabled=credential.tester is None
                    or not (entered or existing),
                )
            with clear:
                do_clear = st.button(
                    "Remove",
                    key=f"clear_{credential.env_key}",
                    icon=":material/delete:",
                    width="stretch",
                    disabled=not existing,
                )

            # -- Save ------------------------------------------------------
            if do_save:
                if problem:
                    # Blocking, not advisory. An advisory caption next to a
                    # working Save button is how a truncated paste gets stored
                    # anyway — and a value that fails the shape check is also
                    # the value most likely to be a control-character
                    # injection attempt.
                    st.error(problem, icon=":material/block:")
                    st.stop()
                updates: dict[str, str | None] = {}
                if entered:
                    updates[credential.env_key] = entered
                if url_key and new_url is not None and new_url != current_url:
                    updates[url_key] = new_url
                if not updates:
                    st.info("Nothing to save.", icon=":material/info:")
                else:
                    try:
                        changed = update_env_file(env_path, updates)
                    except ValueError as exc:
                        # Control characters or a malformed key — refused by
                        # the writer before anything touched the file.
                        audit.record(
                            "config.credential_rejected",
                            current.username,
                            current.role,
                            "blocked",
                            severity="warning",
                            target=credential.env_key,
                            detail=str(exc),
                            breakglass=current.breakglass,
                        )
                        st.error(str(exc), icon=":material/block:")
                        changed = []
                    except OSError as exc:
                        st.error(f"Could not write `.env`: {exc}", icon=":material/error:")
                        changed = []
                    if changed:
                        reload_configuration()
                        audit.record(
                            "config.credential_set",
                            current.username,
                            current.role,
                            "success",
                            severity="warning",
                            target=", ".join(changed),
                            # Length and fingerprint only — never the value.
                            detail=(
                                f"{credential.env_key} updated "
                                f"({len(entered)} chars, fp "
                                f"{fingerprint(entered)})"
                                if entered
                                else f"{url_key} updated"
                            ),
                            breakglass=current.breakglass,
                        )
                        st.success(
                            f"Saved {', '.join(changed)} and reloaded configuration.",
                            icon=":material/check_circle:",
                        )
                        if credential.tester and entered:
                            with st.spinner("Testing the new credential…"):
                                result = credential.tester(new_url or "", entered)
                            if result.ok:
                                st.success(
                                    f"{result.message} {result.detail}",
                                    icon=result.icon,
                                )
                            else:
                                st.error(result.message, icon=result.icon)

            # -- Test ------------------------------------------------------
            if do_test and credential.tester:
                value = entered or existing or ""
                base = new_url if url_key else ""
                with st.spinner(f"Asking {credential.service}…"):
                    result = credential.tester(base or "", value)
                audit.record(
                    "config.credential_test",
                    current.username,
                    current.role,
                    "success" if result.ok else "failure",
                    target=credential.env_key,
                    detail=result.message,
                    breakglass=current.breakglass,
                )
                if result.ok:
                    st.success(f"{result.message} {result.detail}", icon=result.icon)
                else:
                    st.error(result.message, icon=result.icon)

            # -- Remove ----------------------------------------------------
            if do_clear:
                update_env_file(env_path, {credential.env_key: None})
                # reload rebuilds the effective-environment snapshot; a key
                # removed from the file is genuinely gone (config.py tracks
                # file-sourced keys, so the stale import-time copy cannot
                # shadow the removal).
                reload_configuration()
                audit.record(
                    "config.credential_removed",
                    current.username,
                    current.role,
                    "success",
                    severity="warning",
                    target=credential.env_key,
                    breakglass=current.breakglass,
                )
                st.success(
                    f"Removed {credential.env_key}.", icon=":material/check_circle:"
                )
                st.rerun()

            st.divider()

st.caption(
    ":gray[Saving a credential rebuilds the settings object and clears the "
    "collector caches, so the change is visible on the next page render.]"
)
