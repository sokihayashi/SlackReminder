const { extractModification } = require('../ai');
const { findByThreadTs, updateReminder, restoreReminder, approveReminder, cancelReminder, getPendingQuestion, deletePendingQuestion, findLatestBulkByThreadTs } = require('../db');
const { formatDueAt, silentDisplayAssignee, silentAssigneeDisplay } = require('../utils');
const { handleMention, refreshBulkMessage } = require('./mention');
const botConfig = require('../botConfig');

// In-memory cache: `${channel}:${thread_ts}` → boolean
// Tracks whether the bot has posted in a given thread (used for no-mention auto-engagement).
const engagedThreadsCache = new Map();

async function isBotEngagedInThread(client, channel, thread_ts) {
  if (!botConfig.botUserId) return false;
  const key = `${channel}:${thread_ts}`;
  if (engagedThreadsCache.get(key) === true) return true;

  try {
    const result = await client.conversations.replies({ channel, ts: thread_ts, limit: 100 });
    const engaged = (result.messages || []).some(m => m.user === botConfig.botUserId);
    // Only cache positive results — negative results can become stale if the bot posts later
    if (engaged) engagedThreadsCache.set(key, true);
    return engaged;
  } catch (e) {
    console.error('[thread] isBotEngagedInThread failed:', e.message);
    return false;
  }
}

async function handleThreadReply({ message, client }) {
  const { text, channel, thread_ts, ts, user } = message;

  // 1. Follow-up to "missing info" question (no mention needed, already existed)
  const pending = getPendingQuestion(channel, thread_ts);
  if (pending) {
    deletePendingQuestion(channel, thread_ts);
    await handleMention({
      event: { text, channel, ts, thread_ts, user },
      client,
      priorText: pending.original_text,
    });
    return;
  }

  const reminder = findByThreadTs(channel, thread_ts);

  // 2. Modification / restore of existing reminder in this thread
  if (reminder) {
    let mod;
    try {
      mod = await extractModification(text, reminder);
    } catch (err) {
      console.error('[thread] extractModification error:', err.message);
    }

    if (mod?.action === 'restore' && reminder.status === 'cancelled') {
      restoreReminder(reminder.id);
      approveReminder(reminder.id);
      const assigneeDisplay = await silentDisplayAssignee(client, reminder);
      await client.chat.postMessage({
        channel,
        thread_ts,
        text: `✅ リマインドを再登録しました。\n${formatDueAt(reminder.due_at)} に ${assigneeDisplay} へ通知します。`,
      });
      return;
    }

    if (mod?.action === 'modify' && ['draft', 'pending'].includes(reminder.status)) {
      let assigneeSlackUserId = reminder.assignee_slack_user_id;
      let assigneeName = reminder.assignee_name;

      if (mod.assignee) {
        const m = mod.assignee.match(/^<@(U[A-Z0-9]+)>$/) || mod.assignee.match(/^(U[A-Z0-9]{6,})$/);
        if (m) {
          assigneeSlackUserId = m[1];
          assigneeName = `<@${assigneeSlackUserId}>`;
        } else {
          assigneeName = mod.assignee;
          assigneeSlackUserId = null;
        }
      }

      updateReminder(reminder.id, {
        assigneeName: mod.assignee ? assigneeName : undefined,
        assigneeSlackUserId: mod.assignee ? assigneeSlackUserId : undefined,
        dueAt: mod.due_at || undefined,
      });

      const updatedAssignee = await silentAssigneeDisplay(client, assigneeSlackUserId, assigneeName);
      const updatedDue = mod.due_at ? formatDueAt(mod.due_at) : formatDueAt(reminder.due_at);

      await client.chat.postMessage({
        channel,
        thread_ts,
        text: `✏️ リマインドを修正しました。\n*担当：* ${updatedAssignee}\n*期限：* ${updatedDue}`,
      });
      return;
    }
  }

  // 3. NEW: Number-prefixed bulk modification ("⌗1 の期限を 明日17時 に", "2 をキャンセル" 等)
  const numHandled = await handleNumberedBulkAction({ text, channel, thread_ts, client });
  if (numHandled) return;

  // 4. NEW: Auto-engagement — if the bot has previously posted in this thread,
  // treat any reply as if the bot were mentioned (silent on irrelevant chat).
  const engaged = await isBotEngagedInThread(client, channel, thread_ts);
  if (engaged) {
    await handleMention({
      event: { text, channel, ts, thread_ts, user },
      client,
      silentOnNone: true,
    });
  }
}

