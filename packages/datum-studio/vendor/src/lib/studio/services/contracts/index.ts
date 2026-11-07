/**
 * Layanan kontrak (register 05 §5.6, §5.7, §7, §15 I54-I58; DC-07). Barrel murni:
 * reader Prisma diimpor langsung dari `./prisma-reader` agar barrel tidak memuat klien DB.
 * Belum dihubungkan ke gerbang ingest (DC-08) maupun commit (DC-09).
 */
export {
  checkContractRecord,
  CONTRACT_REF_DOCUMENT_ID_PATTERN,
  type ContractCheckIssue,
  type ContractCheckOptions,
  type ContractCheckResult,
  type ContractItemKeyDuplicateDetails,
} from "./validate";
export {
  resolveContractRefs,
  type ContractRefReader,
  type ContractRefTargetDoc,
  type ContractRefTargetIdentity,
  type ResolveContractRefsOptions,
  type ResolveContractRefsResult,
  type ResolvedContractRef,
} from "./refs";
export {
  projectContractRows,
  type ContractItemRow,
  type ContractMirrorColumns,
  type ContractProjection,
  type ContractProjectionContext,
  type ContractRecordRow,
  type ContractRefRow,
} from "./project";
export { contractItemTextPlain, contractRecordTextPlain } from "./text";
export { contractDateToUtc, isCalendarDay, isContractDate, isContractReportedAt, reportedAtToUtc } from "./dates";
export { summarizeContractChecks, type ContractCheckSummary, type ContractItemKeyDuplicate } from "./issues";
export { setContractsLogSink, type ContractsLogEntry, type ContractsLogSink } from "./log";
