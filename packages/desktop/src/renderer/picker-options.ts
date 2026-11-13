// Row 33b: maps the app-level directory picker options to the preload call. defaultPath must reach the native dialog
// so U-8 "Choose" opens at the home folder (main/ipc.ts open-directory-picker already honours it).
export function directoryPickerArgs(opts?: { title?: string; multiple?: boolean; defaultPath?: string }) {
  return {
    multiple: opts?.multiple ?? false,
    title: opts?.title,
    defaultPath: opts?.defaultPath,
  }
}
