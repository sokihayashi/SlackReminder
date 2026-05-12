const { extractReminder, resolveCancelTarget, extractTasksFromThread } = require('../ai');
const {
  createReminder, setConfirmationTs, setNotificationTarget,
  getAllPending, getPendingByAssignee, cancelReminder, approveReminder,
  getSetting, setSetting, getAllSettings,
  savePendingQuestion, deletePendingQuestion, findByThreadTs,
} = require('../db');
const { formatDueAt, formatHours, displayAssignee, silentAssigneeDisplay, silentDisplayAssignee, getDisplayName, CONFIDENCE_THRESHOLD, DEFAULT_ADVANCE_NOTICE_HOURS } = require('../utils');
const botConfig = require('../botConfig');

async function handleMention({ event, client, priorText = null }) {
  const { text, channel, ts, thread_ts, user } = event;
  const replyThreadTs = thread_ts || ts;

  console.log(`[mention] user=${user} channel=${channel}${priorText ? ' (follow-up)' : ''}`);

  try {
    // Fast-path: keyword match before calling AI (only for first-turn)
    if (!priorText) {
      const bare = text.replace(/<@[^>]+>/g, '').trim();
      if (/^(ヘルプ|help|使い方|つかいかた)\??$/i.test(bare)) {
        await postHelp(channel, replyThreadTs, client);
        return;
      }
      if (/^(診断|debug|diagnos[ei]s|scope確認|セルフチェック)\??$/i.test(bare)) {
        await runDiagnostics(channel, replyThreadTs, client);
        return;
      }
    }

    const threadMessages = await fetchThreadContext(client, channel, thread_ts, ts);
    const botMentionPattern = botConfig.botUserId
      ? new RegExp(`<@${botConfig.botUserId}>`, 'g')
      : null;
    const stripBot = (s) => botMentionPattern ? s.replace(botMentionPattern, '').trim() : s;
    const cleanText = priorText
      ? `${stripBot(priorText)}\n${stripBot(text)}`
      : stripBot(text);
    const extraction = await extractReminder(cleanText, new Date(), threadMessages);

    switch (extraction.intent) {
      case 'query_tasks':           return handleTaskQuery(extraction, channel, replyThreadTs, client);
      case 'cancel_reminder':       return handleCancelReminder(text, channel, replyThreadTs, client);
      case 'update_setting':        return handleUpdateSetting(extraction, channel, replyThreadTs, client);
      case 'set_summary_channel':   return handleSetSummaryChannel(channel, replyThreadTs, client);
      case 'remove_summary_channel':return handleRemoveSummaryChannel(channel, replyThreadTs, client);
      case 'show_settings':         return handleShowSettings(channel, replyThreadTs, client);
      case 'extract_from_thread':
        if (extraction.channel_scope === 'all') {
          return handleExtractFromAllChannels(channel, replyThreadTs, ts, user, client);
        }
        return handleExtractFromThread(channel, thread_ts, replyThreadTs, ts, user, client);
    }

    if (extraction.intent !== 'create_reminder' || extraction.tasks.length === 0) {
      await client.chat.postMessage({
        channel,
        thread_ts: replyThreadTs,
        text: `リマインド対象のタスクが見つかりませんでした。\n理由：${extraction.reason || '不明'}`,
      });
      return;
    }

    if (extraction.confidence < CONFIDENCE_THRESHOLD || extraction.missing_fields?.length > 0) {
      const missing = extraction.missing_fields?.length > 0
        ? extraction.missing_fields.join('、')
        : '日時または担当者';
      savePendingQuestion({
        channelId: channel,
        threadTs: replyThreadTs,
        originalText: cleanText,
        sourceMessageTs: ts,
        createdBy: user,
      });
      await client.chat.postMessage({
        channel,
        thread_ts: replyThreadTs,
        text: `リマインドの作成に必要な情報が不足しています。\n不足情報：*${missing}*\n\nこのスレッドに返信して詳細を教えてください（メンション不要）。`,
      });
      return;
    }

    deletePendingQuestion(channel, replyThreadTs);

    const notifTarget = extraction.notification_target === 'thread' ? 'thread' : 'dm';

    if (extraction.tasks.length === 1) {
      return postSingleConfirmation(extraction.tasks[0], notifTarget, channel, ts, replyThreadTs, user, client);
    }
    return postBulkCreate(extraction.tasks, notifTarget, channel, ts, replyThreadTs, user, client);
  } catch (err) {
    console.error('[mention] Error:', err);
    await client.chat.postMessage({
      channel,
      thread_ts: replyThreadTs,
      text: 'エラーが発生しました。しばらく後にもう一度お試しください。',
    });
  }
}

