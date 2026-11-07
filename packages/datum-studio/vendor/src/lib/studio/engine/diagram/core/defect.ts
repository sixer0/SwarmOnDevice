/**
 * `DiagramDefect` (port `datum_diagram.py:66`): cacat spek/geometri yang
 * memblokir rilis. Turunan `StudioEngineError` agar route memetakan ke HTTP:
 * sumber Mermaid -> 422 `DATUM-31`; JSON rusak -> 400 `JSON_MALFORMED`;
 * cacat lain -> 422 `BY_CONSTRUCTION_FAILED`. Pesan = teks Python (fixture
 * `bad_cases.json` mencocokkan substring `expect` pada pesan).
 */
import { StudioEngineError } from "../../../contract/errors";
import type { StudioErrorCode } from "../../../contract";

export class DiagramDefect extends StudioEngineError {
  /** Id cek Garis A yang gagal (mis. `P1-title`, `DATUM-24`), bila diketahui. */
  readonly checkId?: string;
  /** JSON pointer ke medan spek, bila diketahui. */
  readonly pointer?: string;

  constructor(message: string, opts: { checkId?: string; pointer?: string; code?: StudioErrorCode } = {}) {
    super(opts.code ?? "BY_CONSTRUCTION_FAILED", message, {
      checkId: opts.checkId,
      pointer: opts.pointer,
    });
    this.name = "DiagramDefect";
    this.checkId = opts.checkId;
    this.pointer = opts.pointer;
  }
}
