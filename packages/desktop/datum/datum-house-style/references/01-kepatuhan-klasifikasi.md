# 01 · Kepatuhan: Klasifikasi, Penomoran, Regulasi, Surat, PPN

Standard: GSP Writing Manual Rev A, Chapter 3 (ID p.13-17 / EN p.13-18) and Chapter 11.3 for
AHS (ID p.72 / EN p.74). Citations are **(ID p.N / EN p.N)**; "[v1.7, Rev A silent]" marks a v1.7
rule the manual does not state and that is kept as it was.

**Load this before writing any document that carries a classification, any RAB, or any
sentence that cites an Indonesian regulation.** Every rule of Chapter 3 is WAJIB and sits at
levels 1 and 2 of the authority hierarchy, so no form or language rule can loosen it. Lint 18
guards classification and lint 19 guards VAT; the rest is checked by eye (ID p.13 / EN p.13).
Items marked ⛔ are release defects.

---

## 1 ⛔ Classification vocabulary depends on the RECIPIENT (DT-28a, ID p.13 / EN p.13)

| Recipient | Governing instrument | Levels available |
|---|---|---|
| **Kemhan / TNI** (AD, AL, AU, Mabes) | Permenhan No. 26 Tahun 2017 Pasal 3 ayat (1) | `BIASA` · `RAHASIA` · `SANGAT RAHASIA` |
| **Polri / Bareskrim / Densus** | Perkap Polri No. 1 Tahun 2023 Pasal 79 | `BIASA` · `TERBATAS` · `RAHASIA` · `SANGAT RAHASIA` |
| **Civil ministries and bodies, BIN, BNPT, internal GSP** | Peraturan ANRI No. 5 Tahun 2021 Pasal 104 sampai 109 | `BIASA` · `TERBATAS` · `RAHASIA` · `SANGAT RAHASIA` |

Permenhan 26/2017 Pasal 3 ayat (1), quoted in the manual: "Klasifikasi Keamanan Arsip Dinamis
di lingkungan Kemhan terdiri atas Klasifikasi: a. biasa, b. rahasia dan c. sangat Rahasia."
(ID p.13). **⛔ There is no `TERBATAS` in the defence scheme.** Wrong: a TNI AD study marked
TERBATAS, or a Bareskrim proposal marked "Confidential" (ID p.13). Lint 18.

Official definitions worth quoting when a client asks why a document is marked as it is
[v1.7, Rev A silent]:

- **Sangat Rahasia**: disclosure "dapat membahayakan kedaulatan negara, keutuhan wilayah NKRI,
  dan keselamatan bangsa"; technically, "terganggunya strategi pertahanan dan daya/kalkulasi
  tempur relatif".
- **Rahasia**: disclosure causes "terganggunya pelaksanaan tugas dan fungsi lembaga
  pemerintahan … serta kerugian serius terhadap privasi".
- **Terbatas** (civil/Polri only): disclosure "dapat mengakibatkan terganggunya pelaksanaan
  fungsi dan tugas lembaga, seperti kerugian finansial yang signifikan".
- **Biasa**: disclosure "tidak akan menimbulkan akibat buruk", but still not for anyone.

### 1.1 Choosing the level, without asking (DT-28b, ID p.13-14 / EN p.13-14)

Choose with Figure 3.1, in this order:

1. **Floor first.** RAHASIA for installation data, case data and personal data. For a military
   installation the floor comes from UU No. 14 Tahun 2008 Pasal 17 huruf c angka 4: "gambar dan
   data tentang situasi dan keadaan pangkalan dan/atau instalasi militer"; for the rest it is a
   working ruling (PK) (ID p.13-14).
2. **Then the client's level**, if it is not below the floor. A client's level never lowers the
   floor. Wrong: a TNI AL arsenal CCTV layout marked BIASA because the client's e-mail said
   "biasa saja" (ID p.14).
3. **Then the recipient scheme**, by content.

When unsure between two levels, take the higher one and record a △ assumption. SANGAT RAHASIA
only when the client sets it (ID p.13). A covering letter takes the highest level of its
attachments (ID p.14).