// ── Intent handlers ──────────────────────────────────────────────────────────────

async function handleTaskQuery(extraction, channel, replyThreadTs, client) {
  const queryUserId = extractUserId(extraction.query_assignee);
  const reminders = queryUserId ? getPendingByAssignee(queryUserId) : getAllPending();
  let headerText = 'ペンディングタスク一覧';
  if (queryUserId) {
    const name = await getDisplayName(client, queryUserId);
    headerText = `${name ? `@${name}` : 'ユーザー'} のタスク一覧`;
  }

  if (reminders.length === 0) {
    await client.chat.postMessage({
      channel,
      thread_ts: replyThreadTs,
      text: `*${headerText}*\n\n現在ペンディング中のタスクはありません。`,
    });
    return;
  }

  const lines = await Promise.all(reminders.map(async (r, i) => {
    const assignee = await silentDisplayAssignee(client, r);
    const statusLabel = r.status === 'draft' ? '未確認' : '確認済み';
    return `${i + 1}. *${r.task}*\n　担当：${assignee}　期限：${formatDueAt(r.due_at)}　[${statusLabel}]`;
  }));

  await client.chat.postMessage({
    channel,
    thread_ts: replyThreadTs,
    text: `*${headerText}*\n\n${lines.join('\n\n')}`,
  });
}

async function handleCancelReminder(text, channel, replyThreadTs, client) {
  const pending = getAllPending();

  if (pending.length === 0) {
    await client.chat.postMessage({
      channel,
      thread_ts: replyThreadTs,
      text: 'キャンセル対象のペンディングリマインドが見つかりませんでした。',
    });
    return;
  }

  const { scope, reminder_id, assignee_filter } = await resolveCancelTarget(text, pending);

  switch (scope) {
    case 'all':         return cancelAll(pending, channel, replyThreadTs, client);
    case 'one':         return cancelOne(reminder_id, pending, channel, replyThreadTs, client);
    case 'by_assignee': return cancelByAssignee(assignee_filter, pending, channel, replyThreadTs, client);
    default:            return showAmbiguousList(pending, channel, replyThreadTs, client);
  }
}

async function cancelAll(pending, channel, replyThreadTs, client) {
  for (const r of pending) cancelReminder(r.id);
  await client.chat.postMessage({
    channel,
    thread_ts: replyThreadTs,
    text: `❌ ${pending.length}件のリマインドをすべてキャンセルしました。`,
  });
}

async function cancelOne(reminderId, pending, channel, replyThreadTs, client) {
  const r = pending.find(p => p.id === reminderId);
  if (!r) return showAmbiguousList(pending, channel, replyThreadTs, client);

  cancelReminder(r.id);
  const assignee = await silentDisplayAssignee(client, r);
  await client.chat.postMessage({
    channel,
    thread_ts: replyThreadTs,
    text: `❌ リマインドをキャンセルしました。\n*内容：* ${r.task}　*担当：* ${assignee}　*期限：* ${formatDueAt(r.due_at)}`,
  });
}

async function cancelByAssignee(assigneeFilter, pending, channel, replyThreadTs, client) {
  if (!assigneeFilter) return showAmbiguousList(pending, channel, replyThreadTs, client);

  const assigneeId = extractUserId(assigneeFilter);
  const matched = pending.filter(r =>
    assigneeId
      ? r.assignee_slack_user_id === assigneeId
      : r.assignee_name?.includes(assigneeFilter)
  );
  if (matched.length === 0) return showAmbiguousList(pending, channel, replyThreadTs, client);

  for (const r of matched) cancelReminder(r.id);
  let label;
  if (assigneeId) {
    const name = await getDisplayName(client, assigneeId);
    label = name ? `@${name}` : assigneeFilter;
  } else {
    label = assigneeFilter;
  }
  await client.chat.postMessage({
    channel,
    thread_ts: replyThreadTs,
    text: `❌ ${label} のリマインドを ${matched.length}件キャンセルしました。`,
  });
}

async function showAmbiguousList(pending, channel, replyThreadTs, client) {
  const lines = await Promise.all(pending.map(async (r, i) => {
    const assignee = await silentDisplayAssignee(client, r);
    return `${i + 1}. *${r.task}*　担当：${assignee}　期限：${formatDueAt(r.due_at)}`;
  }));
  await client.chat.postMessage({
    channel,
    thread_ts: replyThreadTs,
    text: `キャンセル対象を特定できませんでした。確認メッセージの ❌ でキャンセルするか、もう少し詳しく教えてください。\n\n${lines.join('\n')}`,
  });
}

// ── Reminder creation helpers ───────────────────────────────────────────────

