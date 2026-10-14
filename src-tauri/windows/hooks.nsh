; Adika PDF Editor installer hooks.

; Explorer context menu entries (classic menu; on Windows 11 under "Show more options").
; All machine users when possible, otherwise the installing user.
!macro AdikaVerb EXT VERB LABEL ARGS
  ClearErrors
  WriteRegStr HKLM "Software\Classes\SystemFileAssociations\${EXT}\shell\${VERB}" "" "${LABEL}"
  IfErrors 0 +5
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\${VERB}" "" "${LABEL}"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\${VERB}" "Icon" "$INSTDIR\adika-pdf-editor.exe,0"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\${VERB}\command" "" '"$INSTDIR\adika-pdf-editor.exe" ${ARGS} "%1"'
  Goto +3
  WriteRegStr HKLM "Software\Classes\SystemFileAssociations\${EXT}\shell\${VERB}" "Icon" "$INSTDIR\adika-pdf-editor.exe,0"
  WriteRegStr HKLM "Software\Classes\SystemFileAssociations\${EXT}\shell\${VERB}\command" "" '"$INSTDIR\adika-pdf-editor.exe" ${ARGS} "%1"'
!macroend

!macro AdikaVerbRemove EXT VERB
  DeleteRegKey HKLM "Software\Classes\SystemFileAssociations\${EXT}\shell\${VERB}"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\${VERB}"
!macroend

!macro AdikaShellMenu
  !insertmacro AdikaVerb ".pdf" "AdikaCombine" "Combine in Adika PDF Editor" "--combine"
  ; Shown for any number of selected PDFs (each is handed to the running window, which combines them).
  WriteRegStr HKLM "Software\Classes\SystemFileAssociations\.pdf\shell\AdikaCombine" "MultiSelectModel" "Player"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\.pdf\shell\AdikaCombine" "MultiSelectModel" "Player"
  !insertmacro AdikaVerb ".pdf" "AdikaCompress" "Compress with Adika PDF Editor" "--batch --compress"
  !insertmacro AdikaVerb ".pdf" "AdikaOcr" "Make searchable with Adika PDF Editor (OCR)" "--batch --ocr"
  !insertmacro AdikaVerb ".docx" "AdikaConvert" "Convert to PDF with Adika PDF Editor" "--convert"
  !insertmacro AdikaVerb ".doc" "AdikaConvert" "Convert to PDF with Adika PDF Editor" "--convert"
  !insertmacro AdikaVerb ".xlsx" "AdikaConvert" "Convert to PDF with Adika PDF Editor" "--convert"
  !insertmacro AdikaVerb ".xls" "AdikaConvert" "Convert to PDF with Adika PDF Editor" "--convert"
  !insertmacro AdikaVerb ".pptx" "AdikaConvert" "Convert to PDF with Adika PDF Editor" "--convert"
  !insertmacro AdikaVerb ".ppt" "AdikaConvert" "Convert to PDF with Adika PDF Editor" "--convert"
  !insertmacro AdikaVerb ".odt" "AdikaConvert" "Convert to PDF with Adika PDF Editor" "--convert"
  !insertmacro AdikaVerb ".rtf" "AdikaConvert" "Convert to PDF with Adika PDF Editor" "--convert"
  !insertmacro AdikaVerb ".jpg" "AdikaConvert" "Convert to PDF with Adika PDF Editor" "--convert"
  !insertmacro AdikaVerb ".jpeg" "AdikaConvert" "Convert to PDF with Adika PDF Editor" "--convert"
  !insertmacro AdikaVerb ".png" "AdikaConvert" "Convert to PDF with Adika PDF Editor" "--convert"
  !insertmacro AdikaVerb ".tif" "AdikaConvert" "Convert to PDF with Adika PDF Editor" "--convert"
  !insertmacro AdikaVerb ".tiff" "AdikaConvert" "Convert to PDF with Adika PDF Editor" "--convert"
  !insertmacro AdikaVerb ".heic" "AdikaConvert" "Convert to PDF with Adika PDF Editor" "--convert"
  !insertmacro AdikaVerb ".bmp" "AdikaConvert" "Convert to PDF with Adika PDF Editor" "--convert"
  !insertmacro AdikaVerb ".gif" "AdikaConvert" "Convert to PDF with Adika PDF Editor" "--convert"
  !insertmacro AdikaVerb ".webp" "AdikaConvert" "Convert to PDF with Adika PDF Editor" "--convert"
  !insertmacro AdikaVerb ".html" "AdikaConvert" "Convert to PDF with Adika PDF Editor" "--convert"
  !insertmacro AdikaVerb ".htm" "AdikaConvert" "Convert to PDF with Adika PDF Editor" "--convert"
  !insertmacro AdikaVerb ".md" "AdikaConvert" "Convert to PDF with Adika PDF Editor" "--convert"
  !insertmacro AdikaVerb ".txt" "AdikaConvert" "Convert to PDF with Adika PDF Editor" "--convert"
  !insertmacro AdikaVerb ".eml" "AdikaConvert" "Convert to PDF with Adika PDF Editor" "--convert"
  !insertmacro AdikaVerb ".msg" "AdikaConvert" "Convert to PDF with Adika PDF Editor" "--convert"
  !insertmacro AdikaVerb ".xps" "AdikaConvert" "Convert to PDF with Adika PDF Editor" "--convert"
  !insertmacro AdikaVerb ".oxps" "AdikaConvert" "Convert to PDF with Adika PDF Editor" "--convert"
  !insertmacro AdikaVerb ".epub" "AdikaConvert" "Convert to PDF with Adika PDF Editor" "--convert"
  !insertmacro AdikaVerb ".dxf" "AdikaConvert" "Convert to PDF with Adika PDF Editor" "--convert"
