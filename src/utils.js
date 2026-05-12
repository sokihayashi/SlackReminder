const CONFIDENCE_THRESHOLD = 0.6;
const DEFAULT_ADVANCE_NOTICE_HOURS = 24;

function formatDueAt(dueAt) {
  if (!dueAt) return '(未設定)';
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).format(new Date(dueAt));
}

function formatJST(date) {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'long',
  }).format(date);
}

function formatHours(hours) {
  if (hours % 24 === 0) return `${hours / 24}日`;
  return `${hours}時間`;
}

function displayAssignee(reminder) {
  if (reminder.assignee_slack_user_id) return `<@${reminder.assignee_slack_user_id}>`;
  return reminder.assignee_name || '(担当者未設定)';
}

const userNameCache = new Map();

async function getDisplayName(client, userId) {
  if (!userId) return null;
  if (userNameCache.has(userId)) return userNameCache.get(userId);
  try {
    const result = await client.users.info({ user: userId });
    const profile = result.user?.profile;
    const name = profile?.display_name || profile?.real_name || result.user?.name || userId;
    userNameCache.set(userId, name);
    return name;
  } catch (err) {
    console.error('[getDisplayName] failed:', err.message);
    return null;
  }
}

async function silentAssigneeDisplay(client, slackUserId, assigneeName) {
  if (slackUserId) {
    const name = await getDisplayName(client, slackUserId);
    if (name) return `@${name}`;
  }
  if (assigneeName) return assigneeName.replace(/^<@(U[A-Z0-9]+)>$/, '@$1');
  return '(担当者未設定)';
}

async function silentDisplayAssignee(client, reminder) {
  return silentAssigneeDisplay(client, reminder.assignee_slack_user_id, reminder.assignee_name);
}

module.exports = {
  formatDueAt, formatJST, formatHours, displayAssignee,
  getDisplayName, silentAssigneeDisplay, silentDisplayAssignee,
  CONFIDENCE_THRESHOLD, DEFAULT_ADVANCE_NOTICE_HOURS,
};