function defaultDueAtJST(daysFromNow = 7) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const mo = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const da = String(jst.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${da}T10:00:00+09:00`;
}

async function bulkCreateReminders(tasks, source, client) {
  const fallbackDue = defaultDueAtJST(7);
  const results = [];
  for (const t of tasks) {
    const { assigneeSlackUserId, assigneeName } = resolveAssignee(t.assignee);
    if (!assigneeSlackUserId && !assigneeName) continue;
    const dueAt = t.due_at || fallbackDue;
    const hasDefaultDue = !t.due_at;
    try {
      const id = createReminder({
        task: t.task,
        assigneeName,
        assigneeSlackUserId,
        dueAt,
        sourceChannelId: source.channelId,
        sourceMessageTs: source.messageTs,
        sourceThreadTs: source.threadTs,
        createdBy: source.user,
        confidence: t.confidence ?? 1,
        advanceNoticeHours: t.advance_notice_hours ?? null,
        notificationTarget: source.notificationTarget || 'dm',
      });
      approveReminder(id);
      const assigneeDisplay = await silentAssigneeDisplay(client, assigneeSlackUserId, assigneeName);
      results.push({ task: t.task, assigneeDisplay, dueAt, hasDefaultDue, status: 'created' });
    } catch (err) {
      console.error('[bulk] createReminder error:', err.message);
      results.push({ task: t.task, status: 'error' });
    }
  }
  return results;
}

function formatBulkLines(results) {
  return results.map((r, i) => {
    if (r.status !== 'created') return `${i + 1}. ⚠️ 登録失敗: ${r.task}`;
    const dueNote = r.hasDefaultDue ? '　_※期限未指定のため1週間後_' : '';
    return `${i + 1}. ✅ *${r.task}*\n　　担当: ${r.assigneeDisplay}　期限: ${formatDueAt(r.dueAt)}${dueNote}`;
  });
}

async function postSingleConfirmation(t, notifTarget, channel, ts, replyThreadTs, user, client) {
  const { assigneeSlackUserId, assigneeName } = resolveAssignee(t.assignee);
  if (!assigneeSlackUserId && !assigneeName) {
    savePendingQuestion({ channelId: channel, threadTs: replyThreadTs, originalText: t.task, sourceMessageTs: ts, createdBy: user });
    await client.chat.postMessage({
      channel,
      thread_ts: replyThreadTs,
      text: 'リマインドの作成に必要な情報が不足しています。\n不足情報：*担当者*\n\n担当する人をスレッド返信でメンションしてください。',
    });
    return;
  }

  const reminderId = createReminder({
    task: t.task,
    assigneeName,
    assigneeSlackUserId,
    dueAt: t.due_at,
    sourceChannelId: channel,
    sourceMessageTs: ts,
    sourceThreadTs: replyThreadTs,
    createdBy: user,
    confidence: t.confidence ?? 1,
    advanceNoticeHours: t.advance_notice_hours ?? null,
    notificationTarget: notifTarget,
  });

  const dueDisplay = formatDueAt(t.due_at);
  const assigneeDisplay = await silentAssigneeDisplay(client, assigneeSlackUserId, assigneeName);
  const noticeHours = t.advance_notice_hours
    ?? parseInt(getSetting('advance_notice_hours', String(DEFAULT_ADVANCE_NOTICE_HOURS)), 10);
  const noticeLabel = formatHours(noticeHours);

  const confirmMsg = await client.chat.postMessage({
    channel,
    thread_ts: replyThreadTs,
    text: `リマインド候補を作成しました。\n担当：${assigneeDisplay}\n期限：${dueDisplay}\n内容：${t.task}`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*リマインド候補を作成しました。*\n\n*担当：* ${assigneeDisplay}\n*期限：* ${dueDisplay}\n*内容：* ${t.task}` },
      },
      notificationTargetBlock(notifTarget),
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `事前通知：${noticeLabel}前　|　✅ 登録　❌ キャンセル　※スレッドに返信で修正可` }],
      },
    ],
  });

  setConfirmationTs(reminderId, confirmMsg.ts);
  await client.reactions.add({ channel, timestamp: confirmMsg.ts, name: 'white_check_mark' });
  await client.reactions.add({ channel, timestamp: confirmMsg.ts, name: 'x' });
}

async function postBulkCreate(tasks, notifTarget, channel, ts, replyThreadTs, user, client) {
  const results = await bulkCreateReminders(tasks, {
    channelId: channel, messageTs: ts, threadTs: replyThreadTs, user, notificationTarget: notifTarget,
  }, client);

  const created = results.filter(r => r.status === 'created');
  if (created.length === 0) {
    await client.chat.postMessage({ channel, thread_ts: replyThreadTs, text: 'タスクの登録に失敗しました。担当者が特定できませんでした。' });
    return;
  }

  await client.chat.postMessage({
    channel,
    thread_ts: replyThreadTs,
    text: `📋 *${created.length} 件* のリマインドに分解して登録しました。\n\n${formatBulkLines(results).join('\n\n')}\n\n_修正はスレッド返信、キャンセルは「@Reminder Bot ○○のリマインドキャンセル」_`,
  });
}

