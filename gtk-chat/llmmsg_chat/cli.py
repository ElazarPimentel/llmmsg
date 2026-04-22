"""
Headless PoC REPL. Validates the HubClient + SSEStream protocol before we wire
up GTK. Prints events as they arrive, accepts /send /history /online /roster
/aro /quit commands.
"""

VERSION = '0.0.3'

import argparse
import os
import queue
import signal
import sys
import threading
import time
from typing import Optional

from .hub_client import HubClient, HubError, SSEStream


HELP = """
commands:
  /send <target> <text>     send to agent or aro:X (multi-word text ok)
  /history <bucket> [N]     recent history (default 40)
  /online [aro]             list online agents (optionally in a given ARO)
  /roster                   list all registered agents
  /aro join <name>          join ARO
  /aro leave <name>         leave ARO
  /guide                    print the current messaging guide
  /quit                     unregister cleanly and exit
  /help | ?                 this list
"""


def main() -> int:
    parser = argparse.ArgumentParser(
        prog='llmmsg-chat-cli',
        description=f'Headless PoC for llmmsg GTK chat (v{VERSION})',
    )
    parser.add_argument('--agent', default=os.environ.get('LLMMSG_AGENT', ''))
    parser.add_argument('--cwd', default=os.environ.get('LLMMSG_CWD', os.getcwd()))
    parser.add_argument('--host', default=os.environ.get('LLMMSG_HUB_HOST', '127.0.0.1'))
    parser.add_argument('--port', type=int,
                        default=int(os.environ.get('LLMMSG_HUB_PORT', '9701')))
    parser.add_argument('-c', '--command', action='append', default=[],
                        help='Run a command string non-interactively '
                             '(e.g. "/online"). Repeatable. Implies --exit '
                             'after all commands and --listen window complete.')
    parser.add_argument('--listen', type=float, default=0.0,
                        help='When --command is used, keep the SSE stream '
                             'open this many seconds after the last command '
                             'to capture incoming events.')
    parser.add_argument('--exit', dest='exit_after', action='store_true',
                        help='Exit after --command batch (implied when -c used).')
    args = parser.parse_args()

    if not args.agent:
        print('error: --agent or LLMMSG_AGENT required', file=sys.stderr)
        return 2

    print(f'llmmsg-chat-cli v{VERSION}')
    print(f'  agent: {args.agent}')
    print(f'  hub:   {args.host}:{args.port}')
    print(f'  cwd:   {args.cwd}')

    client = HubClient(host=args.host, port=args.port)

    try:
        client.register(args.agent, args.cwd, old_agent=args.agent)
    except HubError as exc:
        print(f'register failed: {exc}', file=sys.stderr)
        return 1
    print(f'[ok] registered as {args.agent}')

    events_q: 'queue.Queue[tuple]' = queue.Queue()

    def on_event(evt):
        events_q.put(('event', evt))

    def on_status(line):
        events_q.put(('status', line))

    sse = SSEStream(args.host, args.port, args.agent, args.cwd, on_event, on_status)
    sse.start()

    def shutdown(*_args):
        sys.stdout.write('\n[shutdown] unregistering...\n')
        sys.stdout.flush()
        # Stop the SSE worker first so its readline returns on our terms (flag
        # already set, close() triggered), before /unregister makes the hub
        # close our stream from its side (which would race-print a noisy error).
        sse.stop()
        try:
            client.unregister(args.agent)
        except Exception as exc:
            sys.stderr.write(f'unregister failed: {exc}\n')
        os._exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    printer = threading.Thread(
        target=_printer, args=(events_q, args.agent), name='cli-printer', daemon=True,
    )
    printer.start()

    if args.command or args.exit_after:
        for cmd in args.command:
            sys.stdout.write(f'> {cmd}\n')
            try:
                _handle(cmd.strip(), client, args.agent, shutdown)
            except HubError as exc:
                sys.stdout.write(f'error: {exc}\n')
            except Exception as exc:
                sys.stdout.write(f'client error: {exc}\n')
        if args.listen > 0:
            sys.stdout.write(f'  · listening {args.listen:.0f}s for incoming events...\n')
            sys.stdout.flush()
            time.sleep(args.listen)
        shutdown()
        return 0

    _repl(client, args.agent, shutdown)
    return 0