Definitions (ID p.13): **installation data** is a plan, layout, coordinates, IP addresses, or
physical or network weak points of a building, base or network; a functional design, device
count or budget without those elements is not installation data. **Case data** is a case
number, party names or the content of evidence. **Personal data** is a home address, private
phone or e-mail, an identity number, health, finances, or a person's involvement in a case. The
name, office and work contact of a person acting in office are not personal data.

The EN edition adds a step for foreign recipients in its Figure 3.1 (EN p.14); English
documents follow that edition.

### 1.2 Marking and colour (DT-28c to DT-28e, ID p.14 / EN p.14-15)

1. **Under the number (DT-28c).** The classification in capitals, on its own line under the
   document number (`Klasifikasi :`; in a letter `Sifat :`).
2. **DATUM documents** (report, proposal, kajian, workbook, deck) repeat it at the right of the
   running head and in the right cell of the register block (DT-28c).
3. **Letters and official papers to government bodies** carry it centred at the top and bottom
   of every page, per Perkap 1/2023 Lampiran III (DT-28c).
4. **Colour (DT-28d).** Seal maroon #6E1420, bold, **never alert**. The PDF reads RGB 110, 20, 32
   (± 3). Letters use black ink (3.6); a dark-master deck is ruled by Chapter 11.
5. **SR and R** travel in double envelopes with numbered copies (DT-28c, ID p.14 / EN p.14). The
   copy number appears in the Seal Band and in the control sheet's distribution list (DT-13b).
6. Page one may be typed or stamped; page two onward must be typed [v1.7, Rev A silent].
7. Confirm with the recipient's records officer that the maroon marking on DATUM documents
   meets their marking-colour rule; official letters stay black (open defect E-39, ID p.82 /
   EN p.85).

### 1.3 Second, independent axis: urgency (DT-28e, ID p.14 / EN p.15)

`kilat` · `sangat segera` · `segera` · `biasa` (Perkap 1/2023 Pasal 78). Urgency is speed of
delivery, not sensitivity. Write it on its own `Derajat :` line; never put it in the
classification field. Wrong: `Sifat : Segera` (ID p.14).

---

## 2 ⛔ The current regulatory stack (DT-29a, Table 3.2, ID p.15 / EN p.15)

Cite only from the "Cite" column. A new regulation enters only after its number has been
checked in the official JDIH. A claim of legal obligation names number, year, article and a
literal quotation (SG-L3-01); an article not yet verified is written as an instrument marked △
(ID p.15).

| Topic | **Do not cite** | **Cite** |
|---|---|---|
| Procurement | Perpres 16/2018 without its latest amendment | Perpres No. 16 Tahun 2018 sebagaimana telah diubah terakhir dengan Perpres No. 46 Tahun 2025 |
| Tata Naskah Dinas | Permenpan RB 22/2008 and 80/2012 | Peraturan ANRI No. 5 Tahun 2021 |
| Polri official papers | Perkap 7/2017 (revoked by Perpol No. 3 Tahun 2023) | Perkap Polri No. 1 Tahun 2023 |
| Kemhan administration | Permenhan 60/2014 and 25/2015 | Permenhan No. 30 Tahun 2019 |
| Construction cost estimating | Permen PUPR 28/2016 and 1/2022 | Permen PUPR No. 8 Tahun 2023 |
| VAT | "PPN 10 %", flat "PPN 12 %" | PMK No. 131 Tahun 2024 (§5) |
| Stamp duty | "materai Rp 6.000" | Rp 10.000, UU No. 10 Tahun 2020 |
| Archive classification | none | UU No. 14 Tahun 2008 Pasal 17 · Permenhan No. 26 Tahun 2017 Pasal 3 · Perkap Polri No. 1 Tahun 2023 Pasal 79 · PerANRI No. 5 Tahun 2021 Pasal 104 sampai 109 |
| Time zones | none | Keppres No. 41 Tahun 1987 |
| Spelling | PUEBI 2021 | Keputusan Kepala Badan Bahasa No. 0424/I/BS.00.01/2022 (EYD V) |

Procurement implementing guidance: Perlem LKPP 12/2021 jo 4/2024 [v1.7, Rev A silent].