async function handleExtractFromThread(channel, threadTs, replyThreadTs, currentTs, user, client) {
  const messages = threadTs
    ? await fetchFullThread(client, channel, threadTs, currentTs)
    : await fetchChannelHistory(client, channel, currentTs);

  if (messages.length === 0) {
    await client.chat.postMessage({
      channel, thread_ts: replyThreadTs,
      text: threadTs ? 'スレッド内にメッセージが見つかりませんでした。' : 'チャンネルの履歴が見つかりませんでした。',
    });
    return;
  }

  const tasks = await extractTasksFromThread(messages, new Date(), botConfig.botUserId);
  const filtered = tasks.filter(t => t.confidence >= 0.4);

  if (filtered.length === 0) {
    await client.chat.postMessage({
      channel, thread_ts: replyThreadTs,
      text: threadTs ? 'スレッド内にタスクが見つかりませんでした。' : 'チャンネルの直近メッセージにタスクが見つかりませんでした。',
    });
    return;
  }

  const results = await bulkCreateReminders(filtered, {
    channelId: channel, messageTs: currentTs, threadTs: replyThreadTs, user, notificationTarget: 'dm',
  }, client);

  const created = results.filter(r => r.status === 'created');
  if (created.length === 0) {
    await client.chat.postMessage({ channel, thread_ts: replyThreadTs, text: 'タスクの登録に失敗しました。' });
    return;
  }

  const scope = threadTs ? 'スレッド' : 'チャンネル';
  await client.chat.postMessage({
    channel, thread_ts: replyThreadTs,
    text: `📋 ${scope}から *${created.length} 件* のリマインドを登録しました。\n\n${formatBulkLines(results).join('\n\n')}\n\n_キャンセルは「@Reminder Bot ○○のリマインドキャンセル」_`,
  });
}

async function handleExtractFromAllChannels(originChannel, replyThreadTs, currentTs, user, client) {
  await client.chat.postMessage({
    channel: originChannel, thread_ts: replyThreadTs,
    text: '🔍 入っている全チャンネルをスキャン中…（チャンネル数によっては数十秒かかります）',
  });

  const channels = await fetchAllChannelsHistory(client);
  if (channels.length === 0) {
    await client.chat.postMessage({
      channel: originChannel, thread_ts: replyThreadTs,
      text: 'スキャン対象のチャンネルが見つかりませんでした。`@Reminder Bot 診断` でスコープ／メンバー状態を確認してください。',
    });
    return;
  }

  const perChannel = await Promise.all(channels.map(async (ch) => {
    try {
      const allTasks = await extractTasksFromThread(ch.messages, new Date(), botConfig.botUserId);
      const tasks = allTasks.filter(t => t.confidence >= 0.35);
      console.log(`[all-channels] #${ch.channelName}: AI ${allTasks.length} tasks → ${tasks.length} pass confidence>=0.35`);
      return { ...ch, allTasks, tasks };
    } catch (e) {
      console.error(`[all-channels] extract failed for #${ch.channelName}:`, e.message);
      return { ...ch, allTasks: [], tasks: [], error: e.message };
    }
  }));

  const allResults = [];
  for (const ch of perChannel) {
    const r = await bulkCreateReminders(ch.tasks, {
      channelId: ch.channelId, messageTs: currentTs, threadTs: null, user, notificationTarget: 'dm',
    }, client);
    for (const item of r.filter(x => x.status === 'created')) {
      allResults.push({ channelName: ch.channelName, ...item });
    }
  }

  if (allResults.length === 0) {
    const diag = perChannel.map(ch => {
      let status;
      if (ch.error) status = `❌ ${ch.error}`;
      else if (ch.allTasks.length === 0) status = 'AI抽出: 0件';
      else if (ch.tasks.length === 0) status = `AI抽出: ${ch.allTasks.length}件 (全て信頼度<0.35)`;
      else status = `AI抽出: ${ch.tasks.length}件 (担当者特定失敗)`;

      const sample = ch.allTasks.slice(0, 3).map(t => {
        const conf = (t.confidence ?? 0).toFixed(2);
        const assignee = t.assignee || '(担当不明)';
        return `　　• "${t.task}" 担当=${assignee} conf=${conf}`;
      }).join('\n');

      return `  *#${ch.channelName}* (${ch.messages.length}件のメッセージ) — ${status}${sample ? '\n' + sample : ''}`;
    }).join('\n');

    await client.chat.postMessage({
      channel: originChannel, thread_ts: replyThreadTs,
      text: `🔍 ${channels.length} チャンネルをスキャンしましたが、登録できるタスクはありませんでした。\n\n*診断:*\n${diag}\n\n_メッセージは取得できているが AI がタスクとして拾えていないなら、メッセージの書き方に対する AI プロンプトの調整が必要です。_`,
    });
    return;
  }

  const byChannel = new Map();
  for (const r of allResults) {
    if (!byChannel.has(r.channelName)) byChannel.set(r.channelName, []);
    byChannel.get(r.channelName).push(r);
  }

  const sections = [];
  for (const [chName, items] of byChannel) {
    const lines = items.map((r, i) => {
      const dueNote = r.hasDefaultDue ? '　_※期限未指定のため1週間後_' : '';
      return `　${i + 1}. ✅ *${r.task}*\n　　　担当: ${r.assigneeDisplay}　期限: ${formatDueAt(r.dueAt)}${dueNote}`;
    });
    sections.push(`*#${chName}*\n${lines.join('\n')}`);
  }

  await client.chat.postMessage({
    channel: originChannel, thread_ts: replyThreadTs,
    text: `📋 ${channels.length} チャンネルから *${allResults.length} 件* のリマインドを登録しました。\n\n${sections.join('\n\n')}\n\n_キャンセルは「@Reminder Bot ○○のリマインドキャンセル」_`,
  });
}

