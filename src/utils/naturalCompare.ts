/**
 * Natural (digit-aware) text comparison.
 *
 * Codes in this system are not free prose: management numbers look like `260702006-VOC`,
 * `MQIS-2` or `0007`, and a plain lexicographic compare puts `MQIS-10` before `MQIS-2` and
 * `100` before `20`. Splitting each string into alternating text and digit runs and comparing
 * the runs separately gives the order an operator reads off a whiteboard.
 *
 * This lives outside the Records table module so the table's cell mapping and the shared
 * filter/sort helpers can both use it without importing one another.
 */

interface TextRun {
  text: string;
  isNumber: boolean;
  numeric: number;
}

const DIGIT_RUN_SPLITTER = /(\d+)/u;
const PURE_DIGITS = /^\d+$/u;

function splitNumericRuns(value: string): TextRun[] {
  return value
    .split(DIGIT_RUN_SPLITTER)
    .filter((part) => part !== '')
    .map((part) => {
      const isNumber = PURE_DIGITS.test(part);
      return {
        text: part,
        isNumber,
        // These are identifiers, not arithmetic: a digit run beyond Number.MAX_SAFE_INTEGER
        // only affects ordering inside its own magnitude bucket, which is acceptable here and
        // is why the comparison falls back to run length rather than arbitrary precision.
        numeric: isNumber ? Number(part) : Number.NaN,
      };
    });
}

/**
 * Compares two strings, returning a negative number, zero or a positive number.
 *
 * Numeric runs compare by value, then by digit count, so `7` sorts before `007` which sorts
 * before `10`. Text runs compare with `localeCompare`. Equal runs fall through to the next one.
 */
export function naturalTextCompare(left: string, right: string): number {
  if (left === right) return 0;

  const leftParts = splitNumericRuns(left);
  const rightParts = splitNumericRuns(right);
  const runs = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < runs; index += 1) {
    const a = leftParts[index];
    const b = rightParts[index];
    // A shorter run list is the smaller string: `MQIS` before `MQIS-2`.
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a.isNumber && b.isNumber) {
      if (a.numeric !== b.numeric) return a.numeric - b.numeric;
      if (a.text.length !== b.text.length) return a.text.length - b.text.length;
      continue;
    }
    const compared = a.text.localeCompare(b.text);
    if (compared !== 0) return compared;
  }

  return left.length - right.length;
}
