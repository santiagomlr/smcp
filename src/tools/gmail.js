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
      throw new Error("Abre la app SMCP para usar Gmail.");
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
  const account = z.string().max(200).describe("Correo o nombre de la cuenta, según gmail_list_accounts.");

  server.registerTool(
    "gmail_list_accounts",
    { description: "Lista las cuentas de Gmail conectadas en SMCP, con su nombre.", annotations: readOnly },
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
        "Busca correos con la sintaxis de Gmail (por ejemplo, `is:unread from:ana newer_than:7d`). Sin `account`, busca en todas las cuentas. Sin `query`, muestra la bandeja de entrada.",
      inputSchema: {
        account: account.optional(),
        query: z.string().max(500).optional(),
        limit: z.number().int().min(1).max(50).default(20).describe("Máximo de mensajes por cuenta."),
      },
      annotations: readOnly,
    },
    tool("gmailSearch", externalResult),
  );

  server.registerTool(
    "gmail_read",
    {
      description: "Lee un correo completo con el `uid` y la cuenta que devolvió gmail_search.",
      inputSchema: { account, uid: z.number().int().min(1) },
      annotations: readOnly,
    },
    tool("gmailRead", externalResult),
  );

  server.registerTool(
    "gmail_send",
    {
      description:
        "Envía un correo de texto. Abre una ventana de macOS y solo envía si la persona presiona Enviar. Para responder dentro de una conversación, usa `reply_to_uid`.",
      inputSchema: {
        account,
        to: z.array(z.string().max(254)).min(1).max(10),
        subject: z.string().max(200),
        body: z.string().min(1).max(2000),
        reply_to_uid: z.number().int().min(1).optional().describe("uid del correo que se responde."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    tool("gmailSend", textResult, { timeoutMs: SEND_TIMEOUT_MS }),
  );
}
