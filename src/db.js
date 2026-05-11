const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

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
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

// Migration: add advance_notified to existing tables
try {
  db.exec(`ALTER TABLE reminders ADD COLUMN advance_notified INTEGER NOT NULL DEFAULT 0`);
} catch (_) { /* column already exists */ }

function createReminder({ task, assigneeName, assigneeSlackUserId, dueAt, sourceChannelId, sourceMessageTs, sourceThreadTs, createdBy, confidence }) {
  const now = new Date().toISOString();
  const id = uuidv4();
  const dueAtUtc = new Date(dueAt).toISOString();
  db.prepare(`
    INSERT INTO reminders
      (id, task, assignee_name, assignee_slack_user_id, due_at, source_channel_id, source_message_ts, source_thread_ts, status, created_by, ai_confidence, advance_notified, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, 0, ?, ?)
  `).run(id, task, assigneeName, assigneeSlackUserId, dueAtUtc, sourceChannelId, sourceMessageTs, sourceThreadTs, createdBy, confidence, now, now);
  return id;
}

function setConfirmationTs(id, confirmationMessageTs) {
  db.prepare(`UPDATE reminders SET confirmation_message_ts = ?, updated_at = ? WHERE id = ?`)
    .run(confirmationMessageTs, new Date().toISOString(), id);
}

// Find a reminder by channel + confirmation message ts (any status)
function findByConfirmationTs(channelId, messageTs) {
  return db.prepare(`
    SELECT * FROM reminders
    WHERE source_channel_id = ? AND confirmation_message_ts = ?
    AND status IN ('draft', 'pending', 'cancelled')
  `).get(channelId, messageTs);
}

// Legacy alias used internally
function findDraftByConfirmationTs(channelId, messageTs) {
  return db.prepare(`
    SELECT * FROM reminders
    WHERE source_channel_id = ? AND confirmation_message_ts = ? AND status = 'draft'
  `).get(channelId, messageTs);
}

function approveReminder(id) {
  db.prepare(`
    UPDATE reminders SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'draft'
  `).run(new Date().toISOString(), id);
}

function cancelReminder(id) {
  db.prepare(`
    UPDATE reminders SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('draft', 'pending')
  `).run(new Date().toISOString(), id);
}

function restoreReminder(id) {
  db.prepare(`
    UPDATE reminders SET status = 'draft', updated_at = ? WHERE id = ? AND status = 'cancelled'
  `).run(new Date().toISOString(), id);
}

function getPendingDueReminders() {
  return db.prepare(`
    SELECT * FROM reminders WHERE status = 'pending' AND due_at <= ?
  `).all(new Date().toISOString());
}

// Reminders due within the next 24 hours that haven't had advance notice sent
function getRemindersForAdvanceNotice() {
  const in24h = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  return db.prepare(`
    SELECT * FROM reminders
    WHERE status = 'pending' AND advance_notified = 0 AND due_at <= ?
  `).all(in24h);
}

function markAdvanceNotified(id) {
  db.prepare(`
    UPDATE reminders SET advance_notified = 1, updated_at = ? WHERE id = ?
  `).run(new Date().toISOString(), id);
}

function markSent(id) {
  db.prepare(`
    UPDATE reminders SET status = 'sent', updated_at = ? WHERE id = ? AND status = 'pending'
  `).run(new Date().toISOString(), id);
}

function markFailed(id) {
  db.prepare(`
    UPDATE reminders SET status = 'failed', updated_at = ? WHERE id = ?
  `).run(new Date().toISOString(), id);
}

// Task list queries
function getAllPending() {
  return db.prepare(`
    SELECT * FROM reminders WHERE status IN ('draft', 'pending') ORDER BY due_at ASC
  `).all();
}

function getPendingByAssignee(slackUserId) {
  return db.prepare(`
    SELECT * FROM reminders
    WHERE status IN ('draft', 'pending') AND assignee_slack_user_id = ?
    ORDER BY due_at ASC
  `).all(slackUserId);
}

// Find the latest active reminder in a thread (for thread-reply modification)
function findByThreadTs(channelId, threadTs) {
  return db.prepare(`
    SELECT * FROM reminders
    WHERE source_channel_id = ? AND source_thread_ts = ?
    AND status IN ('draft', 'pending', 'cancelled')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(channelId, threadTs);
}

function updateReminder(id, { assigneeName, assigneeSlackUserId, dueAt } = {}) {
  const now = new Date().toISOString();
  const fields = [];
  const values = [];
  if (assigneeName !== undefined)       { fields.push('assignee_name = ?');          values.push(assigneeName); }
  if (assigneeSlackUserId !== undefined) { fields.push('assignee_slack_user_id = ?'); values.push(assigneeSlackUserId); }
  if (dueAt !== undefined)              { fields.push('due_at = ?');                 values.push(new Date(dueAt).toISOString()); }
  if (fields.length === 0) return;
  fields.push('updated_at = ?');
  values.push(now, id);
  db.prepare(`UPDATE reminders SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

module.exports = {
  createReminder,
  setConfirmationTs,
  findByConfirmationTs,
  findDraftByConfirmationTs,
  approveReminder,
  cancelReminder,
  restoreReminder,
  getPendingDueReminders,
  getRemindersForAdvanceNotice,
  markAdvanceNotified,
  markSent,
  markFailed,
  getAllPending,
  getPendingByAssignee,
  findByThreadTs,
  updateReminder,
};
