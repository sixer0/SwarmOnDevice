/**
 * IMPL-W4 butir 2 (D-545/D-547): saluran meta `studio_edit` untuk DOKUMEN KLIEN. Agen memberi meta datar yang sama
 * dengan `studio_write` (title, number, rev, date, author, checker, approver, classification, revisionNote, ...); modul
 * murni ini menyusun ulang meta lengkap dari isi server (DocMeta + blok kendali sampul + lembar kendali), menimpanya
 * dengan meta agen. Siklus perbaikan 1 (W4-M1, review 13): slot depan TIDAK disusun ulang; hanya entri yang dimaksud
 * ditambal (sel nilai pasangan berlabel sampul, lapis rantai verifikasi dan peran tanda tangan yang dikenal, baris riwayat
 * revisi terakhir/baru, judul lembar kendali berpola baku); semua entri lain tetap identik byte. Perubahan yang tidak
 * dapat diterapkan tanpa kehilangan entri (bahasa label, daftar distribusi yang sudah berisi) -> META_UNSAFE (hasil
 * normal, 0 tulis). Tanpa I/O; pemanggil mengirim lingkup yang berubah (setMeta + slot) lewat jalur sunting.
 */
import { McpToolError } from "./safety";
import { isRecord, tok, type ToolWarning } from "./tool-kit";
import { docMetaOf, frontSlots, labelsOf, LEGACY_EN_LABELS, metaFieldOf, normalizeMeta, NUMBER_DISPLAY_ONLY, shortRev, type ClientMeta, type MetaField } from "./write-client";
import type { Scope } from "./write-client-edit";

type Rec = Record<string, unknown>;
const plain = (v: unknown): string => (isRecord(v) ? (typeof v.text === "string" ? v.text : Array.isArray(v.runs) ? v.runs.map((r) => (isRecord(r) && typeof r.t === "string" ? r.t : "")).join("") : "") : "");
// D-6 (S12): label EN lama (sebelum register S12: Author, Prepared, Checked, Approved) tetap dikenali saat membaca dan
// menambal dokumen EN lama; entri baru memakai label register (`labelsOf`).
const LABEL_SETS = [labelsOf({}), labelsOf({ language: "EN" }), LEGACY_EN_LABELS];

/** Meta datar (nama kanonik) dari isi server: kebalikan `frontSlots` + `docMetaOf`. */
export function serverClientMeta(content: Rec): Record<string, string> {
  const out: Record<string, string> = {};
  const cm = isRecord(content.meta) ? content.meta : {};
  for (const f of ["title", "author", "classification", "audience", "custodian", "basis", "subject", "language"] as const) if (typeof cm[f] === "string" && cm[f] !== "") out[f] = cm[f] as string;
  if (typeof cm.issueDate === "string") out.date = cm.issueDate;
  if (typeof cm.rev === "string") out.rev = cm.rev;
  const sections = isRecord(content.sections) ? content.sections : {};
  const cover = isRecord(sections.cover) ? sections.cover : {};
  const pairs: Array<[string, string]> = [];
  for (const row of Array.isArray(cover.control) ? cover.control : []) {
    if (!Array.isArray(row)) continue;
    for (let i = 0; i + 1 < row.length; i += 2) pairs.push([plain(row[i]), plain(row[i + 1])]);
  }
  for (const [label, value] of pairs) {
    for (const L of LABEL_SETS) {
      if (label === L.number) out.number = value;
      else if (label === L.rev) {
        const [r, d] = value.split(" · ");
        if (r) out.rev = r.trim();
        if (d && /^\d{4}-\d{2}-\d{2}$/.test(d.trim())) out.date = d.trim();
      } else for (const f of ["author", "classification", "audience", "custodian", "basis"] as const) if (label === L[f] && value !== "") out[f] = value;
    }
  }
  if (isRecord(cover.standfirst)) out.standfirst = plain(cover.standfirst);
  const cs = isRecord(sections.controlSheet) ? sections.controlSheet : {};
  if (out.number === undefined && isRecord(cs.title)) {
    const t = plain(cs.title);
    for (const L of LABEL_SETS) if (t.startsWith(`${L.sheet} `)) out.number = t.slice(L.sheet.length + 1);
  }
  for (const v of Array.isArray(cs.verificationChain) ? cs.verificationChain : []) {
    if (!isRecord(v) || typeof v.name !== "string") continue;
    for (const L of LABEL_SETS) {
      if (v.role === L.checked) out.checker = v.name;
      if (v.role === L.approved) out.approver = v.name;
    }
  }
  if (isRecord(cs.methodStatement)) out.method = plain(cs.methodStatement);
  if (Array.isArray(cs.distribution)) out.distribution = cs.distribution.map((d) => (isRecord(d) && typeof d.holder === "string" ? d.holder : "")).filter((h) => h !== "").join("; ");
  return out;
}


