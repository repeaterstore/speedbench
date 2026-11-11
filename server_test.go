package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newTestServer(t *testing.T) (*server, *httptest.Server) {
	rs, err := openResults(filepath.Join(t.TempDir(), "r.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	s := newServer(rs, nil)
	ts := httptest.NewServer(s.handler())
	t.Cleanup(ts.Close)
	return s, ts
}

func progress(t *testing.T, base, sid string) int64 {
	r, err := http.Get(base + "/api/progress?sid=" + sid)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	var p struct{ UpBytes int64 }
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		t.Fatal(err)
	}
	return p.UpBytes
}

// Upload progress must reflect only bytes the server has actually received,
// while the request is still in flight — this is what stops a client-side
// send buffer from inflating the upload result.
func TestUploadCountsOnlyReceivedBytesWhileInFlight(t *testing.T) {
	_, ts := newTestServer(t)
	pr, pw := io.Pipe()
	done := make(chan struct{})
	go func() {
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/up?sid=a", pr)
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			resp.Body.Close()
		}
		close(done)
	}()
	if _, err := pw.Write(make([]byte, 300_000)); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for progress(t, ts.URL, "a") != 300_000 {
		if time.Now().After(deadline) {
			t.Fatalf("in-flight progress = %d, want 300000", progress(t, ts.URL, "a"))
		}
		time.Sleep(10 * time.Millisecond)
	}
	pw.Write(make([]byte, 200_000))
	pw.Close()
	<-done
	if got := progress(t, ts.URL, "a"); got != 500_000 {
		t.Fatalf("final progress = %d, want 500000", got)
	}
}

func TestSessionsAreSeparate(t *testing.T) {
	_, ts := newTestServer(t)
	for sid, n := range map[string]int{"x": 1000, "y": 5000} {
		r, err := http.Post(ts.URL+"/api/up?sid="+sid, "application/octet-stream", strings.NewReader(strings.Repeat("a", n)))
		if err != nil {
			t.Fatal(err)
		}
		r.Body.Close()
	}
	if progress(t, ts.URL, "x") != 1000 || progress(t, ts.URL, "y") != 5000 {
		t.Fatal("sessions mixed up")
	}
}

func TestDownloadReturnsExactBytes(t *testing.T) {
	_, ts := newTestServer(t)
	r, err := http.Get(ts.URL + "/api/down?sid=d&bytes=2500000")
	if err != nil {
		t.Fatal(err)
	}
	n, _ := io.Copy(io.Discard, r.Body)
	r.Body.Close()
	if n != 2_500_000 {
		t.Fatalf("got %d bytes", n)
	}
	if r2, _ := http.Get(ts.URL + "/api/down?bytes=10"); r2.StatusCode != 400 {
		t.Fatalf("missing sid should be 400, got %d", r2.StatusCode)
	}
}

func TestResultsPersistAndReload(t *testing.T) {
	path := filepath.Join(t.TempDir(), "r.jsonl")
	rs, _ := openResults(path)
	ts := httptest.NewServer(newServer(rs, nil).handler())
	defer ts.Close()
	r, _ := http.Post(ts.URL+"/api/results", "application/json", strings.NewReader(`{"device":"phone"}`))
	r.Body.Close()
	again, err := openResults(path)
	if err != nil || len(again.recent(10)) != 1 || again.recent(10)[0]["device"] != "phone" {
		t.Fatalf("reload failed: %v %v", err, again.recent(10))
	}
}
