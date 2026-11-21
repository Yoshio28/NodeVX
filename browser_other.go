//go:build !windows

package main

import (
	"log"
	"os"
	"os/exec"
	"runtime"
)

// openWindow (Linux/macOS, útil para desarrollo): intenta Chrome/Chromium/Edge
// en modo --app y si no, el navegador predeterminado.
func openWindow(url string) {
	if runtime.GOOS == "darwin" {
		for _, app := range []string{"Microsoft Edge", "Google Chrome"} {
			if exec.Command("open", "-na", app, "--args", appArgs(url)[0], appArgs(url)[1]).Start() == nil {
				return
			}
		}
		exec.Command("open", url).Start()
		return
	}
	for _, name := range []string{"microsoft-edge", "google-chrome", "chromium", "chromium-browser"} {
		if p, err := exec.LookPath(name); err == nil {
			cmd := exec.Command(p, appArgs(url)...)
			if cmd.Start() == nil {
				go cmd.Wait()
				return
			}
		}
	}
	if err := exec.Command("xdg-open", url).Start(); err != nil {
		log.Printf("abre manualmente: %s", url)
	}
}

func showError(title, msg string) {
	os.Stderr.WriteString(title + ": " + msg + "\n")
}
