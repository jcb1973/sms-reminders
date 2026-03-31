const chrono = require('chrono-node');

// Extract !call flag from a string, return { text, call }
function parseCallFlag(str) {
  const call = /!call\b/i.test(str);
  return { text: str.replace(/!call\b/i, '').trim(), call };
}

// Expand shorthand like "10m", "2h", "30s", "1d" to chrono-friendly strings
function expandTime(str) {
  return str.replace(/(\d+)\s*(s|m|h|d)\b/gi, (_, n, unit) => {
    const units = { s: 'seconds', m: 'minutes', h: 'hours', d: 'days' };
    return `${n} ${units[unit.toLowerCase()]}`;
  });
}

// Convert bare clock-like numbers (e.g. "830", "1430") to "8:30", "14:30"
function expandBareTime(str) {
  return str.replace(/\b(\d{1,2})(\d{2})\b/g, (match, h, mm) => {
    const hour = parseInt(h, 10);
    const min = parseInt(mm, 10);
    if (hour >= 0 && hour <= 23 && min >= 0 && min <= 59) {
      return `${h}:${mm}`;
    }
    return match;
  });
}

// Move a leading bare number to the end with "at" so chrono treats it as a time
// e.g. "8 tomorrow" -> "tomorrow at 8", "830 tomorrow morning" -> "tomorrow morning at 830"
function moveLeadingTime(str) {
  return str.replace(/^(\d{1,4}(?::\d{2})?)\s+(.+?)$/, (match, num, rest) => {
    // Don't move if followed by a duration unit (e.g. "10 minutes")
    if (/^(seconds|minutes|hours|days)\b/i.test(rest)) return match;
    return `${rest} at ${num}`;
  });
}

// Full pipeline: parse a user time string into a Date
function parseTime(str) {
  const expanded = expandBareTime(expandTime(str));
  const results = chrono.parse(expanded);
  // If chrono parsed something but skipped a leading number, the number was
  // probably meant as the time — retry with "at" so chrono treats it as one.
  if (results.length > 0 && results[0].index > 0 && /^\d/.test(expanded)) {
    const withAt = chrono.parseDate(moveLeadingTime(expanded));
    if (withAt) return withAt;
  }
  if (results.length > 0) return results[0].date();
  return chrono.parseDate(moveLeadingTime(expanded))
    || chrono.parseDate(`in ${expanded}`);
}

module.exports = { parseCallFlag, expandTime, expandBareTime, moveLeadingTime, parseTime };
