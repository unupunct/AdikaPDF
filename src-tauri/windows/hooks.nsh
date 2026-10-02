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


!macro NSIS_HOOK_PREINSTALL
  ; Stop a running print helper so its files can be replaced.
  nsExec::Exec 'taskkill /F /FI "IMAGENAME eq adika-pdf-editor.exe"'
  Pop $0
  ; Explorer's thumbnail host keeps the thumbnail handler loaded: let it go.
  nsExec::Exec 'taskkill /F /FI "MODULES eq adika_thumbs.dll"'
  Pop $0
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; A "logs" folder next to the program, writable by every user (Program Files
  ; is read-only for normal apps), so crash logs can be found in the install path.
  CreateDirectory "$INSTDIR\logs"
  ; *S-1-5-32-545 = BUILTIN\Users (language independent). (OI)(CI)M = modify, inherited.
  nsExec::Exec 'icacls "$INSTDIR\logs" /grant *S-1-5-32-545:(OI)(CI)M /Q'
  Pop $0

  ; Virtual printer "Adika PDF Editor" (needs administrator rights: per-machine install).
  ; printer.ps1 is installed next to the exe as a bundle resource.
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\printer.ps1" -Action install -EnableSpooler'
  Pop $0
  ; Start the print helper at every log-on (all users when possible).
  ClearErrors
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "Adika PDF Printer" '"$INSTDIR\adika-pdf-editor.exe" --print-watcher'
  IfErrors 0 +2
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Adika PDF Printer" '"$INSTDIR\adika-pdf-editor.exe" --print-watcher'
  !insertmacro AdikaShellMenu
  ; PDF thumbnails in Explorer (drawn by the Windows PDF renderer).
  nsExec::Exec 'regsvr32.exe /s "$INSTDIR\adika_thumbs.dll"'
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /FI "IMAGENAME eq adika-pdf-editor.exe"'
  Pop $0
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\printer.ps1" -Action uninstall'
  Pop $0
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "Adika PDF Printer"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Adika PDF Printer"
  !insertmacro AdikaShellMenuRemove
  nsExec::Exec 'regsvr32.exe /s /u "$INSTDIR\adika_thumbs.dll"'
  Pop $0
  nsExec::Exec 'taskkill /F /FI "MODULES eq adika_thumbs.dll"'
  Pop $0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  RMDir /r "$INSTDIR\logs"
!macroend
