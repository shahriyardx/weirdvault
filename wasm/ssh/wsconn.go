//go:build js && wasm

package main

import (
	"bytes"
	"errors"
	"io"
	"net"
	"sync"
	"syscall/js"
	"time"
)

// wsConn adapts a browser WebSocket to net.Conn so x/crypto/ssh can run its
// transport over it. A browser cannot open a TCP socket, so the relay bridges
// WebSocket to TCP — but the SSH encryption terminates here, inside the tab,
// which is what keeps the relay unable to read anything.
type wsConn struct {
	ws js.Value

	mu     sync.Mutex
	buf    bytes.Buffer
	notify chan struct{} // capacity 1; signals "buffer changed"

	closeOnce sync.Once
	closed    chan struct{}
	closeErr  error

	funcs []js.Func
}

var errConnClosed = errors.New("websocket closed")

func dialWS(url string) (*wsConn, error) {
	ws := js.Global().Get("WebSocket").New(url)
	ws.Set("binaryType", "arraybuffer")

	c := &wsConn{
		ws:     ws,
		notify: make(chan struct{}, 1),
		closed: make(chan struct{}),
	}

	opened := make(chan error, 1)

	onOpen := js.FuncOf(func(js.Value, []js.Value) any {
		select {
		case opened <- nil:
		default:
		}
		return nil
	})
	onMessage := js.FuncOf(func(_ js.Value, args []js.Value) any {
		// Must never block: this runs on the JS event loop, and blocking here
		// while a goroutine awaits a promise would deadlock the whole runtime.
		// Hence an unbounded buffer plus a non-blocking signal.
		b := toGoBytes(args[0].Get("data"))
		if len(b) == 0 {
			return nil
		}
		c.mu.Lock()
		c.buf.Write(b)
		c.mu.Unlock()
		c.signal()
		return nil
	})
	onError := js.FuncOf(func(js.Value, []js.Value) any {
		err := errors.New("websocket error (relay unreachable or refused)")
		select {
		case opened <- err:
		default:
		}
		c.shutdown(err)
		return nil
	})
	onClose := js.FuncOf(func(_ js.Value, args []js.Value) any {
		err := errConnClosed
		if len(args) > 0 {
			if reason := args[0].Get("reason"); !reason.IsUndefined() && reason.String() != "" {
				err = errors.New("websocket closed: " + reason.String())
			}
		}
		select {
		case opened <- err:
		default:
		}
		c.shutdown(err)
		return nil
	})

	c.funcs = []js.Func{onOpen, onMessage, onError, onClose}
	ws.Call("addEventListener", "open", onOpen)
	ws.Call("addEventListener", "message", onMessage)
	ws.Call("addEventListener", "error", onError)
	ws.Call("addEventListener", "close", onClose)

	if err := <-opened; err != nil {
		c.Close()
		return nil, err
	}
	return c, nil
}

// CloseReason reports why the relay hung up, if it said. The SSH handshake
// error on its own is just "EOF", which tells the user nothing.
func (c *wsConn) CloseReason() error {
	select {
	case <-c.closed:
		if c.closeErr != nil && !errors.Is(c.closeErr, errConnClosed) {
			return c.closeErr
		}
	default:
	}
	return nil
}

func (c *wsConn) signal() {
	select {
	case c.notify <- struct{}{}:
	default:
	}
}

func (c *wsConn) shutdown(err error) {
	c.closeOnce.Do(func() {
		c.closeErr = err
		close(c.closed)
	})
	c.signal() // wake any blocked Read
}

func (c *wsConn) Read(p []byte) (int, error) {
	for {
		c.mu.Lock()
		if c.buf.Len() > 0 {
			n, _ := c.buf.Read(p)
			c.mu.Unlock()
			return n, nil
		}
		c.mu.Unlock()

		select {
		case <-c.notify:
			// buffer may have data now; loop
		case <-c.closed:
			// Drain anything that landed before the close.
			c.mu.Lock()
			if c.buf.Len() > 0 {
				n, _ := c.buf.Read(p)
				c.mu.Unlock()
				return n, nil
			}
			c.mu.Unlock()
			if c.closeErr != nil && !errors.Is(c.closeErr, errConnClosed) {
				return 0, c.closeErr
			}
			return 0, io.EOF
		}
	}
}

func (c *wsConn) Write(p []byte) (int, error) {
	select {
	case <-c.closed:
		return 0, c.closeErr
	default:
	}
	if c.ws.Get("readyState").Int() != 1 { // 1 == OPEN
		return 0, errConnClosed
	}
	c.ws.Call("send", toUint8Array(p))
	return len(p), nil
}

func (c *wsConn) Close() error {
	c.shutdown(errConnClosed)
	if c.ws.Get("readyState").Int() <= 1 { // CONNECTING or OPEN
		c.ws.Call("close")
	}
	for _, f := range c.funcs {
		f.Release()
	}
	c.funcs = nil
	return nil
}

type wsAddr struct{}

func (wsAddr) Network() string { return "websocket" }
func (wsAddr) String() string  { return "webxterm-relay" }

func (c *wsConn) LocalAddr() net.Addr  { return wsAddr{} }
func (c *wsConn) RemoteAddr() net.Addr { return wsAddr{} }

// Deadlines are unused: x/crypto/ssh sets none, and the browser gives us no
// way to interrupt a socket read anyway. Closing the conn is the cancel path.
func (c *wsConn) SetDeadline(time.Time) error      { return nil }
func (c *wsConn) SetReadDeadline(time.Time) error  { return nil }
func (c *wsConn) SetWriteDeadline(time.Time) error { return nil }
