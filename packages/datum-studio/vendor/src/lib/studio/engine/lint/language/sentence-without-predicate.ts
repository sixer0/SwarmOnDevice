/**
 * C-36 (Swarm 1.3.3 row 85, ST-12; register 03 §7): kalimat tanpa predikat.
 *
 * Peringatan saja: setiap temuan berstatus REPORT, tidak pernah FAIL, jadi tidak pernah
 * menahan render atau rilis. Berlaku untuk teks Indonesia dan Inggris.
 *
 * Ini heuristik tanpa pengurai kalimat. Rancangannya mengutamakan ketepatan, bukan
 * kelengkapan: kalimat dilaporkan hanya bila TIDAK ADA satu pun tanda predikat di dalamnya.
 * Daftar tanda predikat sengaja longgar (kata berimbuhan verbal di dalam anak kalimat atau
 * frasa pewatas pun dihitung), sehingga banyak penggalan lolos tanpa peringatan, tetapi
 * kalimat yang dilaporkan hampir selalu memang penggalan catatan.
 *
 * Yang dipindai: lapisan `prose` (paragraf berperan prosa dan badan `aside`; lihat `prose.ts`).
 * Judul, butir daftar, sel tabel, keterangan gambar dan blok kode tidak ada di lapisan itu.
 *
 * Batas kalimat: `splitSentences` (tokenize.ts) ditambah titik yang disusul huruf kecil
 * yang ditemukan C-35 (`findLowercaseAfterStop`): di situlah penggalan catatan disambung.
 *
 * Kalimat TIDAK diperiksa (dikecualikan dari konstruksinya) bila:
 *  - kurang dari `MIN_WORDS` kata berhuruf (penggalan pendek, label);
 *  - tidak ditutup titik, tanda seru atau tanda tanya (label, kalimat pengantar yang
 *    ditutup titik dua);
 *  - berbentuk "istilah: penjelasan" (titik dua sesudah paling banyak `LABEL_MAX_WORDS` kata);
 *  - kalimat pertama paragraf, paling banyak `RUN_IN_HEADING_MAX_WORDS` kata, dan disusul kalimat
 *    lain: judul sebaris ("Aksi penutup dan penerima. Kepala badan menerima ...");
 *  - dibuka penanda butir (`(a)`, `1.`, `a)`): butir daftar sebaris;
 *  - berada di dalam tanda kutip, atau dibuka tanda kutip;
 *  - memuat rentang kode (backtick; dikenali bila unit membawa `raw`, lihat C-35);
 *  - berupa rumus (dua tanda hitung atau lebih, termasuk `=`; satu `=` saja bukan rumus);
 *  - paragrafnya baris tabel bergaris tegak (`a | b | c`).
 *
 * Tanda predikat bahasa Indonesia (sumber daftar: imbuhan verbal dan kata tugas baku
 * Tata Bahasa Baku Bahasa Indonesia; daftar kata disusun untuk baris ini, bukan kamus):
 *  - kata berawalan me(N)-, ber-, di-, ter-, atau berakhiran -kan (dengan daftar kecuali
 *    untuk kata benda, kata depan dan kata sambung yang kebetulan berbentuk sama; kata
 *    pe-...-kan dan ke-...-kan dianggap kata benda kecuali yang terdaftar);
 *  - kopula dan penanda: adalah, ialah, yaitu, yakni, ada (`sebagai` TIDAK dihitung);
 *    `bukan` dihitung hanya bila tidak mengikuti koma, tanda pisah atau kurung buka;
 *  - kata modal, aspek atau ingkar yang disusul kata (akan, dapat, harus, sudah, tidak, ...);
 *  - kata kerja dasar yang lazim tanpa imbuhan (masuk, naik, butuh, gagal, ...);
 *  - predikat sifat yang aman dikenali: kata penguat + kata (lebih, sangat, paling, ...),
 *    kata sifat di akhir kalimat atau di depan kata depan (peka terhadap, cukup untuk);
 *  - predikat nominal atau bilangan yang aman dikenali: kata ber-`nya` di awal kalimat
 *    (hasilnya 12,04 kVA), `ini`/`itu` yang disusul kata, kata ganti orang yang disusul
 *    kata, dan kalimat yang ditutup bilangan bersatuan, boleh disusul keterangan dalam
 *    kurung (Panjang ruas 40 km.).
 * Tanda predikat bahasa Inggris: kata kerja bantu dan kopula, akhiran -ed/-ize/-ify/-ate,
 * daftar ringkas kata kerja lazim (dengan -s/-es/-ed/-ing sesudah kata bantu), kata ganti
 * subjek yang disusul kata, dan kata jamak yang disusul kata isi (cameras monitor ...).
 * Pada dokumen berbahasa Indonesia, kata bantu Inggris yang tidak ambigu ikut dihitung.
 */
