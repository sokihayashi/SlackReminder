const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const { DEFAULT_ADVANCE_NOTICE_HOURS } = require('./utils');

const db = new Database(path.join(__dirname, '..', 'reminders.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS reminders (
    id TEXT PRIMARY KEY,
    task TEXT NOT NULL,
    assignee_name TEXT,
    assignee_slack_user_id TEXT,
    due_at TEXT NOT NULL,
    source_channel_id TEXT NOT NULL,
    source_message_ts TEXT NOT NULL,
    source_thread_ts TEXT NOT NULL,
    confirmation_message_ts TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    created_by TEXT NOT NULL,
    ai_confidence REAL,
    advance_notified INTEGER NOT NULL DEFAULT 0,
    advance_notice_hours INTEGER,
    notification_target TEXT NOT NULL DEFAULT 'dm',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pending_questions (
    channel_id TEXT NOT NULL,
    thread_ts TEXT NOT NULL,
    original_text TEXT NOT NULL,
    source_message_ts TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (channel_id, thread_ts)
  );

  CREATE TABLE IF NOT EXISTS bot_sent_messages (
    channel_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (channel_id, ts)
  );
`);

// Migrations for existing databases
for (const sql of [
  `ALTER TABLE reminders ADD COLUMN advance_notified INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE reminders ADD COLUMN advance_notice_hours INTEGER`,
  `ALTER TABLE reminders ADD COLUMN notification_target TEXT NOT NULL DEFAULT 'dm'`,
]) {
  try { db.exec(sql); } catch (err) {
    if (!err.message.includes('duplicate column name')) throw err;
  }
}

function toUtcISO(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) throw new Error(`Invalid date: ${dateStr}`);
  return d.toISOString();
}

// ── Settings ───────────────────────────────────────────────────────────────

function getSetting(key, defaultValue = null) {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
  return row ? row.value : defaultValue;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, String(value), new Date().toISOString());
}

function getAllSettings() {
  return db.prepare(`SELECT key, value FROM settings ORDER BY key`).all();
}

// ── Reminders ───────────────────────────────────────────────────────────────

function createReminder({ task, assigneeName, assigneeSlackUserId, dueAt, sourceChannelId, sourceMessageTs, sourceThreadTs, createdBy, confidence, advanceNoticeHours, notificationTarget = 'dm' }) {
  const now = new Date().toISOString();
  const id = uuidv4();
  db.prepare(`
    INSERT INTO reminders
      (id, task, assignee_name, assignee_slack_user_id, due_at, source_channel_id, source_message_ts,
       source_thread_ts, status, created_by, ai_confidence, advance_notified, advance_notice_hours, notification_target, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, 0, ?, ?, ?, ?)
  `).run(
    id, task, assigneeName, assigneeSlackUserId,
    toUtcISO(dueAt),
    sourceChannelId, sourceMessageTs, sourceThreadTs,
    createdBy, confidence,
    advanceNoticeHours ?? null,
    notificationTarget,
    now, now,
  );
  return id;
}

function setNotificationTarget(id, target) {
  db.prepare(`UPDATE reminders SET notification_target = ?, updated_at = ? WHERE id = ?`)
    .run(target, new Date().toISOString(), id);
}

function setConfirmationTs(id, confirmationMessageTs) {
  db.prepare(`UPDATE reminders SET confirmation_message_ts = ?, updated_at = ? WHERE id = ?`)
    .run(confirmationMessageTs, new Date().toISOString(), id);
}

function findByConfirmationTs(channelId, messageTs) {
  return db.prepare(`
    SELECT * FROM reminders
    WHERE source_channel_id = ? AND confirmation_message_ts = ?
    AND status IN ('draft', 'pending', 'cancelled')
  `).get(channelId, messageTs);
}

function findAllByConfirmationTs(channelId, messageTs) {
  return db.prepare(`
    SELECT * FROM reminders
    WHERE source_channel_id = ? AND confirmation_message_ts = ?
    ORDER BY created_at ASC
  `).all(channelId, messageTs);
}

/**
 * Returns all reminders that belong to the most recent bulk batch in a thread,
 * ordered by created_at (so the user-visible numbering ⌗1, ⌗2, ... matches).
 */
function findLatestBulkByThreadTs(channelId, threadTs) {
  const latest = db.prepare(`
    SELECT confirmation_message_ts FROM reminders
    WHERE source_channel_id = ? AND source_thread_ts = ?
      AND confirmation_message_ts IS NOT NULL
    ORDER BY created_at DESC LIMIT 1
  `).get(channelId, threadTs);
  if (!latest?.confirmation_message_ts) return [];
  return db.prepare(`
    SELECT * FROM reminders
    WHERE source_channel_id = ? AND confirmation_message_ts = ?
    ORDER BY created_at ASC
  `).all(channelId, latest.confirmation_message_ts);
}

function approveReminder(id) {
  db.prepare(`UPDATE reminders SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'draft'`)
    .run(new Date().toISOString(), id);
}

function cancelReminder(id) {
  db.prepare(`UPDATE reminders SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('draft', 'pending')`)
    .run(new Date().toISOString(), id);
}

function restoreReminder(id) {
  db.prepare(`UPDATE reminders SET status = 'draft', updated_at = ? WHERE id = ? AND status = 'cancelled'`)
    .run(new Date().toISOString(), id);
}

function getPendingDueReminders() {
  return db.prepare(`SELECT * FROM reminders WHERE status = 'pending' AND due_at <= ?`)
    .all(new Date().toISOString());
}

// All pending reminders that haven't received advance notice yet
function getUnnotifiedPendingReminders() {
  return db.prepare(`SELECT * FROM reminders WHERE status = 'pending' AND advance_notified = 0`)
    .all();
}

function markAdvanceNotified(id) {
  db.prepare(`UPDATE reminders SET advance_notified = 1, updated_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), id);
}

