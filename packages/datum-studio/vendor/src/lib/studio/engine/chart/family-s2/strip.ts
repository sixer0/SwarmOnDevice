/**
 * S-06 Strip atau jitter — setiap pengamatan satu titik, satu kolom per grup.
 *
 * Jitter DETERMINISTIK: geser horizontal = (u - 0,5) x 2 x sebaran, u dari mulberry32 per
 * grup yang dibenihi FNV-1a("S-06|<indeks>|<nama>") XOR 42 (common.ts `groupRng`). Spec
 * yang sama -> posisi sama di setiap mesin. Angka acuan (numpy PCG64 `SEED + 57 + gi`)
 * tidak direplikasi; paritas CB bersifat struktural (research/06 N4).
 *
 * Gaya datum (acuan pustakachart `v57_jitter` + `v56_strip`, PENUH): titik ms 2,8 pt
 * (r 1,4 pt) alpha 0,8, sebaran +-0,14 jarak kolom, gridline y ink200 0,4 pt, tick mono
 * 6,5 pt, satuan di atas sumbu. Penyimpangan disengaja: acuan mewarnai tiap grup dengan
 * CAT_SERIES (ink900, signal, verd, ...) = lebih dari satu aksen (DATUM-26) dan > 1
 * keluarga warna; di sini titik ink700 dan HANYA grup beraksen ber-signal.
 * Gaya gallery (Gambar 8.5 panel S-06): titik ink400, grup beraksen signal, garis rerata
 * ink900 tebal, sumbu y bertick, label grup ink400 di bawah.
 *
 * Petunjuk data (bukan registri, S94): `jitter` (default true; false = strip v56 tanpa
 * geser), `meanLine` (default false; true = garis rerata ink900 per grup, kecuali acuan
 * v56 yang memakai signal: tidak diikuti karena melanggar aksen tunggal).
 */
import {
  type S2Ctx,
  accentGroupIndex,
  columnFrame,
  columnLabel,
  groupRng,
  hintBool,
  linearScale,
  mean,
  ran,
  report,
  requireDistribution,
} from "./common";

/** Jari-jari titik acuan: ms 2,8 pt = diameter. */
const DATUM_R_MM = 1.4 * (25.4 / 72);

export function renderStrip(ctx: S2Ctx): void {
  const { pal, doc, style } = ctx;
  const gal = style === "gallery";
  const groups = requireDistribution(ctx);
  const accent = accentGroupIndex(
    ctx,
    groups.map((g) => g.name),
  );
  const jitter = hintBool(ctx, "jitter", true);
  const meanLine = hintBool(ctx, "meanLine", false);
  const total = groups.reduce((s, g) => s + g.values.length, 0);
  if (total > 1000) report(ctx, "S-06.points", `${total} titik; strip/jitter untuk sampel kecil sampai sedang (Tabel 8.5: hindari ribuan titik)`);

  const f = columnFrame(ctx, groups, groups.length, (dom, top, base) => linearScale(dom.min, dom.max, base, top), groups.map((g) => g.name));
  const spread = f.step * (gal ? 0.2 : 0.14);
  const r = gal ? Math.min(0.55, f.step * 0.06) : DATUM_R_MM;
  ran(ctx, "S-06.jitterDeterministic");

  groups.forEach((g, gi) => {
    const gx = f.centre(gi);
    const rng = groupRng("S-06", gi, g.name);
    const fill = gi === accent ? pal.role.accent : gal ? pal.ink400 : pal.ink700;
    doc.open(`data-group="${gi}"`);
    g.values.forEach((v, vi) => {
      const dx = jitter ? (rng() - 0.5) * 2 * spread : 0;
      doc.circle(gx + dx, f.sy(v), r, fill, {
        mark: { mark: "point", series: g.name, index: gi },
        attrs: ` data-obs="${vi}"${gal ? "" : ' fill-opacity="0.8"'}`,
      });
    });
    if (meanLine) {
      const half = Math.min(f.step * 0.3, spread + 1.2);
      doc.line(gx - half, f.sy(mean(g.values)), gx + half, f.sy(mean(g.values)), pal.ink900, gal ? 0.5 : 1.5 * (25.4 / 72), {
        mark: { mark: "segment", series: g.name, index: gi },
        attrs: ' data-stat="mean"',
      });
    }
    doc.close();
    columnLabel(ctx, f, gx, g.name, gi);
  });
}