import type { LintIssue } from "../../../contract";
import type { Scanner } from "./checks";
import { findLowercaseAfterStop } from "./lowercase-after-stop";
import type { TextUnit } from "./prose";
import { splitSentences } from "./tokenize";

/** @internal test seam */
export const SENTENCE_WITHOUT_PREDICATE_ID = "C-36";

/** Kalimat dengan kata berhuruf lebih sedikit dari ini tidak diperiksa. */
/** @internal test seam */
export const MIN_WORDS = 4;
/** "Istilah: penjelasan": titik dua sesudah paling banyak sekian kata (isi kurung tidak dihitung). */
const LABEL_MAX_WORDS = 4;
/**
 * Kalimat pertama paragraf yang pendek dan disusul kalimat lain dianggap judul sebaris
 * (run-in heading, biasanya dicetak tebal): lapisan prosa tidak membawa tanda tebal.
 */
const RUN_IN_HEADING_MAX_WORDS = 6;
/** Plafon isu (satu isu per paragraf); sisanya diringkas. */
const MAX_PARAGRAPH_ISSUES = 50;
/** Kalimat yang dikutip per isu. */
const MAX_QUOTED = 2;
const MAX_QUOTE_CHARS = 120;
const CODE_PLACEHOLDER = "￼";

const set = (s: string): ReadonlySet<string> => new Set(s.split(/\s+/u).filter(Boolean));

// ── Indonesia ──────────────────────────────────────────────────────────────

/** Kata berbentuk me(N)- yang bukan kata kerja (benda, sifat, kata depan, kata sambung). */
const ME_NOT_VERB = set(`
  menara menit meter metode metoda media medium mesin meja merek memori menu mesh mekanisme mekanik mekanis
  metrik medan megah merah mentah menteri mental medis menurut mengenai menjelang mengingat merdeka mewah mebel
  medali megabit megabita megawatt meskipun meski melainkan memang mereka menengah mendatang menyeluruh
  mendasar mendalam mendadak melintang membujur mendatar meteran merpati melati melodi membran memo
  memorandum mentor merkuri mesiu metal metalik meteor meteorologi metropolitan metana mentega menantu
  mercusuar meriam mesra`);
/** Kata berbentuk ber- yang bukan predikat. */
const BER_NOT_VERB = set(`
  berkas berita beras berbagai bersama berikut berikutnya berdasarkan berkat berkala beranda berlian beruang
  berturut beringin berandal berontak bersih berat berani`);
/** Kata berbentuk di- yang bukan kata kerja pasif. */
const DI_NOT_VERB = set(`
  diagram digital dinding dinamis dinamika dinamo diameter dimensi diesel direktur direktorat direksi
  distribusi distributor diskusi disiplin diskon dialog divisi dioda diode digit diagnosis diagnostik
  dirinya dingin dinas dinar diklat dilema diploma diplomasi dispenser display distrik diversifikasi
  disket disposisi diferensial difusi dielektrik diktat diare diksi dipan disko diagonal dialek
  digitalisasi diskriminasi disertasi distorsi dividen dimana diantara diatas dibawah didalam
  disana disini disitu disamping diafragma diabetes direktif direktori diskrit dispersi disipasi
  disrupsi diskresi dimmer dipol dikotomi`);
/** Kata berbentuk ter- yang bukan predikat (benda, kata depan, penunjuk, superlatif pewatas). */
const TER_NOT_VERB = set(`
  terminal terminasi termal termin terhadap terutama tertentu terlalu terang teras terima terap teratai
  teritori teritorial terowongan termometer termostat termasuk terkait tersebut tersendiri terakhir terbaik
  terburuk terbesar terkecil tertinggi terendah terjauh terdekat terlama terbaru terpanjang terpendek
  terpenting terbanyak terdepan terdahulu terpadu terlebih termis terminologi terapi terasi terompet
  terpal terali terumbu ternak terjemahan terbitan terusan terobosan terapan terminus terra`);
