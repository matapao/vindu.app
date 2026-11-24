; The app's links on Windows (src/links.ts): its installer registers the vindu scheme, for the person it installs for, as
; a Mac's app declares it in its Info.plist and Linux's in its desktop entry (electron-builder does those two); its
; uninstaller takes it away. A link comes to the program as an argument of its own, quoted whole. vindu only: never an
; app's own scheme, which stays with that app as it is installed.
!macro customInstall
  WriteRegStr SHCTX "Software\Classes\vindu" "" "URL:vindu"
  WriteRegStr SHCTX "Software\Classes\vindu" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\vindu\DefaultIcon" "" "$appExe,0"
  WriteRegStr SHCTX "Software\Classes\vindu\shell\open\command" "" '"$appExe" "%1"'
!macroend
!macro customUnInstall
  DeleteRegKey SHCTX "Software\Classes\vindu"
!macroend