async function handleUpdateSetting(extraction, channel, replyThreadTs, client) {
  const { setting_key: key, setting_value: value } = extraction;

  if (key === 'advance_notice_hours') {
    const hours = parseInt(value, 10);
    if (Number.isFinite(hours) && hours >= 0) {
      setSetting('advance_notice_hours', String(hours));
      await client.chat.postMessage({
        channel,
        thread_ts: replyThreadTs,
        text: `⚙️ 事前通知タイミングを *${formatHours(hours)}前* に設定しました。`,
      });
    } else {
      await postAdvanceNoticeButtons(channel, replyThreadTs, client);
    }
    return;
  }

  await client.chat.postMessage({
    channel,
    thread_ts: replyThreadTs,
    text: `不明な設定キーです：\`${key}\``,
  });
}

async function handleSetSummaryChannel(channel, replyThreadTs, client) {
  setSetting('summary_channel_id', channel);
  await client.chat.postMessage({
    channel,
    thread_ts: replyThreadTs,
    text: `📋 このチャンネルを週次タスクサマリーの送信先に設定しました。\n毎週月曜 9:00 にペンディングタスクをまとめて投稿します。`,
  });
}

async function handleRemoveSummaryChannel(channel, replyThreadTs, client) {
  const current = getSetting('summary_channel_id');
  if (current !== channel) {
    await client.chat.postMessage({
      channel,
      thread_ts: replyThreadTs,
      text: 'このチャンネルはサマリー送信先として設定されていません。',
    });
    return;
  }
  setSetting('summary_channel_id', '');
  await client.chat.postMessage({
    channel,
    thread_ts: replyThreadTs,
    text: '📋 週次タスクサマリーの設定を解除しました。',
  });
}

async function handleShowSettings(channel, replyThreadTs, client) {
  const advanceHours = parseInt(getSetting('advance_notice_hours', String(DEFAULT_ADVANCE_NOTICE_HOURS)), 10);
  const summaryChannelId = getSetting('summary_channel_id', '');
  const summaryLine = summaryChannelId
    ? `*週次サマリー：* <#${summaryChannelId}>（毎週月曜 9:00）`
    : `*週次サマリー：* 未設定`;

  await client.chat.postMessage({
    channel,
    thread_ts: replyThreadTs,
    text: `⚙️ 現在の設定`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `⚙️ *現在の設定*\n\n*事前通知タイミング：* ${formatHours(advanceHours)}前\n${summaryLine}`,
        },
      },
      { type: 'divider' },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*事前通知タイミングを変更：*' },
      },
      advanceNoticeActionsBlock(),
    ],
  });
}

function notificationTargetBlock(current) {
  const dm = { type: 'button', text: { type: 'plain_text', text: '📱 DM' }, value: 'dm', action_id: 'set_notification_target__dm' };
  const thread = { type: 'button', text: { type: 'plain_text', text: '💬 スレッド' }, value: 'thread', action_id: 'set_notification_target__thread' };
  if (current === 'dm') dm.style = 'primary';
  else thread.style = 'primary';
  return { type: 'actions', elements: [dm, thread] };
}

