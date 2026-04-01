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

// Check if chrono actually assigned a time (hour/minute) rather than just a date.
// "tomorrow morning" → implied hour 6, minute 0 (from time-period word) → accept
// "tomorrow" → implied hour copies wall clock (minute/second non-zero) → reject
function hasExplicitTime(result) {
  if (!result || !result.start) return false;
  if (result.start.isCertain('hour') || result.start.isCertain('minute')) return true;
  // Accept time-period modifiers (morning/evening/etc) — they imply clean round hours
  const implied = result.start.impliedValues || {};
  if (implied.hour !== undefined && implied.minute === 0 && implied.second === 0) return true;
  return false;
}

// Check that chrono consumed most of the input — reject if alphabetic words were skipped.
// "tomorrow at 3" over "3 apples tomorrow" would leave "apples" unmatched → reject.
function inputFullyConsumed(input, results) {
  if (!Array.isArray(results)) results = [results];
  let remainder = input;
  // Remove all matched regions (right to left to preserve indices)
  const sorted = [...results].sort((a, b) => b.index - a.index);
  for (const r of sorted) {
    remainder = remainder.slice(0, r.index) + remainder.slice(r.index + r.text.length);
  }
  remainder = remainder.trim();
  // Allow leftover digits, whitespace, punctuation — but not alphabetic words
  return !/[a-zA-Z]{2,}/.test(remainder);
}

// Full pipeline: parse a user time string into a Date
function parseTime(str) {
  const expanded = expandBareTime(expandTime(str));
  const results = chrono.parse(expanded);
  // If chrono parsed something but skipped a leading number, the number was
  // probably meant as the time — retry with "at" so chrono treats it as one.
  if (results.length > 0 && results[0].index > 0 && /^\d/.test(expanded)) {
    const movedStr = moveLeadingTime(expanded);
    const retried = chrono.parse(movedStr);
    if (retried.length > 0 && hasExplicitTime(retried[0]) && inputFullyConsumed(movedStr, retried)) {
      return retried[0].date();
    }
  }
  // Only accept results that include an explicit time component and consumed the input.
  if (results.length > 0) {
    if (hasExplicitTime(results[0]) && inputFullyConsumed(expanded, results)) {
      return results[0].date();
    }
    return null;
  }
  const movedStr2 = moveLeadingTime(expanded);
  const moved = chrono.parse(movedStr2);
  if (moved.length > 0 && hasExplicitTime(moved[0]) && inputFullyConsumed(movedStr2, moved)) {
    return moved[0].date();
  }
  const withInStr = `in ${expanded}`;
  const withIn = chrono.parse(withInStr);
  if (withIn.length > 0 && hasExplicitTime(withIn[0]) && inputFullyConsumed(withInStr, withIn)) {
    return withIn[0].date();
  }
  return null;
}

module.exports = { parseCallFlag, expandTime, expandBareTime, moveLeadingTime, parseTime };