const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const txt = (s: string) => ({ text: s });
type LabelKey = keyof ReturnType<typeof labelsOf>;
const isLabel = (v: unknown, key: LabelKey) => LABEL_SETS.some((L) => plain(v) === L[key] || v === L[key]);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Meta agen -> medan kanonik yang diberi (nilai satu baris); kunci tak dikenal / tanggal tak sah = peringatan. */
function wanted(given: Record<string, string>, warn: (w: ToolWarning) => void): ClientMeta {
  const want: ClientMeta = {};
  const unknown: string[] = [];
  for (const [k, v] of Object.entries(given)) {
    const f = metaFieldOf(k);
    const val = String(v).replace(/\s+/g, " ").trim();
    if (f === undefined) unknown.push(k);
    else if (val !== "") want[f] = val;
  }
  if (unknown.length > 0) warn({ code: "META_IGNORED", message: `meta tidak dikenal: ${unknown.slice(0, 8).map((k) => tok(k, "?")).join(", ")}` });
  if (want.number !== undefined) warn(NUMBER_DISPLAY_ONLY);
  if (want.date !== undefined && !ISO_DATE.test(want.date)) {
    warn({ code: "DATE_IGNORED", message: "meta.date bukan YYYY-MM-DD; tanggal tidak diubah" });
    delete want.date;
  }
  if (want.tier !== undefined) {
    // S12: tier menentukan slot depan yang sah (D-1); mengubahnya di sini dapat meninggalkan slot yang dilarang tier baru.
    warn({ code: "META_IGNORED", message: "meta.tier hanya diterapkan saat dokumen dibuat (studio_write dokumen baru); tier dokumen yang ada tidak diubah" });
    delete want.tier;
  }
  if (want.source !== undefined) {
    warn({ code: "META_IGNORED", message: "meta.source hanya dipakai tabel/gambar saat studio_write; tidak disimpan di slot depan" });
    delete want.source;
  }
  return want;
}

/** Sel nilai pasangan berlabel di blok kendali sampul; tidak ada -> pasangan ditambahkan (baris lain tetap). */
function setPair(control: unknown[][], key: LabelKey, label: string, value: string): void {
  for (const row of control) {
    for (let i = 0; i + 1 < row.length; i += 2) {
      if (isLabel(row[i], key)) {
        if (plain(row[i + 1]) !== value) row[i + 1] = txt(value);
        return;
      }
    }
  }
  const free = control.find((r) => r.length >= 4 && plain(r[2]) === "" && plain(r[3]) === "");
  if (free !== undefined) {
    free[2] = txt(label);
    free[3] = txt(value);
  } else control.push([txt(label), txt(value), txt(""), txt("")]);
}

/** Lapis rantai verifikasi ber-peran dikenal: nama ditambal; tidak ada -> lapis baru di akhir. */
function setChain(chain: Rec[], key: LabelKey, role: string, name: string): void {
  const hit = chain.find((v) => isLabel(v.role, key));
  if (hit !== undefined) {
    if (hit.name !== name) hit.name = name;
    return;
  }
  const layer = Math.max(0, ...chain.map((v) => Number(v.layer) || 0)) + 1;
  chain.push({ layer: String(layer), role, name });
}