function advanceNoticeActionsBlock() {
  const options = [
    { label: '12時間前', value: '12' },
    { label: '1日前',   value: '24' },
    { label: '2日前',   value: '48' },
    { label: '3日前',   value: '72' },
    { label: '1週間前', value: '168' },
  ];
  return {
    type: 'actions',
    elements: options.map(o => ({
      type: 'button',
      text: { type: 'plain_text', text: o.label },
      value: o.value,
      action_id: `set_advance_notice_hours__${o.value}`,
    })),
  };
}

async function postAdvanceNoticeButtons(channel, replyThreadTs, client) {
  await client.chat.postMessage({
    channel,
    thread_ts: replyThreadTs,
    text: '事前通知タイミングを選択してください',
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '⚙️ *事前通知タイミングを選択してください：*' },
      },
      advanceNoticeActionsBlock(),
    ],
  });
}

async function postHelp(channel, replyThreadTs, client) {
  await client.chat.postMessage({
    channel,
    thread_ts: replyThreadTs,
    text: 'Reminder Bot の使い方',
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '📌 Reminder Bot の使い方' },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*リマインド登録*\nメンションして依頼内容を書くだけ。スレッドの途中でメンションすると会話から文脈を読み取ります。\n```@Reminder Bot @田中 台本の初稿、金曜17時まで\n@Reminder Bot @yamada 編集書き出し 来週月曜 2日前に通知して```',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*リアクション操作*\n✅ → 登録確定　❌ → キャンセル\nキャンセル後に ✅ → 再登録\n確認メッセージのスレッドに返信 → 担当者・期限の修正や再登録',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*タスク一覧*\n```@Reminder Bot タスク一覧\n@Reminder Bot @田中 のタスク```',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*設定・診断*\n```@Reminder Bot 設定確認\n@Reminder Bot 設定: 事前通知 2日前\n@Reminder Bot このチャンネルにタスクサマリーを設定\n@Reminder Bot サマリーを解除\n@Reminder Bot 診断   ← スコープ・チャンネルメンバー状態を確認```',
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: '週次サマリーは毎週月曜 9:00 に送信先チャンネルへ自動投稿されます。',
          },
        ],
      },
    ],
  });
}

// ── Diagnostics ─────────────────────────────────────────────────────────────────

/**
 * Map Slack API error codes to the scope likely missing.
 */
function scopeHintForError(err) {
  const code = err?.data?.error || err?.code || err?.message || '';
  if (code.includes('missing_scope')) {
    const needed = err?.data?.needed;
    return needed ? `不足scope: \`${needed}\`` : '不足scope（needed情報なし）';
  }
  if (code.includes('not_in_channel')) return 'bot がそのチャンネルに招待されていません';
  if (code.includes('channel_not_found')) return 'チャンネルIDが無効、または bot から見えない（プライベートで未招待）';
  if (code.includes('account_inactive')) return 'bot ユーザーが無効化されています';
  return `エラー: \`${code}\``;
}