**Facts that change** (officials, rates, prices, editions) are looked up first. If that is not
possible, write "Terakhir diketahui X, per [bulan tahun]. Periksa di Y." Wrong: "sesuai
ketentuan yang berlaku" (ID p.16).

---

## 3 · Document numbering (DT-04a, DT-04b, Table 3.1)

**Pattern (DT-04b, ID p.15 / EN p.15).** `005/GSP/KT/VIII/2026`: running number, GSP, type code,
Roman month (Perkap 1/2023 Lampiran III.A.1.d.3), year. **No SR, R, T or B prefix.** Right:
`012/GSP/STD/X/2026`. Wrong: `R/012/GSP/DS/X/2026` and `009/GSP/RAB/8/2026` (ID p.15).

| Source | Pattern | Example [v1.7, Rev A silent] |
|---|---|---|
| PerANRI 5/2021 nota dinas | `no urut / kode klasifikasi / bulan Romawi / tahun` | `190/KN.01/XI/2020` |
| Perkap 1/2023 surat Polri | `klasifikasi / no urut / bulan Romawi / KKA / tahun / Satfung` | `B/3/II/KKA/2023/Setum` |
| **GSP** | `no urut / GSP / kode jenis / bulan Romawi / tahun` | `005/GSP/KT/VIII/2026` |

**Type codes, closed ARSIP list (Table 3.1, ID p.15 / EN p.15):**

| Code | Type | Code | Type |
|---|---|---|---|
| PT | Proposal teknis | DEK | Presentasi |
| KT | Kajian dan analisis teknis | LAP | Laporan kegiatan |
| RAB | RAB atau BoQ | MAT | Matriks atau register |
| SPH | Surat penawaran harga | STD | Standar atau SOP |
| SP | Surat, termasuk surat pengantar | NOT | Nota internal |
| BA | Berita acara | MOD | Model yang diserahkan |
| NDA | Perjanjian kerahasiaan | VER | Verifikasi data, uji, atau forensik |

DS is retired (Rev K, E-21; ID p.15).

**Before building (DT-04a, ID p.12 / EN p.12).** Take the number from the Register Induk. If it is
out of reach, write `XXX/GSP/<KODE>/<BULAN>/<TAHUN>` with the document's own code and month,
note it, and hold release until the real number is taken. The Register Induk beats a project
register; a cancelled number is void and never reused. Revisions raise the Rev, never the
number: Draf 1, Draf 2, then RevA.

---

## 4 · Letters (surat pengantar and official letters) (DT-32, ID p.16-17 / EN p.16-17)

A letter to a government body is set on the recipient's Tata Naskah Dinas: **Arial 12 and black
ink, classification included**. The report it carries stays DATUM. This is the one place DATUM
stands down (ID p.16).

| Element (Table 3.3, ID p.16) | PerANRI 5/2021 (civil, Kemhan, TNI) | Perkap 1/2023 (Polri) |
|---|---|---|
| Paper | HVS A4, ≥ 70 g/m² | HVS A4 white |
| Typeface | Arial 12 | Arial or Arial Narrow 12 |
| Margin top · bottom | 2 cm · ≥ 2,5 cm | 2 cm · 3 cm |
| Margin left · right | ≥ 3 cm · ≥ 2 cm | 3 cm · 2 cm |
| Page number | top centre, page 1 unnumbered △ | top centre, page 1 unnumbered |

The PerANRI column also serves Kemhan and TNI (PK) (ID p.16).

**Sixteen elements, top down (Table 3.4, ID p.17):** letterhead (logo, company name in bold Arial,
address line Arial 9 pt black); place and date; number; Sifat (highest classification of the
attachments); Derajat (or the line removed); Lampiran; Hal; address; opening salutation; body;
proposal; closing salutation; office; signature and stamp; name; copies.

