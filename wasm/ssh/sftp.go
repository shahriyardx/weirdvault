//go:build js && wasm

package main

import (
	"fmt"
	"io"
	"io/fs"
	"path"
	"sort"
	"syscall/js"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// SFTP runs over the same SSH connection as the shell, which is what makes
// "file explorer attached to every session" free rather than a second login.
//
// Transfers stream in both directions instead of buffering: a browser tab has
// no business holding a multi-gigabyte file in memory, so uploads pull chunks
// from a JS callback and downloads push chunks to one, with the promise
// returned by the callback providing backpressure.

const chunkSize = 256 << 10

type sftpSession struct {
	client *sftp.Client
	funcs  []js.Func
}

func newSFTP(client *ssh.Client) (*sftpSession, error) {
	// MaxPacket tuned up from the 32 KB default; the round trip through the
	// relay makes small packets expensive.
	c, err := sftp.NewClient(client, sftp.MaxPacket(1<<15), sftp.UseConcurrentReads(true), sftp.UseConcurrentWrites(true))
	if err != nil {
		return nil, fmt.Errorf("start sftp subsystem: %w", err)
	}
	return &sftpSession{client: c}, nil
}

func (s *sftpSession) handle() js.Value {
	mk := func(fn func(args []js.Value) (any, error)) js.Func {
		f := js.FuncOf(func(_ js.Value, args []js.Value) any {
			return newPromise(func(resolve, reject func(any)) {
				go func() {
					v, err := fn(args)
					if err != nil {
						reject(err.Error())
						return
					}
					resolve(v)
				}()
			})
		})
		s.funcs = append(s.funcs, f)
		return f
	}

	return js.ValueOf(map[string]any{
		"list":     mk(s.list),
		"stat":     mk(s.stat),
		"mkdir":    mk(s.mkdir),
		"remove":   mk(s.remove),
		"rename":   mk(s.rename),
		"chmod":    mk(s.chmod),
		"realpath": mk(s.realpath),
		"download": mk(s.download),
		"upload":   mk(s.upload),
	})
}

func (s *sftpSession) close() {
	s.client.Close()
	for _, f := range s.funcs {
		f.Release()
	}
	s.funcs = nil
}

func argPath(args []js.Value, i int) (string, error) {
	if len(args) <= i || args[i].Type() != js.TypeString {
		return "", fmt.Errorf("argument %d must be a path string", i)
	}
	return args[i].String(), nil
}

func entryToJS(name string, fi fs.FileInfo) map[string]any {
	return map[string]any{
		"name":    name,
		"size":    float64(fi.Size()),
		"mode":    fi.Mode().String(),
		"modTime": float64(fi.ModTime().UnixMilli()),
		"isDir":   fi.IsDir(),
		"isLink":  fi.Mode()&fs.ModeSymlink != 0,
	}
}

func (s *sftpSession) list(args []js.Value) (any, error) {
	dir, err := argPath(args, 0)
	if err != nil {
		return nil, err
	}
	entries, err := s.client.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("list %s: %w", dir, err)
	}
	// Directories first, then name order — the ordering every file manager uses.
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].IsDir() != entries[j].IsDir() {
			return entries[i].IsDir()
		}
		return entries[i].Name() < entries[j].Name()
	})
	out := make([]any, 0, len(entries))
	for _, e := range entries {
		out = append(out, entryToJS(e.Name(), e))
	}
	return map[string]any{"path": dir, "entries": out}, nil
}

func (s *sftpSession) stat(args []js.Value) (any, error) {
	p, err := argPath(args, 0)
	if err != nil {
		return nil, err
	}
	fi, err := s.client.Stat(p)
	if err != nil {
		return nil, fmt.Errorf("stat %s: %w", p, err)
	}
	return entryToJS(path.Base(p), fi), nil
}

func (s *sftpSession) mkdir(args []js.Value) (any, error) {
	p, err := argPath(args, 0)
	if err != nil {
		return nil, err
	}
	if err := s.client.MkdirAll(p); err != nil {
		return nil, fmt.Errorf("mkdir %s: %w", p, err)
	}
	return true, nil
}

func (s *sftpSession) remove(args []js.Value) (any, error) {
	p, err := argPath(args, 0)
	if err != nil {
		return nil, err
	}
	fi, err := s.client.Stat(p)
	if err != nil {
		return nil, fmt.Errorf("remove %s: %w", p, err)
	}
	if fi.IsDir() {
		err = s.client.RemoveDirectory(p)
	} else {
		err = s.client.Remove(p)
	}
	if err != nil {
		return nil, fmt.Errorf("remove %s: %w", p, err)
	}
	return true, nil
}