!macroend

!macro AdikaShellMenuRemove
  !insertmacro AdikaVerbRemove ".pdf" "AdikaCombine"
  !insertmacro AdikaVerbRemove ".pdf" "AdikaCompress"
  !insertmacro AdikaVerbRemove ".pdf" "AdikaOcr"
  !insertmacro AdikaVerbRemove ".docx" "AdikaConvert"
  !insertmacro AdikaVerbRemove ".doc" "AdikaConvert"
  !insertmacro AdikaVerbRemove ".xlsx" "AdikaConvert"
  !insertmacro AdikaVerbRemove ".xls" "AdikaConvert"
  !insertmacro AdikaVerbRemove ".pptx" "AdikaConvert"
  !insertmacro AdikaVerbRemove ".ppt" "AdikaConvert"
  !insertmacro AdikaVerbRemove ".odt" "AdikaConvert"
  !insertmacro AdikaVerbRemove ".rtf" "AdikaConvert"
  !insertmacro AdikaVerbRemove ".jpg" "AdikaConvert"
  !insertmacro AdikaVerbRemove ".jpeg" "AdikaConvert"
  !insertmacro AdikaVerbRemove ".png" "AdikaConvert"
  !insertmacro AdikaVerbRemove ".tif" "AdikaConvert"
  !insertmacro AdikaVerbRemove ".tiff" "AdikaConvert"
  !insertmacro AdikaVerbRemove ".heic" "AdikaConvert"
  !insertmacro AdikaVerbRemove ".bmp" "AdikaConvert"
  !insertmacro AdikaVerbRemove ".gif" "AdikaConvert"
  !insertmacro AdikaVerbRemove ".webp" "AdikaConvert"
  !insertmacro AdikaVerbRemove ".html" "AdikaConvert"
  !insertmacro AdikaVerbRemove ".htm" "AdikaConvert"
  !insertmacro AdikaVerbRemove ".md" "AdikaConvert"
  !insertmacro AdikaVerbRemove ".txt" "AdikaConvert"
  !insertmacro AdikaVerbRemove ".eml" "AdikaConvert"
  !insertmacro AdikaVerbRemove ".msg" "AdikaConvert"
  !insertmacro AdikaVerbRemove ".xps" "AdikaConvert"
  !insertmacro AdikaVerbRemove ".oxps" "AdikaConvert"
  !insertmacro AdikaVerbRemove ".epub" "AdikaConvert"
  !insertmacro AdikaVerbRemove ".dxf" "AdikaConvert"
!macroend


