/**
 * Diff blok antar dua snapshot revisi (S50, D-06): identitas = `blockId`
 * (§4.2 butir 2); hanya blok beralamat (spacer/device tidak dibandingkan).
 */
import type { NormBlock, NormDocSnapshot } from "../../contract";

export interface BlockDiffEntry {
  blockId: string;
  type: string;
  oldAddress?: string;
  newAddress?: string;
  oldArtifactLabel?: string;
  newArtifactLabel?: string;
}

export interface SnapshotDiff {
  /** Ada di revisi baru saja. */
  added: BlockDiffEntry[];
  /** Ada di revisi lama saja. */
  removed: BlockDiffEntry[];
  /** Ada di keduanya, isi (contentSha256) berbeda. */
  changed: BlockDiffEntry[];
  /** Ada di keduanya, alamat atau label artefak bergeser (isi boleh sama). */
  moved: BlockDiffEntry[];
  /** Alamat/label lama -> baru untuk semua blok yang bergeser (§4.2 butir 3). */
  addressMap: Record<string, string>;
}

export interface RevisionDiff extends SnapshotDiff {
  documentId: string;
  fromRevisionNo: number;
  toRevisionNo: number;
}

function addressed(s: NormDocSnapshot): Map<string, NormBlock> {
  const m = new Map<string, NormBlock>();
  for (const b of s.blocks ?? []) if (b.address && !m.has(b.blockId)) m.set(b.blockId, b);
  return m;
}

function entry(o: NormBlock | undefined, n: NormBlock | undefined): BlockDiffEntry {
  const base = (n ?? o) as NormBlock;
  const e: BlockDiffEntry = { blockId: base.blockId, type: base.type };
  if (o?.address) e.oldAddress = o.address;
  if (n?.address) e.newAddress = n.address;
  if (o?.artifactLabel) e.oldArtifactLabel = o.artifactLabel;
  if (n?.artifactLabel) e.newArtifactLabel = n.artifactLabel;
  return e;
}

/** Urutan keluaran mengikuti ordinal snapshot (lama untuk removed, baru untuk lainnya). */
export function diffSnapshots(prev: NormDocSnapshot, next: NormDocSnapshot): SnapshotDiff {
  const a = addressed(prev);
  const b = addressed(next);
  const out: SnapshotDiff = { added: [], removed: [], changed: [], moved: [], addressMap: {} };
  for (const [id, o] of a) if (!b.has(id)) out.removed.push(entry(o, undefined));
  for (const [id, n] of b) {
    const o = a.get(id);
    if (!o) {
      out.added.push(entry(undefined, n));
      continue;
    }
    if (o.contentSha256 !== n.contentSha256) out.changed.push(entry(o, n));
    const addrMoved = o.address !== n.address;
    const labelMoved = (o.artifactLabel ?? "") !== (n.artifactLabel ?? "");
    if (addrMoved || labelMoved) {
      out.moved.push(entry(o, n));
      if (addrMoved && o.address && n.address) out.addressMap[o.address] = n.address;
      if (labelMoved && o.artifactLabel && n.artifactLabel) out.addressMap[o.artifactLabel] = n.artifactLabel;
    }
  }
  return out;
}

/** Alamat yang tersentuh perubahan (untuk `changedAddresses`): baru untuk tambah/ubah, lama untuk hapus. */
export function changedAddressesOf(d: SnapshotDiff): string[] {
  const s = new Set<string>();
  for (const e of d.added) if (e.newAddress) s.add(e.newAddress);
  for (const e of d.changed) if (e.newAddress) s.add(e.newAddress);
  for (const e of d.removed) if (e.oldAddress) s.add(e.oldAddress);
  return [...s];
}
