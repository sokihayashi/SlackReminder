const { extractReminder } = require('../ai');
const { createReminder, setConfirmationTs, getAllPending, getPendingByAssignee } = require('../db');
const { formatDueAt } = require('../utils');
const botConfig = require('../botConfig');

async function handleMention({ event, client }) {
  const { text, channel, ts, thread_ts, user } = event;
  const replyThreadTs = thread_ts || ts;

  console.log(`[mention] received from user=${user} channel=${channel} text=${text}`);

  try {
    // Fetch thread context when mentioned inside an existing thread
    let threadMessages = [];
    if (thread_ts) {
      try {
        const result = await client.conversations.replies({ channel, ts: thread_ts, limit: 10 });
        threadMessages = (result.messages || [])
          .filter(m => m.user && m.user !== botConfig.botUserId && m.ts !== ts)
          .slice(-5)
          .map(m => ({ user: m.user, text: m.text }));
      } catch (e) {
        console.error('[mention] Failed to fetch thread context:', e.message);
      }
    }

    const extraction = await extractReminder(text, new Date(), threadMessages);

    // Handle task list query
    if (extraction.intent === 'query_tasks') {
      await handleTaskQuery(extraction, channel, replyThreadTs, client);
      return;
    }

    if (!extraction.should_create_reminder) {
      await client.chat.postMessage({
        channel,
        thread_ts: replyThreadTs,
        text: `リマインド対象のタスクが見つかりませんでした。\n理由：${extraction.reason || '不明'}`,
      });
      return;
    }

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
      text: `リマインド候補を作成しました。\n\n担当：${assigneeDisplay}\n期限：${dueDisplay}\n内容：${extraction.task}\n\n✅ 登録 / ❌ キャンセル`,
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
              text: `確信度：${Math.round(extraction.confidence * 100)}%　|　✅ 登録　❌ キャンセル　※スレッドに返信で内容修正も可`,
            },
          ],
        },
      ],
    });

    setConfirmationTs(reminderId, confirmMsg.ts);

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

async function handleTaskQuery(extraction, channel, replyThreadTs, client) {
  const queryUserId = (() => {
    if (!extraction.query_assignee) return null;
    const m = extraction.query_assignee.match(/^<@(U[A-Z0-9]+)>$/) ||
              extraction.query_assignee.match(/^(U[A-Z0-9]{6,})$/);
    return m ? m[1] : null;
  })();

  const reminders = queryUserId ? getPendingByAssignee(queryUserId) : getAllPending();
  const headerText = queryUserId ? `<@${queryUserId}> のタスク一覧` : 'ペンディングタスク一覧';

  if (reminders.length === 0) {
    await client.chat.postMessage({
      channel,
      thread_ts: replyThreadTs,
      text: `*${headerText}*\n\n現在ペンディング中のタスクはありません。`,
    });
    return;
  }

  const lines = reminders.map((r, i) => {
    const assignee = r.assignee_slack_user_id ? `<@${r.assignee_slack_user_id}>` : r.assignee_name;
    const due = formatDueAt(r.due_at);
    const statusLabel = r.status === 'draft' ? '未確認' : '確認済み';
    return `${i + 1}. *${r.task}*\n　担当：${assignee}　期限：${due}　[${statusLabel}]`;
  });

  await client.chat.postMessage({
    channel,
    thread_ts: replyThreadTs,
    text: `*${headerText}*\n\n${lines.join('\n\n')}`,
  });
}

module.exports = { handleMention };