**Salutation (SG-L5-08, ID p.17):** "Yth." without "Kepada"; "Dengan hormat,"; GSP is "kami";
"berkenan" towards government officials; the same Bapak or Ibu in address, body and close;
"Saudara" and bare "mohon" only to equals or juniors. One yes-or-no proposal per letter
(SG-L1-07), to the Pokja Pemilihan for bid evaluation or to the PPK for a contract. Wrong:
"Kepada Yth. Bapak Direktur, ... Atas perhatian Saudara" set in Plex on DATUM margins.

English letters and e-mails to foreign parties follow the EN edition's own rules (EN p.16-17,
Table 8.1 EN p.51).

---

## 5 ⛔ VAT, terbilang and stamp duty

### 5.1 VAT (DT-31a, ID p.17 / EN p.18)

Compute PPN **only in the recapitulation**, at **12 % of DPP nilai lain = 11/12 × subtotal**
(PMK No. 131 Tahun 2024), because 12 % on the selling price applies only to luxury goods. Unit
prices exclude VAT. DPP, PPN and the total each round **down to whole rupiah**, with no further
rounding unless the KAK asks.

```
TURUNAN 3.7A · PPN DENGAN DPP NILAI LAIN (ILUSTRATIF)            (ID p.17)
Subtotal sebelum PPN                  Rp 651.575.000   ◈ DITURUNKAN
DPP nilai lain  11/12 × subtotal      Rp 597.277.083   ◈ DITURUNKAN
PPN  12 % × DPP                       Rp 71.673.249    ◈ DITURUNKAN
Total termasuk PPN                    Rp 723.248.249   ◈ DITURUNKAN
  Bila tarif PPN berubah sebelum kontrak, hanya baris PPN dan total yang dihitung ulang.
```

Prose may say "termasuk PPN 11 % efektif", and a summary may carry an extract of the
recapitulation of at most 5 lines, copied exactly and pointing to its table (lint 19 does not
apply there). Wrong: "PPN 12 %" on the whole subtotal (ID p.17). Lint 19: ID "PPN selain 11 %
efektif" (Table 13.1, ID p.80); EN "VAT over IDR 2 from 11 % of the pre-VAT subtotal" (EN p.82);
VAT only in the recapitulation (DT-31a test).

[Interpretation C22: on Derivation 3.7a, 11 % of the subtotal is Rp 71.673.250 and the DT-31a
path gives Rp 71.673.249, a difference of 1; a workbook cross-check therefore compares PPN
with the rounded-down DT-31a path, tolerance 1, not with 11 % of the subtotal.]

### 5.2 Terbilang (DT-31b, ID p.37 / EN p.38)

A `Terbilang :` line under every binding money sum, generated from the same figure by formula
or code, word for word equal to it. Right: Rp 723.248.249 with "Terbilang : tujuh ratus dua
puluh tiga juta dua ratus empat puluh delapan ribu dua ratus empat puluh sembilan rupiah"
(ID p.37). Its place, with PPN, is the recapitulation.

### 5.3 Stamp duty (DT-29b, ID p.17 / EN p.18)

"meterai Rp 10.000" (UU No. 10 Tahun 2020 Pasal 5). Never "bermaterai Rp 6.000", never the
spelling "materai".

---

## 6 · RAB, BoQ, AHS (Permen PUPR No. 8 Tahun 2023)

### 6.1 AHS structure (DT-33, ID p.72 / EN p.74)

| Row | Content |
|---|---|
| **A** | Tenaga kerja |
| **B** | Bahan |
| **C** | Peralatan |
| **D** | A + B + C |
| **E** | Biaya umum dan keuntungan: percentage × D, **within 10 % sampai 15 %** (Pasal 11 ayat (3)) |
| **F** | Harga satuan pekerjaan: D + E |

Write the band, never "maksimum 15 %", and state which figure GSP used. A 12 % overhead in AHS
shows in amber as a typed input (ID p.72 / EN p.74).

AHS columns `No · Uraian · Kode · Satuan · Koefisien · Harga Satuan (Rp) · Jumlah Harga (Rp)`;
labour codes `L.01` Pekerja, `L.02` Tukang, `L.03` Kepala tukang, `L.04` Mandor, unit **OH**
[v1.7, Rev A silent].

**Coefficients:** three significant figures (0,150), number format `0.000##` (ID p.72 / EN p.74
format only).

