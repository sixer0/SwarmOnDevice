#!/usr/bin/env python3
"""Bangun dua indeks untuk knowledge library teknis GSP.

  indeks_struktur.json / .md  : apa yang ada di mana (folder, peran, domain, kartu, resume, katalog rumus)
  indeks_pemicu.json / .md    : kata di tugas -> domain -> berkas yang dibuka, dalam urutan baca

Hanya membaca pustaka; menulis ke folder keluaran. Pustaka standar Python saja.

Pakai:
  python3 build_kl_index.py --root "<akar pustaka>/4 Knowledge Bank/ekas-lapis-teks" --out <folder>

Isi otomatis diambil dari pustaka (nama berkas, front matter kartu, judul bagian, tabel "Indeks cepat").
Kata pemicu dwibahasa per domain ada di SEED di bawah: itu kurasi, bukan hasil ekstraksi, dan harus
ditinjau pemilik pustaka.
"""
import argparse
import binascii
import json
import os
import re
import stat
import sys

# Folder pustaka teknis di dalam akar pustaka bawaan; semua path di indeks relatif ke sini.
ROOT_RELATIVE = "4 Knowledge Bank/ekas-lapis-teks"

FOLDER_ROLE = {
    "00_START-HERE": ("peta dan cara pakai pustaka", "awal sesi, sekali"),
    "01_GOVERNANCE": ("tingkat keyakinan sumber dan gerbang jaminan", "saat menilai seberapa kuat sebuah sumber"),
    "02_REGISTERS": ("register induk rujukan, kebutuhan, hitungan, uji", "saat mencari nomor rujukan atau menelusur"),
    "04_KNOWLEDGE-CARDS": ("kartu ringkas per sumber: apa yang dipasok, halaman jangkar", "langkah pertama per domain"),
    "05_DOMAIN-KNOWLEDGE": ("resume buku dan standar per domain, rantai jaminan", "setelah kartu, untuk rumus dan batas"),
    "06_ENGINEERING": ("katalog rumus, asumsi baku, contoh kartu hitung", "setiap perhitungan"),
    "07_VERIFICATION-VALIDATION": ("ambang terima induk, ITP, FAT, SAT", "saat menetapkan kriteria lulus atau uji"),
    "08_EVIDENCE": ("pola bukti ukur (OTDR, OLTS, pembumian, listrik)", "saat merencanakan atau menilai bukti"),
    "09_HANDOVER": ("as-built, berita acara, O&M, pelatihan", "saat serah terima"),
    "10_TEMPLATES": ("templat kartu kendali sampai NCR", "saat membuat dokumen kendali"),
}

