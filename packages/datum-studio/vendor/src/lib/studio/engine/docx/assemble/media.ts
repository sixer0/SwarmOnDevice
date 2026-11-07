/**
 * Media fragmen DOCX (S20; IP-03 penamaan seragam): penulisan bagian
 * `word/media/*`, relasi `word/_rels/document.xml.rels`, dan penulisan ulang
 * rujukan relasi di XML fragmen.
 *
 * Satu kelas media (IP-03, D-47/D-66): SEMUA media diberi nama
 * `fig-<sha256 32 hex>.<ext>` dan relasi `rIdFig<hex>`, apa pun renderernya
 * (S16 blok, S17 tabel, S18 pembungkus, S19 figur). Nama `fig-*` yang dibawa
 * fragmen dipertahankan; nama lain diturunkan dari sha256 isi. Dedup per nama
 * lewat `mergeFigureMedia` (nama sama isi beda = cacat). Relasi tidak
 * numerik sehingga tidak bentrok dengan alokasi seksi `FIRST_FREE_REL_ID`.
 * Fragmen merujuk media lewat `r:embed|link|id|pict` bernilai `media[i].name`
 * (boleh berawalan `media/`/`word/media/`), rId `rIdFig*`, atau placeholder
 * S16 `{{media:<nama>}}` (D-49); perakit mengganti dengan rId.
 *
 * Rujukan relasi yang tidak terselesaikan = BY_CONSTRUCTION_FAILED (gambar
 * rusak tidak pernah dikirim diam-diam).
 */
import { createHash } from "node:crypto";
import type { DocxFragment } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { mergeFigureMedia } from "../figures";
import { DOCX_CONTENT_TYPES, DOCX_REL_TYPES } from "../package";

const EXT_BY_CT: Readonly<Record<string, string>> = {
  [DOCX_CONTENT_TYPES.png]: "png",
  [DOCX_CONTENT_TYPES.jpeg]: "jpg",
  [DOCX_CONTENT_TYPES.gif]: "gif",
  [DOCX_CONTENT_TYPES.svg]: "svg",
  [DOCX_CONTENT_TYPES.emf]: "emf",
};

/** Nama media seragam (S19 `figureMediaName`, S18 `mediaName`). */
const UNIFORM_MEDIA_NAME_RE = /^fig-([0-9a-f]{32})\.(?:png|jpg|gif|svg|emf)$/;

const REL_ATTR_RE = /\br:(embed|link|id|pict)="([^"]*)"/g;
/** Placeholder relasi media S16 (blocks/media.ts `mediaRelPlaceholder`, D-49). */
const MEDIA_PLACEHOLDER_RE = /^\{\{media:([^}]+)\}\}$/;

export interface MediaPart {
  path: string;
  data: Uint8Array;
  contentType: string;
}

export interface MediaRelationship {
  id: string;
  type: string;
  target: string;
}

type FragmentMedia = NonNullable<DocxFragment["media"]>[number];

/** Nama seragam `fig-<sha32>.<ext>` untuk isi media. */
export function uniformMediaName(data: Uint8Array, contentType: string): string {
  const ext = EXT_BY_CT[contentType];
  if (!ext) throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `Tipe isi media tidak didukung DOCX: ${contentType}`);
  return `fig-${createHash("sha256").update(data).digest("hex").slice(0, 32)}.${ext}`;
}

/** Relasi `rIdFig<hex>` untuk nama seragam (= S19 `figureMediaRelId` untuk png/jpg). */
export function uniformMediaRelId(name: string): string {
  const m = UNIFORM_MEDIA_NAME_RE.exec(name);
  if (!m) throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `Nama media tidak seragam: ${name}`);
  return `rIdFig${m[1]}`;
}

/**
 * Pengumpul media lintas fragmen. `firstRelId` dipertahankan demi tanda
 * tangan S20 (relasi seksi berakhir sebelum nilai ini); sejak IP-03 media tidak
 * lagi memakai rId numerik.
 */
export class MediaCollector {
  private readonly entries: FragmentMedia[] = [];

  constructor(readonly firstRelId: number) {}

  private register(m: FragmentMedia, where: string): string {
    if (!EXT_BY_CT[m.contentType]) {
      throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `Tipe isi media tidak didukung DOCX: ${m.contentType} (${where})`, {
        media: m.name,
      });
    }
    const name = UNIFORM_MEDIA_NAME_RE.test(m.name) ? m.name : uniformMediaName(m.data, m.contentType);
    this.entries.push({ name, data: m.data, contentType: m.contentType });
    return uniformMediaRelId(name);
  }

  /**
   * Daftarkan media fragmen dan kembalikan XML fragmen dengan rujukan relasi
   * terselesaikan. `where` = alamat/blockId untuk pesan galat.
   */
  bind(fragment: DocxFragment, where: string): string {
    const local = new Map<string, string>();
    for (const m of fragment.media ?? []) {
      if (!m || typeof m.name !== "string" || m.name === "") {
        throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `Media tanpa nama (${where})`);
      }
      if (!(m.data instanceof Uint8Array) || m.data.length === 0) {
        throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `Media kosong: ${m.name} (${where})`);
      }
      if (local.has(m.name)) {
        throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `Nama media ganda dalam satu fragmen: ${m.name} (${where})`);
      }
      const rId = this.register(m, where);
      local.set(m.name, rId);
      local.set(rId, rId);
    }
    const out = fragment.xml.replace(REL_ATTR_RE, (_all, attr: string, raw: string) => {
      // Placeholder S16 (D-49): `{{media:<nama>}}` -> nama.
      const ph = MEDIA_PLACEHOLDER_RE.exec(raw);
      const value = ph ? ph[1] : raw;
      const rId = local.get(value) ?? local.get(value.replace(/^(?:word\/)?media\//, ""));
      if (!rId) {
        throw new StudioEngineError(
          "BY_CONSTRUCTION_FAILED",
          `Rujukan relasi r:${attr}="${value}" tidak terselesaikan (${where}); fragmen wajib merujuk media miliknya`,
        );
      }
      return `r:${attr}="${rId}"`;
    });
    if (out.includes("{{media:")) {
      throw new StudioEngineError("BY_CONSTRUCTION_FAILED", `Placeholder {{media:...}} tersisa di luar atribut relasi (${where})`);
    }
    return out;
  }

  /** Bagian dan relasi final, urut kemunculan pertama, dedup per nama. */
  finish(): { parts: MediaPart[]; relationships: MediaRelationship[] } {
    const merged = mergeFigureMedia([{ media: this.entries }]);
    return {
      parts: merged.map((m) => ({ path: `word/media/${m.name}`, data: m.data, contentType: m.contentType })),
      relationships: merged.map((m) => ({ id: uniformMediaRelId(m.name), type: DOCX_REL_TYPES.image, target: `media/${m.name}` })),
    };
  }
}

/**
 * Nomori ulang `wp:docPr/@id` berurutan 1..n menurut urutan dokumen (id unik
 * per dokumen; S19 memakai id sementara 100000 + ordinal*16); nama
 * `Picture N` ikut diselaraskan (pola BM). Dengan urutan
 * unit C14, nomor = urutan penempatan = nomor `bm-fig-NN` benchmark (D-44).
 */
export function renumberDrawingIds(xml: string): { xml: string; count: number } {
  let n = 0;
  const out = xml.replace(/<wp:docPr\b[^>]*>/g, (tag) => {
    const id = ++n;
    return tag.replace(/(\sid=")\d+(")/, `$1${id}$2`).replace(/(\sname="Picture )\d+(")/, `$1${id}$2`);
  });
  return { xml: out, count: n };
}
