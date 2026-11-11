; Harmony-Setup.exe: installs or updates Harmony for the current Windows user (no admin needed).
;
; Built by .github/workflows/release.yml:
;   iscc /DMyVersion=0.2.14 installer.iss
; Expects build\Harmony.exe (from build-exe.ps1). build\MicrosoftEdgeWebview2Setup.exe is
; optional: when present it runs only on PCs without the WebView2 runtime Harmony draws with.
;
; Harmony's updater runs it as: Harmony-Setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /RELAUNCH
; It waits for Harmony to close (the single-instance mutex), replaces the exe, and with /RELAUNCH
; starts Harmony again. Your sign-in lives in the Windows Credential Manager and your settings in
; %APPDATA%, so an update or reinstall keeps both.

#ifndef MyVersion
  #define MyVersion "0.0.0"
#endif

[Setup]
AppId={{9B1E4F7A-5C2D-4E8B-A1F3-6D7C8E9F0A21}
AppName=Harmony
AppVersion={#MyVersion}
AppVerName=Harmony {#MyVersion}
AppPublisher=Harmony
DefaultDirName={localappdata}\Programs\Harmony
UsePreviousAppDir=yes
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
PrivilegesRequired=lowest
OutputDir=build\installer
OutputBaseFilename=Harmony-Setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=force
RestartApplications=no
SetupIconFile=icons\icon.ico
UninstallDisplayIcon={app}\Harmony.exe
UninstallDisplayName=Harmony

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"

[Files]
Source: "build\Harmony.exe"; DestDir: "{app}"; Flags: ignoreversion
#if FileExists(AddBackslash(SourcePath) + "build\MicrosoftEdgeWebview2Setup.exe")
Source: "build\MicrosoftEdgeWebview2Setup.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall; Check: NeedsWebView2
#endif

[Icons]
Name: "{autoprograms}\Harmony"; Filename: "{app}\Harmony.exe"
Name: "{autodesktop}\Harmony"; Filename: "{app}\Harmony.exe"; Tasks: desktopicon

[Run]
#if FileExists(AddBackslash(SourcePath) + "build\MicrosoftEdgeWebview2Setup.exe")
Filename: "{tmp}\MicrosoftEdgeWebview2Setup.exe"; Parameters: "/silent /install"; StatusMsg: "Installing the Microsoft WebView2 runtime Harmony draws with..."; Flags: waituntilterminated; Check: NeedsWebView2
#endif
Filename: "{app}\Harmony.exe"; Parameters: "--updated"; Flags: nowait; Check: ShouldRelaunch
Filename: "{app}\Harmony.exe"; Description: "Open Harmony"; Flags: nowait postinstall skipifsilent; Check: not ShouldRelaunch

[Code]
function HasParam(const Name: String): Boolean;
var
  I: Integer;
begin
  Result := False;
  for I := 1 to ParamCount do
    if CompareText(ParamStr(I), Name) = 0 then
      Result := True;
end;

function ShouldRelaunch: Boolean;
begin
  Result := HasParam('/RELAUNCH');
end;

{ Harmony's window uses Microsoft's WebView2 runtime (built into Windows 11 and current Windows 10). }
function HasWebView2Key(Root: Integer; const Key: String): Boolean;
var
  Version: String;
begin
  Result := RegQueryStringValue(Root, Key, 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0');
end;

function NeedsWebView2: Boolean;
var
  Client: String;
begin
  Client := 'Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  Result := not (HasWebView2Key(HKLM, 'SOFTWARE\WOW6432Node\' + Client)
    or HasWebView2Key(HKLM, 'SOFTWARE\' + Client)
    or HasWebView2Key(HKCU, 'Software\' + Client));
end;

{ Give a Harmony that just launched us a moment to close on its own. }
function InitializeSetup: Boolean;
var
  Tries: Integer;
begin
  Tries := 0;
  while CheckForMutexes('Local\HarmonyClient') and (Tries < 30) do
  begin
    Sleep(500);
    Tries := Tries + 1;
  end;
  Result := True;
end;