func (s *sftpSession) rename(args []js.Value) (any, error) {
	from, err := argPath(args, 0)
	if err != nil {
		return nil, err
	}
	to, err := argPath(args, 1)
	if err != nil {
		return nil, err
	}
	if err := s.client.Rename(from, to); err != nil {
		return nil, fmt.Errorf("rename %s -> %s: %w", from, to, err)
	}
	return true, nil
}

func (s *sftpSession) chmod(args []js.Value) (any, error) {
	p, err := argPath(args, 0)
	if err != nil {
		return nil, err
	}
	if len(args) < 2 || args[1].Type() != js.TypeNumber {
		return nil, fmt.Errorf("mode must be a number")
	}
	if err := s.client.Chmod(p, fs.FileMode(args[1].Int())); err != nil {
		return nil, fmt.Errorf("chmod %s: %w", p, err)
	}
	return true, nil
}

func (s *sftpSession) realpath(args []js.Value) (any, error) {
	p, err := argPath(args, 0)
	if err != nil {
		return nil, err
	}
	rp, err := s.client.RealPath(p)
	if err != nil {
		return nil, fmt.Errorf("realpath %s: %w", p, err)
	}
	return rp, nil
}

// download streams a remote file to a JS sink.
//
//	download(path, onChunk) where onChunk(Uint8Array) may return a Promise;
//	awaiting it is what stops us from outrunning a slow disk writer.
func (s *sftpSession) download(args []js.Value) (any, error) {
	p, err := argPath(args, 0)
	if err != nil {
		return nil, err
	}
	if len(args) < 2 || args[1].Type() != js.TypeFunction {
		return nil, fmt.Errorf("download(path, onChunk) requires a callback")
	}
	sink := args[1]

	f, err := s.client.Open(p)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", p, err)
	}
	defer f.Close()

	start := time.Now()
	n, err := io.CopyBuffer(&jsPushWriter{fn: sink}, f, make([]byte, chunkSize))
	if err != nil {
		return nil, fmt.Errorf("download %s: %w", p, err)
	}
	return transferResult(n, start), nil
}

// upload streams a remote file from a JS source.
//
//	upload(path, next) where next() returns Promise<Uint8Array|null>; null ends
//	the stream. The browser side reads from File.stream(), so a 4 GB upload
//	never exists in memory as a whole.
func (s *sftpSession) upload(args []js.Value) (any, error) {
	p, err := argPath(args, 0)
	if err != nil {
		return nil, err
	}
	if len(args) < 2 || args[1].Type() != js.TypeFunction {
		return nil, fmt.Errorf("upload(path, next) requires a callback")
	}
	src := args[1]

	f, err := s.client.Create(p)
	if err != nil {
		return nil, fmt.Errorf("create %s: %w", p, err)
	}
	defer f.Close()

	start := time.Now()
	n, err := io.CopyBuffer(f, &jsPullReader{fn: src}, make([]byte, chunkSize))
	if err != nil {
		return nil, fmt.Errorf("upload %s: %w", p, err)
	}
	return transferResult(n, start), nil
}

func transferResult(n int64, start time.Time) map[string]any {
	ms := float64(time.Since(start).Microseconds()) / 1000
	mbps := 0.0
	if ms > 0 {
		mbps = float64(n) / 1048576 / (ms / 1000)
	}
	return map[string]any{"bytes": float64(n), "ms": ms, "mbPerSec": mbps}
}

// jsPushWriter forwards bytes to a JS callback, awaiting it when it returns a
// promise so a slow consumer applies backpressure instead of ballooning memory.
type jsPushWriter struct{ fn js.Value }

func (w *jsPushWriter) Write(p []byte) (int, error) {
	res := w.fn.Invoke(toUint8Array(p))
	if isPromise(res) {
		if _, err := await(res); err != nil {
			return 0, fmt.Errorf("sink: %w", err)
		}
	}
	return len(p), nil
}

// jsPullReader pulls bytes from a JS callback returning Promise<Uint8Array|null>.
type jsPullReader struct {
	fn  js.Value
	buf []byte
}

func (r *jsPullReader) Read(p []byte) (int, error) {
	for len(r.buf) == 0 {
		res := r.fn.Invoke()
		if isPromise(res) {
			v, err := await(res)
			if err != nil {
				return 0, fmt.Errorf("source: %w", err)
			}
			res = v
		}
		if res.IsNull() || res.IsUndefined() {
			return 0, io.EOF
		}
		r.buf = toGoBytes(res)
		if len(r.buf) == 0 {
			return 0, io.EOF
		}
	}
	n := copy(p, r.buf)
	r.buf = r.buf[n:]
	return n, nil
}

func isPromise(v js.Value) bool {
	return v.Type() == js.TypeObject && v.Get("then").Type() == js.TypeFunction
}
