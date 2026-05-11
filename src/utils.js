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

module.exports = { formatDueAt, formatJST, formatHours, CONFIDENCE_THRESHOLD, DEFAULT_ADVANCE_NOTICE_HOURS };
