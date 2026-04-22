"""
Hub protocol client for llmmsg-chat (GTK replacement PoC).

Stdlib-only. Two public classes:

- HubClient: synchronous HTTP wrapper for register/unregister/send/history/etc.
- SSEStream: worker-thread SSE consumer with a 60-second silence watchdog and
  automatic reconnect. Mirrors the shape of channel.mjs's resilient client.

Both are UI-agnostic. The GTK layer (or this file's CLI sibling) owns the
thread boundary: when SSEStream fires on_event from the worker, the UI side is
responsible for dispatching back to its main thread.
"""

VERSION = '0.0.3'

import http.client
import json
import threading
import time
import urllib.parse
from typing import Callable, Optional


class HubError(Exception):
    pass


class HubClient:
    def __init__(self, host: str = '127.0.0.1', port: int = 9701, timeout: float = 10.0):
        self.host = host
        self.port = port
        self.timeout = timeout

    def _request(self, method: str, path: str, body: Optional[dict] = None) -> Optional[dict]:
        conn = http.client.HTTPConnection(self.host, self.port, timeout=self.timeout)
        headers: dict = {}
        data: Optional[bytes] = None
        if body is not None:
            data = json.dumps(body).encode('utf-8')
            headers['Content-Type'] = 'application/json'
            headers['Content-Length'] = str(len(data))
        try:
            conn.request(method, path, body=data, headers=headers)
            resp = conn.getresponse()
            text = resp.read().decode('utf-8', errors='replace')
            status = resp.status
        finally:
            conn.close()

        parsed: Optional[dict]
        if not text:
            parsed = None
        else:
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError:
                parsed = {'raw': text}
        if status >= 400:
            raise HubError(f'{method} {path} -> {status}: {parsed}')
        return parsed

    # --- endpoints ---

    def register(self, agent: str, cwd: str, old_agent: Optional[str] = None) -> dict:
        return self._request('POST', '/register', {
            'agent': agent, 'cwd': cwd, 'old_agent': old_agent,
        }) or {}

    def unregister(self, agent: str) -> dict:
        return self._request('POST', '/unregister', {'agent': agent}) or {}

    def send(self, from_: str, to: str, message, re: Optional[str] = None) -> dict:
        body = {'from': from_, 'to': to, 'message': message}
        if re:
            body['re'] = re
        return self._request('POST', '/send', body) or {}

    def history(self, agent: str, bucket: str, limit: int = 80) -> list:
        q = urllib.parse.urlencode({'agent': agent, 'bucket': bucket, 'limit': limit})
        result = self._request('GET', f'/history?{q}')
        return result if isinstance(result, list) else []

    def online(self, agent: str, aro: Optional[str] = None) -> dict:
        params = {'agent': agent}
        if aro:
            params['aro'] = aro
        q = urllib.parse.urlencode(params)
        return self._request('GET', f'/online?{q}') or {}

    def roster(self) -> list:
        result = self._request('GET', '/roster')
        return result if isinstance(result, list) else []

    def guide(self) -> dict:
        return self._request('GET', '/guide') or {}

    def aro_join(self, agent: str, aro: str) -> dict:
        return self._request('POST', '/aro/join', {'agent': agent, 'aro': aro}) or {}

    def aro_leave(self, agent: str, aro: str) -> dict:
        return self._request('POST', '/aro/leave', {'agent': agent, 'aro': aro}) or {}

    def aro_list(self) -> dict:
        """All known ARO groups. Returns {aro_name: [member_agents, ...]}."""
        result = self._request('GET', '/aro')
        return result if isinstance(result, dict) else {}


