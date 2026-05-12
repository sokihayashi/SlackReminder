const botConfig = require('./botConfig');

async function listBotMemberChannels(client) {
  const channels = [];
  if (!botConfig.botUserId) return channels;
  let cursor;
  for (let i = 0; i < 20; i++) {
    const r = await client.users.conversations({
      user: botConfig.botUserId,
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
      cursor,
    });
    for (const c of (r.channels || [])) channels.push(c);
    cursor = r.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return channels;
}

// Throws on Slack API error so caller can record fail reason (e.g. missing_scope)
async function listAllIMConversations(client) {
  const ims = [];
  let cursor;
  for (let page = 0; page < 10; page++) {
    const params = { types: 'im', exclude_archived: true, limit: 200 };
    if (cursor) params.cursor = cursor;
    const r = await client.conversations.list(params);
    for (const im of (r.channels || [])) ims.push(im);
    cursor = r.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return ims;
}

// scanReplies=false for DMs (bot never posts DM replies; saves rate-limit budget)
async function deleteBotMessagesInConversation(client, channelId, { maxPages = 5, scanReplies = true } = {}) {
  let deleted = 0, errors = 0, firstErr = null;
  let cursor;
  const recordErr = (e) => {
    errors++;
    if (!firstErr) firstErr = e?.data?.error || e.message;
  };
  for (let page = 0; page < maxPages; page++) {
    let r;
    try {
      const params = { channel: channelId, limit: 200 };
      if (cursor) params.cursor = cursor;
      r = await client.conversations.history(params);
    } catch (e) {
      if (!firstErr) firstErr = e?.data?.error || e.message;
      console.error(`[slack] history failed for ${channelId} page ${page}:`, e.message);
      break;
    }
    for (const m of (r.messages || [])) {
      const isBotMsg = m.user === botConfig.botUserId || m.bot_id;
      if (isBotMsg) {
        try {
          await client.chat.delete({ channel: channelId, ts: m.ts });
          deleted++;
        } catch (e) { recordErr(e); }
      }
      // Only scan replies for user-started threads (where the bot might have replied)
      if (scanReplies && m.reply_count > 0 && m.thread_ts === m.ts && !isBotMsg) {
        const r2 = await deleteBotRepliesInThread(client, channelId, m.ts);
        deleted += r2.deleted;
        errors += r2.errors;
        if (!firstErr && r2.firstErr) firstErr = r2.firstErr;
      }
    }
    cursor = r.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return { deleted, errors, firstErr };
}

async function deleteBotRepliesInThread(client, channelId, threadTs) {
  let deleted = 0, errors = 0, firstErr = null;
  let cursor;
  for (let page = 0; page < 3; page++) {
    let rr;
    try {
      const params = { channel: channelId, ts: threadTs, limit: 100 };
      if (cursor) params.cursor = cursor;
      rr = await client.conversations.replies(params);
    } catch (_) {
      return { deleted, errors, firstErr };
    }
    for (const reply of (rr.messages || [])) {
      if (reply.ts === threadTs) continue;
      if (reply.user !== botConfig.botUserId && !reply.bot_id) continue;
      try {
        await client.chat.delete({ channel: channelId, ts: reply.ts });
        deleted++;
      } catch (e) {
        errors++;
        if (!firstErr) firstErr = e?.data?.error || e.message;
      }
    }
    cursor = rr.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return { deleted, errors, firstErr };
}

module.exports = {
  listBotMemberChannels,
  listAllIMConversations,
  deleteBotMessagesInConversation,
};
