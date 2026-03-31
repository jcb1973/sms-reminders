const { expandTime, expandBareTime, moveLeadingTime, parseTime, parseCallFlag } = require('./parse');

describe('expandBareTime', () => {
  test('converts 3-digit bare time', () => {
    expect(expandBareTime('830')).toBe('8:30');
    expect(expandBareTime('945')).toBe('9:45');
    expect(expandBareTime('100')).toBe('1:00');
  });

  test('converts 4-digit bare time', () => {
    expect(expandBareTime('1430')).toBe('14:30');
    expect(expandBareTime('2359')).toBe('23:59');
    expect(expandBareTime('1200')).toBe('12:00');
  });

  test('preserves surrounding text', () => {
    expect(expandBareTime('830 tomorrow morning')).toBe('8:30 tomorrow morning');
    expect(expandBareTime('tomorrow at 1430')).toBe('tomorrow at 14:30');
  });

  test('does not convert invalid times', () => {
    expect(expandBareTime('2500')).toBe('2500');
    expect(expandBareTime('1261')).toBe('1261');
  });

  test('does not convert 1-2 digit numbers', () => {
    expect(expandBareTime('5')).toBe('5');
    expect(expandBareTime('12')).toBe('12');
  });

  test('does not mangle already-colon-separated times', () => {
    expect(expandBareTime('8:30')).toBe('8:30');
    expect(expandBareTime('14:30')).toBe('14:30');
  });
});

describe('expandTime', () => {
  test('expands shorthand durations', () => {
    expect(expandTime('10m')).toBe('10 minutes');
    expect(expandTime('2h')).toBe('2 hours');
    expect(expandTime('30s')).toBe('30 seconds');
    expect(expandTime('1d')).toBe('1 days');
  });

  test('preserves surrounding text', () => {
    expect(expandTime('in 10m please')).toBe('in 10 minutes please');
  });
});

describe('parseCallFlag', () => {
  test('detects !call flag', () => {
    expect(parseCallFlag('830 tomorrow !call')).toEqual({ text: '830 tomorrow', call: true });
  });

  test('returns false when no flag', () => {
    expect(parseCallFlag('830 tomorrow')).toEqual({ text: '830 tomorrow', call: false });
  });
});

describe('moveLeadingTime', () => {
  test('moves leading bare number to end with "at"', () => {
    expect(moveLeadingTime('8 tomorrow')).toBe('tomorrow at 8');
    expect(moveLeadingTime('830 tomorrow morning')).toBe('tomorrow morning at 830');
  });

  test('handles colon-separated leading time', () => {
    expect(moveLeadingTime('8:30 tomorrow')).toBe('tomorrow at 8:30');
  });

  test('does not move when number is not leading', () => {
    expect(moveLeadingTime('tomorrow at 8')).toBe('tomorrow at 8');
  });

  test('does not move before duration units', () => {
    expect(moveLeadingTime('10 minutes')).toBe('10 minutes');
    expect(moveLeadingTime('2 hours')).toBe('2 hours');
    expect(moveLeadingTime('30 seconds')).toBe('30 seconds');
    expect(moveLeadingTime('1 days')).toBe('1 days');
  });
});

describe('parseTime', () => {
  test('parses bare 3-digit times like "830 tomorrow morning"', () => {
    const result = parseTime('830 tomorrow morning');
    expect(result).not.toBeNull();
    expect(result.getHours()).toBe(8);
    expect(result.getMinutes()).toBe(30);
  });

  test('parses bare 4-digit times like "1430"', () => {
    const result = parseTime('1430');
    expect(result).not.toBeNull();
    expect(result.getHours()).toBe(14);
    expect(result.getMinutes()).toBe(30);
  });

  test('parses "8 tomorrow" as 8:00', () => {
    const result = parseTime('8 tomorrow');
    expect(result).not.toBeNull();
    expect(result.getHours()).toBe(8);
    expect(result.getMinutes()).toBe(0);
  });

  test('parses "tomorrow at 8" as 8:00', () => {
    const result = parseTime('tomorrow at 8');
    expect(result).not.toBeNull();
    expect(result.getHours()).toBe(8);
    expect(result.getMinutes()).toBe(0);
  });

  test('parses "8 tomorrow morning" as 8:00', () => {
    const result = parseTime('8 tomorrow morning');
    expect(result).not.toBeNull();
    expect(result.getHours()).toBe(8);
    expect(result.getMinutes()).toBe(0);
  });

  test('parses colon-separated times', () => {
    const result = parseTime('8:30 tomorrow morning');
    expect(result).not.toBeNull();
    expect(result.getHours()).toBe(8);
    expect(result.getMinutes()).toBe(30);
  });

  test('parses shorthand durations', () => {
    const before = Date.now();
    const result = parseTime('10m');
    expect(result).not.toBeNull();
    // Should be roughly 10 minutes from now
    const diffMin = (result.getTime() - before) / 60000;
    expect(diffMin).toBeGreaterThan(9);
    expect(diffMin).toBeLessThan(11);
  });

  test('parses natural language', () => {
    const result = parseTime('5pm');
    expect(result).not.toBeNull();
    expect(result.getHours()).toBe(17);
    expect(result.getMinutes()).toBe(0);
  });

  test('parses "8 tomorrow evening" as 20:00', () => {
    const result = parseTime('8 tomorrow evening');
    expect(result).not.toBeNull();
    expect(result.getHours()).toBe(20);
    expect(result.getMinutes()).toBe(0);
  });

  test('parses "830pm" as 20:30', () => {
    const result = parseTime('830pm');
    expect(result).not.toBeNull();
    expect(result.getHours()).toBe(20);
    expect(result.getMinutes()).toBe(30);
  });

  test('parses "tomorrow at 830" as 8:30', () => {
    const result = parseTime('tomorrow at 830');
    expect(result).not.toBeNull();
    expect(result.getHours()).toBe(8);
    expect(result.getMinutes()).toBe(30);
  });

  test('bare "8" with no date context returns null', () => {
    expect(parseTime('8')).toBeNull();
  });

  test('bare "830" parses as 8:30', () => {
    const result = parseTime('830');
    expect(result).not.toBeNull();
    expect(result.getHours()).toBe(8);
    expect(result.getMinutes()).toBe(30);
  });

  test('returns null for unparseable input', () => {
    expect(parseTime('asdfghjkl')).toBeNull();
  });
});
