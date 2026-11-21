@echo off
REM Compila NodeVX.exe en Windows. Requiere Go 1.22+ (https://go.dev/dl/).
cd /d "%~dp0"
if not exist dist mkdir dist
where rsrc >nul 2>nul || go install github.com/akavel/rsrc@v0.10.2
for /f "delims=" %%i in ('go env GOPATH') do set GOPATHDIR=%%i
"%GOPATHDIR%\bin\rsrc.exe" -ico assets\icon.ico -manifest assets\nodevx.manifest -arch amd64 -o rsrc_windows_amd64.syso
set GOOS=windows
set GOARCH=amd64
set CGO_ENABLED=0
go build -trimpath -ldflags "-H windowsgui -s -w" -o dist\NodeVX.exe .
echo Listo: dist\NodeVX.exe