### 6.2 PPN placement and recapitulation

PPN is computed on the recapitulation and never in a unit price; HSP is always "belum termasuk
PPN" (DT-31a, ID p.17 / EN p.18). Recapitulation: sum per work type + mobilisation and
demobilisation + SMKK + PPN = RAB / HPS [v1.7, Rev A silent]. The HPS rounds down to thousands
of rupiah **only when the KAK asks** (ID p.72 / EN none). Every priced recapitulation carries a
`Terbilang :` line (§5.2).

### 6.3 BoQ columns

No current LKPP or PUPR instrument prescribes a BoQ column header verbatim; SPSE generates
them. The six-column form GSP uses is convention, not regulation, and is never presented as a
regulatory requirement [v1.7, Rev A silent]:
`No · Uraian Pekerjaan · Volume · Satuan · Harga Satuan (Rp) · Jumlah (Rp)` (the same columns
appear in Rev A's Tabel 7.3, ID p.42).

Money in tables, the RAB and binding sums is written in full: `Rp 3.360.000.000`; never "rb" or
"ribu" (DT-30g, ID p.36 / EN p.38).

---

## 7 · What a Dokumen Penawaran must contain [v1.7, Rev A silent]

**Pekerjaan Konstruksi, e-Tender pascakualifikasi:**

1. **Administrasi**: surat penawaran + lampiran; jaminan penawaran (only for konstruksi with HPS
   above Rp 10 miliar, at 1 % sampai 3 % of HPS); other documents per LDP.
2. **Teknis**: metode pelaksanaan; jangka waktu; daftar peralatan utama; daftar personel
   manajerial + pernyataan sertifikat kompetensi; formulir **RKK**; daftar subkontrak;
   pernyataan kesediaan memenuhi spesifikasi teknis.
3. **Harga**: daftar kuantitas dan harga; formulir AHSP **only** if the price-reasonableness
   evaluation falls below 80 % of HPS, and then "bukan merupakan bagian dari Dokumen Kontrak".

**Jasa Konsultansi** additionally prescribes the Proposal Teknis shape: "disarankan … misalnya 50
halaman, termasuk gambar kerja dan diagram, dibagi menjadi tiga bab: a) Pendekatan Teknis dan
Metodologi, b) Program Kerja, c) Organisasi dan Personil".

**Signing.** Electronic submission through SPSE is itself the signature: "Peserta tidak perlu
membuat surat penawaran bertanda tangan basah dan berstempel". Meterai Rp 10.000 still applies
to the Form Isian Kualifikasi in some SDPs and to contract originals.

**Language.** "Semua Dokumen Penawaran harus menggunakan Bahasa Indonesia." Foreign-language
supporting documents need an Indonesian explanation; Indonesian prevails on conflict.

---

## 8 · Sources

Rev A Chapter 3 and Table 3.2 (ID p.13-17 / EN p.13-18), DT-33 (ID p.72 / EN p.74). Regulations:
Permenhan No. 26 Tahun 2017 · Permenhan No. 30 Tahun 2019 · Peraturan ANRI No. 5 Tahun 2021 ·
Perkap Polri No. 1 Tahun 2023 · Perpres No. 16 Tahun 2018 as last amended by Perpres No. 46 Tahun
2025 · Permen PUPR No. 8 Tahun 2023 · PMK No. 131 Tahun 2024 · UU No. 10 Tahun 2020 · UU No. 14
Tahun 2008 Pasal 17 · Keppres No. 41 Tahun 1987 · EYD Edisi V.

**Not verified, treat as unknown [v1.7, Rev A silent]:** Peraturan Kasal No. 30 Tahun 2018 and the
Handbook Kesekretariatan TNI AL; the Lampiran of Permenhan 30/2019 (scanned imagery). If TNI
AL-specific correspondence rules become load-bearing, obtain them from the official source and
update this file rather than guessing.

---

## Perubahan dari v1.7