/** Kata berakhiran -kan yang bukan kata kerja. */
const KAN_NOT_VERB = set(`
  bukan makan rekan pekan pakan dekan bahkan sedangkan melainkan jangankan akan ikan pelikan rakan
  apakan gerakan tekan masukan rujukan tumpukan ledakan desakan tebakan pijakan bentukan tolakan`);
/** Kata kerja berakhiran -kan yang berawalan pe- atau ke- (bentuk perintah atau dasar). */
const PE_KE_KAN_VERB = set(`
  perhatikan pertimbangkan perlihatkan pergunakan persiapkan perkirakan perlakukan peringatkan pecahkan
  pegangkan pentingkan keluarkan kerjakan kembalikan kenakan kemukakan kecualikan kembangkan kendalikan
  kerahkan ketahuilah kirimkan kumpulkan kurangkan`);
/** ke-...-an dalam pemakaian predikat. */
const KE_AN_VERB = set(`
  kehilangan kekurangan kelebihan ketinggalan kehabisan kedapatan kelihatan kedengaran kemasukan ketahuan
  kebanjiran keberatan kehujanan kepanasan kedinginan kemalaman kesulitan`);
/** Kopula dan penanda predikat (register 03 §7; `sebagai` sengaja tidak dimuat). */
const COPULA_ID = set(`adalah ialah yaitu yakni ada`);
/** Modal, aspek, ingkar: tanda predikat bila disusul kata. */
const MODAL_ID = set(`
  akan dapat bisa harus perlu sudah telah sedang belum tidak tak wajib boleh mampu sanggup mesti masih
  pernah jangan hendak ingin mau tetap sempat usah`);
/** Kata kerja dasar dan kata predikatif yang lazim tanpa imbuhan. */
const BASE_VERB_ID = set(`
  punya pakai masuk keluar naik turun tiba datang pergi jadi ikut lolos lulus gagal jatuh hilang muncul
  timbul tumbuh hidup mati tinggal kembali mulai selesai butuh minta tahu lihat buat beri ambil bawa pasang
  hitung tulis baca simpan kirim tunggu pilih ganti cek lahir lewat tampak setara sesuai layak pindah putus
  rusak habis duduk mohon harap tolong silakan coba ingat catat periksa sebut anggap kena suka lupa paham
  yakin setuju percaya maju mundur terbang pulang lari ukur rujuk bandingkan tambah kurangi bagi kali
  jumlah-kan tutup buka cabut lepas tarik dorong angkat taruh letak isi hapus ubah salin cetak unduh unggah
  muat pasok jaga jamin capai lampaui penuhi ikuti jalani alami setop henti lanjut ulang tuju bergantung
  tergantung wajib`);
/** Kata penguat: tanda predikat sifat bila disusul kata. */
const DEGREE_ID = set(`lebih kurang paling sangat amat terlalu cukup agak makin semakin sama`);
/** Kata sifat predikatif: dihitung di akhir kalimat atau di depan kata dalam `AFTER_ADJECTIVE`. */
const ADJECTIVE_ID = set(`
  besar kecil tinggi rendah penting aman sah benar salah baik buruk mahal murah cepat lambat panjang pendek
  kuat lemah jelas mudah sulit sukar mungkin wajar peka stabil lengkap siap kosong penuh tepat sempit luas
  lebar ringan berat kritis mustahil rawan rentan bebas identik serupa mirip konsisten relevan valid akurat
  efektif efisien sederhana rumit kompleks bersih kotor panas dingin baru lama jauh dekat sedikit banyak
  nol nihil terbuka tertutup tersedia`);
const AFTER_ADJECTIVE = set(`
  terhadap daripada dari bagi untuk dengan karena sehingga bila jika apabila sekali saat ketika tetapi namun
  meskipun walaupun agar supaya`);