# Kata pemicu kurasi per domain (Indonesia dan Inggris, huruf kecil). Ditinjau pemilik pustaka.
SEED = {
    "VIDEO-SURVEILLANCE": "cctv kamera video pengawasan vms nvr lensa piksel pix/m dori bitrate laju bit rekaman retensi fps resolusi onvif camera surveillance",
    "FIBER-OPTIC": "serat optik fiber fibre optic otdr olts loss budget anggaran rugi redaman sambungan splice konektor odf pon gpon single-mode multimode db/km",
    "POWER-BACKUP": "ups baterai battery genset generator diesel daya cadangan backup autonomi ah kva derating bypass inverter vrla",
    "GROUNDING-LIGHTNING": "pembumian pentanahan grounding earthing petir lightning lps rolling sphere bola gelinding spd surja resistans tanah wenner elektroda",
    "NETWORKING": "jaringan network switch router vlan ip routing wan lan bandwidth lebar pita latency tcp qos ospf bgp throughput",
    "STORAGE": "penyimpanan storage raid san nas cakram disk kapasitas tb iops replikasi backup arsip",
    "ELECTRICAL": "listrik electrical panel kabel pengaman mcb tegangan arus jatuh tegangan voltage drop isolasi megger instalasi",
    "CYBERSECURITY": "keamanan siber cyber security firewall enkripsi autentikasi hardening ancaman threat kerentanan zona",
    "RF-WIRELESS": "radio rf wireless nirkabel antena link budget frekuensi microwave gelombang mikro fresnel spektrum",
    "THERMAL": "termal thermal termografi inframerah infrared suhu emisivitas kamera termal",
    "RCM": "keandalan reliability rcm pemeliharaan maintenance interval p-f kegagalan failure mtbf ketersediaan availability",
    "HVAC-BUILDING": "hvac pendingin pendinginan cooling tata udara ac ventilasi beban panas btu ruang server",
    "MECHANICAL": "mekanikal mechanical struktur baja braket getaran beban torsi",
    "CIVIL-STRUCTURAL": "sipil civil struktur pondasi beton tiang menara tower beban angin",
    "BUILDING-CONSTRUCTION": "bangunan gedung konstruksi building arsitektur ruang",
    "CONSTRUCTION": "konstruksi pelaksanaan pemasangan instalasi lapangan metode kerja",
    "CRITICAL-INFRASTRUCTURE": "infrastruktur kritis objek vital perlindungan fasilitas critical infrastructure",
    "DRAWING-CAD": "gambar teknik drawing cad denah as-built simbol skala",
    "GEOSPATIAL-SURVEY": "survei geospasial peta koordinat gnss gps topografi ukur tanah",
    "PROJECT-QUALITY": "mutu quality proyek itp inspeksi qa qc manajemen proyek",
    "SOFTWARE-DATA": "perangkat lunak software basis data database api data aplikasi",
    "SYSTEMS-ENGINEERING": "rekayasa sistem systems engineering kebutuhan requirement verifikasi validasi antarmuka",
    "AI-ML": "ai machine learning model inferensi pelatihan gpu neural",
    "COMPUTER-VISION": "computer vision visi komputer deteksi objek analitik video citra",
    "NUMERICAL-METHODS": "metode numerik numerical interpolasi regresi optimasi galat",
}

# Domain di luar pohon pustaka (tidak punya folder kartu atau resume): kata pemicu dan berkas pertama.
# Berkas pertama memakai awalan `skill:` = relatif ke folder skill bawaan (saudara pustaka), bukan ke akar pustaka.
# Kata pemicu ditetapkan pemilik (U21, KL-4): diagram gambar topologi arsitektur "satu garis" urutan jadwal alur.
EXTERNAL_DOMAINS = {
    "DIAGRAM-STANDARD": {
        "terms": ["diagram", "gambar", "topologi", "arsitektur", "satu garis", "urutan", "jadwal", "alur"],
        "read_order": ["skill:gsp-diagram-standard/references/index.md"],
    },
}


# Domain -> nomor bagian KATALOG-RUMUS.md (kurasi; nomor bagian dibaca dari judul "N. ...").
FORMULA_SECTIONS = {
    "VIDEO-SURVEILLANCE": [1, 7], "COMPUTER-VISION": [1], "FIBER-OPTIC": [2, 13],
    "GROUNDING-LIGHTNING": [3, 4, 13], "ELECTRICAL": [5, 13], "RCM": [6], "STORAGE": [7],
    "POWER-BACKUP": [8, 9, 10], "NETWORKING": [11], "THERMAL": [12],
}


# Kata umum: sendirian tidak cukup untuk memicu domain (perlu satu kata kuat atau dua kata lemah).
WEAK = set("data model ruang kerja beban kapasitas backup struktur proyek aplikasi video objek lapangan metode suhu "
           "instalasi kabel panel arus gambar peta ukur mutu kebutuhan pelatihan arsip ac ai ip alur urutan jadwal".split())  # alur urutan jadwal: kata umum domain diagram (arsitektur tetap kuat: sudah kuat di BUILDING-CONSTRUCTION)


def read(path):
    try:
        return open(path, encoding="utf-8", errors="replace").read()
    except OSError:
        return ""


def front(text):
    m = re.match(r"---\n(.*?)\n---", text, re.S)
    out = {}
    if m:
        for line in m.group(1).splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                out[k.strip()] = v.strip().strip('"')
    return out


