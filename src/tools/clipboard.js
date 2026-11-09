// The clipboard, as plain text. Off by default: it often holds passwords and codes.
import { z } from "zod";
import { runJxa } from "../jxa.js";
import { errorResult, externalResult, textResult } from "../util.js";

const MAX_CHARS = 100_000;

const PRELUDE = `
ObjC.import("AppKit");
const pb = $.NSPasteboard.generalPasteboard;
`;

const SCRIPTS = {
  read: `
function main(a) {
  const value = pb.stringForType($.NSPasteboardTypeString);
  const text = value && !value.isNil() ? value.js : null;
  const types = pb.types;
  const kinds = [];
  for (let i = 0; types && !types.isNil() && i < types.count; i++) kinds.push(types.objectAtIndex(i).js);
  return { text: text === null ? null : text.slice(0, a.maxChars), truncated: text !== null && text.length > a.maxChars, types: kinds.slice(0, 20) };
}`,
  write: `
function main(a) {
  pb.clearContents;
  return { written: Boolean(pb.setStringForType($(a.text), $.NSPasteboardTypeString)), chars: a.text.length };
}`,
};

export function createClipboard({ jxa = runJxa } = {}) {
  const call = (name, params) => jxa(PRELUDE, SCRIPTS[name], params, { timeoutMs: 10_000, failure: "Could not use the clipboard." });
  return {
    read: () => call("read", { maxChars: MAX_CHARS }),
    write: ({ text }) => call("write", { text }),
  };
}

export function registerClipboard(server, clipboard = createClipboard()) {
  server.registerTool(
    "clipboard_read",
    {
      description: "Reads the text currently on the clipboard. If it holds something else, such as an image, `text` is null and `types` says what it is.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return externalResult(await clipboard.read());
      } catch (error) {
        return errorResult(error.message);
      }
    },
  );

  server.registerTool(
    "clipboard_write",
    {
      description: "Puts text on the clipboard, replacing what was there, so the person can paste it anywhere.",
      inputSchema: { text: z.string().min(1).max(MAX_CHARS) },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        return textResult(await clipboard.write(args));
      } catch (error) {
        return errorResult(error.message);
      }
    },
  );
}