/** Peran tanda tangan dikenal: pemegang (dan tanggal) ditambal; tidak ada -> peran baru di akhir. */
function setSig(roles: Rec[], key: LabelKey, role: string, holder: string, date?: string): void {
  const hit = roles.find((r) => isLabel(r.role, key));
  if (hit !== undefined) {
    if (plain(hit.holder) !== holder) hit.holder = txt(holder);
    if (date !== undefined && hit.date !== undefined && plain(hit.date) !== date) hit.date = txt(date);
    return;
  }
  roles.push({ role: txt(role), holder: txt(holder), ...(date !== undefined ? { date: txt(date) } : {}) });
}

const DOC_META_FIELDS: ReadonlyArray<[MetaField, string]> = [["title", "title"], ["author", "author"], ["classification", "classification"], ["custodian", "custodian"], ["audience", "audience"], ["basis", "basis"], ["subject", "subject"]];

/**
 * W4-M1: terapkan meta agen ke `content` (proyeksi R20, dimutasi) dengan MENAMBAL entri yang dimaksud. Kembali:
 * lingkup yang berubah (meta + slot depan) dan meta kanonik sesudahnya (gema). Tidak dapat tanpa kehilangan ->
 * McpToolError META_UNSAFE (sebelum mutasi apa pun).
 */
