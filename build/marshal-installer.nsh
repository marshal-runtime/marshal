; Custom NSIS installer script for Marshal.
;
; Fixes a false-positive "Marshal is already running" bug in the electron-builder
; default process-detection logic.
;
; Root cause:
;   The default FIND_PROCESS macro checks whether a running process's exe path
;   starts with $INSTDIR using PowerShell's String.StartsWith().  Because the original
;   Marshal install directory was "...\Programs\M" (a single-char name), this prefix
;   also matched any other app whose install folder begins with "M" (for
;   example "...\Programs\My Editor\"). The installer therefore falsely
;   detected that other app as Marshal, showed the dialog, and then killed it
;   when the user clicked Continue.
;
; Fix:
;   Override the customCheckAppRunning macro (checked by
;   allowOnlyOneInstallerInstance.nsh before running its default logic) to use
;   an exact path comparison (-ieq) instead of StartsWith.
;
; Notes on variable availability inside this macro:
;   $CmdPath, $FindPath, $PowerShellPath  – declared + initialised by the
;       surrounding CHECK_APP_RUNNING macro before calling us; safe to use.
;   $pid, $IsPowerShellAvailable – declared only inside the !ifmacrondef guard
;       that we bypass; we declare our own equivalents (_marshal_pid, _marshal_psAvail).
;   ${isUpdated} – compile-time define injected by electron-builder; valid here.
;   getProcessInfo.nsh – has !ifndef include guards; safe to re-include.

!include "getProcessInfo.nsh"

; Keep the NSIS installer sharp on high-DPI Windows displays instead of letting
; Windows bitmap-scale the installer UI.
ManifestDPIAware true

; ---------------------------------------------------------------------------
; customInit — runs at installer startup, before process detection.
;
; ---------------------------------------------------------------------------
!macro customInit
  ; Enforce the product's canonical per-user location after electron-builder
  ; initializes install mode and processes any /D= command-line override.
  StrCpy $installMode CurrentUser
  SetShellVarContext current
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\Marshal\Marshal"
!macroend

!macro customCheckAppRunning
  Var /GLOBAL _marshal_pid
  Var /GLOBAL _marshal_psAvail

  ; Check whether PowerShell + Get-CimInstance is available (mirrors IS_POWERSHELL_AVAILABLE).
  nsExec::Exec `"$PowerShellPath" -C "if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"`
  Pop $0
  ${if} $0 != 0
    StrCpy $0 1
  ${endIf}
  StrCpy $_marshal_psAvail $0

  ; Capture PID + image name of the installer process itself.
  ${GetProcessInfo} 0 $_marshal_pid $1 $2 $3 $4

  ; Skip the check when the installer executable is named Marshal.exe (edge-case guard
  ; preserved from the original template).
  ${if} $3 != "${APP_EXECUTABLE_FILENAME}"
    ${if} ${isUpdated}
      Sleep 300
    ${endIf}

    ; --- Detect running Marshal using EXACT path match (not StartsWith) ---
    ${if} $_marshal_psAvail == 0
      nsExec::Exec `"$PowerShellPath" -C "if ((Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path -ieq '$INSTDIR\${APP_EXECUTABLE_FILENAME}'}).Count -gt 0) { exit 0 } else { exit 1 }"`
      Pop $R0
    ${else}
      nsExec::Exec `"$CmdPath" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV | "$FindPath" "${APP_EXECUTABLE_FILENAME}"`
      Pop $R0
    ${endIf}

    ${if} $R0 == 0
      ${if} ${isUpdated}
        Sleep 1000
        Goto doStop
      ${endIf}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK doStop
      Quit

      doStop:
      DetailPrint "$(appClosing)"

      ; --- Kill only the exact Marshal.exe (not path-prefix matches of other apps) ---
      ${if} $_marshal_psAvail == 0
        nsExec::Exec `"$PowerShellPath" -C "Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path -ieq '$INSTDIR\${APP_EXECUTABLE_FILENAME}'} | % { Stop-Process -Id $$_.ProcessId }"`
      ${else}
        nsExec::Exec `"$CmdPath" /C taskkill /IM "${APP_EXECUTABLE_FILENAME}" /FI "PID ne $_marshal_pid" /FI "USERNAME eq %USERNAME%"`
      ${endIf}
      Pop $0
      Sleep 300

      StrCpy $R1 0
      retryLoop:
        IntOp $R1 $R1 + 1

        ; Re-check using same exact-match logic
        ${if} $_marshal_psAvail == 0
          nsExec::Exec `"$PowerShellPath" -C "if ((Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path -ieq '$INSTDIR\${APP_EXECUTABLE_FILENAME}'}).Count -gt 0) { exit 0 } else { exit 1 }"`
          Pop $R0
        ${else}
          nsExec::Exec `"$CmdPath" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV | "$FindPath" "${APP_EXECUTABLE_FILENAME}"`
          Pop $R0
        ${endIf}

        ${if} $R0 == 0
          Sleep 1000
          ; Force-kill if still running
          ${if} $_marshal_psAvail == 0
            nsExec::Exec `"$PowerShellPath" -C "Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path -ieq '$INSTDIR\${APP_EXECUTABLE_FILENAME}'} | % { Stop-Process -Id $$_.ProcessId -Force }"`
          ${else}
            nsExec::Exec `"$CmdPath" /C taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" /FI "PID ne $_marshal_pid" /FI "USERNAME eq %USERNAME%"`
          ${endIf}
          Pop $0

          ; Check once more after force-kill
          ${if} $_marshal_psAvail == 0
            nsExec::Exec `"$PowerShellPath" -C "if ((Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path -ieq '$INSTDIR\${APP_EXECUTABLE_FILENAME}'}).Count -gt 0) { exit 0 } else { exit 1 }"`
            Pop $R0
          ${else}
            nsExec::Exec `"$CmdPath" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV | "$FindPath" "${APP_EXECUTABLE_FILENAME}"`
            Pop $R0
          ${endIf}

          ${if} $R0 == 0
            DetailPrint `Waiting for "${PRODUCT_NAME}" to close.`
            Sleep 2000
          ${else}
            Goto doneWaiting
          ${endIf}
        ${else}
          Goto doneWaiting
        ${endIf}

        ; App likely running with elevated permissions — ask user to close manually.
        ${if} $R1 > 1
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY retryLoop
          Quit
        ${else}
          Goto retryLoop
        ${endIf}
      doneWaiting:
    ${endIf}
  ${endIf}
!macroend
