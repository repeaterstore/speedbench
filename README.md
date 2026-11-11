# SpeedBench

A self-hosted speed test for the local network: one Go binary with a mobile-first web UI. Any number of devices can test at once.

## Run

```sh
go run .            # or: go build -o speedbench . && ./speedbench
```

It prints `http://<lan-ip>:8080`; open that on any device on the network. Flags:

- `-port 8080`: web UI and API
- `-data-ports 4`: extra ports (8081–8084) used for parallel streams. Browsers allow only about 6 HTTP/1.1 connections per host:port, so streams are spread across these ports. Open them in the firewall too.
- `-results results.jsonl`: every finished test is appended here, with client IP, user agent and the optional device name.

Run the server on a **wired** machine with a link faster than anything you test; every simultaneous test shares that link.

## How it measures

The method follows what matched Ookla in the waveform-att-aia-app comparisons:

- **8 parallel streams**, with request sizes that adapt toward about 1 s per request.
- **5 s warm-up excluded**, then a **15 s measured window** per direction. All three are settings.
- **Headline = Ookla-style trimmed mean** by default: the measured window is cut into 250 ms slices, and the slowest 30 % and fastest 10 % are dropped before averaging. The plain average (all bytes in the window) and the median are shown underneath. A setting switches the headline to the plain average.
- **Upload is counted at the server.** The browser's upload progress counts bytes handed to its send buffer, so on deeply buffered links (CBRS/LTE) it reads high early and then sags. Here the client polls `/api/progress`, which reports bytes the server has actually received, stamped with the server's clock.
- **Download** is counted in the browser as bytes arrive.
- **Latency:** 20 idle pings (median and jitter), plus pings during each load phase after warm-up (latency under load).

The header shows how many tests are active and the server's total throughput, so you can see whether simultaneous tests are sharing the server, the access point or the radio.

## Test

```sh
go test ./...
node --test test/analysis.test.mjs
```
