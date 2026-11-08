; Swarm per-user install folder (spec 114 WP-NSIS-1, decision L20).
; electron-builder derives the oneClick per-user folder from package.json "name"
; (@opencode-aidesktop). initMultiUser (multiUser.nsh:21-56) runs after preInit and
; takes HKCU\${INSTALL_REGISTRY_KEY}\InstallLocation when present, so preInit seeds
; that value once. An earlier install location and /D= still win.
!macro preInit
  !ifndef BUILD_UNINSTALLER
    !ifndef INSTALL_MODE_PER_ALL_USERS
      Push $0
      Push $1
      Push $2
      SetRegView 64
      ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
      ${If} $0 == ""
        ; same root as setInstallModePerUser: UserProgramFiles, else $LOCALAPPDATA\Programs
        StrCpy $0 "$LOCALAPPDATA\Programs"
        StrCpy $2 0
        System::Call 'SHELL32::SHGetKnownFolderPath(g "${FOLDERID_UserProgramFiles}", i ${KF_FLAG_CREATE}, p 0, *p .r2)i.r1'
        ${If} $1 == 0
          System::Call 'KERNEL32::lstrcpynW(w .r0, p r2, i ${NSIS_MAX_STRLEN})p'
        ${EndIf}
        ${If} $2 != 0
          System::Call 'OLE32::CoTaskMemFree(p r2)'
        ${EndIf}
        WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$0\Swarm"
      ${EndIf}
      Pop $2
      Pop $1
      Pop $0
    !endif
  !endif
!macroend
