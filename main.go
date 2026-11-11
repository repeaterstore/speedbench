package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"sync"
	"time"
)

type resultStore struct {
	mu   sync.Mutex
	path string
	list []map[string]any
}

func openResults(path string) (*resultStore, error) {
	rs := &resultStore{path: path}
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return rs, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		var m map[string]any
		if json.Unmarshal(sc.Bytes(), &m) == nil {
			rs.list = append(rs.list, m)
		}
	}
	return rs, sc.Err()
}

func (rs *resultStore) add(m map[string]any) error {
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	rs.mu.Lock()
	defer rs.mu.Unlock()
	f, err := os.OpenFile(rs.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.Write(append(b, '\n')); err != nil {
		return err
	}
	rs.list = append(rs.list, m)
	return nil
}

func (rs *resultStore) recent(n int) []map[string]any {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	out := []map[string]any{}
	for i := len(rs.list) - 1; i >= 0 && len(out) < n; i-- {
		out = append(out, rs.list[i])
	}
	return out
}

func lanAddrs() []string {
	var out []string
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		if ip, ok := a.(*net.IPNet); ok && ip.IP.To4() != nil && !ip.IP.IsLoopback() {
			out = append(out, ip.IP.String())
		}
	}
	return out
}

func main() {
	port := flag.Int("port", 8080, "main port (web UI and API)")
	extra := flag.Int("data-ports", 4, "extra ports after -port for parallel streams (browsers allow ~6 connections per host:port)")
	resultsPath := flag.String("results", "results.jsonl", "file to append results to")
	flag.Parse()

	rs, err := openResults(*resultsPath)
	if err != nil {
		log.Fatal(err)
	}
	var dataPorts []int
	for i := 1; i <= *extra; i++ {
		dataPorts = append(dataPorts, *port+i)
	}
	s := newServer(rs, dataPorts)
	go s.sample(time.Second, nil)

	for _, p := range dataPorts {
		srv := &http.Server{Addr: fmt.Sprintf(":%d", p), Handler: s.dataHandler()}
		go func() { log.Fatal(srv.ListenAndServe()) }()
	}
	for _, a := range lanAddrs() {
		log.Printf("open http://%s:%d on any device on this network", a, *port)
	}
	log.Fatal((&http.Server{Addr: fmt.Sprintf(":%d", *port), Handler: s.handler()}).ListenAndServe())
}
