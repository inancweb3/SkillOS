/**
 * I-JSON-oriented JSON text parser: rejects duplicate keys (RFC 7493 / RFC 8785 §3.1).
 * Standard JSON.parse keeps last-wins and is not sufficient.
 */

import { ProtocolError } from "./types.js";

/**
 * Parse a JSON text with fail-closed duplicate key detection.
 */
export function parseJsonStrict(text: string): unknown {
  if (typeof text !== "string") {
    throw new ProtocolError("INVALID_JSON", "JSON text must be a string");
  }
  let i = 0;
  const n = text.length;

  function peek(): string {
    return i < n ? text[i]! : "";
  }

  function advance(): string {
    return i < n ? text[i++]! : "";
  }

  function skipWs(): void {
    while (i < n) {
      const c = text[i]!;
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        i++;
      } else {
        break;
      }
    }
  }

  function expect(ch: string): void {
    skipWs();
    if (advance() !== ch) {
      throw new ProtocolError(
        "INVALID_JSON",
        `expected '${ch}' at position ${i - 1}`,
      );
    }
  }

  function parseString(): string {
    if (advance() !== '"') {
      throw new ProtocolError("INVALID_JSON", `expected string at ${i - 1}`);
    }
    let out = "";
    while (i < n) {
      const c = advance();
      if (c === '"') {
        return out;
      }
      if (c === "\\") {
        const e = advance();
        switch (e) {
          case '"':
          case "\\":
          case "/":
            out += e;
            break;
          case "b":
            out += "\b";
            break;
          case "f":
            out += "\f";
            break;
          case "n":
            out += "\n";
            break;
          case "r":
            out += "\r";
            break;
          case "t":
            out += "\t";
            break;
          case "u": {
            const hex = text.slice(i, i + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              throw new ProtocolError(
                "INVALID_JSON",
                `invalid unicode escape at ${i}`,
              );
            }
            i += 4;
            out += String.fromCharCode(parseInt(hex, 16));
            break;
          }
          default:
            throw new ProtocolError(
              "INVALID_JSON",
              `invalid escape \\${e} at ${i}`,
            );
        }
      } else if (c.charCodeAt(0) < 0x20) {
        throw new ProtocolError(
          "INVALID_JSON",
          `unescaped control character at ${i - 1}`,
        );
      } else {
        out += c;
      }
    }
    throw new ProtocolError("INVALID_JSON", "unterminated string");
  }

  function parseNumber(): number {
    const start = i;
    if (peek() === "-") i++;
    if (peek() === "0") {
      i++;
    } else if (peek() >= "1" && peek() <= "9") {
      while (peek() >= "0" && peek() <= "9") i++;
    } else {
      throw new ProtocolError("INVALID_JSON", `invalid number at ${start}`);
    }
    if (peek() === ".") {
      i++;
      if (!(peek() >= "0" && peek() <= "9")) {
        throw new ProtocolError("INVALID_JSON", `invalid fraction at ${i}`);
      }
      while (peek() >= "0" && peek() <= "9") i++;
    }
    if (peek() === "e" || peek() === "E") {
      i++;
      if (peek() === "+" || peek() === "-") i++;
      if (!(peek() >= "0" && peek() <= "9")) {
        throw new ProtocolError("INVALID_JSON", `invalid exponent at ${i}`);
      }
      while (peek() >= "0" && peek() <= "9") i++;
    }
    const raw = text.slice(start, i);
    const num = Number(raw);
    if (!Number.isFinite(num)) {
      throw new ProtocolError(
        "INVALID_JSON",
        `non-finite JSON number token: ${raw}`,
      );
    }
    return num;
  }

  function parseArray(): unknown[] {
    expect("[");
    skipWs();
    const arr: unknown[] = [];
    if (peek() === "]") {
      i++;
      return arr;
    }
    for (;;) {
      arr.push(parseValue());
      skipWs();
      if (peek() === ",") {
        i++;
        continue;
      }
      if (peek() === "]") {
        i++;
        return arr;
      }
      throw new ProtocolError("INVALID_JSON", `expected , or ] at ${i}`);
    }
  }

  function parseObject(): Record<string, unknown> {
    expect("{");
    skipWs();
    // null prototype so "__proto__" is a normal key, not a prototype mutation.
    const obj = Object.create(null) as Record<string, unknown>;
    const seen = new Set<string>();
    if (peek() === "}") {
      i++;
      return obj;
    }
    for (;;) {
      skipWs();
      if (peek() !== '"') {
        throw new ProtocolError("INVALID_JSON", `expected property name at ${i}`);
      }
      const key = parseString();
      if (seen.has(key)) {
        throw new ProtocolError(
          "DUPLICATE_KEY",
          `duplicate JSON object key: ${JSON.stringify(key)}`,
          { key },
        );
      }
      seen.add(key);
      expect(":");
      const value = parseValue();
      // Own data property — never trigger Object.prototype.__proto__ setter.
      Object.defineProperty(obj, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      skipWs();
      if (peek() === ",") {
        i++;
        continue;
      }
      if (peek() === "}") {
        i++;
        return obj;
      }
      throw new ProtocolError("INVALID_JSON", `expected , or } at ${i}`);
    }
  }

  function parseValue(): unknown {
    skipWs();
    const c = peek();
    if (c === '"') return parseString();
    if (c === "{") return parseObject();
    if (c === "[") return parseArray();
    if (c === "t") {
      if (text.slice(i, i + 4) !== "true") {
        throw new ProtocolError("INVALID_JSON", `expected true at ${i}`);
      }
      i += 4;
      return true;
    }
    if (c === "f") {
      if (text.slice(i, i + 5) !== "false") {
        throw new ProtocolError("INVALID_JSON", `expected false at ${i}`);
      }
      i += 5;
      return false;
    }
    if (c === "n") {
      if (text.slice(i, i + 4) !== "null") {
        throw new ProtocolError("INVALID_JSON", `expected null at ${i}`);
      }
      i += 4;
      return null;
    }
    if (c === "-" || (c >= "0" && c <= "9")) return parseNumber();
    throw new ProtocolError("INVALID_JSON", `unexpected token at ${i}`);
  }

  const value = parseValue();
  skipWs();
  if (i !== n) {
    throw new ProtocolError(
      "INVALID_JSON",
      `trailing data at position ${i}`,
    );
  }
  return value;
}
