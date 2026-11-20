// NodeVX: espacio de trabajo de notas tipo wiki/bloques con bloc de notas rápidas.
//
// El ejecutable incrusta la interfaz web (carpeta web/), levanta un servidor
// HTTP solo en 127.0.0.1, guarda los datos como JSON en la carpeta de
// configuración del usuario (%APPDATA%\NodeVX en Windows) y abre una ventana
// de aplicación usando Microsoft Edge o Google Chrome en modo --app.
package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

//go:embed web
var webFS embed.FS

const (
	appName     = "NodeVX"
	defaultPort = 47821
	maxBody     = 64 << 20 // 64 MB
	keepBackups = 15
)

var (
	dataDir   string
	storeMu   sync.Mutex
	lastBeat  atomic.Int64 // unix nanos del último latido de la ventana
	byeAt     atomic.Int64 // unix nanos del último aviso de cierre
	validName = regexp.MustCompile(`^[a-z0-9_-]{1,40}$`)
	version   = "1.0.0"
)

func main() {
	port := flag.Int("port", defaultPort, "puerto local")
	noBrowser := flag.Bool("no-browser", false, "no abrir ventana; mantener el servidor activo")
	dirFlag := flag.String("data", "", "carpeta de datos (por defecto %APPDATA%\\NodeVX)")
	flag.Parse()

	dataDir = *dirFlag
	if dataDir == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			base = "."
		}
		dataDir = filepath.Join(base, appName)
	}
	if err := os.MkdirAll(filepath.Join(dataDir, "backups"), 0o755); err != nil {
		fatal("no se pudo crear la carpeta de datos: %v", err)
	}
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		existing := fmt.Sprintf("http://127.0.0.1:%d/", *port)
		if isRunningInstance(existing) {
			// Ya hay una instancia: solo abrimos otra ventana y salimos.
			log.Printf("instancia existente detectada, abriendo ventana")
			openWindow(existing)
			return
		}
		ln, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			fatal("no se pudo abrir un puerto local: %v", err)
		}
	}
	// Solo la instancia que sirve escribe el log.
	if lf, err := os.OpenFile(filepath.Join(dataDir, "nodevx.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644); err == nil {
		log.SetOutput(io.MultiWriter(lf, os.Stderr))
	}
	url := "http://" + ln.Addr().String() + "/"
	log.Printf("%s %s — datos en %s — sirviendo en %s", appName, version, dataDir, url)

	srv := &http.Server{Handler: routes(), ReadHeaderTimeout: 10 * time.Second}
	stop := make(chan struct{})
	var once sync.Once
	requestStop := func() { once.Do(func() { close(stop) }) }
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("servidor: %v", err)
			requestStop()
		}
	}()

	if !*noBrowser {
		openWindow(url)
		go watchdog(requestStop)
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt)
	go func() { <-sig; requestStop() }()

	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	srv.Shutdown(ctx) // espera a que terminen las peticiones en curso
	storeMu.Lock()    // y a cualquier escritura de datos
	storeMu.Unlock()
	log.Printf("cerrado")
}

func routes() http.Handler {
	mux := http.NewServeMux()
	sub, _ := fs.Sub(webFS, "web")
	static := http.FileServer(http.FS(sub))
	mux.Handle("/", noCache(static))

	mux.HandleFunc("GET /api/ping", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]string{"app": appName, "version": version})
	})
	mux.HandleFunc("GET /api/info", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]string{"app": appName, "version": version, "dataDir": dataDir})
	})
	mux.HandleFunc("POST /api/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		lastBeat.Store(time.Now().UnixNano())
		byeAt.Store(0)
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /api/bye", func(w http.ResponseWriter, r *http.Request) {
		byeAt.Store(time.Now().UnixNano())
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("GET /api/store/{name}", getStore)
	mux.HandleFunc("PUT /api/store/{name}", putStore)
	mux.HandleFunc("POST /api/store/{name}", putStore) // para navigator.sendBeacon
	return mux
}

func storePath(name string) string { return filepath.Join(dataDir, name+".json") }

func getStore(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if !validName.MatchString(name) {
		http.Error(w, "nombre inválido", http.StatusBadRequest)
		return
	}
	storeMu.Lock()
	b, err := os.ReadFile(storePath(name))
	storeMu.Unlock()
	if errors.Is(err, os.ErrNotExist) {
		w.WriteHeader(http.StatusNoContent) // todavía no hay datos guardados
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(b)
}

func putStore(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if !validName.MatchString(name) {
		http.Error(w, "nombre inválido", http.StatusBadRequest)
		return
	}
	b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil {
		http.Error(w, "cuerpo demasiado grande", http.StatusRequestEntityTooLarge)
		return
	}
	if !json.Valid(b) {
		http.Error(w, "JSON inválido", http.StatusBadRequest)
		return
	}
	storeMu.Lock()
	defer storeMu.Unlock()
	path := storePath(name)
	backupDaily(name, path)
	if err := writeAtomic(path, b); err != nil {
		log.Printf("guardar %s: %v", name, err)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// writeAtomic escribe en un archivo temporal y lo renombra encima del destino,
// así un corte de luz nunca deja el JSON a medias.
func writeAtomic(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	return os.Rename(tmpName, path)
}

// backupDaily guarda una copia del archivo actual una vez al día y conserva las últimas N.
func backupDaily(name, path string) {
	cur, err := os.ReadFile(path)
	if err != nil {
		return
	}
	dir := filepath.Join(dataDir, "backups")
	dst := filepath.Join(dir, fmt.Sprintf("%s-%s.json", name, time.Now().Format("2006-01-02")))
	if _, err := os.Stat(dst); err == nil {
		return
	}
	if err := os.WriteFile(dst, cur, 0o644); err != nil {
		log.Printf("copia de seguridad: %v", err)
		return
	}
	matches, _ := filepath.Glob(filepath.Join(dir, name+"-*.json"))
	sort.Strings(matches)
	for len(matches) > keepBackups {
		os.Remove(matches[0])
		matches = matches[1:]
	}
}

// watchdog apaga el servidor cuando la ventana se cierra.
func watchdog(stop func()) {
	start := time.Now()
	for range time.Tick(time.Second) {
		now := time.Now()
		beat := lastBeat.Load()
		bye := byeAt.Load()
		switch {
		case bye != 0 && now.Sub(time.Unix(0, bye)) > 6*time.Second:
			log.Printf("ventana cerrada")
		case beat == 0 && now.Sub(start) > 3*time.Minute:
			log.Printf("la ventana nunca se conectó")
		case beat != 0 && now.Sub(time.Unix(0, beat)) > 3*time.Minute:
			log.Printf("sin latidos de la ventana")
		default:
			continue
		}
		stop()
		return
	}
}

func isRunningInstance(url string) bool {
	c := http.Client{Timeout: 2 * time.Second}
	resp, err := c.Get(url + "api/ping")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	var v map[string]string
	if json.NewDecoder(resp.Body).Decode(&v) != nil {
		return false
	}
	return v["app"] == appName
}

func noCache(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		h.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(v)
}

func fatal(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	log.Print(msg)
	showError(appName, msg)
	os.Exit(1)
}

// browserProfileDir es un perfil aislado para que la ventana de la app sea
// independiente del navegador habitual del usuario.
func browserProfileDir() string {
	return filepath.Join(dataDir, "ventana")
}

func appArgs(url string) []string {
	return []string{
		"--app=" + url,
		"--user-data-dir=" + browserProfileDir(),
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-features=Translate",
		"--window-size=1280,840",
	}
}
