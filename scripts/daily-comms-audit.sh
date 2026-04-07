#!/usr/bin/env bash
VERSION="1.6"

DB="${LLMMSG_DB:-/opt/llmmsg/db/llmmsg.sqlite}"
REPORT_DIR="${LLMMSG_REPORT_DIR:-/opt/llmmsg/sqlite-report}"
REPORT_FILE="$REPORT_DIR/$(date +%F)-llmmsg-sqlite-report.txt"

if [[ ! -f "$DB" ]]; then
    echo "DB not found: $DB" >&2
    exit 1
fi

mkdir -p "$REPORT_DIR"
exec > >(tee "$REPORT_FILE") 2>&1

echo "daily-comms-audit.sh v$VERSION"
echo "Report file: $REPORT_FILE"

# Median avg_chars across agents (for comparison)
MEDIAN=$(sqlite3 "$DB" "
  WITH agent_avgs AS (
    SELECT ROUND(AVG(LENGTH(body))) AS avg_chars
    FROM messages
    WHERE CAST(ts AS INTEGER) > CAST(strftime('%s', 'now', '-1 day') AS INTEGER)
      AND retracted_at IS NULL
    GROUP BY sender
    ORDER BY avg_chars
  ),
  counted AS (SELECT COUNT(*) AS n FROM agent_avgs)
  SELECT avg_chars FROM agent_avgs
  LIMIT 1 OFFSET (SELECT n/2 FROM counted);
")
MEDIAN="${MEDIAN:-0}"

# Average avg_chars across agents
AVERAGE=$(sqlite3 "$DB" "
  WITH agent_avgs AS (
    SELECT ROUND(AVG(LENGTH(body))) AS avg_chars
    FROM messages
    WHERE CAST(ts AS INTEGER) > CAST(strftime('%s', 'now', '-1 day') AS INTEGER)
      AND retracted_at IS NULL
    GROUP BY sender
  )
  SELECT ROUND(AVG(avg_chars)) FROM agent_avgs;
")
AVERAGE="${AVERAGE:-0}"

echo ""
echo "=== Last 24h Communications Audit ==="
echo "Median avg chars/message: $MEDIAN"
echo "Average avg chars/message: $AVERAGE"
echo ""

echo "--- Per-Agent Efficiency ---"
sqlite3 -header -column "$DB" "
  SELECT
    sender,
    COUNT(*) AS msgs,
    ROUND(AVG(LENGTH(body))) AS avg_chars,
    MAX(LENGTH(body)) AS max_chars,
    SUM(LENGTH(body)) AS total_chars,
    ROUND(SUM(LENGTH(body)) / 4.0) AS est_tokens,
    SUM(CASE WHEN re IS NOT NULL THEN 1 ELSE 0 END) AS replies,
    SUM(CASE WHEN re IS NULL THEN 1 ELSE 0 END) AS initiated,
    ROUND(AVG(CASE WHEN re IS NOT NULL THEN LENGTH(body) END)) AS avg_reply_chars,
    ROUND(AVG(CASE WHEN re IS NULL THEN LENGTH(body) END)) AS avg_init_chars,
    SUM(CASE WHEN LENGTH(body) > 2000 THEN 1 ELSE 0 END) AS over_2k,
    SUM(
      CASE
        WHEN json_valid(body)
         AND json_extract(body, '$.summary') IS NOT NULL
         AND json_extract(body, '$.details') IS NOT NULL
        THEN 1
        ELSE 0
      END
    ) AS has_summary_and_details,
    SUM(
      CASE
        WHEN json_valid(body)
         AND json_extract(body, '$.summary') IS NOT NULL
         AND json_extract(body, '$.message') IS NOT NULL
        THEN 1
        ELSE 0
      END
    ) AS has_summary_and_message
  FROM messages
  WHERE CAST(ts AS INTEGER) > CAST(strftime('%s', 'now', '-1 day') AS INTEGER)
    AND retracted_at IS NULL
  GROUP BY sender
  ORDER BY total_chars DESC;
"

echo ""
echo "--- Flagged: Messages over 2000 chars ---"
sqlite3 -header -column "$DB" "
  SELECT id, sender, recipient, tag, LENGTH(body) AS chars,
    SUBSTR(
      COALESCE(
        CASE WHEN json_valid(body) THEN json_extract(body, '$.summary') END,
        CASE WHEN json_valid(body) THEN json_extract(body, '$.message') END,
        body
      ),
      1,
      80
    ) AS preview
  FROM messages
  WHERE CAST(ts AS INTEGER) > CAST(strftime('%s', 'now', '-1 day') AS INTEGER)
    AND retracted_at IS NULL
    AND LENGTH(body) > 2000
  ORDER BY LENGTH(body) DESC;
"

echo ""
echo "--- Flagged: Duplicate summary+details pattern ---"
sqlite3 -header -column "$DB" "
  SELECT id, sender, tag, LENGTH(body) AS chars
  FROM messages
  WHERE CAST(ts AS INTEGER) > CAST(strftime('%s', 'now', '-1 day') AS INTEGER)
    AND retracted_at IS NULL
    AND json_valid(body)
    AND json_extract(body, '$.summary') IS NOT NULL
    AND json_extract(body, '$.details') IS NOT NULL
  ORDER BY chars DESC;
"

echo ""
echo "--- Flagged: Agents 2x above median avg chars ---"
sqlite3 -header -column "$DB" "
  SELECT sender, COUNT(*) AS msgs, ROUND(AVG(LENGTH(body))) AS avg_chars,
    ROUND(AVG(LENGTH(body)) / $MEDIAN, 1) AS vs_median
  FROM messages
  WHERE CAST(ts AS INTEGER) > CAST(strftime('%s', 'now', '-1 day') AS INTEGER)
    AND retracted_at IS NULL
  GROUP BY sender
  HAVING AVG(LENGTH(body)) > ($MEDIAN * 2)
  ORDER BY avg_chars DESC;
"

echo ""
echo "--- Flagged: One-off type values (used only once in 24h) ---"
sqlite3 -header -column "$DB" "
  SELECT json_extract(body, '$.type') AS type, sender, tag
  FROM messages
  WHERE CAST(ts AS INTEGER) > CAST(strftime('%s', 'now', '-1 day') AS INTEGER)
    AND retracted_at IS NULL
    AND json_valid(body)
    AND json_extract(body, '$.type') IS NOT NULL
    AND json_extract(body, '$.type') IN (
      SELECT json_extract(body, '$.type')
      FROM messages
      WHERE CAST(ts AS INTEGER) > CAST(strftime('%s', 'now', '-1 day') AS INTEGER)
        AND retracted_at IS NULL
        AND json_valid(body)
        AND json_extract(body, '$.type') IS NOT NULL
      GROUP BY json_extract(body, '$.type')
      HAVING COUNT(*) = 1
    )
  ORDER BY sender;
"

echo ""
echo "--- Summary ---"
sqlite3 "$DB" "
  SELECT json_object(
    'period', '24h',
    'total_messages', (SELECT COUNT(*) FROM messages WHERE CAST(ts AS INTEGER) > CAST(strftime('%s', 'now', '-1 day') AS INTEGER) AND retracted_at IS NULL),
    'total_chars', (SELECT SUM(LENGTH(body)) FROM messages WHERE CAST(ts AS INTEGER) > CAST(strftime('%s', 'now', '-1 day') AS INTEGER) AND retracted_at IS NULL),
    'est_tokens', (SELECT ROUND(SUM(LENGTH(body)) / 4.0) FROM messages WHERE CAST(ts AS INTEGER) > CAST(strftime('%s', 'now', '-1 day') AS INTEGER) AND retracted_at IS NULL),
    'median_avg_chars', $MEDIAN,
    'agents_above_2x_median', (
      SELECT COUNT(*) FROM (
        SELECT sender FROM messages
        WHERE CAST(ts AS INTEGER) > CAST(strftime('%s', 'now', '-1 day') AS INTEGER) AND retracted_at IS NULL
        GROUP BY sender HAVING AVG(LENGTH(body)) > ($MEDIAN * 2)
      )
    )
  );
"

# Compare with last audit snapshot
LAST_AUDIT_TS=$(sqlite3 "$DB" "SELECT MAX(ts) FROM audit_snapshots;" 2>/dev/null)
if [[ -n "$LAST_AUDIT_TS" && "$LAST_AUDIT_TS" != "" ]]; then
    LAST_GUIDE=$(sqlite3 "$DB" "SELECT guide_version FROM audit_snapshots WHERE ts = '$LAST_AUDIT_TS' LIMIT 1;")
    LAST_TIME=$(sqlite3 "$DB" "SELECT datetime($LAST_AUDIT_TS, 'unixepoch', 'localtime');")
    echo ""
    echo "--- Comparison vs Last Audit ($LAST_TIME, guide v$LAST_GUIDE) ---"
    sqlite3 -header -column "$DB" "
      WITH current AS (
        SELECT sender,
          COUNT(*) AS msgs,
          ROUND(AVG(LENGTH(body))) AS avg_chars,
          SUM(LENGTH(body)) AS total_chars,
          ROUND(SUM(LENGTH(body)) / 4.0) AS est_tokens,
          SUM(CASE WHEN LENGTH(body) > 2000 THEN 1 ELSE 0 END) AS over_2k
        FROM messages
        WHERE CAST(ts AS INTEGER) > CAST(strftime('%s', 'now', '-1 day') AS INTEGER)
          AND retracted_at IS NULL
        GROUP BY sender
      ),
      prev AS (
        SELECT agent, msgs, avg_chars, total_chars, est_tokens, over_2k
        FROM audit_snapshots
        WHERE ts = '$LAST_AUDIT_TS'
      )
      SELECT
        c.sender AS agent,
        c.msgs AS msgs_now,
        COALESCE(p.msgs, 0) AS msgs_prev,
        c.msgs - COALESCE(p.msgs, 0) AS msgs_delta,
        c.avg_chars AS avg_now,
        COALESCE(p.avg_chars, 0) AS avg_prev,
        ROUND(c.avg_chars - COALESCE(p.avg_chars, 0)) AS avg_delta,
        c.est_tokens AS tok_now,
        COALESCE(p.est_tokens, 0) AS tok_prev,
        ROUND(c.est_tokens - COALESCE(p.est_tokens, 0)) AS tok_delta,
        c.over_2k AS big_now,
        COALESCE(p.over_2k, 0) AS big_prev
      FROM current c
      LEFT JOIN prev p ON c.sender = p.agent
      ORDER BY tok_delta DESC;
    "
else
    echo ""
    echo "--- No previous audit snapshot for comparison ---"
fi

echo ""

# Write per-agent metrics to audit_snapshots
GUIDE_VERSION=$(sqlite3 "$DB" "SELECT version FROM config WHERE key = 'message_guide';" 2>/dev/null || echo "unknown")

sqlite3 "$DB" "
  INSERT INTO audit_snapshots (guide_version, agent, msgs, avg_chars, total_chars, est_tokens, over_2k, has_dup_fields)
  SELECT
    '$GUIDE_VERSION',
    sender,
    COUNT(*),
    ROUND(AVG(LENGTH(body))),
    SUM(LENGTH(body)),
    ROUND(SUM(LENGTH(body)) / 4.0),
    SUM(CASE WHEN LENGTH(body) > 2000 THEN 1 ELSE 0 END),
    SUM(
      CASE
        WHEN json_valid(body)
         AND json_extract(body, '$.summary') IS NOT NULL
         AND (
           json_extract(body, '$.details') IS NOT NULL
           OR json_extract(body, '$.message') IS NOT NULL
         )
        THEN 1
        ELSE 0
      END
    )
  FROM messages
  WHERE CAST(ts AS INTEGER) > CAST(strftime('%s', 'now', '-1 day') AS INTEGER)
    AND retracted_at IS NULL
  GROUP BY sender;
"
echo ""
echo "Audit snapshot saved (guide v$GUIDE_VERSION)"

REPORT_DIR_KB=$(du -sk "$REPORT_DIR" | awk '{print $1}')
if (( REPORT_DIR_KB >= 10240 )); then
    REPORT_DIR_MB=$(awk "BEGIN { printf \"%.1f\", $REPORT_DIR_KB / 1024 }")
    echo "WARNING: $REPORT_DIR is ${REPORT_DIR_MB} MB. Consider cleaning old reports."
fi
