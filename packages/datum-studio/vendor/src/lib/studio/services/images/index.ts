/**
 * Layanan gambar Studio (I43, 01_specs.md §3.7, §7.1, §8.2; S53).
 *
 * Tanda tangan kontrak I43: `decodeImage`, `pxGuard`. Ekspor tambahan untuk
 * S51/S57: dekode rinci (`decodeImageDetailed`: DPI tertanam, orientasi
 * EXIF), multipart (`assertMultipartLength`, `decodeImageBlob`,
 * `decodeImageFormField`), penyimpanan lewat S52 (`storeImageAsset`,
 * `readImageAsset`, `assets/<sha256>.<png|jpg>`), helper DATUM-39
 * (`effectiveDpi`, `minWidthPxFor`, `pxGuardMinDpi`). SR-19 (I52): `storeAsset`,
 * `resolveAssetRef`, `resolveSubmissionAssets` atas model M13 `StudioAsset`.
 *
 * Masukan tak tepercaya: hanya PNG/JPEG menurut magic bytes (SVG mentah dan
 * format lain -> 415 `ASSET_TYPE_UNSUPPORTED`); dimensi dari header tanpa
 * dekompresi; batas `STUDIO_MAX_ASSET_BYTES` (413) dicek sebelum dekode
 * base64; batas piksel `IMAGE_MAX_SIDE_PX`/`IMAGE_MAX_PIXELS` (413).
 * `widthPx`/`heightPx` = piksel tersimpan tanpa rotasi EXIF (paritas PIL
 * `im.size` di HS `px_guard` dan S19 `sniffImage`).
 */
export {
  assertMultipartLength,
  decodeBase64Strict,
  decodeImage,
  decodeImageBlob,
  decodeImageDetailed,
  decodeImageFormField,
  IMAGE_MAX_BASE64_CHARS,
  IMAGE_MAX_MULTIPART_BYTES,
  IMAGE_MAX_PIXELS,
  IMAGE_MAX_SIDE_PX,
  IMAGE_SOURCE,
} from "./decode";
export type { DecodedImage, DecodedImageDetail } from "./decode";
export {
  effectiveDpi,
  formatFixed0,
  minWidthPxFor,
  pxGuard,
  pxGuardMinDpi,
  PX_GUARD_CHECK_ID,
  PX_GUARD_MIN_DPI_CHART,
  PX_GUARD_MIN_DPI_DEFAULT,
} from "./guard";
export { sniffRaster } from "./sniff";
export type { RasterHeader, RasterMime, RejectedKind, SniffResult } from "./sniff";
export { assetFileName, assetRelPath, assetShardRelPath, ASSETS_DIR, imageExt, linkAssetCopy, readImageAsset, storeImageAsset, writeAssetFile } from "./store";
export type { StoredImageAsset } from "./store";
// SR-19 (I52, M13 StudioAsset): unggah idempoten + resolusi rujukan aset v2.
export {
  assertAssetQuota,
  assetQuotaLimits,
  assetQuotaScope,
  assetRefOf,
  findAssetBySha,
  resolveAssetRef,
  resolveSubmissionAssets,
  storeAsset,
  storeAssetRow,
  toAssetDto,
} from "./asset-store";
export type { AssetQuotaLimits, AssetQuotaOptions, AssetQuotaScope, AssetStoreOptions, ResolveAssetRefOptions, StoreAssetInput, StudioAssetDb, StudioAssetRow } from "./asset-store";