async function runDiagnostics(channel, replyThreadTs, client) {
  const lines = ['🔧 *セルフ診断レポート*\n'];

  // 1. auth.test
  let botUserId = null;
  try {
    const auth = await client.auth.test();
    botUserId = auth.user_id;
    lines.push(`✅ *認証* OK — bot user: \`${auth.user}\` (\`${auth.user_id}\`), team: \`${auth.team}\``);
  } catch (e) {
    lines.push(`❌ *認証* 失敗 — ${scopeHintForError(e)}`);
    await client.chat.postMessage({ channel, thread_ts: replyThreadTs, text: lines.join('\n') });
    return;
  }

  // 2. users.conversations (paginated) — primary listing of bot's member channels
  let memberChannels = [];
  let publicCount = 0;
  let privateCount = 0;
  try {
    memberChannels = await listBotMemberChannels(client);
    publicCount = memberChannels.filter(c => !c.is_private).length;
    privateCount = memberChannels.filter(c => c.is_private).length;
    lines.push(`✅ *users.conversations* OK — bot がメンバーのチャンネル: *${memberChannels.length} 個* (public ${publicCount} / private ${privateCount})`);
    if (memberChannels.length > 0) {
      const sample = memberChannels.slice(0, 5).map(c => `#${c.name}`).join(', ');
      lines.push(`  サンプル: ${sample}${memberChannels.length > 5 ? ` ほか${memberChannels.length - 5}件` : ''}`);
    }
  } catch (e) {
    lines.push(`❌ *users.conversations* 失敗 — ${scopeHintForError(e)}\n  → \`channels:read\` / \`groups:read\` を追加して再インストール`);
  }

  // 3. history of current channel
  try {
    const r = await client.conversations.history({ channel, limit: 1 });
    lines.push(`✅ *このチャンネルの history* OK — 取得可能(${r.messages?.length ?? 0}件サンプル)`);
  } catch (e) {
    const hint = scopeHintForError(e);
    lines.push(`❌ *このチャンネルの history* 失敗 — ${hint}\n  → public なら \`channels:history\`、private なら \`groups:history\` を追加して再インストール`);
  }

  // 4. summary
  lines.push('');
  if (memberChannels.length === 0) {
    lines.push(`⚠️ bot がメンバーになっているチャンネルが0件です。原因の可能性:`);
    lines.push(`  1. 後から追加した scope を反映するため *Reinstall to Workspace* が必要`);
    lines.push(`  2. bot を実際にチャンネルに招待していない`);
    lines.push(`  3. プライベートチャンネルのみで \`groups:read\` が未付与`);
  } else {
    lines.push(`📊 合計: *${memberChannels.length} チャンネル* で動作可能`);
  }

  await client.chat.postMessage({
    channel,
    thread_ts: replyThreadTs,
    text: lines.join('\n'),
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────────────

async function fetchFullThread(client, channel, threadTs, currentTs) {
  const botPattern = botConfig.botUserId ? new RegExp(`<@${botConfig.botUserId}>`, 'g') : null;
  try {
    const result = await client.conversations.replies({ channel, ts: threadTs, limit: 50 });
    return (result.messages || [])
      .filter(m => m.user && m.user !== botConfig.botUserId && m.ts !== currentTs && m.text)
      .map(m => {
        const txt = botPattern ? m.text.replace(botPattern, '').trim() : m.text;
        return { user: m.user, text: txt.slice(0, 500) };
      });
  } catch (e) {
    console.error('[mention] Failed to fetch full thread:', e.message);
    return [];
  }
}

async function fetchChannelHistory(client, channel, beforeTs, limit = 100) {
  const botPattern = botConfig.botUserId ? new RegExp(`<@${botConfig.botUserId}>`, 'g') : null;
  try {
    const result = await client.conversations.history({ channel, latest: beforeTs, limit, inclusive: false });
    return (result.messages || [])
      .filter(m => m.user && m.user !== botConfig.botUserId && m.text)
      .reverse()
      .map(m => {
        const txt = botPattern ? m.text.replace(botPattern, '').trim() : m.text;
        return { user: m.user, text: txt.slice(0, 500) };
      });
  } catch (e) {
    console.error('[mention] Failed to fetch channel history:', e.message);
    return [];
  }
}

/**
 * Paginated listing of channels the bot itself is a member of.
 * Uses users.conversations (returns only bot's member channels — no client-side filtering needed)
 * and walks all pages to avoid missing channels in large workspaces.
 */
async function listBotMemberChannels(client) {
  const memberChannels = [];
  if (!botConfig.botUserId) return memberChannels;
  let cursor;
  for (let i = 0; i < 20; i++) {
    const r = await client.users.conversations({
      user: botConfig.botUserId,
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
      cursor,
    });
    for (const c of (r.channels || [])) memberChannels.push(c);
    cursor = r.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return memberChannels;
}

async function fetchAllChannelsHistory(client) {
  const botPattern = botConfig.botUserId ? new RegExp(`<@${botConfig.botUserId}>`, 'g') : null;
  try {
    const memberChannels = await listBotMemberChannels(client);
    console.log(`[all-channels] bot is member of ${memberChannels.length} channels`);

    const perChannel = await Promise.all(memberChannels.map(async (ch) => {
      try {
        const r = await client.conversations.history({ channel: ch.id, limit: 100 });
        const messages = (r.messages || [])
          .filter(m => m.user && m.user !== botConfig.botUserId && m.text)
          .reverse()
          .map(m => {
            const txt = botPattern ? m.text.replace(botPattern, '').trim() : m.text;
            return { user: m.user, text: txt.slice(0, 500) };
          });
        console.log(`[all-channels] #${ch.name}: ${r.messages?.length ?? 0} raw → ${messages.length} user msgs`);
        return { channelId: ch.id, channelName: ch.name, messages };
      } catch (e) {
        console.error(`[all-channels] history failed for #${ch.name}:`, e.message);
        return { channelId: ch.id, channelName: ch.name, messages: [] };
      }
    }));

    return perChannel.filter(p => p.messages.length > 0);
  } catch (e) {
    console.error('[all-channels] conversations.list failed:', e.message);
    return [];
  }
}

async function fetchThreadContext(client, channel, thread_ts, currentTs) {
  if (!thread_ts) return [];
  const botPattern = botConfig.botUserId ? new RegExp(`<@${botConfig.botUserId}>`, 'g') : null;
  try {
    const result = await client.conversations.replies({ channel, ts: thread_ts, limit: 50 });
    return (result.messages || [])
      .filter(m => m.user && m.user !== botConfig.botUserId && m.ts !== currentTs && m.text)
      .map(m => {
        const txt = botPattern ? m.text.replace(botPattern, '').trim() : m.text;
        return { user: m.user, text: txt.slice(0, 500) };
      });
  } catch (e) {
    console.error('[mention] Failed to fetch thread context:', e.message);
    return [];
  }
}

function resolveAssignee(rawAssignee) {
  const name = rawAssignee || '(未設定)';
  const m = name.match(/^<@(U[A-Z0-9]+)>$/) || name.match(/^(U[A-Z0-9]{6,})$/);
  if (m) {
    if (m[1] === botConfig.botUserId) return { assigneeSlackUserId: null, assigneeName: null };
    return { assigneeSlackUserId: m[1], assigneeName: `<@${m[1]}>` };
  }
  return { assigneeSlackUserId: null, assigneeName: name };
}

function extractUserId(raw) {
  if (!raw) return null;
  const m = raw.match(/^<@(U[A-Z0-9]+)>$/) || raw.match(/^(U[A-Z0-9]{6,})$/);
  return m ? m[1] : null;
}

/**
 * Passive monitoring: called for all non-bot messages containing @USER mentions.
 * Auto-creates a reminder when a task + assignee + due_at can be extracted with high confidence.
 */
async function handlePassiveDetection({ message, client }) {
  const { text, channel, ts, thread_ts, user } = message;

  // Skip if this thread already has a reminder being managed
  if (thread_ts) {
    const existing = findByThreadTs(channel, thread_ts);
    if (existing) return;
  }

  let extraction;
  try {
    extraction = await extractReminder(text, new Date(), []);
  } catch (err) {
    console.error('[passive] extractReminder error:', err.message);
    return;
  }

  if (extraction.intent !== 'create_reminder') return;
  if (extraction.confidence < 0.85) return;
  if (extraction.missing_fields?.length > 0) return;
  if (extraction.tasks.length === 0) return;

  const replyThreadTs = thread_ts || ts;
  const valid = extraction.tasks.filter(t => t.due_at && (resolveAssignee(t.assignee).assigneeSlackUserId || resolveAssignee(t.assignee).assigneeName));
  if (valid.length === 0) return;

  const results = await bulkCreateReminders(valid, {
    channelId: channel, messageTs: ts, threadTs: replyThreadTs, user, notificationTarget: 'dm',
  }, client);
  const created = results.filter(r => r.status === 'created');
  if (created.length === 0) return;

  const summary = created.length === 1
    ? `🔔 リマインドを自動登録しました。\n担当: ${created[0].assigneeDisplay}　期限: ${formatDueAt(created[0].dueAt)}\n内容: ${created[0].task}`
    : `🔔 ${created.length} 件のリマインドを自動登録しました。\n\n${formatBulkLines(results).join('\n\n')}`;

  await client.chat.postMessage({
    channel, thread_ts: replyThreadTs,
    text: `${summary}\n\n_❌ で取消し、スレッド返信で修正可_`,
  });
}

/**
 * Auto-crawl on channel join: silently scan the recent history and bulk-register
 * any action items. Posts a single summary message only when reminders are
 * actually created — otherwise stays quiet to avoid channel noise.
 */
async function handleBotJoinedChannel({ event, client }) {
  if (!botConfig.botUserId || event.user !== botConfig.botUserId) return;
  const channel = event.channel;
  console.log(`[join] bot joined channel=${channel}; starting background crawl`);

  // Background extraction: silent unless tasks are actually registered.
  const messages = await fetchChannelHistory(client, channel, undefined, 100);
  if (messages.length === 0) return;

  let tasks;
  try {
    tasks = await extractTasksFromThread(messages, new Date(), botConfig.botUserId);
  } catch (err) {
    console.error('[join] extractTasksFromThread error:', err.message);
    return;
  }
  const filtered = tasks.filter(t => t.confidence >= 0.5);
  if (filtered.length === 0) return;

  const results = await bulkCreateReminders(filtered, {
    channelId: channel, messageTs: null, threadTs: null, user: botConfig.botUserId, notificationTarget: 'dm',
  }, client);
  const created = results.filter(r => r.status === 'created');
  if (created.length === 0) return;

  await client.chat.postMessage({
    channel,
    text: `🔔 過去メッセージから *${created.length} 件* のリマインドを自動登録しました。\n\n${formatBulkLines(results).join('\n\n')}\n\n_誤検出は「@Reminder Bot ○○のリマインドキャンセル」で削除できます。_`,
  });
}

module.exports = { handleMention, notificationTargetBlock, handlePassiveDetection, handleBotJoinedChannel };