/** Kata ber-`nya` yang kata keterangan, bukan subjek. */
const NYA_ADVERB = set(`
  hanya tanya punya misalnya biasanya umumnya khususnya sebaiknya seharusnya selanjutnya sebelumnya
  sesudahnya setelahnya akhirnya sebenarnya tampaknya agaknya rupanya kiranya setidaknya sepenuhnya
  sebaliknya seluruhnya semuanya lainnya berikutnya`);
const DEMONSTRATIVE_ID = set(`ini itu`);
const PREPOSITION_ID = set(`tentang untuk di pada dari bagi dengan sampai dalam ke oleh`);
const PRONOUN_ID = set(`ia dia mereka kami kita saya aku anda kamu beliau`);

// ── Inggris ────────────────────────────────────────────────────────────────

/** Kata bantu dan kopula Inggris yang tidak sama bentuknya dengan kata Indonesia. */
const AUX_EN_SAFE = set(`
  is are was were be been being am has have had does did will would can could shall should may might must
  isn't aren't wasn't weren't doesn't didn't don't won't can't cannot`);
const AUX_EN = new Set([...AUX_EN_SAFE, "do"]);
const VERB_EN = set(`
  make makes made use uses need needs show shows give gives gave take takes took run runs ran hold holds held
  keep keeps kept provide provides require requires include includes contain contains remain remains depend
  depends follow follows apply applies work works cover covers carry carries allow allows mean means become
  becomes became come comes came go goes went get gets got see sees saw set sets put puts add adds send sends
  sent read reads write writes wrote store stores feed feeds fed supply supplies support supports meet meets
  met exceed exceeds reach reaches start starts stop stops fail fails pass passes rise rises rose fall falls
  fell know knows knew say says said tell tells told find finds found let lets leave leaves left bring brings
  brought begin begins began seem seems help helps turn turns move moves live lives stand stands stood lose
  loses lost pay pays paid sit sits lead leads led grow grows grew open opens draw draws drew build builds
  built stay stays cut cuts drive drives drove break breaks broke spend spends spent serve serves call calls
  ask asks want wants try tries feel feels think thinks thought look looks play plays offer offers change
  changes check checks connect connects describe describes define defines list lists report reports return
  returns reject rejects accept accepts refuse refuses warn warns block blocks render renders compute computes
  measure measures monitor monitors record records sit lie lies lay rely relies
  replace install note ensure remove click select enter type press choose create delete update configure
  verify confirm review refer consult contact avoid consider do please copy paste save load attach
  submit fill sign print download upload restart reboot enable disable specify assume compare repeat wait`);
const PRONOUN_EN = set(`it he she they we you i this that these those there who which`);
/** Sesudah kata jamak, kata-kata ini bukan kata kerja (kata depan, kata sambung, penentu). */
const FUNCTION_EN = set(`
  of in on at for with by from to into onto over under per and or but nor as than the a an its their his her
  our your no not all both each every some any many several other such only also via within without between
  among across through during before after above below near against about around if when while because so
  that which who whose where`);

