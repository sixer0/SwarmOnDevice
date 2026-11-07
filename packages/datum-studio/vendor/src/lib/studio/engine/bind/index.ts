/**
 * Modul engine/bind (I02, 01_specs.md §8.2), diisi S12.
 * Port `datumbind.py` (HS datum-house-style): Register, format angka DATUM
 * (DT-30), Derivation dengan parser aritmetika aman (tanpa evaluasi kode dinamis),
 * auditText, auditRetired.
 */
export { BindDefect } from "./defect";
export {
  DATUM_DECIMAL_SEPARATOR,
  DATUM_LEADING_UNITS,
  DATUM_MAX_DECIMALS,
  DATUM_THOUSANDS_SEPARATOR,
  DEFAULT_NUMBER_LANGUAGE,
  NUMBER_CONVENTIONS,
  fmt,
  numberConvention,
  numberLanguageOf,
  pyRound,
  withUnit,
  type NumberConvention,
  type NumberLanguage,
} from "./format";
export { Register, normalizeRegisterEntry, registerForSnapshot, type RegisterEmitInput, type RegisterSource } from "./register";
export { ARITH_MAX_DEPTH, ARITH_MAX_LENGTH, evalArith } from "./arith";
export {
  DERIVATION_DEFAULT_TOL,
  DERIVATION_DEFAULT_WIDTH,
  DERIVATION_VALUE_WIDTH,
  Derivation,
  buildDerivationBlock,
  checkResult,
  inlineText,
  monoLine,
  type DerivationBuild,
  type DerivationRow,
  type ResultCheck,
} from "./derivation";
export { BIND_NUMBER_PATTERN_SOURCE, auditRetired, auditText, bindNumberPatternSource } from "./audit";
export { BENCHMARK_MARKER_KEY, hasBenchmarkMarker, isVerbatimDerivation, isVerbatimReproduction } from "./reproduction";
export { decodeBase64, docAssetBytes, type DocAssetBytes, type DocAssetSource } from "./asset-bytes";
