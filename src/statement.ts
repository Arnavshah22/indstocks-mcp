/**
 * Statement routing.
 *
 * Two unrelated documents both get called a "CAS":
 *
 *   - the CAMS/KFintech registrar statement (`cas.ts`) — mutual funds only, with a
 *     full dated transaction ledger behind every folio;
 *   - the NSDL/CDSL depository statement (`casdepository.ts`) — every demat
 *     account across every broker, equities and bonds alongside funds, but a
 *     holdings snapshot with no transactions in it.
 *
 * They share almost nothing structurally, so they get separate parsers and this
 * module picks between them. It lives apart from both to avoid an import cycle:
 * the depository parser reuses the number and date helpers from the RTA one.
 *
 * It also closes a gap that was worse than either format being unsupported. A
 * depository statement used to be *detected* correctly and then handed to the RTA
 * parser, which found no folios and returned an empty statement with no warning —
 * so the tool reported zero holdings and zero rupees for someone whose entire
 * portfolio was sitting in the file. Both branches now say so when they read
 * nothing.
 */

import { parseCasText, type CasStatement } from "./cas.js";
import {
  detectDepositoryType,
  parseDepositoryText,
  type DepositoryStatement,
} from "./casdepository.js";

export type AnyStatement =
  | { kind: "rta"; statement: CasStatement }
  | { kind: "depository"; statement: DepositoryStatement };

export function parseStatement(text: string): AnyStatement {
  const depository = detectDepositoryType(text);
  if (depository) {
    return { kind: "depository", statement: parseDepositoryText(text, depository) };
  }

  const statement = parseCasText(text);
  if (statement.folios.length === 0) {
    // Never let "parsed nothing" look like "owns nothing".
    statement.warnings.push(
      "No folios could be read from this statement. If it is a CAMS or KFintech CAS, it may " +
        "be a summary rather than a detailed statement, or an image-only PDF. Do not read " +
        "this as an empty portfolio.",
    );
  }
  return { kind: "rta", statement };
}

/** True when the statement carries dated transactions, i.e. XIRR is possible. */
export function hasTransactions(parsed: AnyStatement): boolean {
  return parsed.kind === "rta";
}
