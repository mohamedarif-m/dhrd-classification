/**
 * READABLE AMOUNTS ON THE AUTHORIZATION SURFACES.
 *
 * The review and the receipt are where a reader authorizes money and where they
 * are told what happened to it. `5000 USD` and `50000 USD` are one keystroke
 * apart on screen and an order of magnitude apart in the bank; thousands
 * separators are the entire defence, and the review is where that defence earns
 * its keep. The Job Change tools already format their own amounts (`_money_disp`
 * / `_num_disp` in jcc/support/util.py: separators and two decimals, so
 * `1000000` reads as `1,000,000.00`); One-Time Payment does not, and its review
 * row is built as the raw typed amount plus a currency code. This closes that
 * gap in the one place it can be closed for every tool at once.
 *
 * DISPLAY ONLY. Nothing here touches a value, an envelope or a contract. It
 * rewrites a STRING on its way to the screen and nothing else.
 *
 * THE HARD PART IS KNOWING WHAT IS MONEY. This product's review rows are full of
 * things made of digits that must never be regrouped: employee ids, requisition
 * numbers, position ids, spreadsheet keys, dates. Guessing from the row LABEL
 * ("Amount", "Pay", "Salary") would be a heuristic over tool-authored copy and
 * would eventually put a comma in the middle of an identifier on a confirm
 * screen. So the rule is narrow and structural instead:
 *
 *     A VALUE IS MONEY ONLY WHEN IT CARRIES A CURRENCY MARKER.
 *
 * A leading currency symbol, or a trailing three-letter ISO-style code, with a
 * plain number and nothing else in the string. `5000 USD` qualifies. `95000`
 * alone does not - it could be an id, and an unmarked number is left exactly as
 * the tool wrote it. Neither does `0.00 - 1,000,000.00 USD Annual`, a range the
 * tool has already formatted, nor `R0008169`, nor anything with prose in it.
 * Everything that does not match is returned VERBATIM, which keeps the engine's
 * standing promise that the words on a receipt are the tool's.
 *
 * Idempotent: a value the tool already formatted comes back unchanged.
 *
 * THE SEPARATOR IS ALWAYS `,` AND THE POINT ALWAYS `.`, DELIBERATELY - this is
 * not an oversight about locales. The agents' own tools already format some
 * amounts themselves, en-US style (`_num_disp` in jcc/support/util.py emits
 * `1,000,000.00`), and those strings land on the SAME review screen as the ones
 * formatted here. Following the viewer's locale would render one row as
 * `5.000,00 USD` and the row under it as `1,000,000.00 USD`, which is worse than
 * either convention applied consistently. One screen, one convention; changing
 * it is a product decision that has to move the tools too.
 */

/** Amount body: digits, optional existing comma grouping, optional decimals. */
const AMOUNT = String.raw`\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?`;
/** Symbols a tool may put in front of an amount. */
const SYMBOL = String.raw`[$£€¥₹]`;

/**
 * Currency codes this formatter will act on. A WHITELIST rather than "any three
 * capitals", because `5000 NEW` or `1200 EACH` are not amounts and three
 * capitals is not a currency test. An unlisted-but-real currency simply renders
 * unformatted, which is the safe direction and exactly what the rest of this
 * module does with anything it is not sure about.
 */
const CODES = [
  'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'NZD', 'CHF', 'SEK', 'NOK', 'DKK',
  'INR', 'SGD', 'HKD', 'CNY', 'MXN', 'BRL', 'ZAR', 'PLN', 'CZK', 'HUF', 'ILS',
  'AED', 'SAR', 'KRW', 'TWD', 'THB', 'MYR', 'PHP', 'IDR', 'TRY', 'RON', 'CLP',
  'COP', 'ARS', 'VND', 'ISK',
];
const CODE = `(?:${CODES.join('|')})`;

/**
 * Currencies with NO minor unit: padding these to two decimals invents a
 * precision the currency does not have (`5000 JPY` is five thousand yen, not
 * five thousand point zero zero). ISO 4217 zero-decimal list, trimmed to the
 * codes above.
 */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK']);

/** `$1,234.5` / `£95000` - symbol in front, nothing after the number. */
const SYMBOL_FIRST = new RegExp(`^(${SYMBOL})\\s?(${AMOUNT})$`);
/** `5000 USD` / `1,234.50USD` - code behind, nothing in front. */
const CODE_LAST = new RegExp(`^(${AMOUNT})\\s?(${CODE})$`);

/**
 * Thousands separators and at least two decimals - WITHOUT CHANGING THE NUMBER.
 *
 * Done on the digit STRING, never through `Number`, and that is not fussiness.
 * The first cut of this function used
 * `toLocaleString('en-US', {min/maxFractionDigits: 2})` and it silently rewrote
 * the amount:
 *
 *     1234.5678            -> 1,234.57                     (rounded)
 *     12.3456789           -> 12.35                        (rounded)
 *     95000.999            -> 95,001.00                    (rounded)
 *     12345678901234567890 -> 12,345,678,901,234,567,000   (float precision)
 *
 * Workday accepts up to SIX decimal places on an amount (see `_canon_money` in
 * the agents' util.py, which rejects anything longer), so 1234.5678 is a value a
 * user can legitimately submit - and a review that displays 1,234.57 while the
 * envelope carries 1234.5678 is showing the reader a different number from the
 * one they are authorizing. That is precisely the defect this whole function
 * exists to prevent, reintroduced by the formatting itself.
 *
 * So: group the integer part, and PAD the fraction to two places without ever
 * truncating it. Exact at any length, no floating point anywhere near it.
 */
function grouped(amount: string, minDecimals = 2): string | null {
  const plain = amount.replace(/,/g, '');
  const parts = /^(\d+)(?:\.(\d*))?$/.exec(plain);
  if (!parts) return null;
  const whole = parts[1].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  // At least `minDecimals` places so amounts line up as money; any the source
  // actually carries are KEPT verbatim, never trimmed.
  const fraction = (parts[2] ?? '').padEnd(minDecimals, '0');
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * A currency-marked amount with thousands separators and two decimals; ANY
 * other string returned exactly as it came in.
 */
export function formatMoneyText(value: string): string {
  const text = value.trim();
  if (!text) return value;

  const symbolFirst = SYMBOL_FIRST.exec(text);
  if (symbolFirst) {
    const symbol = symbolFirst[1];
    // The yen/yuan sign is the one symbol here whose currency has no minor
    // unit; the rest ($, £, €, ₹) all do.
    const n = grouped(symbolFirst[2], symbol === '¥' ? 0 : 2);
    return n === null ? value : `${symbol}${n}`;
  }

  const codeLast = CODE_LAST.exec(text);
  if (codeLast) {
    const code = codeLast[2];
    const n = grouped(codeLast[1], ZERO_DECIMAL.has(code) ? 0 : 2);
    return n === null ? value : `${n} ${code}`;
  }

  return value;
}