const TOKEN_RE = /[\p{L}][\p{L}'’]*/gu;
const ENUM_MARKER_AT_START = /^(?:\(\s*[\p{L}\p{N}]{1,3}\s*\)|[\p{L}\p{N}]{1,3}\))\s|^\d{1,3}\.\s/u;
const OPEN_QUOTES = `"“‘«`;
const TERMINAL = /[.!?…]["'”’»)\]]*$/u;
const FORMULA_OPERATORS = /[=×÷Σ∑√⌊⌈∫^]|\s[*/]\s/gu;
/** Kalimat ditutup bilangan + satu kata satuan: predikat bilangan (Panjang ruas 40 km.). */
const ENDS_WITH_QUANTITY = /\p{L}[^()]*\s[+\-−±≈~≤≥<>]?\d[\d.,]*\s?(?:%|‰|[\p{L}µμΩ°/²³]{1,12})\s*[.!?]$/u;

type PredicateLanguage = "ID" | "EN";

interface SentenceWithoutPredicateHit {
  /** Kalimat yang dilaporkan (dirapatkan spasinya). */
  sentence: string;
  /** Jumlah kata berhuruf dalam kalimat. */
  words: number;
}

interface Tok {
  /** Huruf kecil. */
  w: string;
  /** Karakter non-spasi terakhir sebelum kata ("" di awal kalimat). */
  before: string;
  /** Karakter tepat sesudah kata. */
  after: string;
  /** Token berikutnya dipisahkan spasi saja (tanpa tanda baca). */
  adjacentNext: boolean;
}

/** Rentang kode diganti penanda netral, penanda tebal/miring md-lite dibuang, spasi dirapatkan. */
function normalize(text: string): string {
  return text
    .replace(/`[^`\n]*`/gu, CODE_PLACEHOLDER)
    .replace(/[*`]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Baris tabel bergaris tegak yang masuk sebagai paragraf: sel tabel tidak dipindai. */
function looksLikeTableRow(text: string): boolean {
  return (text.match(/\s\|\s/gu) ?? []).length >= 2;
}

/** Pengenal, nama berkas, path dan kode dibuang sebelum kata dibaca (`KATALOG-RUMUS.md:408`, `A-28`, `05_calc_rev2.md`). */
function dropIdentifiers(sentence: string): string {
  return sentence
    .split(" ")
    .map((chunk) => {
      const core = chunk.replace(/^[("'“‘[]+|[)"'”’\].,;:!?…]+$/gu, "");
      if (core === "") return chunk;
      if (/[_\\@]|:\/\//u.test(core)) return " ";
      if (/\p{L}/u.test(core) && /\p{N}/u.test(core)) return " "; // A-28, L01, rev2, V6O13
      if (/\.\p{L}{1,5}(?::[\d\-,]+)?$/u.test(core) && /^[\p{L}\p{N}\-./:,]+$/u.test(core) && core.includes(".")) return " "; // nama berkas
      if ((core.match(/\//gu) ?? []).length >= 2) return " "; // path
      return chunk;
    })
    .join(" ");
}

function tokens(sentence: string): Tok[] {
  const s = dropIdentifiers(sentence);
  const out: Tok[] = [];
  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(s); m !== null; m = TOKEN_RE.exec(s)) {
    const head = s.slice(0, m.index).trimEnd();
    const rest = s.slice(m.index + m[0].length);
    out.push({
      w: m[0].toLowerCase().replace(/^['’]+|['’]+$/gu, ""),
      before: head.slice(-1),
      after: rest.charAt(0),
      adjacentNext: /^\s+[\p{L}]/u.test(rest) || /^[-‐/][\p{L}]/u.test(rest),
    });
  }
  return out.filter((t) => t.w !== "");
}

function verbalAffixId(w: string): boolean {
  if (w.length >= 5 && /^me(?:m|n|ng|ny)?\p{L}{3,}$/u.test(w) && !ME_NOT_VERB.has(w)) return true;
  if (w.length >= 6 && w.startsWith("ber") && !BER_NOT_VERB.has(w)) return true;
  if (w.length >= 5 && w.startsWith("di") && !DI_NOT_VERB.has(w)) return true;
  if (w.length >= 6 && w.startsWith("ter") && !TER_NOT_VERB.has(w)) return true;
  // -kan: kata berawalan pe- atau ke- umumnya kata benda (kebijakan, perbaikan, pendidikan), kecuali daftar perintah.
  if (w.length >= 6 && w.endsWith("kan") && !KAN_NOT_VERB.has(w) && (!/^(?:pe|ke)/u.test(w) || PE_KE_KAN_VERB.has(w))) return true;
  if (KE_AN_VERB.has(w)) return true;
  return false;
}

function hasPredicateId(toks: readonly Tok[], sentence: string): boolean {
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const next = toks[i + 1];
    const w = t.w;
    if (verbalAffixId(w)) return true;
    if (COPULA_ID.has(w) || BASE_VERB_ID.has(w) || AUX_EN_SAFE.has(w)) return true;
    if (w === "bukan" && !/[,—–\-(;:]/u.test(t.before) && next) return true;
    if (next && t.adjacentNext && (MODAL_ID.has(w) || DEGREE_ID.has(w))) return true;
    if (ADJECTIVE_ID.has(w) && i > 0 && (!next || /[.,;!?]/u.test(t.after) || AFTER_ADJECTIVE.has(next.w))) return true;
    if (i < 3 && next && w.length >= 6 && w.endsWith("nya") && !NYA_ADVERB.has(w)) return true; // hasilnya 12,04 kVA
    if (next && t.adjacentNext && (DEMONSTRATIVE_ID.has(w) || PRONOUN_ID.has(w))) return true;
    // predikat frasa depan yang aman dikenali: "hanya tentang ...", "hanya untuk ..."
    if (w === "hanya" && next && t.adjacentNext && PREPOSITION_ID.has(next.w) && !/[(,—–]/u.test(t.before)) return true;
  }
  return ENDS_WITH_QUANTITY.test(sentence.replace(/\s*\([^()]*\)/gu, ""));
}

function hasPredicateEn(toks: readonly Tok[]): boolean {
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const next = toks[i + 1];
    const w = t.w;
    if (AUX_EN.has(w) || VERB_EN.has(w)) return true;
    if (w.includes("'") || w.includes("’")) {
      if (/(?:n['’]t|['’](?:s|re|ve|ll|d|m))$/u.test(w)) return true; // it's, they're, don't
    }
    if (w.length >= 5 && /(?:[^e]ed|ied|ized|ised|ated)$/u.test(w)) return true;
    if (w.length >= 6 && /(?:izes?|ises?|ifies|ify|ates?)$/u.test(w) && i > 0) return true;
    if (next && t.adjacentNext && PRONOUN_EN.has(w) && !FUNCTION_EN.has(next.w)) return true;
    // kata jamak atau orang ketiga yang disusul kata isi: "cameras monitor the gate", "the system monitors gates"
    if (i > 0 && w.length >= 4 && /[^s]s$/u.test(w) && next && t.adjacentNext && !FUNCTION_EN.has(next.w)) return true;
    if (i > 0 && w.length >= 4 && /[^s]s$/u.test(w) && !FUNCTION_EN.has(toks[i - 1].w) && next && t.adjacentNext && /^(?:the|a|an|its|their|all|both|each|every|no|some|any)$/u.test(next.w)) return true;
  }
  return false;
}

/** Benar bila kalimat memuat tanda predikat menurut heuristik bahasa itu. */
/** @internal test seam */
export function hasPredicate(sentence: string, language: PredicateLanguage = "ID"): boolean {
  const toks = tokens(sentence);
  return language === "EN" ? hasPredicateEn(toks) : hasPredicateId(toks, sentence);
}

/** "Istilah: penjelasan" atau label: titik dua (disusul spasi) sesudah paling banyak LABEL_MAX_WORDS kata. */
function isLabelForm(sentence: string): boolean {
  const flat = sentence.replace(/\([^()]*\)/gu, " ").replace(/\[[^\]]*\]/gu, " ");
  const colon = flat.search(/:(?=\s)/u);
  if (colon < 0) return false;
  const lead = flat.slice(0, colon);
  if (/[.!?;]/u.test(lead.replace(/\d[.,]\d/gu, "0"))) return false;
  return (lead.match(/[\p{L}\p{N}][\p{L}\p{N}_\-./']*/gu) ?? []).length <= LABEL_MAX_WORDS;
}

function isFormula(sentence: string): boolean {
  return (sentence.match(FORMULA_OPERATORS) ?? []).length >= 2;
}

/** Jumlah tanda kutip ganda pembuka yang belum ditutup sesudah `text` (kutip lurus berpasangan). */
function quoteOpenAfter(open: boolean, text: string): boolean {
  let o = open;
  for (const ch of text) {
    if (ch === '"') o = !o;
    else if (ch === "“" || ch === "«") o = true;
    else if (ch === "”" || ch === "»") o = false;
  }
  return o;
}

/** Kalimat paragraf: `splitSentences` di dalam potongan yang dibatasi temuan C-35. */
function sentencesOf(t: string): string[] {
  const cuts = findLowercaseAfterStop(t).map((h) => h.index + 1);
  const pieces: string[] = [];
  let start = 0;
  for (const c of cuts) {
    if (c <= start || c > t.length) continue;
    pieces.push(t.slice(start, c));
    start = c;
  }
  pieces.push(t.slice(start));
  return pieces.flatMap((p) => splitSentences(p));
}

/**
 * Kalimat tanpa predikat pada satu paragraf. `text` boleh md-lite (backtick dan `*` dikenali)
 * atau teks polos.
 */
/** @internal test seam */
export function findSentencesWithoutPredicate(text: string, language: PredicateLanguage = "ID"): SentenceWithoutPredicateHit[] {
  if (typeof text !== "string") return [];
  const t = normalize(text);
  if (t === "" || looksLikeTableRow(t)) return [];
  const hits: SentenceWithoutPredicateHit[] = [];
  let inQuote = false;
  const sentences = sentencesOf(t);
  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i];
    const startedInQuote = inQuote;
    inQuote = quoteOpenAfter(inQuote, sentence);
    if (startedInQuote || OPEN_QUOTES.includes(sentence.charAt(0))) continue; // di dalam kutipan
    if (sentence.includes(CODE_PLACEHOLDER)) continue; // rentang kode
    if (!TERMINAL.test(sentence)) continue; // label, pengantar bertitik dua
    if (ENUM_MARKER_AT_START.test(sentence)) continue; // butir daftar sebaris
    if (isLabelForm(sentence)) continue; // istilah: penjelasan
    if (isFormula(sentence)) continue;
    const toks = tokens(sentence);
    const words = toks.filter((x) => x.w.length >= 2).length;
    if (words < MIN_WORDS) continue;
    if (i === 0 && sentences.length > 1 && words <= RUN_IN_HEADING_MAX_WORDS) continue; // judul sebaris di awal paragraf
    if (language === "EN" ? hasPredicateEn(toks) : hasPredicateId(toks, sentence)) continue;
    hits.push({ sentence, words });
  }
  return hits;
}

/** Teks sumber unit: md-lite asli bila tersedia (`raw`), selain itu teks lapisan prosa. */
function sourceText(u: TextUnit): string {
  const raw = (u as TextUnit & { raw?: unknown }).raw;
  if (typeof raw === "string") return raw;
  return typeof u.text === "string" ? u.text : "";
}

function quoted(sentence: string): string {
  return sentence.length <= MAX_QUOTE_CHARS ? sentence : `${sentence.slice(0, MAX_QUOTE_CHARS - 1).trimEnd()}…`;
}

/** Pemindai C-36: satu isu REPORT per paragraf yang memuat temuan; PASS bila bersih. */
export const sentenceWithoutPredicate: Scanner = (ctx) => {
  const id = SENTENCE_WITHOUT_PREDICATE_ID;
  // Dokumen tanpa blok, bab kosong, bab berisi tabel saja: lapisan prosa kosong atau tidak ada; tidak pernah melempar.
  const prose = Array.isArray(ctx?.layers?.prose) ? ctx.layers.prose.filter((u): u is TextUnit => typeof u === "object" && u !== null) : [];
  const found = prose
    .map((unit) => ({ unit, hits: findSentencesWithoutPredicate(sourceText(unit), ctx.language) }))
    .filter((x) => x.hits.length > 0);
  if (found.length === 0) {
    return [{ checkId: id, status: "PASS", detail: `${prose.length} paragraf prosa tanpa kalimat yang jelas tidak berpredikat` }];
  }
  const out: LintIssue[] = found.slice(0, MAX_PARAGRAPH_ISSUES).map(({ unit, hits }) => {
    const shown = hits.slice(0, MAX_QUOTED).map((h) => `"${quoted(h.sentence)}"`).join("; ");
    const more = hits.length > MAX_QUOTED ? `; dan ${hits.length - MAX_QUOTED} lagi di paragraf ini` : "";
    return {
      checkId: id,
      status: "REPORT",
      detail: `${unit.address ?? `blok ${unit.blockId}`}: ${hits.length} kalimat tanpa predikat: ${shown}${more}; tulis ulang menjadi kalimat utuh bersubjek dan berpredikat (peringatan heuristik, periksa dengan membaca)`,
      ...(unit.address ? { address: unit.address } : {}),
    };
  });
  if (found.length > MAX_PARAGRAPH_ISSUES) {
    const restHits = found.slice(MAX_PARAGRAPH_ISSUES).reduce((a, x) => a + x.hits.length, 0);
    out.push({
      checkId: id,
      status: "REPORT",
      detail: `dan ${restHits} kalimat tanpa predikat di ${found.length - MAX_PARAGRAPH_ISSUES} paragraf lain tidak dirinci (peringatan)`,
    });
  }
  return out;
};
