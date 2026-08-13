"""Bounded, redirect-refusing HTTP GET for credentialed collectors.

Two properties the plain `requests.get(...)` calls lacked:

* **Redirects are refused, not followed.** Requests does not reliably strip
  custom headers on a cross-host redirect, so a compromised or misconfigured
  service could bounce a request — with its `X-Api-Key` or `X-Plex-Token`
  attached — to a host of its choosing. A monitoring probe has no business
  following redirects anyway; a 3xx from Sonarr is a finding, not a detour.

* **The body is bounded in size and total time.** `timeout=` in requests is an
  *inactivity* timeout per socket operation, not a deadline: a peer that
  trickles one byte per second keeps the call alive forever while the default
  `stream=False` buffers everything it sends. Collectors here read via a
  streaming loop with a byte cap and a wall-clock deadline.

GET only, by design — this module serves read-only collectors, and keeping the
verb out of the signature means it cannot drift.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

import requests

DEFAULT_MAX_BYTES = 2 * 1024 * 1024
CHUNK = 64 * 1024


class ResponseTooLarge(RuntimeError):
    pass


class DeadlineExceeded(RuntimeError):
    pass


@dataclass
class BoundedResponse:
    status_code: int
    body: bytes = b""
    headers: dict[str, str] = field(default_factory=dict)

    def json(self):
        import json

        return json.loads(self.body.decode("utf-8", errors="replace"))

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")


def read_bounded(
    response,
    max_bytes: int = DEFAULT_MAX_BYTES,
    deadline: float | None = None,
) -> bytes:
    """Drain a streaming response under a byte cap and a wall-clock deadline.

    Takes any object with `iter_content(chunk_size)`, which keeps it unit
    testable without a socket.
    """
    chunks: list[bytes] = []
    size = 0
    for chunk in response.iter_content(CHUNK):
        if deadline is not None and time.monotonic() > deadline:
            raise DeadlineExceeded("total response deadline exceeded")
        if not chunk:
            continue
        size += len(chunk)
        if size > max_bytes:
            raise ResponseTooLarge(f"response body exceeded {max_bytes} bytes")
        chunks.append(chunk)
    return b"".join(chunks)


def get_bounded(
    url: str,
    *,
    headers: dict[str, str] | None = None,
    params: dict | None = None,
    timeout: float = 8.0,
    max_bytes: int = DEFAULT_MAX_BYTES,
    verify: bool | str = True,
    auth=None,
) -> BoundedResponse:
    """One GET: no redirects, bounded body, total deadline ≈ `timeout`.

    Raises `requests.RequestException`, `ResponseTooLarge` or
    `DeadlineExceeded`. 3xx responses are returned to the caller (with an
    empty body) rather than followed — deciding what a redirect *means* is the
    caller's job; transporting credentials to the new location is nobody's.
    """
    deadline = time.monotonic() + timeout
    with requests.get(
        url,
        headers=headers,
        params=params,
        stream=True,
        timeout=(min(3.05, timeout), min(5.0, timeout)),
        allow_redirects=False,
        verify=verify,
        auth=auth,
    ) as response:
        status = response.status_code
        response_headers = dict(response.headers)
        if 300 <= status < 400:
            return BoundedResponse(status_code=status, headers=response_headers)
        body = read_bounded(response, max_bytes=max_bytes, deadline=deadline)
    return BoundedResponse(status_code=status, body=body, headers=response_headers)