def headings(text, level=2, limit=14):
    return [h.strip() for h in re.findall(r"^%s (.+)$" % ("#" * level), text, re.M)][:limit]


def supplies(text):
    m = re.search(r"## 1\. Yang dipasok rujukan ini\s*\n+(.+?)\n\s*\n", text, re.S)
    return re.sub(r"\s+", " ", m.group(1)).strip()[:300] if m else ""


def build(root):
    if not os.path.isdir(root):
        sys.exit("akar pustaka tidak ada: " + root)
    structure = {"root_relative": ROOT_RELATIVE, "folders": [], "domains": {}, "formula_catalogue": {}}
    for name in sorted(os.listdir(root)):
        p = os.path.join(root, name)
        if os.path.isdir(p):
            n = sum(len(f) for _, _, f in os.walk(p))
            role, when = FOLDER_ROLE.get(name, ("", ""))
            structure["folders"].append({"folder": name, "files": n, "holds": role, "open_when": when})
    cards_dir = os.path.join(root, "04_KNOWLEDGE-CARDS")
    dom_dir = os.path.join(root, "05_DOMAIN-KNOWLEDGE")
    domains = sorted(set(os.listdir(dom_dir)) | set(os.listdir(cards_dir)))
    for d in domains:
        entry = {"cards": [], "resumes": [], "chain": None}
        cd = os.path.join(cards_dir, d)
        if os.path.isdir(cd):
            for f in sorted(os.listdir(cd)):
                t = read(os.path.join(cd, f))
                fm = front(t)
                entry["cards"].append({"id": fm.get("reference_id", f[:-3]), "title": fm.get("title", ""),
                                       "level": fm.get("reference_confidence_level", ""),
                                       "path": "04_KNOWLEDGE-CARDS/%s/%s" % (d, f), "supplies": supplies(t)})
        dd = os.path.join(dom_dir, d)
        if os.path.isdir(dd):
            for f in sorted(os.listdir(dd)):
                rel = "05_DOMAIN-KNOWLEDGE/%s/%s" % (d, f)
                if f.upper().startswith("RANTAI"):
                    entry["chain"] = rel
                else:
                    t = read(os.path.join(dd, f))
                    entry["resumes"].append({"path": rel, "lines": t.count("\n") + 1, "sections": headings(t, 2, 10)})
        structure["domains"][d] = entry
    cat = os.path.join(root, "06_ENGINEERING", "CALCULATIONS", "KATALOG-RUMUS.md")
    ct = read(cat)
    sections = [(m.start(), m.group(1).strip()) for m in re.finditer(r"^## (.+)$", ct, re.M)]
    structure["formula_catalogue"] = {
        "path": "06_ENGINEERING/CALCULATIONS/KATALOG-RUMUS.md",
        "sections": [{"title": t, "line": ct.count("\n", 0, pos) + 1} for pos, t in sections],
    }
    structure["always"] = ["06_ENGINEERING/ASSUMPTIONS/ASUMSI-BAKU.md",
                           "07_VERIFICATION-VALIDATION/ACCEPTANCE-CRITERIA/AMBANG-TERIMA-INDUK.md"]
    # indeks pemicu
    quick = []
    qm = re.search(r"## Indeks cepat.*?\n(.*?)\n## ", ct, re.S)
    if qm:
        for line in qm.group(1).splitlines():
            cells = [c.strip().strip("*") for c in line.strip().strip("|").split("|")]
            if len(cells) >= 4 and not set(cells[0]) <= set("-: ") and not cells[0].lower().startswith("pertanyaan"):
                quick.append({"question": cells[0], "formula": cells[1].strip("`"), "book": cells[2], "page": cells[3]})
    triggers = {"how_to_use": "Cocokkan kata di tugas, judul misi, atau baris misi dengan `terms`. Untuk tiap domain yang "
                              "cocok, buka berkas di `read_order` dari kiri ke kanan; untuk perhitungan buka juga `formula_sections`.",
                "domains": {}, "questions": quick}
    for d, e in structure["domains"].items():
        seed = SEED.get(d, "").split()
        auto = set()
        for c in e["cards"]:
            for w in re.findall(r"[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\-]{3,}", (c["title"] + " " + c["supplies"]).lower()):
                auto.add(w)
        stop = {"yang", "dari", "untuk", "dengan", "pada", "dan", "atau", "halaman", "jangkar", "guide", "reference", "book",
                "handbook", "edition", "tabel", "kolom", "batas", "lihat", "this", "that", "with", "from"}
        auto = sorted(w for w in auto if w not in stop and w not in seed)[:25]
        order = [c["path"] for c in e["cards"]] + ([e["chain"]] if e["chain"] else []) + [r["path"] for r in e["resumes"]]
        want = FORMULA_SECTIONS.get(d, [])
        fs = [s for s in structure["formula_catalogue"]["sections"]
              if re.match(r"(\d+)\.", s["title"]) and int(re.match(r"(\d+)\.", s["title"]).group(1)) in want]
        triggers["domains"][d] = {"terms": seed, "terms_from_cards": auto, "read_order": order,
                                  "formula_sections": fs}
    for d, e in EXTERNAL_DOMAINS.items():
        triggers["domains"][d] = {"terms": list(e["terms"]), "terms_from_cards": [], "read_order": list(e["read_order"]),
                                  "formula_sections": []}
    triggers["weak"] = sorted(WEAK)
    return structure, triggers


