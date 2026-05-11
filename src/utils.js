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

module.exports = { formatDueAt, formatJST, formatHours, displayAssignee, CONFIDENCE_THRESHOLD, DEFAULT_ADVANCE_NOTICE_HOURS };
