package main

import (
	"crypto/rand"
	"embed"
	"encoding/json"
	"io"
	"io/fs"
	"net"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

//go:embed web
var webFS embed.FS

const (
	maxDownBytes = 4 << 30 // per request
	maxUpBytes   = 4 << 30
	chunkSize    = 1 << 20
	sessionTTL   = 2 * time.Minute
)

// session tracks one client's test. Upload bytes are counted here, as they
// arrive at the server, so the browser's send-buffer progress never inflates
// the result.
type session struct {
	upBytes  atomic.Int64
	lastSeen atomic.Int64 // unix nanos
}

type server struct {
	start      time.Time
	random     []byte
	mu         sync.Mutex
	sessions   map[string]*session
	totalDown  atomic.Int64
	totalUp    atomic.Int64
	liveMu     sync.Mutex
	liveDown   float64 // Mbps over the last sampling interval
	liveUp     float64
	results    *resultStore
	dataPorts  []int
}

func newServer(results *resultStore, dataPorts []int) *server {
	buf := make([]byte, chunkSize)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	return &server{start: time.Now(), random: buf, sessions: map[string]*session{}, results: results, dataPorts: dataPorts}
}

// nowMs is a monotonic server clock, used to timestamp upload progress.
func (s *server) nowMs() float64 {
	return float64(time.Since(s.start).Microseconds()) / 1000
}

func (s *server) session(id string, create bool) *session {
	if id == "" || len(id) > 64 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	ss := s.sessions[id]
	if ss == nil && create {
		ss = &session{}
		s.sessions[id] = ss
	}
	if ss != nil {
		ss.lastSeen.Store(time.Now().UnixNano())
	}
	return ss
}

func (s *server) activeSessions() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	cutoff := time.Now().Add(-5 * time.Second).UnixNano()
	n := 0
	for _, ss := range s.sessions {
		if ss.lastSeen.Load() > cutoff {
			n++
		}
	}
	return n
}

// sample computes server-wide throughput once per interval and expires idle sessions.
func (s *server) sample(interval time.Duration, stop <-chan struct{}) {
	t := time.NewTicker(interval)
	defer t.Stop()
	lastDown, lastUp, last := s.totalDown.Load(), s.totalUp.Load(), time.Now()
	for {
		select {
		case <-stop:
			return
		case now := <-t.C:
			d, u := s.totalDown.Load(), s.totalUp.Load()
			secs := now.Sub(last).Seconds()
			s.liveMu.Lock()
			s.liveDown = float64(d-lastDown) * 8 / secs / 1e6
			s.liveUp = float64(u-lastUp) * 8 / secs / 1e6
			s.liveMu.Unlock()
			lastDown, lastUp, last = d, u, now
			cutoff := now.Add(-sessionTTL).UnixNano()
			s.mu.Lock()
			for id, ss := range s.sessions {
				if ss.lastSeen.Load() < cutoff {
					delete(s.sessions, id)
				}
			}
			s.mu.Unlock()
		}
	}
}

func noStore(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Cache-Control", "no-store, no-transform")
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	h.Set("Access-Control-Allow-Headers", "Content-Type")
}

func writeJSON(w http.ResponseWriter, v any) {
	noStore(w)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// dataHandler serves only the transfer endpoints. It is mounted on the main
// port and on each extra data port, so browsers can open more than their
// per-host connection limit (6 for HTTP/1.1) by spreading streams over ports.
func (s *server) dataHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/down", s.handleDown)
	mux.HandleFunc("/api/up", s.handleUp)
	mux.HandleFunc("/api/ping", s.handlePing)
	return mux
}

func (s *server) handler() http.Handler {
	mux := http.NewServeMux()
	data := s.dataHandler()
	mux.Handle("/api/down", data)
	mux.Handle("/api/up", data)
	mux.Handle("/api/ping", data)
	mux.HandleFunc("/api/progress", s.handleProgress)
	mux.HandleFunc("/api/config", s.handleConfig)
	mux.HandleFunc("/api/live", s.handleLive)
	mux.HandleFunc("/api/results", s.handleResults)
	sub, _ := fs.Sub(webFS, "web")
	files := http.FileServer(http.FS(sub))
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		files.ServeHTTP(w, r)
	}))
	return mux
}

func (s *server) handlePing(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) handleDown(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	if r.Method == http.MethodOptions {
		return
	}
	n, err := strconv.ParseInt(r.URL.Query().Get("bytes"), 10, 64)
	if err != nil || n < 0 || n > maxDownBytes {
		http.Error(w, "bad bytes", http.StatusBadRequest)
		return
	}
	if ss := s.session(r.URL.Query().Get("sid"), true); ss == nil {
		http.Error(w, "missing sid", http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(n, 10))
	for n > 0 {
		c := int64(len(s.random))
		if n < c {
			c = n
		}
		m, err := w.Write(s.random[:c])
		s.totalDown.Add(int64(m))
		if err != nil {
			return
		}
		n -= int64(m)
	}
}

func (s *server) handleUp(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	if r.Method == http.MethodOptions {
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	ss := s.session(r.URL.Query().Get("sid"), true)
	if ss == nil {
		http.Error(w, "missing sid", http.StatusBadRequest)
		return
	}
	body := http.MaxBytesReader(w, r.Body, maxUpBytes)
	buf := make([]byte, 64<<10)
	for {
		m, err := body.Read(buf)
		if m > 0 {
			ss.upBytes.Add(int64(m))
			s.totalUp.Add(int64(m))
			ss.lastSeen.Store(time.Now().UnixNano())
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleProgress reports bytes received for a session, stamped with the server clock.
func (s *server) handleProgress(w http.ResponseWriter, r *http.Request) {
	ss := s.session(r.URL.Query().Get("sid"), true)
	if ss == nil {
		http.Error(w, "missing sid", http.StatusBadRequest)
		return
	}
	writeJSON(w, map[string]any{"t": s.nowMs(), "upBytes": ss.upBytes.Load()})
}

func (s *server) handleConfig(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]any{"dataPorts": s.dataPorts})
}

func (s *server) handleLive(w http.ResponseWriter, r *http.Request) {
	s.liveMu.Lock()
	d, u := s.liveDown, s.liveUp
	s.liveMu.Unlock()
	writeJSON(w, map[string]any{"activeTests": s.activeSessions(), "downMbps": d, "upMbps": u})
}

func (s *server) handleResults(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, s.results.recent(50))
	case http.MethodPost:
		var res map[string]any
		if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&res); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		host, _, _ := net.SplitHostPort(r.RemoteAddr)
		res["clientIp"] = host
		res["userAgent"] = r.UserAgent()
		res["time"] = time.Now().Format(time.RFC3339)
		if err := s.results.add(res); err != nil {
			http.Error(w, "store failed", http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]any{"ok": true})
	default:
		http.Error(w, "method", http.StatusMethodNotAllowed)
	}
}