def md_structure(s):
    out = ["# Indeks struktur knowledge library teknis", "",
           "Akar: `%s` di dalam pustaka bawaan. Semua path di bawah relatif ke akar itu." % s["root_relative"], "",
           "## Folder", "", "| Folder | Berkas | Isi | Dibuka saat |", "|---|---:|---|---|"]
    for f in s["folders"]:
        out.append("| `%s` | %d | %s | %s |" % (f["folder"], f["files"], f["holds"], f["open_when"]))
    out += ["", "## Selalu dibuka untuk perhitungan dan kriteria lulus", ""] + ["- `%s`" % p for p in s["always"]]
    out += ["- `%s` (katalog rumus)" % s["formula_catalogue"]["path"], "", "## Katalog rumus: bagian dan baris", "",
            "| Bagian | Baris |", "|---|---:|"]
    for sec in s["formula_catalogue"]["sections"]:
        out.append("| %s | %d |" % (sec["title"], sec["line"]))
    out += ["", "## Domain", "", "| Domain | Kartu | Resume | Rantai jaminan |", "|---|---|---|---|"]
    for d, e in s["domains"].items():
        cards = ", ".join(c["id"] for c in e["cards"]) or "tidak ada"
        out.append("| %s | %s | %d berkas | %s |" % (d, cards, len(e["resumes"]), "ada" if e["chain"] else "tidak ada"))
    return "\n".join(out) + "\n"


def md_triggers(t):
    out = ["# Indeks pemicu knowledge library teknis", "", t["how_to_use"], "",
           "Kolom kata pemicu adalah kurasi dan perlu ditinjau pemilik pustaka.", "",
           "## Kata di tugas ke domain", "", "| Kata pemicu | Domain | Berkas pertama | Bagian katalog rumus |", "|---|---|---|---|"]
    for d, e in t["domains"].items():
        first = e["read_order"][0] if e["read_order"] else "tidak ada kartu"
        fs = ", ".join("%s (baris %d)" % (s["title"], s["line"]) for s in e["formula_sections"]) or "tidak ada"
        out.append("| %s | %s | `%s` | %s |" % (", ".join(e["terms"]), d, first, fs))
    out += ["", "## Pertanyaan ke rumus (dari katalog rumus)", "", "| Pertanyaan | Rumus atau angka | Sumber | Halaman |", "|---|---|---|---|"]
    for q in t["questions"]:
        out.append("| %s | `%s` | %s | %s |" % (q["question"], q["formula"], q["book"], q["page"]))
    return "\n".join(out) + "\n"


