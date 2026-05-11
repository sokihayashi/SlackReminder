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
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

function createReminder({ task, assigneeName, assigneeSlackUserId, dueAt, sourceChannelId, sourceMessageTs, sourceThreadTs, createdBy, confidence }) {
  const now = new Date().toISOString();
  const id = uuidv4();
  // Normalize due_at to UTC for consistent comparison
  const dueAtUtc = new Date(dueAt).toISOString();
  db.prepare(`
    INSERT INTO reminders
      (id, task, assignee_name, assignee_slack_user_id, due_at, source_channel_id, source_message_ts, source_thread_ts, status, created_by, ai_confidence, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)
  `).run(id, task, assigneeName, assigneeSlackUserId, dueAtUtc, sourceChannelId, sourceMessageTs, sourceThreadTs, createdBy, confidence, now, now);
  return id;
}

function setConfirmationTs(id, confirmationMessageTs) {
  db.prepare(`UPDATE reminders SET confirmation_message_ts = ?, updated_at = ? WHERE id = ?`)
    .run(confirmationMessageTs, new Date().toISOString(), id);
}

// Find a draft reminder by the channel + confirmation message ts
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

// Get pending reminders whose due_at has passed (UTC comparison)
function getPendingDueReminders() {
  return db.prepare(`
    SELECT * FROM reminders WHERE status = 'pending' AND due_at <= ?
  `).all(new Date().toISOString());
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

module.exports = {
  createReminder,
  setConfirmationTs,
  findDraftByConfirmationTs,
  approveReminder,
  cancelReminder,
  getPendingDueReminders,
  markSent,
  markFailed,
};
