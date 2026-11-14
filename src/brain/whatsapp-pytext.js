/**
 * Text and date helpers that behave like the Python built-ins the reference scripts were written
 * with. Hundreds of notes in the vault were produced with those rules, and the JavaScript
 * equivalents (trim, \s, split, string comparison, Date.parse) are close but not equal: one
 * different byte in a file name or a line means a chat written twice.
 */

/** What Python calls whitespace in str.strip(), str.split(), str.isspace() and the regex \s. */
const SPACE_CODES = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001,
  0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f,
  0x205f, 0x3000,
]);

/** The same set as the body of a regular expression class. It has U+001C to U+001F and U+0085, and not U+FEFF. */
export const PY_SPACE_CLASS = "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

const SPACE_RUN = new RegExp(`[${PY_SPACE_CLASS}]+`, "g");
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u{2028}\u{2029}]/u;

export function isPySpace(char) {
  return SPACE_CODES.has(char.codePointAt(0));
}

/** str.strip(): scans from both ends, so a long run of spaces in the middle costs nothing. */
export function pyStrip(value) {
  const text = String(value ?? "");
  let start = 0;
  let end = text.length;
  while (start < end && SPACE_CODES.has(text.charCodeAt(start))) start += 1;
  while (end > start && SPACE_CODES.has(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(start, end);
}

/** str.split() without arguments: pieces between runs of whitespace, never an empty piece. */
export function pySplit(value) {
  return String(value ?? "").split(SPACE_RUN).filter(Boolean);
}

/** re.sub(r"\s+", " ", text). */
export function pyCollapseSpaces(value) {
  return String(value ?? "").replace(SPACE_RUN, " ");
}

/**
 * str.splitlines(): it also breaks on vertical tab, form feed, the three separators U+001C to
 * U+001E, NEL and the two Unicode separators, and a final break does not add an empty line.
 */
export function pySplitlines(value) {
  const lines = String(value ?? "").split(LINE_BREAK);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** text[:count]: Python counts whole characters, so an emoji is one and is never cut in half. */
export function sliceCodePoints(value, count) {
  const text = String(value ?? "");
  if (text.length <= count) return text;
  return Array.from(text).slice(0, count).join("");
}

/**
 * Python orders strings by code point and JavaScript by UTF-16 unit, which disagree when an emoji
 * meets a character from U+E000 up. The fix-up moves surrogates above the rest of the plane.
 */
export function compareCodePoints(left, right) {
  const size = Math.min(left.length, right.length);
  for (let i = 0; i < size; i += 1) {
    let a = left.charCodeAt(i);
    let b = right.charCodeAt(i);
    if (a === b) continue;
    if (a >= 0xd800 && b >= 0xd800) {
      a += a >= 0xe000 ? -0x800 : 0x2000;
      b += b >= 0xe000 ? -0x800 : 0x2000;
    }
    return a < b ? -1 : 1;
  }
  return left.length - right.length;
}

/** Characters str.isdigit() accepts that are not decimal digits: superscripts, circled digits and the like. */
const EXTRA_DIGIT_RANGES = [
  [0xb2, 0xb3], [0xb9, 0xb9], [0x1369, 0x1371], [0x19da, 0x19da], [0x2070, 0x2070], [0x2074, 0x2079],
  [0x2080, 0x2089], [0x2460, 0x2468], [0x2474, 0x247c], [0x2488, 0x2490], [0x24ea, 0x24ea],
  [0x24f5, 0x24fd], [0x24ff, 0x24ff], [0x2776, 0x277e], [0x2780, 0x2788], [0x278a, 0x2792],
  [0x10a40, 0x10a43], [0x10e60, 0x10e68], [0x11052, 0x1105a], [0x1f100, 0x1f10a],
];
const DECIMAL = /^\p{Nd}$/u;
const LETTER_OR_NUMBER = /^[\p{L}\p{N}]$/u;

/** str.isdigit() for one character. */
export function isPyDigit(char) {
  if (DECIMAL.test(char)) return true;
  const code = char.codePointAt(0);
  return code >= 0xb2 && EXTRA_DIGIT_RANGES.some(([from, to]) => code >= from && code <= to);
}

/** str.isalnum() for one character: every letter and every character with a numeric value. */
export function isPyAlnum(char) {
  return LETTER_OR_NUMBER.test(char);
}

/** Only the ASCII digits, for the places where the reference used [0-9]. */
export function asciiDigits(value) {
  return String(value ?? "").replace(/[^0-9]/g, "");
}

/** The characters of a text that str.isdigit() accepts, joined. */
export function pyDigits(value) {
  let out = "";
  for (const char of String(value ?? "")) if (isPyDigit(char)) out += char;
  return out;
}

const combiningCache = new Map();

/**
 * unicodedata.combining(char) != 0 for a character that is already decomposed. JavaScript has no
 * property for the combining class (\p{M} also takes marks of class 0), so this asks the
 * normalizer: a mark with a class above zero changes places with a neighbour of a lower or higher
 * class, and a character of class 0 never moves.
 */
export function isCombining(char) {
  let known = combiningCache.get(char);
  if (known === undefined) {
    const after = `${char}\u{334}`; // U+0334 has the lowest class, 1
    const before = `\u{345}${char}`; // U+0345 has the highest, 240
    known = after.normalize("NFD") !== after || before.normalize("NFD") !== before;
    combiningCache.set(char, known);
  }
  return known;
}

/** str(value) for the few values that reach a file: None, True and False keep their Python spelling. */
export function pyStr(value) {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

/** round(value, 1): Python sends an exact tie to the even digit and toFixed sends it up. */
export function pyRound1(value) {
  const quarters = Math.abs(value) * 4;
  if (Number.isInteger(quarters) && quarters % 4 === 1) return Math.sign(value) * (Math.floor(Math.abs(value) * 10) / 10);
  return Number(value.toFixed(1));
}

function digitsAt(text, position, count) {
  let value = 0;
  for (let i = 0; i < count; i += 1) {
    const digit = text.charCodeAt(position + i) - 48;
    if (!(digit >= 0 && digit <= 9)) return null;
    value = value * 10 + digit;
  }
  return value;
}

/**
 * One "HH[:MM[:SS[.ffffff]]]" group between `start` and `end`, the way datetime.fromisoformat
 * reads it. Returns null when it is malformed; `more` says that something follows the group.
 */
function clockFields(text, start, end) {
  const fields = [0, 0, 0];
  let micro = 0;
  let position = start;
  let separated = true;
  for (let i = 0; i < 3; i += 1) {
    const value = digitsAt(text, position, 2);
    if (value === null) return null;
    fields[i] = value;
    position += 2;
    const char = position < text.length ? text[position] : "";
    position += 1;
    if (char > "\x7f") return null; // Python reads bytes, and half a character is never a separator
    if (i === 0) separated = char === ":";
    if (position >= end) return char === "." || char === "," ? null : { fields, micro, more: char !== "" };
    if (separated && char === ":") continue;
    if (char === "." || char === ",") break;
    if (separated) return null;
    position -= 1;
  }
  const count = Math.min(end - position, 6);
  const fraction = digitsAt(text, position, count);
  if (fraction === null || count < 1) return null;
  micro = fraction * 10 ** (6 - count);
  position += count;
  while (position < text.length && text.charCodeAt(position) >= 48 && text.charCodeAt(position) <= 57) position += 1;
  return { fields, micro, more: position < text.length };
}

function daysFromCivil(year, month, day) {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

function daysInMonth(year, month) {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * datetime.fromisoformat() of Python 3.11 and later, for calendar dates: "YYYY-MM-DD" or
 * "YYYYMMDD", any single separator, an optional time and an optional offset. Returns the instant
 * as whole seconds since 1970 plus microseconds, the year as written and whether an offset was
 * given, or null where Python raises ValueError. ISO week dates ("2026-W33-1") are not supported
 * and also give null; no state file has ever carried one.
 */
export function parseIsoDateTime(value) {
  const text = String(value ?? "");
  if (text.length < 7) return null;
  const extended = text[4] === "-";
  const dateEnd = extended ? 10 : 8;
  const year = digitsAt(text, 0, 4);
  const month = digitsAt(text, extended ? 5 : 4, 2);
  const day = digitsAt(text, extended ? 8 : 6, 2);
  if (year === null || month === null || day === null) return null;
  if (extended && text[7] !== "-") return null;

  let clock = [0, 0, 0];
  let micro = 0;
  let aware = false;
  let offsetSeconds = 0;
  let offsetMicro = 0;
  if (text.length > dateEnd) {
    const high = text.charCodeAt(dateEnd);
    const start = dateEnd + (high >= 0xd800 && high <= 0xdbff ? 2 : 1);
    let zone = start;
    while (zone < text.length && !"Z+-".includes(text[zone])) zone += 1;
    const time = clockFields(text, start, Math.max(zone, start));
    if (!time) return null;
    clock = time.fields;
    micro = time.micro;
    if (zone >= text.length) {
      if (time.more) return null;
    } else if (text[zone] === "Z") {
      if (zone + 1 !== text.length) return null;
      aware = true;
    } else {
      const sign = text[zone] === "-" ? -1 : 1;
      const offset = clockFields(text, zone + 1, text.length);
      if (!offset || offset.more) return null;
      aware = true;
      offsetSeconds = sign * (offset.fields[0] * 3600 + offset.fields[1] * 60 + offset.fields[2]);
      offsetMicro = sign * offset.micro;
      if (Math.abs(offsetSeconds * 1e6 + offsetMicro) >= 86400e6) return null;
    }
  }

  const [hour, minute, second] = clock;
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  let sec = daysFromCivil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second - offsetSeconds;
  micro -= offsetMicro;
  if (micro < 0) {
    micro += 1e6;
    sec -= 1;
  } else if (micro >= 1e6) {
    micro -= 1e6;
    sec += 1;
  }
  return { sec, micro, year, aware };
}

/** Earlier, same or later, for two instants from parseIsoDateTime. */
export function compareInstants(left, right) {
  return left.sec - right.sec || left.micro - right.micro;
}

/** datetime.isoformat() of a UTC instant with "+00:00" written as "Z": the fraction only shows when it is not zero. */
export function isoUtc(sec, micro = 0) {
  const stamp = new Date(sec * 1000).toISOString().slice(0, 19);
  return micro ? `${stamp}.${String(micro).padStart(6, "0")}Z` : `${stamp}Z`;
}
