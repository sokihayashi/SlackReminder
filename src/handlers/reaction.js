const { findDraftByConfirmationTs, approveReminder, cancelReminder } = require('../db');
const { formatDueAt } = require('../utils');
const botConfig = require('../botConfig');

async function handleReaction({ event, client }) {
  const { reaction, item, user } = event;

  // Ignore the bot's own reactions (added as affordance)
  if (user === botConfig.botUserId) return;

  // Only care about message reactions
  if (item.type !== 'message') return;

  // Only handle ✅ and ❌
  if (!['white_check_mark', 'x'].includes(reaction)) return;

  const reminder = findDraftByConfirmationTs(item.channel, item.ts);
  if (!reminder) return;

  if (reaction === 'white_check_mark') {
    approveReminder(reminder.id);
    const assigneeDisplay = reminder.assignee_slack_user_id
      ? `<@${reminder.assignee_slack_user_id}>`
      : reminder.assignee_name;
    await client.chat.postMessage({
      channel: item.channel,
      thread_ts: reminder.source_thread_ts,
      text: `✅ リマインドを登録しました。\n${formatDueAt(reminder.due_at)} に ${assigneeDisplay} へ通知します。`,
    });
  } else if (reaction === 'x') {
    cancelReminder(reminder.id);
    await client.chat.postMessage({
      channel: item.channel,
      thread_ts: reminder.source_thread_ts,
      text: '❌ リマインドを取り消しました。',
    });
  }
}

module.exports = { handleReaction };
