const { findByConfirmationTs, approveReminder, cancelReminder, restoreReminder } = require('../db');
const { formatDueAt, displayAssignee } = require('../utils');
const botConfig = require('../botConfig');

async function handleReaction({ event, client }) {
  const { reaction, item, user } = event;

  if (user === botConfig.botUserId) return;
  if (item.type !== 'message') return;
  if (!['white_check_mark', 'x'].includes(reaction)) return;

  const reminder = findByConfirmationTs(item.channel, item.ts);
  if (!reminder) return;

  const assigneeDisplay = displayAssignee(reminder);

  if (reaction === 'white_check_mark') {
    if (reminder.status === 'draft') {
      approveReminder(reminder.id);
      await client.chat.postMessage({
        channel: item.channel,
        thread_ts: reminder.source_thread_ts,
        text: `✅ リマインドを登録しました。\n${formatDueAt(reminder.due_at)} に ${assigneeDisplay} へ通知します。`,
      });
    } else if (reminder.status === 'cancelled') {
      // Re-approve a previously cancelled reminder
      restoreReminder(reminder.id);
      approveReminder(reminder.id);
      await client.chat.postMessage({
        channel: item.channel,
        thread_ts: reminder.source_thread_ts,
        text: `✅ リマインドを再登録しました。\n${formatDueAt(reminder.due_at)} に ${assigneeDisplay} へ通知します。`,
      });
    }
  } else if (reaction === 'x') {
    if (['draft', 'pending'].includes(reminder.status)) {
      cancelReminder(reminder.id);
      await client.chat.postMessage({
        channel: item.channel,
        thread_ts: reminder.source_thread_ts,
        text: '❌ リマインドを取り消しました。間違えた場合は ✅ で再登録、またはスレッドに「再登録」と返信できます。',
      });
    }
  }
}

module.exports = { handleReaction };
