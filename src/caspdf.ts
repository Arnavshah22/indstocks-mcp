/**
 * PDF text extraction for Consolidated Account Statements.
 *
 * Kept apart from `cas.ts` on purpose: the parsing rules are the part that can
 * silently go wrong, so they stay pure and unit-testable, and this file holds the
 * one dependency that cannot be tested without a PDF engine.
 *
 * The statement never leaves the machine. It is read from local disk, decoded in
 * process, and only the parsed structure is returned — there is no upload step
 * and no network call anywhere in this path. That matters more here than
 * elsewhere in this server: a CAS is a complete record of someone's mutual fund
 * wealth, keyed to their PAN.
 */

import { readFile } from "node:fs/promises";

export class CasPdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CasPdfError";
  }
}

/** Wrong or missing password — by far the most common failure, so it is typed. */
export class CasPasswordError extends CasPdfError {
  constructor(needsPassword: boolean) {
    super(
      needsPassword
        ? "This CAS is password protected and no password was supplied. " +
            "CAMS/KFintech statements are encrypted with the password you chose when " +
            "requesting the statement (often your PAN in uppercase)."
        : "The supplied password was rejected by the PDF. " +
            "Check for case — CAS passwords are case sensitive and a PAN must be uppercase.",
    );
    this.name = "CasPasswordError";
  }
}

/**
 * Extract the full text of a CAS PDF.
 *
 * pdfjs is loaded through unpdf's bundled build, which pulls in a serverless
 * pdfjs rather than the full 34 MB `pdfjs-dist` distribution. The import is
 * dynamic so that starting the MCP server — which for most users never touches a
 * CAS — does not pay for loading a PDF engine.
 */
export async function extractCasText(filePath: string, password?: string): Promise<string> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(filePath));
  } catch (error) {
    throw new CasPdfError(
      `Could not read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const { getDocumentProxy, extractText } = await import("unpdf");

  let pdf;
  try {
    pdf = await getDocumentProxy(bytes, password ? { password } : {});
  } catch (error) {
    // pdfjs signals both "needs a password" and "wrong password" as
    // PasswordException, distinguished only by a numeric code (1 = needed,
    // 2 = incorrect).
    const name = (error as { name?: string })?.name;
    if (name === "PasswordException") {
      const code = (error as { code?: number })?.code;
      throw new CasPasswordError(code === 1);
    }
    throw new CasPdfError(
      `Could not open ${filePath} as a PDF: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const { text } = await extractText(pdf, { mergePages: true });
    const merged = Array.isArray(text) ? text.join("\n") : text;
    if (!merged || merged.trim().length === 0) {
      throw new CasPdfError(
        "No text could be extracted. This looks like a scanned or image-only PDF; " +
          "CAS files downloaded from CAMS/KFintech are text PDFs, so re-download the " +
          "original rather than a printed or photographed copy.",
      );
    }
    return merged;
  } finally {
    await pdf.loadingTask?.destroy?.();
  }
}