# Batas versi ringkas (baris 97, putusan C7 butir 1): badan skill knowledge-library memuat teks pengaman dan cara pakai
# (sekitar 2,9 KB dengan path akar terpanjang) ditambah versi ringkas ini, dan seluruhnya harus <= 4096 byte.
COMPACT_MAX_BYTES = 1040


def md_compact(t, limit=COMPACT_MAX_BYTES):
    """Versi ringkas untuk badan skill: aturan baca, lalu satu baris per domain dengan kata pemicu kuat.

    Tiap domain mendapat kata kuat pertamanya (bukan `weak`); sisa ruang diisi bergiliran antar domain, satu kata per
    putaran, sampai kata berikutnya melewati `limit`. Domain yang berkas pertamanya di luar pustaka (`skill:`) menuliskan
    berkas itu. Bila satu kata per domain pun tidak muat, build gagal.
    """
    weak = set(t.get("weak", WEAK))
    head = ["Pemicu pustaka teknis: kata domain D di tugas atau misi berarti buka D sebelum menulis angka, "
            "rumus atau kriteria lulus. Di Root/`%s/`: 04_KNOWLEDGE-CARDS/D/, lalu 05_DOMAIN-KNOWLEDGE/D/ "
            "(RANTAI-JAMINAN.md dulu); rumus 06_ENGINEERING/CALCULATIONS/KATALOG-RUMUS.md; kriteria "
            "07_VERIFICATION-VALIDATION/ACCEPTANCE-CRITERIA/AMBANG-TERIMA-INDUK.md." % ROOT_RELATIVE]
    words = {d: [w for w in e["terms"] if w not in weak] or e["terms"][:1] for d, e in t["domains"].items()}
    take = {d: 1 for d in words}

    def render():
        lines = []
        for d, e in t["domains"].items():
            first = e["read_order"][0] if e["read_order"] else ""
            name = "%s (%s)" % (d, first) if first.startswith("skill:") else d
            lines.append("%s: %s" % (name, " ".join(words[d][:take[d]])))
        return "\n".join(head + lines) + "\n"

    text = render()
    if len(text.encode("utf-8")) > limit:
        sys.exit("indeks ringkas %d byte melewati batas %d bahkan dengan satu kata per domain"
                 % (len(text.encode("utf-8")), limit))
    while any(take[d] < len(words[d]) for d in words):
        for d in words:
            if take[d] >= len(words[d]):
                continue
            take[d] += 1
            grown = render()
            if len(grown.encode("utf-8")) > limit:
                return text
            text = grown
    return text


def match(t, text):
    """Pencocokan deterministik: kata utuh (atau frasa dua kata) dari `terms` yang muncul di teks."""
    low = " " + re.sub(r"[^0-9a-zà-ÿ/+\-]+", " ", text.lower()) + " "
    hits = {}
    for d, e in t["domains"].items():
        found = sorted({w for w in e["terms"] if len(w) > 1 and " %s " % w in low})
        strong = [w for w in found if w not in WEAK]
        if strong or len(found) >= 2:
            hits[d] = found
    return dict(sorted(hits.items(), key=lambda kv: -len(kv[1])))


# Lima berkas yang ditulis ke --out, dalam urutan tulis (nama dipakai juga oleh staging dan aturan rutin).
OUTPUT_FILES = ("indeks_struktur.json", "indeks_pemicu.json", "indeks_struktur.md", "indeks_pemicu.md",
                "indeks_pemicu_ringkas.md")


def dir_fd_supported():
    """Platform ini bisa membuka --out sekali (tanpa mengikuti tautan) lalu bekerja relatif ke deskriptor folder itu."""
    return (os.open in os.supports_dir_fd and os.lstat in os.supports_dir_fd and os.rename in os.supports_dir_fd
            and os.unlink in os.supports_dir_fd and hasattr(os, "O_NOFOLLOW") and hasattr(os, "O_DIRECTORY"))


