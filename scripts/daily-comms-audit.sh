#!/usr/bin/env bash
VERSION="1.1"
echo "daily-comms-audit.sh v$VERSION"

DB="${LLMMSG_DB:-/opt/llmmsg/db/llmmsg.sqlite}"

if [[ ! -f "$DB" ]]; then
    echo "DB not found: $DB" >&2
    exit 1
fi

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

echo ""
echo "=== Last 24h Communications Audit ==="
echo "Median avg chars/message: $MEDIAN"
echo ""

echo "--- Per-Agent Efficiency ---"
sqlite3 -header -column "$DB" "SELECT * FROM v_daily_efficiency;"

echo ""
echo "--- Flagged: Messages over 2000 chars ---"
sqlite3 -header -column "$DB" "
  SELECT id, sender, recipient, tag, LENGTH(body) AS chars,
    SUBSTR(COALESCE(json_extract(body, '$.summary'), json_extract(body, '$.message'), body), 1, 80) AS preview
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
    AND json_extract(body, '$.type') IS NOT NULL
    AND json_extract(body, '$.type') IN (
      SELECT json_extract(body, '$.type')
      FROM messages
      WHERE CAST(ts AS INTEGER) > CAST(strftime('%s', 'now', '-1 day') AS INTEGER)
        AND retracted_at IS NULL
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
    SUM(CASE WHEN json_extract(body, '$.summary') IS NOT NULL AND (json_extract(body, '$.details') IS NOT NULL OR json_extract(body, '$.message') IS NOT NULL) THEN 1 ELSE 0 END)
  FROM messages
  WHERE CAST(ts AS INTEGER) > CAST(strftime('%s', 'now', '-1 day') AS INTEGER)
    AND retracted_at IS NULL
  GROUP BY sender;
"
echo ""
echo "Audit snapshot saved (guide v$GUIDE_VERSION)"
