//go:build windows

package main

import (
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"
)

// openWindow abre la app en una ventana propia de Edge o Chrome (modo --app).
// Si no encuentra ninguno, usa el navegador predeterminado.
func openWindow(url string) {
	for _, exe := range browserCandidates() {
		if _, err := os.Stat(exe); err != nil {
			continue
		}
		cmd := exec.Command(exe, appArgs(url)...)
		if err := cmd.Start(); err == nil {
			log.Printf("ventana abierta con %s", exe)
			go cmd.Wait()
			return
		}
	}
	log.Printf("Edge/Chrome no encontrado; usando navegador predeterminado")
	cmd := exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err := cmd.Start(); err != nil {
		showError(appName, "No se pudo abrir el navegador.\nAbre manualmente: "+url)
	}
}

func browserCandidates() []string {
	var out []string
	roots := []string{os.Getenv("ProgramFiles(x86)"), os.Getenv("ProgramFiles"), os.Getenv("LocalAppData")}
	rels := []string{
		`Microsoft\Edge\Application\msedge.exe`,
		`Google\Chrome\Application\chrome.exe`,
		`BraveSoftware\Brave-Browser\Application\brave.exe`,
		`Chromium\Application\chrome.exe`,
	}
	for _, rel := range rels {
		for _, root := range roots {
			if root != "" {
				out = append(out, filepath.Join(root, rel))
			}
		}
	}
	return out
}

func showError(title, msg string) {
	user32 := syscall.NewLazyDLL("user32.dll")
	box := user32.NewProc("MessageBoxW")
	t, _ := syscall.UTF16PtrFromString(title)
	m, _ := syscall.UTF16PtrFromString(msg)
	box.Call(0, uintptr(unsafe.Pointer(m)), uintptr(unsafe.Pointer(t)), 0x10)
}
