const { extractReminder } = require('../ai');
const { createReminder, setConfirmationTs } = require('../db');
const { formatDueAt } = require('../utils');

async function handleMention({ event, client }) {
  const { text, channel, ts, thread_ts, user } = event;
  const replyThreadTs = thread_ts || ts;

  console.log(`[mention] received from user=${user} channel=${channel} text=${text}`);

  try {
    const extraction = await extractReminder(text);

    if (!extraction.should_create_reminder) {
      await client.chat.postMessage({
        channel,
        thread_ts: replyThreadTs,
        text: `リマインド対象のタスクが見つかりませんでした。\n理由：${extraction.reason || '不明'}`,
      });
      return;
    }

    // Ask for clarification when confidence is low or required fields are missing
    if (extraction.confidence < 0.6 || (extraction.missing_fields && extraction.missing_fields.length > 0)) {
      const missing = extraction.missing_fields && extraction.missing_fields.length > 0
        ? extraction.missing_fields.join('、')
        : '日時または担当者';
      await client.chat.postMessage({
        channel,
        thread_ts: replyThreadTs,
        text: `リマインドの作成に必要な情報が不足しています。\n不足情報：*${missing}*\n\nもう少し詳しく教えてください。`,
      });
      return;
    }

    // Resolve Slack user ID — handle both "<@U123456>" and bare "U123456" forms
    let assigneeSlackUserId = null;
    let assigneeName = extraction.assignee || '(未設定)';
    const mentionMatch = assigneeName.match(/^<@(U[A-Z0-9]+)>$/) || assigneeName.match(/^(U[A-Z0-9]{6,})$/);
    if (mentionMatch) {
      assigneeSlackUserId = mentionMatch[1];
      assigneeName = `<@${assigneeSlackUserId}>`;
    }

    const reminderId = createReminder({
      task: extraction.task,
      assigneeName,
      assigneeSlackUserId,
      dueAt: extraction.due_at,
      sourceChannelId: channel,
      sourceMessageTs: ts,
      sourceThreadTs: replyThreadTs,
      createdBy: user,
      confidence: extraction.confidence,
    });

    const dueDisplay = formatDueAt(extraction.due_at);
    const assigneeDisplay = assigneeSlackUserId ? `<@${assigneeSlackUserId}>` : assigneeName;

    const confirmMsg = await client.chat.postMessage({
      channel,
      thread_ts: replyThreadTs,
      text: `リマインド候補を作成しました。\n\n担当：${assigneeDisplay}\n期限：${dueDisplay}\n内容：${extraction.task}\n\n✅ 登録 / ❌ 無視`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*リマインド候補を作成しました。*\n\n*担当：* ${assigneeDisplay}\n*期限：* ${dueDisplay}\n*内容：* ${extraction.task}`,
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `確信度：${Math.round(extraction.confidence * 100)}%　|　✅ でリアクションすると登録、❌ でキャンセル`,
            },
          ],
        },
      ],
    });

    setConfirmationTs(reminderId, confirmMsg.ts);

    // Add reaction affordances so users see them immediately
    await client.reactions.add({ channel, timestamp: confirmMsg.ts, name: 'white_check_mark' });
    await client.reactions.add({ channel, timestamp: confirmMsg.ts, name: 'x' });
  } catch (err) {
    console.error('Error in handleMention:', err);
    await client.chat.postMessage({
      channel,
      thread_ts: replyThreadTs,
      text: 'エラーが発生しました。しばらく後にもう一度お試しください。',
    });
  }
}

module.exports = { handleMention };