function markSent(id) {
  db.prepare(`UPDATE reminders SET status = 'sent', updated_at = ? WHERE id = ? AND status = 'pending'`)
    .run(new Date().toISOString(), id);
}

function markFailed(id) {
  db.prepare(`UPDATE reminders SET status = 'failed', updated_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), id);
}

function getAllPending() {
  return db.prepare(`SELECT * FROM reminders WHERE status IN ('draft', 'pending') ORDER BY due_at ASC`)
    .all();
}

function getRecentlySentReminders(days = 7) {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  return db.prepare(`
    SELECT * FROM reminders WHERE status = 'sent' AND updated_at >= ?
    ORDER BY due_at ASC
  `).all(since);
}

function getPendingByAssignee(slackUserId) {
  return db.prepare(`
    SELECT * FROM reminders
    WHERE status IN ('draft', 'pending') AND assignee_slack_user_id = ?
    ORDER BY due_at ASC
  `).all(slackUserId);
}

function findByThreadTs(channelId, threadTs) {
  return db.prepare(`
    SELECT * FROM reminders
    WHERE source_channel_id = ? AND source_thread_ts = ?
    AND status IN ('draft', 'pending', 'cancelled')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(channelId, threadTs);
}

function getReminderById(id) {
  return db.prepare(`SELECT * FROM reminders WHERE id = ?`).get(id) ?? null;
}

function updateReminder(id, { assigneeName, assigneeSlackUserId, dueAt, advanceNoticeHours } = {}) {
  const now = new Date().toISOString();
  const fields = [];
  const values = [];
  if (assigneeName !== undefined)        { fields.push('assignee_name = ?');          values.push(assigneeName); }
  if (assigneeSlackUserId !== undefined)  { fields.push('assignee_slack_user_id = ?'); values.push(assigneeSlackUserId); }
  if (dueAt !== undefined)               { fields.push('due_at = ?');                 values.push(toUtcISO(dueAt)); }
  if (advanceNoticeHours !== undefined)  { fields.push('advance_notice_hours = ?');   values.push(advanceNoticeHours); }
  if (fields.length === 0) return;
  fields.push('updated_at = ?');
  values.push(now, id);
  db.prepare(`UPDATE reminders SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

// ── Pending questions ───────────────────────────────────────────────────────

const PENDING_QUESTION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function savePendingQuestion({ channelId, threadTs, originalText, sourceMessageTs, createdBy }) {
  db.prepare(`
    INSERT INTO pending_questions (channel_id, thread_ts, original_text, source_message_ts, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(channel_id, thread_ts) DO UPDATE SET
      original_text = excluded.original_text,
      source_message_ts = excluded.source_message_ts,
      created_at = excluded.created_at
  `).run(channelId, threadTs, originalText, sourceMessageTs, createdBy, new Date().toISOString());
}

function getPendingQuestion(channelId, threadTs) {
  const row = db.prepare(`SELECT * FROM pending_questions WHERE channel_id = ? AND thread_ts = ?`)
    .get(channelId, threadTs);
  if (!row) return null;
  if (Date.now() - new Date(row.created_at).getTime() > PENDING_QUESTION_TTL_MS) {
    deletePendingQuestion(channelId, threadTs);
    return null;
  }
  return row;
}

function deletePendingQuestion(channelId, threadTs) {
  db.prepare(`DELETE FROM pending_questions WHERE channel_id = ? AND thread_ts = ?`)
    .run(channelId, threadTs);
}

// ── Bot sent message tracking ──────────────────────────────────────────────

function recordBotSentMessage(channelId, ts) {
  if (!channelId || !ts) return;
  try {
    db.prepare(`
      INSERT INTO bot_sent_messages (channel_id, ts, created_at) VALUES (?, ?, ?)
      ON CONFLICT(channel_id, ts) DO NOTHING
    `).run(channelId, ts, new Date().toISOString());
  } catch (_) {}
}

function getBotSentMessages() {
  return db.prepare(`SELECT channel_id, ts FROM bot_sent_messages ORDER BY created_at ASC`).all();
}

function clearBotSentMessages() {
  const count = db.prepare(`SELECT COUNT(*) as c FROM bot_sent_messages`).get().c;
  db.prepare(`DELETE FROM bot_sent_messages`).run();
  return count;
}

function deleteBotSentMessage(channelId, ts) {
  db.prepare(`DELETE FROM bot_sent_messages WHERE channel_id = ? AND ts = ?`).run(channelId, ts);
}

// ── Admin / reset ───────────────────────────────────────────────────────────

function getAllReminders() {
  return db.prepare(`SELECT * FROM reminders`).all();
}

/**
 * Wipe all reminder data. Preserves settings (notification timing, summary channel)
 * so the bot keeps its configuration after a reset.
 */
function wipeAll() {
  const reminders = db.prepare(`SELECT COUNT(*) as c FROM reminders`).get().c;
  const pending = db.prepare(`SELECT COUNT(*) as c FROM pending_questions`).get().c;
  db.prepare(`DELETE FROM reminders`).run();
  db.prepare(`DELETE FROM pending_questions`).run();
  return { reminders, pending };
}

module.exports = {
  // settings
  getSetting,
  setSetting,
  getAllSettings,
  // reminders
  createReminder,
  setNotificationTarget,
  setConfirmationTs,
  findByConfirmationTs,
  findAllByConfirmationTs,
  findLatestBulkByThreadTs,
  approveReminder,
  cancelReminder,
  restoreReminder,
  getPendingDueReminders,
  getUnnotifiedPendingReminders,
  markAdvanceNotified,
  markSent,
  markFailed,
  getAllPending,
  getRecentlySentReminders,
  getPendingByAssignee,
  findByThreadTs,
  getReminderById,
  updateReminder,
  // pending questions
  savePendingQuestion,
  getPendingQuestion,
  deletePendingQuestion,
  // bot sent message tracking
  recordBotSentMessage,
  getBotSentMessages,
  clearBotSentMessages,
  deleteBotSentMessage,
  // admin / reset
  getAllReminders,
  wipeAll,
};
