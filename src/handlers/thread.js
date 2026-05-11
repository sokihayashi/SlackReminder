const { extractModification } = require('../ai');
const { findByThreadTs, updateReminder, restoreReminder, approveReminder } = require('../db');
const { formatDueAt } = require('../utils');

async function handleThreadReply({ message, client }) {
  const { text, channel, thread_ts } = message;

  const reminder = findByThreadTs(channel, thread_ts);
  if (!reminder) return;

  let mod;
  try {
    mod = await extractModification(text);
  } catch (err) {
    console.error('[thread] extractModification error:', err.message);
    return;
  }

  if (!mod.action) return;

  if (mod.action === 'restore' && reminder.status === 'cancelled') {
    restoreReminder(reminder.id);
    approveReminder(reminder.id);
    const assigneeDisplay = reminder.assignee_slack_user_id
      ? `<@${reminder.assignee_slack_user_id}>`
      : reminder.assignee_name;
    await client.chat.postMessage({
      channel,
      thread_ts,
      text: `✅ リマインドを再登録しました。\n${formatDueAt(reminder.due_at)} に ${assigneeDisplay} へ通知します。`,
    });
    return;
  }

  if (mod.action === 'modify' && ['draft', 'pending'].includes(reminder.status)) {
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

    const updatedAssignee = assigneeSlackUserId ? `<@${assigneeSlackUserId}>` : assigneeName;
    const updatedDue = mod.due_at ? formatDueAt(mod.due_at) : formatDueAt(reminder.due_at);

    await client.chat.postMessage({
      channel,
      thread_ts,
      text: `✏️ リマインドを修正しました。\n*担当：* ${updatedAssignee}\n*期限：* ${updatedDue}`,
    });
  }
}

module.exports = { handleThreadReply };