def _printer(events_q: 'queue.Queue[tuple]', agent: str) -> None:
    while True:
        kind, payload = events_q.get()
        if kind == 'status':
            sys.stderr.write(f'  · {payload}\n')
            sys.stderr.flush()
        elif kind == 'event':
            _format_event(payload, agent)


def _format_event(evt: dict, agent: str) -> None:
    frm = evt.get('from', '?')
    to = evt.get('to', '?')
    tag = evt.get('tag', '')
    re = evt.get('re') or ''
    origin_aro = evt.get('origin_aro')
    body = evt.get('body')
    if isinstance(body, dict) and 'message' in body:
        text = body['message']
    else:
        text = str(body)

    if origin_aro:
        prefix = f'[{origin_aro}]'
    elif to == agent:
        prefix = '[DM]'
    else:
        prefix = f'[->{to}]'
    re_suffix = f' re={re}' if re else ''
    sys.stdout.write(f'\n{prefix} <{frm}> {text}  (tag={tag}{re_suffix})\n> ')
    sys.stdout.flush()


def _repl(client: HubClient, agent: str, shutdown) -> None:
    sys.stdout.write('ready. /help for commands.\n> ')
    sys.stdout.flush()
    for line in sys.stdin:
        line = line.rstrip('\n')
        if not line.strip():
            sys.stdout.write('> ')
            sys.stdout.flush()
            continue
        try:
            _handle(line.strip(), client, agent, shutdown)
        except HubError as exc:
            sys.stdout.write(f'error: {exc}\n')
        except Exception as exc:
            sys.stdout.write(f'client error: {exc}\n')
        sys.stdout.write('> ')
        sys.stdout.flush()
    # EOF on stdin
    shutdown()


def _handle(line: str, client: HubClient, agent: str, shutdown) -> None:
    if line in ('/help', '?'):
        sys.stdout.write(HELP)
        return
    if line == '/quit':
        shutdown()
        return
    if line == '/roster':
        for row in client.roster():
            sys.stdout.write(f'  {row.get("agent", "?"):30s} cwd={row.get("cwd", "")}\n')
        return
    if line.startswith('/online'):
        parts = line.split(maxsplit=1)
        aro = parts[1].strip() if len(parts) > 1 else None
        result = client.online(agent, aro)
        count = result.get('count', 0)
        names = ', '.join(result.get('online', []) or [])
        sys.stdout.write(f'  online ({count}): {names}\n')
        return
    if line.startswith('/history'):
        parts = line.split(maxsplit=2)
        if len(parts) < 2:
            sys.stdout.write('usage: /history <bucket> [limit]\n')
            return
        bucket = parts[1]
        limit = int(parts[2]) if len(parts) > 2 else 40
        rows = client.history(agent, bucket, limit)
        for row in rows:
            body = row.get('body', {})
            text = body.get('message') if isinstance(body, dict) else str(body)
            snip = (text or '')[:100].replace('\n', ' ')
            sys.stdout.write(f'  #{row.get("id")} <{row.get("from", "?")}> {snip}\n')
        return
    if line.startswith('/aro '):
        parts = line.split(maxsplit=2)
        if len(parts) < 3 or parts[1] not in ('join', 'leave'):
            sys.stdout.write('usage: /aro join|leave <name>\n')
            return
        op, name = parts[1], parts[2].strip()
        if op == 'join':
            result = client.aro_join(agent, name)
        else:
            result = client.aro_leave(agent, name)
        sys.stdout.write(f'  {op} {name}: {result}\n')
        return
    if line == '/guide':
        g = client.guide()
        text = g.get('guide') or g.get('value') or str(g)
        sys.stdout.write(text + '\n')
        return
    if line.startswith('/send '):
        parts = line.split(maxsplit=2)
        if len(parts) < 3:
            sys.stdout.write('usage: /send <target> <text>\n')
            return
        target, text = parts[1], parts[2]
        result = client.send(agent, target, text)
        tag = result.get('tag') or result.get('tags') or result.get('ids')
        sys.stdout.write(f'  sent: tag={tag}\n')
        return
    sys.stdout.write(f'unknown: {line!r}. /help for commands.\n')


if __name__ == '__main__':
    sys.exit(main())
