// Command relay is the Phase 0 WebSocket-to-TCP relay.
//
// It forwards opaque bytes between a browser WebSocket and a TCP endpoint. It
// never sees plaintext: the SSH handshake and all encryption happen inside the
// browser's WASM SSH client, so this process only ever handles ciphertext.
//
// The production relay will be Rust (see PLAN.md §4). This one exists to
// de-risk the WASM client, and doubles as the static file server for the
// harness.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

var (
	addr         = flag.String("addr", ":8080", "listen address")
	webRoot      = flag.String("web", "spike/web", "static files to serve")
	allowedPorts = flag.String("ports", "22", "comma-separated destination ports")
	allowPrivate = flag.Bool("allow-private", false, "DEV ONLY: permit RFC1918/loopback destinations")
	dialTimeout  = flag.Duration("dial-timeout", 10*time.Second, "TCP dial timeout")

	connSeq atomic.Uint64
)

func main() {
	flag.Parse()

	ports := parsePorts(*allowedPorts)
	if *allowPrivate {
		log.Printf("WARNING: -allow-private is set. Private and loopback destinations are reachable. Never do this in production.")
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		handleWS(w, r, ports)
	})
	mux.Handle("/", http.FileServer(http.Dir(*webRoot)))

	log.Printf("relay listening on %s, serving %s, allowed ports %v", *addr, *webRoot, ports)
	srv := &http.Server{
		Addr:              *addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Fatal(srv.ListenAndServe())
}

func parsePorts(s string) map[int]bool {
	out := map[int]bool{}
	for p := range strings.SplitSeq(s, ",") {
		if n, err := strconv.Atoi(strings.TrimSpace(p)); err == nil {
			out[n] = true
		}
	}
	return out
}

func handleWS(w http.ResponseWriter, r *http.Request, ports map[int]bool) {
	id := connSeq.Add(1)

	host := r.URL.Query().Get("host")
	port, err := strconv.Atoi(r.URL.Query().Get("port"))
	if err != nil || host == "" {
		http.Error(w, "host and port required", http.StatusBadRequest)
		return
	}
	if !ports[port] {
		http.Error(w, "destination port not allowed", http.StatusForbidden)
		return
	}

	// Resolve first and validate every answer, then dial the specific IP we
	// approved. Dialing the hostname again would reopen a DNS-rebinding window
	// between the check and the connect.
	ip, err := resolveAndVet(r.Context(), host)
	if err != nil {
		log.Printf("[%d] rejected %s:%d: %v", id, host, port, err)
		http.Error(w, err.Error(), http.StatusForbidden)
		return
	}

	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Phase 0 harness is served from this same origin; production must
		// pin OriginPatterns and require an authenticated session.
		InsecureSkipVerify: true,
	})
	if err != nil {
		log.Printf("[%d] ws accept: %v", id, err)
		return
	}
	defer c.CloseNow()
	c.SetReadLimit(-1) // SSH streams are long-lived; no message cap

	target := net.JoinHostPort(ip.String(), strconv.Itoa(port))
	tcp, err := net.DialTimeout("tcp", target, *dialTimeout)
	if err != nil {
		log.Printf("[%d] dial %s: %v", id, target, err)
		c.Close(websocket.StatusInternalError, "dial failed")
		return
	}
	defer tcp.Close()

	log.Printf("[%d] open %s -> %s", id, r.RemoteAddr, target)
	start := time.Now()
	up, down := pump(r.Context(), c, tcp)
	log.Printf("[%d] close %s after %s (up %d B, down %d B)", id, target, time.Since(start).Round(time.Millisecond), up, down)
}

// pump copies bytes in both directions until either side closes, and reports
// the byte counts. The relay treats the payload as opaque.
func pump(ctx context.Context, c *websocket.Conn, tcp net.Conn) (up, down int64) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	// NetConn gives us a net.Conn view of the WebSocket, so both directions are
	// a plain io.Copy over binary frames.
	ws := websocket.NetConn(ctx, c, websocket.MessageBinary)

	var upN, downN atomic.Int64
	errc := make(chan error, 2)
	go func() {
		n, err := io.Copy(tcp, ws)
		upN.Store(n)
		if t, ok := tcp.(*net.TCPConn); ok {
			t.CloseWrite() // half-close so the server sees EOF, not a reset
		}
		errc <- err
	}()
	go func() {
		n, err := io.Copy(ws, tcp)
		downN.Store(n)
		errc <- err
	}()

	err := <-errc
	cancel()
	<-errc

	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, context.Canceled) {
		log.Printf("pump: %v", err)
	}
	return upN.Load(), downN.Load()
}

// resolveAndVet resolves host and returns the first address that passes the
// SSRF guard. A relay that will dial arbitrary hosts on request is an SSRF
// cannon by default; this is the safety catch, not a nicety.
func resolveAndVet(ctx context.Context, host string) (net.IP, error) {
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, fmt.Errorf("resolve %s: %w", host, err)
	}
	if len(ips) == 0 {
		return nil, fmt.Errorf("resolve %s: no addresses", host)
	}
	for _, a := range ips {
		if err := vetIP(a.IP); err != nil {
			// Reject the whole hostname if any answer is bad, so a DNS record
			// mixing a public and a private address can't sneak through.
			return nil, err
		}
	}
	return ips[0].IP, nil
}

func vetIP(ip net.IP) error {
	if *allowPrivate {
		return nil
	}
	switch {
	case ip.IsLoopback():
		return fmt.Errorf("destination %s is loopback", ip)
	case ip.IsPrivate():
		return fmt.Errorf("destination %s is a private address", ip)
	case ip.IsLinkLocalUnicast(), ip.IsLinkLocalMulticast():
		return fmt.Errorf("destination %s is link-local", ip)
	case ip.IsUnspecified():
		return fmt.Errorf("destination %s is unspecified", ip)
	case ip.IsMulticast():
		return fmt.Errorf("destination %s is multicast", ip)
	case isCloudMetadata(ip):
		return fmt.Errorf("destination %s is a cloud metadata endpoint", ip)
	case ip.IsInterfaceLocalMulticast():
		return fmt.Errorf("destination %s is interface-local", ip)
	}
	// Carrier-grade NAT 100.64.0.0/10 — not covered by IsPrivate.
	if ip4 := ip.To4(); ip4 != nil && ip4[0] == 100 && ip4[1]&0xc0 == 64 {
		return fmt.Errorf("destination %s is in the CGNAT range", ip)
	}
	return nil
}

func isCloudMetadata(ip net.IP) bool {
	// 169.254.169.254 (AWS/GCP/Azure/DO) and fd00:ec2::254 (AWS IMDSv6).
	// Already covered by the link-local checks, but named explicitly because
	// this is the address that turns an SSRF into a credential leak.
	return ip.Equal(net.ParseIP("169.254.169.254")) || ip.Equal(net.ParseIP("fd00:ec2::254"))
}
