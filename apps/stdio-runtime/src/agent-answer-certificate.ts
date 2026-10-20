/**
 * Machine-readable final-answer certificate helpers (pure, no I/O).
 *
 * The certificate is carrier data in the existing WorkPacket
 * `suggestedChecks` field. It never proves the mathematics and never changes
 * `candidateVerified`; it only lets control detect an internal contradiction
 * between the answer and the model's own explicit checks.
 */

export const CERT_PREFIX = "CERT1|";

export interface CertificatePacketView {
  readonly suggestedChecks?: readonly string[] | null;
  readonly candidateProposal?: string | null;
}

export interface CertificateSummary {
  readonly certified: boolean;
  readonly checkCount: number;
  readonly optionTruths: ReadonlyMap<string, boolean>;
  readonly verdict: boolean | null;
}

function rows(packet: CertificatePacketView): readonly string[] {
  return Array.isArray(packet.suggestedChecks)
    ? packet.suggestedChecks.filter((row): row is string => typeof row === "string")
    : [];
}

function truth(value: string): boolean | null {
  const token = value.trim().toUpperCase();
  if (["TRUE", "T", "YES", "Y", "真", "正确", "√"].includes(token)) return true;
  if (["FALSE", "F", "NO", "N", "假", "错误", "×"].includes(token)) return false;
  return null;
}

export function summarizeCertificate(packet: CertificatePacketView): CertificateSummary {
  const optionTruths = new Map<string, boolean>();
  let checkCount = 0;
  let certified = false;
  let verdict: boolean | null = null;
  for (const row of rows(packet)) {
    if (!row.startsWith(CERT_PREFIX)) continue;
    if (row.startsWith("CERT1|FINAL|")) {
      certified = true;
      continue;
    }
    if (row.startsWith("CERT1|CHECK|")) {
      if (row.includes("=>")) checkCount += 1;
      continue;
    }
    if (row.startsWith("CERT1|OPTIONS|")) {
      for (const part of row.slice("CERT1|OPTIONS|".length).split(/[,，;；]/u)) {
        const match = /^\s*([A-E])\s*[=:：]\s*(.+?)\s*$/u.exec(part);
        if (match === null) continue;
        const value = truth(match[2]!);
        if (value !== null) optionTruths.set(match[1]!.toUpperCase(), value);
      }
      continue;
    }
    if (row.startsWith("CERT1|VERDICT|")) {
      verdict = truth(row.slice("CERT1|VERDICT|".length));
    }
  }
  return { certified, checkCount, optionTruths, verdict };
}

export function isCertifiedPacket(packet: CertificatePacketView): boolean {
  const summary = summarizeCertificate(packet);
  return summary.certified && summary.checkCount >= 1;
}

/** Answer letters of a short multiple-choice proposal, in stable order. */
export function candidateChoiceLetters(candidate: string): string[] {
  const found = new Set<string>();
  for (const match of candidate.matchAll(/(?:^|[^A-Za-z])([A-E])(?=$|[^A-Za-z])/gu)) {
    found.add(match[1]!.toUpperCase());
  }
  return [...found].sort();
}

function canonicalChoice(letters: readonly string[]): string {
  return [...letters].sort().join("、");
}

function canonicalVerdict(packet: CertificatePacketView, verdict: boolean): string | null {
  const candidate = packet.candidateProposal ?? "";
  const canonical = verdict ? "正确" : "错误";
  if (candidate.trim() === canonical) return null;
  if (verdict) {
    if (/(?:^|[^正确])(错误|×|FALSE|NO)/iu.test(candidate)) return canonical;
  } else if (/(?:^|[^错误])(正确|√|TRUE|YES)/iu.test(candidate)) {
    return canonical;
  }
  return canonical;
}

/**
 * Derive a correction only from the model's own structured certificate rows.
 * Returning null means no machine-visible contradiction; it never means the
 * answer is mathematically correct.
 */
export function certificateCorrection(packet: CertificatePacketView): string | null {
  const summary = summarizeCertificate(packet);
  if (summary.optionTruths.size >= 2) {
    const trueLetters = [...summary.optionTruths.entries()]
      .filter(([, value]) => value)
      .map(([letter]) => letter)
      .sort();
    const proposed = candidateChoiceLetters(packet.candidateProposal ?? "");
    if (
      trueLetters.length > 0 &&
      (proposed.length !== trueLetters.length ||
        proposed.some((letter, index) => letter !== trueLetters[index]))
    ) {
      return canonicalChoice(trueLetters);
    }
  }
  if (summary.verdict !== null) {
    return canonicalVerdict(packet, summary.verdict);
  }
  return null;
}
