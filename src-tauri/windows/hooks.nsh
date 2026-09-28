; Adika PDF Editor installer hooks.

!macro NSIS_HOOK_PREINSTALL
  ; Stop a running print helper so its files can be replaced.
  nsExec::Exec 'taskkill /F /FI "IMAGENAME eq adika-pdf-editor.exe"'
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
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /FI "IMAGENAME eq adika-pdf-editor.exe"'
  Pop $0
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\printer.ps1" -Action uninstall'
  Pop $0
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "Adika PDF Printer"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Adika PDF Printer"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  RMDir /r "$INSTDIR\logs"
!macroend