class SSEStream:
    """
    Worker-thread SSE consumer.

    Call start() once after construction. stop() is idempotent and signals the
    worker to tear down; clean exit joins the thread within a couple of seconds.

    Callbacks:
      on_event(event_dict)  — fires on every data: frame; JSON-parsed payload
      on_status(line)       — fires on connect / disconnect / watchdog / errors;
                              plain string for logging, never for UX

    Reconnect policy: on any error (connection, idle timeout, end-of-stream),
    the worker waits BACKOFF seconds and reconnects. A 60s silence watchdog
    closes the underlying socket if no bytes arrive in that window, which is
    the same shape as channel.mjs's zombie-socket guard.
    """

    IDLE_TIMEOUT = 60.0
    BACKOFF = 5.0

    def __init__(
        self,
        host: str,
        port: int,
        agent: str,
        cwd: str,
        on_event: Callable[[dict], None],
        on_status: Optional[Callable[[str], None]] = None,
    ):
        self.host = host
        self.port = port
        self.agent = agent
        self.cwd = cwd
        self.on_event = on_event
        self.on_status = on_status or (lambda _s: None)
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._conn: Optional[http.client.HTTPConnection] = None
        self._last_bytes = 0.0

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name='sse-worker', daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        try:
            if self._conn is not None:
                self._conn.close()
        except Exception:
            pass
        if self._thread is not None:
            self._thread.join(timeout=2.0)

    # --- worker ---

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self._stream_once()
            except AttributeError:
                # http.client's HTTPResponse.read*() raises AttributeError on a
                # response whose underlying socket was closed from another
                # thread (fp becomes None). Treat as a clean disconnect.
                pass
            except (OSError, HubError) as exc:
                if not self._stop.is_set():
                    self.on_status(f'sse error: {exc}')
            except Exception as exc:
                if not self._stop.is_set():
                    self.on_status(f'sse error: {exc}')
            if self._stop.is_set():
                return
            self.on_status(f'sse reconnect in {self.BACKOFF:.0f}s')
            self._stop.wait(self.BACKOFF)

    def _stream_once(self) -> None:
        q = urllib.parse.urlencode({'agent': self.agent, 'cwd': self.cwd})
        conn = http.client.HTTPConnection(self.host, self.port, timeout=None)
        self._conn = conn
        conn.request('GET', f'/connect?{q}')
        resp = conn.getresponse()
        if resp.status != 200:
            raise HubError(f'/connect -> {resp.status}')
        self.on_status(f'sse connected as {self.agent}')
        self._last_bytes = time.monotonic()

        # Per-connection watchdog cancel flag. Each _stream_once has its own so
        # an old watchdog from a dead connection cannot affect a reconnect.
        wd_cancel = threading.Event()
        watchdog = threading.Thread(
            target=self._watchdog, args=(conn, wd_cancel),
            name='sse-watchdog', daemon=True,
        )
        watchdog.start()

        buf: list[str] = []
        try:
            while not self._stop.is_set():
                # readline() returns each \n-terminated line as soon as the hub
                # flushes it, so the 25s ping frames land immediately. A full
                # empty line (\n) marks end of frame; b'' means EOF.
                line = resp.readline()
                if line == b'':
                    raise HubError('sse end-of-stream')
                self._last_bytes = time.monotonic()
                if line in (b'\n', b'\r\n'):
                    if buf:
                        self._dispatch_frame(''.join(buf))
                        buf = []
                    continue
                buf.append(line.decode('utf-8', errors='replace'))
        finally:
            wd_cancel.set()
            try:
                resp.close()
            except Exception:
                pass
            try:
                conn.close()
            except Exception:
                pass
            if self._conn is conn:
                self._conn = None

    def _dispatch_frame(self, frame_text: str) -> None:
        for line in frame_text.splitlines():
            if not line.startswith('data: '):
                continue  # comment (": ping ...") or id/event/retry lines — ignored
            payload = line[6:]
            try:
                event = json.loads(payload)
            except json.JSONDecodeError:
                continue
            try:
                self.on_event(event)
            except Exception as exc:
                self.on_status(f'handler error: {exc}')

    def _watchdog(self, conn: http.client.HTTPConnection, cancel: threading.Event) -> None:
        # Tick every 15s. Exit cleanly when (a) stop flag set, (b) per-connection
        # cancel fires because _stream_once finished, or (c) idle-threshold hit.
        while not self._stop.is_set() and not cancel.is_set():
            cancel.wait(15.0)
            if self._stop.is_set() or cancel.is_set():
                return
            if time.monotonic() - self._last_bytes > self.IDLE_TIMEOUT:
                self.on_status(f'sse idle >{self.IDLE_TIMEOUT:.0f}s, forcing reconnect')
                try:
                    conn.close()
                except Exception:
                    pass
                return