| # | v1.7 rule (section) | Rev A | Source | Class |
|---|---|---|---|---|
| 01-1 | §1 marking rule 1: classification code is the first element of the document number (SR/R/T/B) | GSP numbers carry **no** classification prefix | DT-04b, ID p.15 / EN p.15 | CHANGED |
| 01-2 | §1 marking rule 2: `Klasifikasi :` line in sentence case | Classification in capitals on its own line under the number | DT-28c, ID p.14 / EN p.14 | CHANGED |
| 01-3 | §1 marking rule 3: centred top or bottom, satisfied in DATUM by running head and register | DATUM documents: right of the running head and right cell of the register; letters and official papers: centred top and bottom | DT-28c, ID p.14 / EN p.14 | CHANGED |
| 01-4 | §1 marking rule 5: RAHASIA and SANGAT RAHASIA in alert red, TERBATAS and BIASA in ink900 | All classification text in seal #6E1420 bold, never alert; letters black | DT-28d, ID p.14 / EN p.15 | CHANGED |
| 01-5 | §1 military installation: at minimum RAHASIA | Kept and widened: RAHASIA floor for installation, case and personal data, chosen without asking, client level never lowers it | DT-28b, ID p.13-14 / EN p.13-14 | CHANGED (widened) |
| 01-6 | §1 urgency "sits in the control block as its own field" | On its own `Derajat :` line; never in the classification field | DT-28e, ID p.14 / EN p.15 | CHANGED |
| 01-7 | §2 "Procurement: Perpres 46/2025" | Cite "Perpres No. 16 Tahun 2018 sebagaimana telah diubah terakhir dengan Perpres No. 46 Tahun 2025" | Table 3.2, ID p.15 / EN p.15 | CHANGED |
| 01-8 | §2 regulatory table | Adds archive classification, time-zone and spelling rows; JDIH check before a new regulation enters; unverified article as △ | DT-29a, ID p.15 / EN p.15 | CHANGED (added) |
| 01-9 | §2 "VAT: PPN 11 % effective"; PPN 12 % listed as dead | PPN 12 % × DPP nilai lain (11/12 × subtotal), recapitulation only, each line rounded down; "11 % efektif" allowed in prose | DT-31a, ID p.17 / EN p.18 | CHANGED |
| 01-10 | §3 type codes KT, PT, RAB, SPH, SP, BA, DS | Closed list of 14 codes; DS retired | Table 3.1, ID p.15 / EN p.15 | CHANGED |
| 01-11 | §3 no rule for an unreachable register | `XXX/GSP/<KODE>/<BULAN>/<TAHUN>` and release held | DT-04a, ID p.12 / EN p.12 | CHANGED (added) |
| 01-12 | §4 letter table: PerANRI top margin "2 cm (or 2 spasi below kop)", page number "angka Arab", ink "tinta pigment / cap dinas ungu" | Top 2 cm; page number top centre, page 1 unnumbered; black ink including the classification; PerANRI column also for Kemhan and TNI (PK) | DT-32, Table 3.3, ID p.16 / EN p.16 | CHANGED |
| 01-13 | §4 no element list or salutation rules | 16 letter elements (Table 3.4) and salutation rules (SG-L5-08) | ID p.17 | CHANGED (added) |
| 01-14 | §5 koefisien "tiga angka berturut-turut di belakang koma selain nol" | Three significant figures (0,150), format `0.000##` | ID p.72 / EN p.74 | CHANGED |
| 01-15 | §5 "HPS totals are rounded down" | DPP, PPN, total rounded down to whole rupiah; HPS to thousands only when the KAK asks | DT-31a, ID p.17, p.72 / EN p.18 | CHANGED |
| 01-16 | §5 AHS row E "(10 % – 15 %) × D" | Same band, written with "sampai", cited to Pasal 11 ayat (3); D = A + B + C, F = D + E | DT-33, ID p.72 / EN p.74 | KEPT (citation and wording) |
| 01-17 | §7 source list | Updated to the Rev A Table 3.2 forms | ID p.15 / EN p.15 | CHANGED |

Kept as v1.7 [Rev A silent]: official level definitions; page-one stamping; Perlem LKPP 4/2024;
AHS columns and labour codes; recapitulation make-up; BoQ convention; Dokumen Penawaran
contents; the unverified-sources note.
