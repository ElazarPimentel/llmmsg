#!/usr/bin/env python3
"""llmmsg-cli.py — Read and send llmmsg messages from Python (for Codex/non-CC agents).
Usage:
  llmmsg-cli.py register <agent> <cwd>
  llmmsg-cli.py unregister <agent>
  llmmsg-cli.py roster
  llmmsg-cli.py read <agent>
  llmmsg-cli.py send <from> <to> [re:<tag>] <body>
  llmmsg-cli.py retract <tag> <sender>
  llmmsg-cli.py thread <tag>
  llmmsg-cli.py search <text>
  llmmsg-cli.py log [limit]
  llmmsg-cli.py agents
"""
VERSION = "2.2"

import sqlite3
import sys
import os
import json

DB = os.environ.get("LLMMSG_DB", os.path.expanduser("~/Documents/work/llmmsg/llmmsg.sqlite"))


def get_db():
    if not os.path.exists(DB):
        print(json.dumps({"error": f"DB not found at {DB}. Run: llmmsg.sh init"}), file=sys.stderr)
        sys.exit(1)
    con = sqlite3.connect(DB)
    con.execute("PRAGMA busy_timeout=5000")
    con.row_factory = sqlite3.Row
    return con


def row_to_msg(r, include_body=True):
    msg = {
        "id": r["id"], "from": r["sender"], "to": r["recipient"],
        "tag": r["tag"], "re": r["re"],
    }
    if "retracted_at" in r.keys() and r["retracted_at"] is not None:
        msg["retracted"] = True
        msg["retracted_by"] = r["retracted_by"]
        if include_body:
            msg["body"] = None
        else:
            msg["preview"] = "<retracted>"
        return msg
    try:
        body = json.loads(r["body"])
    except Exception:
        body = r["body"]
    if include_body:
        msg["body"] = body
    else:
        preview = body.get("summary", json.dumps(body))[:120] if isinstance(body, dict) else str(body)[:120]
        msg["preview"] = preview
    return msg


def cmd_read(agent):
    con = get_db()
    row = con.execute("SELECT last_id FROM cursors WHERE agent = ?", (agent,)).fetchone()
    last_id = row["last_id"] if row else 0

    rows = con.execute(
        "SELECT id, sender, recipient, tag, re, body FROM messages "
        "WHERE (recipient = ? OR recipient = '*') AND id > ? AND retracted_at IS NULL ORDER BY id",
        (agent, last_id)
    ).fetchall()

    messages = [row_to_msg(r) for r in rows]
    max_id = max((r["id"] for r in rows), default=last_id)

    con.execute(
        "INSERT INTO cursors (agent, last_id) VALUES (?, ?) "
        "ON CONFLICT(agent) DO UPDATE SET last_id = MAX(cursors.last_id, excluded.last_id)",
        (agent, max_id)
    )
    con.commit()
    con.close()
    print(json.dumps(messages, ensure_ascii=False))


def fail(msg):
    print(json.dumps({"error": msg}), file=sys.stderr)
    sys.exit(1)


def cmd_register(agent, cwd):
    con = get_db()
    con.execute(
        "INSERT INTO roster (agent, cwd) VALUES (?, ?) "
        "ON CONFLICT(agent) DO UPDATE SET cwd = excluded.cwd, registered_at = strftime('%s','now')",
        (agent, cwd)
    )
    con.commit()
    print(json.dumps({"ok": True, "action": "registered", "agent": agent, "cwd": cwd}))


def cmd_unregister(agent):
    con = get_db()
    cur = con.execute("DELETE FROM roster WHERE agent = ?", (agent,))
    con.commit()
    if cur.rowcount == 0:
        fail(f"agent '{agent}' not in roster")
    print(json.dumps({"ok": True, "action": "unregistered", "agent": agent}))


def cmd_roster():
    con = get_db()
    rows = con.execute("SELECT agent, cwd FROM roster ORDER BY agent").fetchall()
    print(json.dumps([{"agent": r["agent"], "cwd": r["cwd"]} for r in rows], ensure_ascii=False))


def cmd_send(sender, recipient, re_tag, body_raw):
    try:
        payload = json.loads(body_raw)
    except Exception as e:
        fail(f"body must be valid JSON: {e}")
    if not isinstance(payload, dict):
        fail("body must be a JSON object")

    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))

    con = get_db()

    roster = [r[0] for r in con.execute("SELECT agent FROM roster").fetchall()]
    if roster:
        if sender not in roster:
            fail(f"sender '{sender}' not registered. Run: llmmsg-cli.py register {sender} /path/to/cwd")
        if recipient != '*' and recipient not in roster:
            names = ", ".join(roster)
            fail(f"recipient '{recipient}' not in roster. Ask your user for the correct session name. Registered: {names}")

    cur = con.cursor()
    cur.execute("BEGIN")
    cur.execute(
        "INSERT INTO messages (sender, recipient, tag, re, body) "
        "VALUES (?, ?, '_pending', ?, ?) RETURNING id",
        (sender, recipient, re_tag, body)
    )
    row_id = cur.fetchone()[0]
    tag = f"{sender}-{row_id}"
    cur.execute("UPDATE messages SET tag = ? WHERE id = ?", (tag, row_id))
    cur.execute("COMMIT")
    con.close()
    print(json.dumps({"ok": True, "id": row_id, "tag": tag}))