def write_outputs(out, files, use_dir_fd=None):
    """Tulis `files` [(nama, teks)] ke folder `out` hanya sebagai berkas biasa di dalam `out` (temuan keamanan L1).

    Semua diperiksa dulu, baru ditulis: `out` yang berupa tautan simbolik, nama yang memuat bagian folder, atau nama
    yang sudah ada sebagai tautan simbolik, folder atau berkas tak biasa menghentikan build sebelum satu berkas pun
    ditulis. Tiap berkas ditulis ke nama sementara di dalam `out` (O_EXCL, tidak mengikuti tautan) lalu di-rename
    menimpa yang lama, jadi tautan atau tautan keras yang muncul di nama keluaran diganti, tidak pernah ditulisi.
    Bila platform punya deskriptor folder, semua langkah relatif ke `out` yang dibuka sekali tanpa mengikuti tautan.
    """
    if use_dir_fd is None:
        use_dir_fd = dir_fd_supported()
    for name, _ in files:
        if name in ("", ".", "..") or os.path.basename(name) != name or (os.altsep and os.altsep in name):
            sys.exit("keluaran ditolak: nama %r bukan nama berkas di dalam --out" % name)
    if os.path.islink(out):
        sys.exit("--out ditolak: folder keluaran adalah tautan simbolik")
    os.makedirs(out, exist_ok=True)
    if os.path.islink(out) or not os.path.isdir(out):
        sys.exit("--out ditolak: folder keluaran bukan folder biasa")
    real = os.path.realpath(out)
    try:
        dfd = os.open(out, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW) if use_dir_fd else None
    except OSError:
        sys.exit("--out ditolak: folder keluaran tidak bisa dibuka tanpa mengikuti tautan")
    at = (lambda name: name) if dfd is not None else (lambda name: os.path.join(real, name))
    pending = []
    try:
        for name, _ in files:
            try:
                info = os.lstat(at(name), dir_fd=dfd)
            except FileNotFoundError:
                continue
            if not stat.S_ISREG(info.st_mode):
                sys.exit("keluaran ditolak: %s di --out sudah ada dan bukan berkas biasa (tautan simbolik atau folder)" % name)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
        for name, text in files:
            temp = ".%s.%s.tmp" % (name, binascii.hexlify(os.urandom(6)).decode())
            fd = os.open(at(temp), flags, 0o666, dir_fd=dfd)
            pending.append(temp)
            with os.fdopen(fd, "wb") as f:
                f.write(text.encode("utf-8"))
            if dfd is not None:
                os.rename(temp, name, src_dir_fd=dfd, dst_dir_fd=dfd)
            else:
                os.replace(at(temp), at(name))
            pending.remove(temp)
    except OSError as e:
        sys.exit("keluaran gagal ditulis: %s" % (e.strerror or e.__class__.__name__))
    finally:
        for temp in pending:
            try:
                os.unlink(at(temp), dir_fd=dfd)
            except OSError:
                pass
        if dfd is not None:
            os.close(dfd)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--out")
    ap.add_argument("--match", help="teks tugas atau misi; cetak domain yang terpicu lalu keluar")
    a = ap.parse_args()
    s, t = build(a.root)
    if a.match is not None:
        for d, words in match(t, a.match).items():
            print("%s <- %s | buka dulu: %s" % (d, ", ".join(words), t["domains"][d]["read_order"][0]))
        return
    if not a.out:
        sys.exit("--out wajib bila tidak memakai --match")
    texts = [json.dumps(s, ensure_ascii=False, indent=1), json.dumps(t, ensure_ascii=False, indent=1),
             md_structure(s), md_triggers(t), md_compact(t)]
    write_outputs(a.out, list(zip(OUTPUT_FILES, texts)))
    print("domain %d, kartu %d, pertanyaan %d" % (len(s["domains"]), sum(len(e["cards"]) for e in s["domains"].values()), len(t["questions"])))


if __name__ == "__main__":
    main()
