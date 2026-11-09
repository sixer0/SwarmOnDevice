// Output verification report types (row 148 spec §2; decision U24 A). Do not edit without a spec change.
export const OUTPUT_VERIFICATION_SCHEMA = "studio.output-verification/v1" as const
export const OUTPUT_VERIFICATION_CHECKS_VERSION = 1 as const
export const VERIFY_FINDINGS_CAP = 50
export const VERIFY_REPORT_MAX_BYTES = 256 * 1024

export type VerifyCheckId = "LINT" | "OVERLAP_CLIP" | "FIDELITY" | "PAGE_COUNT" | "FIGURE_FIT" | "EMPTY_SLOTS"
export type VerifyCheckStatus = "PASS" | "FAIL" | "UNKNOWN" | "NOT_APPLICABLE"
export type OutputVerificationState = "verified" | "unverified"
export type VerifyUnknownReason =
  | "BRIDGE_UNAVAILABLE" | "QUEUE_FULL" | "TIMEOUT" | "BUDGET_EXCEEDED" | "MEASURE_TRUNCATED"
  | "LINT_NOT_RUN" | "LINT_PARTIAL" | "SOURCE_MISSING" | "PARSE_FAILED" | "NO_GEOMETRY_LINT"
  | "MARGINS_UNREADABLE" | "NUMBER_UNPARSED" | "VERIFY_INTERNAL"
  // Row 205 (1.2.3, HB-1): a flow document laid out narrower than the sheet (e.g. a classic scrollbar took layout width),
  // so a right-edge overflow cannot be judged against the sheet the PDF uses. Blocks `verified` like every UNKNOWN.
  | "FLOW_LAYOUT_UNMEASURABLE"
/** Where a check was measured: on the file itself, the revision's stored lint, or the same render job's HTML/SVG (§3.7). */
export type VerifyBasis = "self" | "revision-lint" | "revision-store" | "same-job-html" | "same-job-svg"

export interface VerifyFinding {
  code: string
  page: number | null // 1-based; null in flow layout or when the finding has no page
  address: string | null // data-address / block address
  label: string | null // element label or figure key (document-derived: untrusted)
  detail: string // short, document-derived parts are untrusted
  amount?: number // mm, mm2 or count, per code
}
export interface VerifyCheck {
  id: VerifyCheckId
  status: VerifyCheckStatus
  basis: VerifyBasis
  reason: VerifyUnknownReason | null // set only when status is UNKNOWN
  findings: VerifyFinding[] // at most VERIFY_FINDINGS_CAP
  truncated: number // findings not listed
  ms: number
}
export interface VerifyPage {
  n: number
  png: string | null // absolute path of the page image (GAP-1); null when none was made
  findings: number
}
export interface VerifiedOutput {
  outputId: string
  format: "DOCX" | "PDF" | "HTML" | "SVG" | "PNG"
  role: "PRIMARY" | "FIGURE"
  figureLabel: string | null
  sha256: string
  state: OutputVerificationState
  checks: VerifyCheck[] // always all six ids, in the order of VerifyCheckId
  pages: VerifyPage[]
}
export interface OutputVerificationReport {
  $schema: typeof OUTPUT_VERIFICATION_SCHEMA
  checksVersion: typeof OUTPUT_VERIFICATION_CHECKS_VERSION
  documentId: string
  revisionNo: number
  renderJobId: string | null
  scope: "DOCUMENT" | "CHAPTER" | "SLOT"
  draft: boolean
  layout: "paged" | "flow" | "none"
  formatsAdded: Array<"html" | "svg"> // formats the wrapper added to the request (§6.1)
  layoutWitness: boolean // a PRIMARY PDF or HTML of this revision is verified (§7.2)
  overall: OutputVerificationState // all outputs verified, and layoutWitness for DOCUMENT scope
  outputs: VerifiedOutput[]
  bridgeJobs: number
  ms: number
}