def cmd_retract(tag, sender):
    con = get_db()
    row = con.execute(
        "SELECT sender, retracted_at FROM messages WHERE tag = ?",
        (tag,)
    ).fetchone()
    if row is None:
        fail(f"tag '{tag}' not found")
    if row["sender"] != sender:
        fail(f"tag '{tag}' was sent by '{row['sender']}', not '{sender}'")
    already_retracted = row["retracted_at"] is not None
    if not already_retracted:
        con.execute(
            "UPDATE messages "
            "SET retracted_at = strftime('%s','now'), retracted_by = ? "
            "WHERE tag = ?",
            (sender, tag)
        )
        con.commit()
    print(json.dumps({"ok": True, "action": "retracted", "tag": tag, "sender": sender, "already_retracted": already_retracted}))


def cmd_thread(tag):
    con = get_db()
    rows = con.execute(
        "WITH RECURSIVE thread_tags(t) AS ("
        "  VALUES(?)"
        "  UNION"
        "  SELECT m.tag FROM messages m JOIN thread_tags tt ON m.re = tt.t"
        ") "
        "SELECT id, sender, recipient, tag, re, body, retracted_at, retracted_by FROM messages "
        "WHERE tag IN (SELECT t FROM thread_tags) OR re IN (SELECT t FROM thread_tags) "
        "ORDER BY id",
        (tag,)
    ).fetchall()
    print(json.dumps([row_to_msg(r) for r in rows], ensure_ascii=False))


def cmd_search(text):
    con = get_db()
    rows = con.execute(
        "SELECT id, sender, recipient, tag, re, body FROM messages "
        "WHERE body LIKE ? AND retracted_at IS NULL ORDER BY id",
        (f"%{text}%",)
    ).fetchall()
    print(json.dumps([row_to_msg(r) for r in rows], ensure_ascii=False))


def cmd_log(limit):
    con = get_db()
    rows = con.execute(
        "SELECT id, sender, recipient, tag, re, body, retracted_at, retracted_by FROM messages "
        "ORDER BY id DESC LIMIT ?",
        (limit,)
    ).fetchall()
    print(json.dumps([row_to_msg(r, include_body=False) for r in rows], ensure_ascii=False))


def cmd_agents():
    con = get_db()
    rows = con.execute("SELECT agent, last_id FROM cursors ORDER BY agent").fetchall()
    print(json.dumps([{"agent": r["agent"], "last_id": r["last_id"]} for r in rows], ensure_ascii=False))


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        print(f"llmmsg-cli.py v{VERSION}")
        print(__doc__)
        sys.exit(0)

    cmd = sys.argv[1]
    if cmd == "register" and len(sys.argv) >= 4:
        cmd_register(sys.argv[2], sys.argv[3])
    elif cmd == "unregister" and len(sys.argv) >= 3:
        cmd_unregister(sys.argv[2])
    elif cmd == "roster":
        cmd_roster()
    elif cmd == "read" and len(sys.argv) >= 3:
        cmd_read(sys.argv[2])
    elif cmd == "send" and len(sys.argv) >= 4:
        # llmmsg-cli.py send <from> <to> [re:<tag>] <body>
        sender = sys.argv[2]
        recipient = sys.argv[3]
        re_tag = None
        body_idx = 4
        if len(sys.argv) > 4 and sys.argv[4].startswith("re:"):
            re_tag = sys.argv[4][3:]
            body_idx = 5
        if len(sys.argv) <= body_idx:
            fail("missing JSON body")
        cmd_send(sender, recipient, re_tag, sys.argv[body_idx])
    elif cmd == "retract" and len(sys.argv) >= 4:
        cmd_retract(sys.argv[2], sys.argv[3])
    elif cmd == "thread" and len(sys.argv) >= 3:
        cmd_thread(sys.argv[2])
    elif cmd == "search" and len(sys.argv) >= 3:
        cmd_search(sys.argv[2])
    elif cmd == "log":
        limit = 20
        if len(sys.argv) >= 3:
            try:
                limit = int(sys.argv[2])
            except ValueError:
                fail("log limit must be an integer")
        cmd_log(limit)
    elif cmd == "agents":
        cmd_agents()
    else:
        print(json.dumps({"error": f"unknown or incomplete command: {cmd}"}), file=sys.stderr)
        sys.exit(1)