export function applyClientMeta(content: Rec, given: Record<string, string>, today: string, warn: (w: ToolWarning) => void): { touched: Scope[]; applied: Record<string, string> } {
  const want = wanted(given, warn);
  const sections = isRecord(content.sections) ? content.sections : {};
  content.sections = sections;
  const cm = isRecord(content.meta) ? content.meta : {};
  content.meta = cm;
  const cover = isRecord(sections.cover) ? sections.cover : null;
  const cs = isRecord(sections.controlSheet) ? sections.controlSheet : null;
  const sig = isRecord(sections.signature) ? sections.signature : null;
  const unsafe: string[] = [];
  const lang = cm.language === "EN" ? "EN" : "ID";
  if (want.language !== undefined && (want.language.toUpperCase().startsWith("EN") || /inggris/i.test(want.language) ? "EN" : "ID") !== lang) unsafe.push("language (label slot depan disusun dalam bahasa dokumen)");
  if (want.distribution !== undefined && cs !== null && Array.isArray(cs.distribution) && cs.distribution.length > 0) unsafe.push("distribution (daftar distribusi berisi akan diganti utuh)");
  if (unsafe.length > 0) {
    throw new McpToolError("META_UNSAFE", `${unsafe.length} medan meta tidak dapat diterapkan tanpa menghapus entri slot depan; tidak ada yang ditulis. Ubah entri itu dengan studio_edit { find, replace } atau studio_write`, { details: { fields: unsafe } });
  }
  const server = serverClientMeta(content);
  const merged = normalizeMeta({ ...server, ...want }, null, today, () => undefined);
  const L = labelsOf({ language: lang });
  const before = { cover: JSON.stringify(cover), controlSheet: JSON.stringify(cs), signature: JSON.stringify(sig) };
  const revGiven = want.rev !== undefined || want.date !== undefined || want.revisionNote !== undefined;
  // Sampul: blok kendali.
  if (cover !== null) {
    if (!Array.isArray(cover.control)) {
      if (want.number !== undefined) cover.control = (frontSlots(merged, () => undefined).cover.control as unknown[][]) ?? [];
    } else {
      const control = cover.control as unknown[][];
      if (want.number !== undefined) setPair(control, "number", L.number, want.number);
      if (want.rev !== undefined || want.date !== undefined) setPair(control, "rev", L.rev, `${merged.rev !== undefined ? shortRev(merged.rev) : "A"} · ${merged.date}`);
      for (const f of ["author", "classification", "audience", "custodian", "basis"] as const) if (want[f] !== undefined) setPair(control, f, L[f], want[f] as string);
    }
    if (want.standfirst !== undefined && plain(cover.standfirst) !== want.standfirst) cover.standfirst = txt(want.standfirst);
  }
  // Lembar kendali: judul berpola baku, riwayat revisi, rantai verifikasi, metode, distribusi (kosong saja).
  if (cs !== null) {
    if (want.number !== undefined) {
      const cur = plain(cs.title);
      if (cs.title === undefined || LABEL_SETS.some((x) => cur.startsWith(`${x.sheet} `))) {
        if (cur !== `${L.sheet} ${want.number}`) cs.title = txt(`${L.sheet} ${want.number}`);
      } else warn({ code: "META_PARTIAL", message: "judul lembar kendali kustom tidak diubah; nomor tampilan diterapkan di sampul" });
    }
    if (revGiven) {
      const fresh = (frontSlots(merged, () => undefined).controlSheet.revisionHistory as Rec[])[0];
      const rows = Array.isArray(cs.revisionHistory) ? (cs.revisionHistory as Rec[]) : [];
      const last = rows[rows.length - 1];
      if (last === undefined) rows.push(fresh);
      else if (String(last.rev) === String(fresh.rev)) {
        if (want.date !== undefined) last.date = fresh.date;
        if (want.rev !== undefined || want.revisionNote !== undefined) last.what = fresh.what;
      } else rows.push(fresh.what === L.first ? { ...fresh, what: shortRev(String(fresh.rev)) } : fresh);
      cs.revisionHistory = rows;
    }
    const chain = Array.isArray(cs.verificationChain) ? (cs.verificationChain as Rec[]) : null;
    if (chain !== null) {
      if (want.author !== undefined) setChain(chain, "author", L.author, want.author);
      if (want.checker !== undefined) setChain(chain, "checked", L.checked, want.checker);
      if (want.approver !== undefined) setChain(chain, "approved", L.approved, want.approver);
    }
    if (want.method !== undefined && plain(cs.methodStatement) !== want.method) cs.methodStatement = txt(want.method);
    if (want.distribution !== undefined) cs.distribution = frontSlots(merged, () => undefined).controlSheet.distribution;
  }
  // Tanda tangan.
  if (sig !== null && Array.isArray(sig.roles)) {
    const roles = sig.roles as Rec[];
    if (want.author !== undefined || want.date !== undefined) setSig(roles, "made", L.made, merged.author as string, want.date);
    if (want.checker !== undefined) setSig(roles, "checked", L.checked, want.checker);
    if (want.approver !== undefined) setSig(roles, "approved", L.approved, want.approver);
  }
  const touched: Scope[] = [];
  // DocMeta: hanya kunci yang medan sumbernya diberi.
  const dm = docMetaOf(merged, (w) => (want.rev !== undefined && w.code === "REV_DISPLAY_ONLY" ? warn(w) : undefined));
  let metaChanged = false;
  const patch = (k: string, v: unknown) => {
    if (v !== undefined && cm[k] !== v) {
      cm[k] = v;
      metaChanged = true;
    }
  };
  for (const [f, k] of DOC_META_FIELDS) if (want[f] !== undefined) patch(k, dm[k]);
  if (want.rev !== undefined) patch("rev", dm.rev);
  if (want.date !== undefined) patch("issueDate", dm.issueDate);
  if (metaChanged) touched.push({ kind: "meta" });
  const now = { cover: JSON.stringify(cover), controlSheet: JSON.stringify(cs), signature: JSON.stringify(sig) };
  for (const slot of ["cover", "controlSheet", "signature"] as const) if (!same(before[slot], now[slot])) touched.push({ kind: "slot", slot });
  const applied: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) if (typeof v === "string") applied[k] = v;
  return { touched, applied };
}