/**
 * Detect a leading "N" / "⌗N" / "#N" / "N." pattern and route to the Nth
 * reminder in the latest bulk batch posted to this thread.
 * Returns true if the message was handled (caller should stop).
 */
async function handleNumberedBulkAction({ text, channel, thread_ts, client }) {
  const m = text.match(/^\s*[⌗#＃]?\s*(\d{1,2})[\s.\．、:：]/);
  if (!m) return false;
  const idx = parseInt(m[1], 10) - 1;
  const bulk = findLatestBulkByThreadTs(channel, thread_ts);
  if (idx < 0 || idx >= bulk.length) return false;
  const target = bulk[idx];
  const rest = text.slice(m[0].length).trim();
  if (!rest) return false;

  // Cancel
  if (/(キャンセル|取消|やめ|削除|消して|消す|消去)/.test(rest)) {
    cancelReminder(target.id);
    await client.chat.postMessage({
      channel, thread_ts,
      text: `❌ ⌗${idx + 1} 「${target.task}」をキャンセルしました。`,
    });
    if (target.confirmation_message_ts) {
      await refreshBulkMessage(client, channel, target.confirmation_message_ts);
    }
    return true;
  }

  // Restore (cancelled → draft + auto-approve)
  if (/(復活|再登録|やっぱり|戻して)/.test(rest) && target.status === 'cancelled') {
    restoreReminder(target.id);
    approveReminder(target.id);
    await client.chat.postMessage({
      channel, thread_ts,
      text: `♻️ ⌗${idx + 1} 「${target.task}」を再登録しました。`,
    });
    if (target.confirmation_message_ts) {
      await refreshBulkMessage(client, channel, target.confirmation_message_ts);
    }
    return true;
  }

  // Approve
  if (/(確定|OK|承認|登録)/.test(rest) && target.status === 'draft') {
    approveReminder(target.id);
    await client.chat.postMessage({
      channel, thread_ts,
      text: `✅ ⌗${idx + 1} 「${target.task}」を確定しました。`,
    });
    if (target.confirmation_message_ts) {
      await refreshBulkMessage(client, channel, target.confirmation_message_ts);
    }
    return true;
  }

  // Modification (assignee / due_at via AI)
  let mod;
  try {
    mod = await extractModification(rest, target);
  } catch (err) {
    console.error('[thread] numbered extractModification error:', err.message);
    return true;
  }
  if (!mod?.action) return true;  // consumed the prefix, no clear modification

  if (mod.action === 'modify' && ['draft', 'pending'].includes(target.status)) {
    let assigneeSlackUserId = target.assignee_slack_user_id;
    let assigneeName = target.assignee_name;
    if (mod.assignee) {
      const am = mod.assignee.match(/^<@(U[A-Z0-9]+)>$/) || mod.assignee.match(/^(U[A-Z0-9]{6,})$/);
      if (am) { assigneeSlackUserId = am[1]; assigneeName = `<@${am[1]}>`; }
      else    { assigneeName = mod.assignee; assigneeSlackUserId = null; }
    }
    updateReminder(target.id, {
      assigneeName:        mod.assignee ? assigneeName        : undefined,
      assigneeSlackUserId: mod.assignee ? assigneeSlackUserId : undefined,
      dueAt:               mod.due_at || undefined,
    });
    const updatedAssignee = await silentAssigneeDisplay(client, assigneeSlackUserId, assigneeName);
    const updatedDue = mod.due_at ? formatDueAt(mod.due_at) : formatDueAt(target.due_at);
    await client.chat.postMessage({
      channel, thread_ts,
      text: `✏️ ⌗${idx + 1} を修正しました。\n*担当：* ${updatedAssignee}　*期限：* ${updatedDue}`,
    });
    if (target.confirmation_message_ts) {
      await refreshBulkMessage(client, channel, target.confirmation_message_ts);
    }
  }
  return true;
}

function markThreadEngaged(channel, thread_ts) {
  if (!channel || !thread_ts) return;
  engagedThreadsCache.set(`${channel}:${thread_ts}`, true);
}

module.exports = { handleThreadReply, markThreadEngaged };