; Stops the print helpers (adika-pdf-editor.exe --print-watcher: no window, nothing
; to save) of every user. Editor windows are left alone.
!macro AdikaStopPrintWatchers
  nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"Name='${MAINBINARYNAME}.exe'\" | Where-Object { $$_.CommandLine -like '*--print-watcher*' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force }"`
  Pop $0
!macroend

; Asks running editor windows to close (WM_CLOSE: Adika offers to save unsaved
; documents) and waits; if one stays open, the user closes it and clicks Retry.
; Silent runs (/S) never ask: when a window is still open after the wait (it has
; unsaved work, or belongs to another session), the setup stops with exit code 2
; and changes nothing, unless /FORCECLOSE was given: then Tauri's own check that
; follows ends the program (unsaved work is offered again from the recovery backup).
; Passive runs (/P, the in-app updater) skip this: the app has already exited.
!macro AdikaCloseEditors
  !define AdikaCE ${__LINE__}
  adika_check_${AdikaCE}:
  !if "${INSTALLMODE}" == "currentUser"
    nsis_tauri_utils::FindProcessCurrentUser "${MAINBINARYNAME}.exe"
  !else
    nsis_tauri_utils::FindProcess "${MAINBINARYNAME}.exe"
  !endif
  Pop $R0
  ${If} $R0 = 0
  ${AndIf} $PassiveMode <> 1
    nsExec::Exec 'taskkill /FI "IMAGENAME eq ${MAINBINARYNAME}.exe"'
    Pop $0
    StrCpy $R1 0
    adika_wait_${AdikaCE}:
      Sleep 500
      !if "${INSTALLMODE}" == "currentUser"
        nsis_tauri_utils::FindProcessCurrentUser "${MAINBINARYNAME}.exe"
      !else
        nsis_tauri_utils::FindProcess "${MAINBINARYNAME}.exe"
      !endif
      Pop $R0
      IntOp $R1 $R1 + 1
      ${If} $R0 = 0
      ${AndIf} $R1 < 16
        Goto adika_wait_${AdikaCE}
      ${EndIf}
    ${If} $R0 = 0
      ${If} ${Silent}
        ClearErrors
        ${GetOptions} $CMDLINE "/FORCECLOSE" $R1
        ${If} ${Errors}
          System::Call 'kernel32::AttachConsole(i -1)i.r0'
          ${If} $0 <> 0
            System::Call 'kernel32::GetStdHandle(i -11)i.r0'
            FileWrite $0 "${PRODUCTNAME} is still running (unsaved work or another session). Close it, or run the setup again with /FORCECLOSE.$\r$\n"
          ${EndIf}
          Abort
        ${EndIf}
      ${Else}
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "${PRODUCTNAME} is running. Save your work and close it, then click Retry." IDRETRY adika_check_${AdikaCE}
        Abort
      ${EndIf}
    ${EndIf}
  ${EndIf}
  !undef AdikaCE
!macroend

; ---------------------------------------------------------------- unattended options
; /NOPRINTER, /NOSHELL, /NOUPDATES, /LANG=xx (README "Deploying in a company").
; Each choice is kept in the install key (HKLM, or HKCU for a per-user install),
; so a later update, which runs without the switches, keeps it; /NOPRINTER=0
; (likewise the others) turns it back on. Adika reads DisableUpdateCheck and
; DefaultLanguage from that key as defaults; Group Policy values override them.

; $R9 = 1 when /SWITCH was given (0 for /SWITCH=0), else what an earlier install stored.
!macro AdikaSwitch SWITCH VALUENAME
  ClearErrors
  ${GetOptions} $CMDLINE "/${SWITCH}" $R9
  ${If} ${Errors}
    ClearErrors
    ReadRegDWORD $R9 SHCTX "${MANUPRODUCTKEY}" "${VALUENAME}"
    ${If} ${Errors}
    ${OrIf} $R9 == ""
      StrCpy $R9 0
    ${EndIf}
  ${ElseIf} $R9 == "=0"
    StrCpy $R9 0
  ${Else}
    StrCpy $R9 1
  ${EndIf}
  ${If} $R9 = 1
    WriteRegDWORD SHCTX "${MANUPRODUCTKEY}" "${VALUENAME}" 1
  ${Else}
    DeleteRegValue SHCTX "${MANUPRODUCTKEY}" "${VALUENAME}"
  ${EndIf}
!macroend

; /LANG=ro|en|de|fr|hu|it|es: the interface language until the user picks one.
!macro AdikaDefaultLanguage
  ClearErrors
  ${GetOptions} $CMDLINE "/LANG=" $R9
  ${IfNot} ${Errors}
    ${If} $R9 == "en"
    ${OrIf} $R9 == "ro"
    ${OrIf} $R9 == "de"
    ${OrIf} $R9 == "fr"
    ${OrIf} $R9 == "hu"
    ${OrIf} $R9 == "it"
    ${OrIf} $R9 == "es"
      WriteRegStr SHCTX "${MANUPRODUCTKEY}" "DefaultLanguage" $R9
    ${EndIf}
  ${EndIf}
!macroend

; The thumbnail DLL may be loaded by Explorer or by any program showing a file
; dialog, which locks it; a loaded DLL can still be renamed. It is moved aside and
; deleted now, or at the next restart when still in use (no program is stopped).
!macro AdikaRetireThumbs
  ${If} ${FileExists} "$INSTDIR\adika_thumbs.dll"
    System::Call 'kernel32::GetTickCount()i.r1'
    Rename "$INSTDIR\adika_thumbs.dll" "$INSTDIR\adika_thumbs.$1.old"
    Delete "$INSTDIR\adika_thumbs.$1.old"
    ${If} ${FileExists} "$INSTDIR\adika_thumbs.$1.old"
      ; MOVEFILE_DELAY_UNTIL_REBOOT, without asking for a restart now.
      System::Call 'kernel32::MoveFileExW(w "$INSTDIR\adika_thumbs.$1.old", p 0, i 4)i'
    ${EndIf}
  ${EndIf}
  ; Copies retired by earlier updates that are no longer in use.
  Delete "$INSTDIR\adika_thumbs.*.old"
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro AdikaStopPrintWatchers
  !insertmacro AdikaCloseEditors
  !insertmacro AdikaRetireThumbs
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Logs are kept per user (%LOCALAPPDATA%\Adika PDF Editor\logs); this folder only
  ; holds the setup logs. Older versions made it writable by every user and wrote
  ; everyone's logs here: those logs go and the folder gets the normal permissions.
  ${If} ${FileExists} "$INSTDIR\logs\*.*"
    Delete "$INSTDIR\logs\adika-*.log"
    Delete "$INSTDIR\logs\crash-*.log"
    nsExec::Exec 'icacls "$INSTDIR\logs" /reset /T /Q'
    Pop $0
  ${EndIf}
  CreateDirectory "$INSTDIR\logs"

  !insertmacro AdikaSwitch "NOUPDATES" "DisableUpdateCheck"
  !insertmacro AdikaDefaultLanguage

  !insertmacro AdikaSwitch "NOPRINTER" "NoPrinter"
  ${If} $R9 = 0
    ; Virtual printer "Adika PDF Editor" (needs administrator rights: per-machine install).
    ; printer.ps1 is installed next to the exe as a bundle resource.
    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\printer.ps1" -Action install -EnableSpooler'
    Pop $0
    ; Start the print helper at every log-on (all users when possible).
    ClearErrors
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "Adika PDF Printer" '"$INSTDIR\adika-pdf-editor.exe" --print-watcher'
    IfErrors 0 +2
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Adika PDF Printer" '"$INSTDIR\adika-pdf-editor.exe" --print-watcher'
  ${Else}
    ; Turned off now: what an earlier install set up goes (the spooler is put back as it was).
    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\printer.ps1" -Action uninstall -RestoreSystem'
    Pop $0
    DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "Adika PDF Printer"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Adika PDF Printer"
  ${EndIf}

  !insertmacro AdikaSwitch "NOSHELL" "NoShell"
  ${If} $R9 = 0
    !insertmacro AdikaShellMenu
    ; PDF thumbnails in Explorer (drawn by the Windows PDF renderer).
    nsExec::Exec 'regsvr32.exe /s "$INSTDIR\adika_thumbs.dll"'
    Pop $0
  ${Else}
    !insertmacro AdikaShellMenuRemove
    nsExec::Exec 'regsvr32.exe /s /u "$INSTDIR\adika_thumbs.dll"'
    Pop $0
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro AdikaStopPrintWatchers
  !insertmacro AdikaCloseEditors
  ; An update (old version removed before the new one is installed) keeps what the
  ; first install changed in Windows; a real uninstall puts it back.
  ${If} $UpdateMode = 1
    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\printer.ps1" -Action uninstall'
  ${Else}
    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\printer.ps1" -Action uninstall -RestoreSystem'
  ${EndIf}
  Pop $0
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "Adika PDF Printer"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Adika PDF Printer"
  !insertmacro AdikaShellMenuRemove
  nsExec::Exec 'regsvr32.exe /s /u "$INSTDIR\adika_thumbs.dll"'
  Pop $0
  !insertmacro AdikaRetireThumbs
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; The unattended options of the install (an update keeps them).
  ${If} $UpdateMode <> 1
    DeleteRegValue SHCTX "${MANUPRODUCTKEY}" "NoPrinter"
    DeleteRegValue SHCTX "${MANUPRODUCTKEY}" "NoShell"
    DeleteRegValue SHCTX "${MANUPRODUCTKEY}" "DisableUpdateCheck"
    DeleteRegValue SHCTX "${MANUPRODUCTKEY}" "DefaultLanguage"
    ; The install folder Tauri remembers (the folder is gone now); then the key and its parent when empty.
    DeleteRegValue SHCTX "${MANUPRODUCTKEY}" ""
    DeleteRegKey /ifempty SHCTX "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty SHCTX "Software\${MANUFACTURER}"
  ${EndIf}
  RMDir /r "$INSTDIR\logs"
  ; A thumbnail DLL still in use is deleted at the next restart: the folder goes then too.
  RMDir "$INSTDIR"
  ${If} ${FileExists} "$INSTDIR\*.*"
  ${AndIf} $UpdateMode <> 1
    System::Call 'kernel32::MoveFileExW(w "$INSTDIR", p 0, i 4)i'
  ${EndIf}
  ; "Delete the application data" also removes what Adika keeps for this user:
  ; recovery backups (document content), printed PDFs, logs, caches, and the
  ; e-mail attachment folder. Other users' profiles are theirs to clean.
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    RMDir /r "$LOCALAPPDATA\Adika PDF Editor"
    RMDir /r "$TEMP\Adika PDF Editor"
  ${EndIf}
!macroend
