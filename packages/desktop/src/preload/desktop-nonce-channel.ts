// 1.2.6 row 38b (SEC-06): the one IPC channel that hands the renderer this launch's desktop nonce. Both the preload and
// main import this file. It has no imports, which keeps it safe for the sandboxed preload bundle.
export const DESKTOP_NONCE_IPC = "desktop-nonce:get"
