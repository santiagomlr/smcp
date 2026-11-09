import { z } from "zod";
import { viaHelper } from "../helper.js";
import { errorResult, externalResult, textResult } from "../util.js";

const SEND_TIMEOUT_MS = 200_000;

/** Passwords live only in SMCP.app, so there is no way to run these without it. */
function callApp(op, params, options) {
  return viaHelper(
    op,
    params,
    () => {
      throw new Error("Open the SMCP app to use Gmail.");
    },
    options,
  );
}

function tool(op, wrap, options) {
  return async (args) => {
    try {
      return wrap(await callApp(op, args, options));
    } catch (error) {
      return errorResult(error.message);
    }
  };
}

export function registerGmail(server) {
  const readOnly = { readOnlyHint: true, openWorldHint: true };
  const account = z.string().max(200).describe("Account email or name, as listed by gmail_list_accounts.");

  server.registerTool(
    "gmail_list_accounts",
    { description: "Lists the Gmail accounts connected in SMCP, with their names.", annotations: readOnly },
    async () => {
      try {
        return textResult(await callApp("gmailAccounts", {}));
      } catch (error) {
        return errorResult(error.message);
      }
    },
  );

  server.registerTool(
    "gmail_search",
    {
      description:
        "Searches email with Gmail syntax (for example, `is:unread from:ana newer_than:7d`). Without `account`, searches every account. Without `query`, shows the inbox.",
      inputSchema: {
        account: account.optional(),
        query: z.string().max(500).optional(),
        limit: z.number().int().min(1).max(50).default(20).describe("Maximum messages per account."),
      },
      annotations: readOnly,
    },
    tool("gmailSearch", externalResult),
  );

  server.registerTool(
    "gmail_read",
    {
      description:
        "Reads a full email using the `uid` and account returned by gmail_search. Attachments come back already scanned by SMCP's antivirus, " +
        "and links that look like phishing are listed under security. Tell the person about anything flagged.",
      inputSchema: { account, uid: z.number().int().min(1) },
      annotations: readOnly,
    },
    tool("gmailRead", externalResult),
  );

  server.registerTool(
    "gmail_send",
    {
      description:
        "Sends a plain-text email. Opens a macOS window and sends only if the person presses Send. To reply within a conversation, use `reply_to_uid`.",
      inputSchema: {
        account,
        to: z.array(z.string().max(254)).min(1).max(10),
        subject: z.string().max(200),
        body: z.string().min(1).max(2000),
        reply_to_uid: z.number().int().min(1).optional().describe("uid of the email being answered."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    tool("gmailSend", textResult, { timeoutMs: SEND_TIMEOUT_MS }),
  );

  server.registerTool(
    "gmail_reply",
    {
      description:
        "Replies to an email. The recipients and the 'Re:' subject come from the original, so only the body is needed. Opens a macOS window and sends only if the person presses Send.",
      inputSchema: {
        account,
        uid: z.number().int().min(1).describe("uid of the email being answered, from gmail_search."),
        body: z.string().min(1).max(2000),
        reply_all: z.boolean().default(false).describe("Also answers everyone else on To and Cc."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    tool("gmailReply", textResult, { timeoutMs: SEND_TIMEOUT_MS }),
  );

  server.registerTool(
    "gmail_draft",
    {
      description:
        "Saves a draft in the account's Drafts folder without sending it, so the person can review and send it from Gmail. With `reply_to_uid`, it stays in that conversation and the recipients and subject can be left out.",
      inputSchema: {
        account,
        to: z.array(z.string().max(254)).max(10).optional(),
        subject: z.string().max(200).optional(),
        body: z.string().min(1).max(50_000),
        reply_to_uid: z.number().int().min(1).optional(),
        reply_all: z.boolean().default(false),
      },
      // A draft is still writing, so read-only mode stops it.
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    tool("gmailDraft", textResult),
  );

  server.registerTool(
    "gmail_read_attachment",
    {
      description:
        "Reads an email attachment as text: PDFs, Word, RTF, HTML and plain text. `index` counts from 0 in the order gmail_read lists the attachments. " +
        "SMCP's antivirus scans it first: a malicious attachment comes back blocked, with the reasons, instead of its text.",
      inputSchema: { account, uid: z.number().int().min(1), index: z.number().int().min(0).max(100) },
      annotations: readOnly,
    },
    tool("gmailAttachment", externalResult, { timeoutMs: 180_000 }),
  );
}
