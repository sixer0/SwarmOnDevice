/**
 * Modul engine/diagram/layout-c (I19, 01_specs.md §8.2), diisi S29.
 * Port `layout_sld`, `layout_rack`, `layout_graph` dari Garis A
 * `HS/datum_diagram.py` (:582-854). Koordinat dalam mm (1 satuan SVG = 1 mm),
 * belum di-snap akhir dan belum memuat cadangan kaki apparatus; keduanya tugas
 * build (S30) seperti `build_svg`. Varian `*Detail` mengembalikan data samping
 * yang Python simpan pada `Sheet` (`bus`, `rack_x`, `rowpack`) untuk build/uji.
 * INT-J (F-022): sld dengan > 1 rel ditolak `E-17/MULTI-BUS` kecuali opsi
 * eksplisit `multiBus` (rel ditumpuk vertikal) atau (FIX-B2) setiap rel
 * tambahan adalah rel hilir yang dicatu cabang rel sebelumnya; lihat `sld.ts`.
 */
export { layoutSld, layoutSldDetail, type SldBus, type SldDetail, type SldLayoutOptions } from "./sld";
export { layoutRack, layoutRackDetail, type RackDetail } from "./rack";
export { layoutGraph, layoutGraphDetail, type GraphDetail, type GraphRowpack } from "./graph";
