const { extractModification } = require('../ai');
const { findByThreadTs, updateReminder, restoreReminder, approveReminder, getPendingQuestion, deletePendingQuestion } = require('../db');
const { formatDueAt, silentDisplayAssignee, silentAssigneeDisplay } = require('../utils');
const { handleMention } = require('./mention');
const botConfig = require('../botConfig');

// In-memory cache: `${channel}:${thread_ts}` → boolean
// Tracks whether the bot has posted in a given thread (used for no-mention auto-engagement).
const engagedThreadsCache = new Map();

async function isBotEngagedInThread(client, channel, thread_ts) {
  if (!botConfig.botUserId) return false;
  const key = `${channel}:${thread_ts}`;
  if (engagedThreadsCache.has(key)) return engagedThreadsCache.get(key);

  try {
    const result = await client.conversations.replies({ channel, ts: thread_ts, limit: 100 });
    const engaged = (result.messages || []).some(m => m.user === botConfig.botUserId);
    engagedThreadsCache.set(key, engaged);
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

  // 3. NEW: Auto-engagement — if the bot has previously posted in this thread,
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

function markThreadEngaged(channel, thread_ts) {
  if (!channel || !thread_ts) return;
  engagedThreadsCache.set(`${channel}:${thread_ts}`, true);
}

module.exports = { handleThreadReply, markThreadEngaged };
