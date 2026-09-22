/**
 * text-safety.test.ts — contract tests for the shared sanitizer.
 *
 * stripControlChars/toSingleLine/safeTruncate back every surface that renders
 * untrusted child or config text. These tests pin the exact escape/output
 * contracts so a call site that drops or swaps a sanitizer is caught.
 */
import { describe, expect, it } from "vitest";
import { safeTruncate, stripControlChars, toSingleLine } from "../src/text-safety.js";

/** Matches an unpaired UTF-16 surrogate (a split astral code point). */
const LONE_SURROGATE = /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF]))|(?:(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/;

describe("toSingleLine", () => {
  it("collapses CR, LF, CRLF, and tab to spaces and trims the result", () => {
    expect(toSingleLine("a\r\nb")).toBe("a b");
    expect(toSingleLine("a\nb")).toBe("a b");
    expect(toSingleLine("a\rb")).toBe("a b");
    expect(toSingleLine("a\tb")).toBe("a b");
    expect(toSingleLine("  padded\tline  ")).toBe("padded line");
  });

  it("returns the empty string for empty or invisible-only input", () => {
    expect(toSingleLine("")).toBe("");
    expect(toSingleLine("\u0000\u200b")).toBe("");
    expect(toSingleLine(" \t\r\n ")).toBe("");
  });

  it("returns the empty string for non-string input", () => {
    for (const value of [undefined, null, 0, 42, Number.NaN, true, {}, ["a"], Symbol("s")]) {
      expect(toSingleLine(value)).toBe("");
    }
  });

  it("is idempotent on a mixed payload", () => {
    const payload = "  \u001b]0;t\u0007a\r\nb\tc\u200b\u2028  ";
    const once = toSingleLine(payload);
    expect(once).toBe("a b c");
    expect(toSingleLine(once)).toBe(once);
  });
});

describe("stripControlChars", () => {
  it("consumes complete OSC sequences whole, BEL and ST terminated", () => {
    expect(stripControlChars("a\u001b]0;title\u0007b")).toBe("ab");
    expect(stripControlChars("a\u001b]8;;https://example.invalid\u001b\\link")).toBe("alink");
  });

  it("removes complete CSI sequences", () => {
    expect(stripControlChars("a\u001b[31mred\u001b[0mb")).toBe("aredb");
    expect(stripControlChars("a\u001b[?25lb")).toBe("ab");
  });

  it("removes a dangling ESC/C1 introducer together with its introducer bytes", () => {
    expect(stripControlChars("a\u001b")).toBe("a");
    expect(stripControlChars("a\u001b]")).toBe("a");
    expect(stripControlChars("a\u001b(")).toBe("a");
    expect(stripControlChars("a\u009bb")).toBe("ab");
  });

  it("leaves an unterminated OSC payload as visible text (documented behavior)", () => {
    // The introducer is dropped, but without a terminator the payload is not
    // consumed as a sequence.
    expect(stripControlChars("a\u001b]0;payload")).toBe("a0;payload");
  });

  it("replaces each unpaired surrogate with U+FFFD", () => {
    expect(stripControlChars("a\uD83Db")).toBe("a\uFFFDb");
    expect(stripControlChars("a\uDE00b")).toBe("a\uFFFDb");
    expect(stripControlChars("a\uD83D\uD83Db")).toBe("a\uFFFD\uFFFDb");
    expect(stripControlChars("\uDE00\uD83D")).toBe("\uFFFD\uFFFD");
  });

  it("keeps well-formed astral pairs intact and is idempotent", () => {
    const astral = "a\u{1F600}\u{1D11E}b";
    expect(stripControlChars(astral)).toBe(astral);
    const once = stripControlChars("a\uD83D\uD83D\uDE00b\uDE00");
    expect(once).toBe("a\uFFFD\u{1F600}b\uFFFD");
    expect(stripControlChars(once)).toBe(once);
  });

  it("drops CR so CRLF collapses to LF", () => {
    expect(stripControlChars("a\r\nb")).toBe("a\nb");
    expect(stripControlChars("a\rb")).toBe("ab");
  });

  const INVISIBLE_CASES: Array<[string, string]> = [
    ["C0 NUL", "\u0000"],
    ["C0 backspace", "\u0008"],
    ["C0 vertical tab", "\u000b"],
    ["C0 form feed", "\u000c"],
    ["C0 carriage return", "\u000d"],
    ["C0 shift out", "\u000e"],
    ["C0 unit separator", "\u001f"],
    ["DEL", "\u007f"],
    ["C1 next line", "\u0085"],
    ["C1 application program command", "\u009f"],
    ["soft hyphen", "\u00ad"],
    ["Arabic letter mark", "\u061c"],
    ["combining grapheme joiner", "\u034f"],
    ["Hangul choseong filler", "\u115f"],
    ["Hangul jungseong filler", "\u1160"],
    ["Hangul filler", "\u3164"],
    ["Hangul halfwidth filler", "\uffa0"],
    ["Mongolian vowel separator", "\u180e"],
    ["zero width space", "\u200b"],
    ["zero width non-joiner", "\u200c"],
    ["zero width joiner", "\u200d"],
    ["left-to-right mark", "\u200e"],
    ["right-to-left mark", "\u200f"],
    ["line separator", "\u2028"],
    ["paragraph separator", "\u2029"],
    ["left-to-right embedding", "\u202a"],
    ["right-to-left embedding", "\u202b"],
    ["pop directional formatting", "\u202c"],
    ["left-to-right override", "\u202d"],
    ["right-to-left override", "\u202e"],
    ["word joiner", "\u2060"],
    ["invisible times", "\u2062"],
    ["left-to-right isolate", "\u2066"],
    ["pop directional isolate", "\u2069"],
    ["language tag", "\u{e0001}"],
    ["tag space", "\u{e0020}"],
    ["tag latin small letter a", "\u{e0061}"],
    ["cancel tag", "\u{e007f}"],
    ["variation selector supplement start", "\u{e0100}"],
    ["variation selector supplement end", "\u{e01ef}"],
    ["BOM / ZWNBSP", "\ufeff"],
  ];

  it.each(INVISIBLE_CASES)("strips %s wherever it appears", (_name, ch) => {
    expect(stripControlChars(`a${ch}b`)).toBe("ab");
    expect(stripControlChars(`a${ch}${ch}b`)).toBe("ab");
  });

  const KEPT_CASES: Array<[string, string]> = [
    ["text presentation selector", "\ufe0e"],
    ["emoji presentation selector", "\ufe0f"],
    ["tab", "\t"],
    ["line feed", "\n"],
    ["accented letter", "é"],
    ["CJK ideograph", "世"],
    ["emoji", "😀"],
    ["markdown", "**bold** _emphasis_ # heading"],
    ["XML-ish", '<tag attr="v">&amp;</tag>'],
  ];

  it.each(KEPT_CASES)("keeps %s", (_name, ch) => {
    expect(stripControlChars(`a${ch}b`)).toBe(`a${ch}b`);
  });

  it("stays linear on ~100 KB of input", () => {
    const body = "lorem ipsum dolor sit amet ".repeat(4_000);
    const input = `${body}\u001b]0;unterminated`;

    const started = performance.now();
    const output = stripControlChars(input);
    const elapsed = performance.now() - started;

    // The dangling introducer goes; the unterminated payload stays visible.
    expect(output).toBe(`${body}0;unterminated`);
    expect(output).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(elapsed).toBeLessThan(1_000);
  });
});

describe("safeTruncate", () => {
  it("returns the input unchanged at or below the limit", () => {
    expect(safeTruncate("abc", 3)).toBe("abc");
    expect(safeTruncate("abc", 10)).toBe("abc");
    expect(safeTruncate("", 0)).toBe("");
  });

  it("drops an astral pair that straddles the cut whole", () => {
    // "ab😀" is a, b, high, low (4 code units).
    expect(safeTruncate("ab😀", 3)).toBe("ab");
    expect(safeTruncate("a😀b", 2)).toBe("a");
  });

  it("never returns a lone surrogate at any cut point", () => {
    const s = "a😀b𝄞c";
    for (let max = 0; max <= s.length; max++) {
      expect(safeTruncate(s, max)).not.toMatch(LONE_SURROGATE);
    }
  });
});
