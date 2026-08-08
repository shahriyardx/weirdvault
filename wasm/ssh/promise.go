//go:build js && wasm

package main

import (
	"errors"
	"syscall/js"
)

// await blocks the calling goroutine until a JS promise settles.
//
// This is safe as long as the caller is not itself running on the JS event
// loop: when every Go goroutine is parked, the wasm runtime hands control back
// to JS, the promise resolves, and the callback wakes us. Anything that calls
// await must therefore run in its own goroutine, never directly inside a
// js.FuncOf handler.
func await(p js.Value) (js.Value, error) {
	type result struct {
		val js.Value
		err error
	}
	done := make(chan result, 1)

	onOK := js.FuncOf(func(_ js.Value, args []js.Value) any {
		var v js.Value
		if len(args) > 0 {
			v = args[0]
		}
		done <- result{val: v}
		return nil
	})
	onErr := js.FuncOf(func(_ js.Value, args []js.Value) any {
		msg := "promise rejected"
		if len(args) > 0 && !args[0].IsUndefined() && !args[0].IsNull() {
			msg = args[0].Call("toString").String()
		}
		done <- result{err: errors.New(msg)}
		return nil
	})
	defer onOK.Release()
	defer onErr.Release()

	// Two-argument then() so exactly one handler ever fires.
	p.Call("then", onOK, onErr)

	r := <-done
	return r.val, r.err
}

// toUint8Array copies a Go slice into a fresh JS Uint8Array.
func toUint8Array(b []byte) js.Value {
	a := js.Global().Get("Uint8Array").New(len(b))
	if len(b) > 0 {
		js.CopyBytesToJS(a, b)
	}
	return a
}

// toGoBytes copies a JS ArrayBuffer or TypedArray into a Go slice.
func toGoBytes(v js.Value) []byte {
	if v.IsUndefined() || v.IsNull() {
		return nil
	}
	// Normalise ArrayBuffer -> Uint8Array.
	if v.InstanceOf(js.Global().Get("ArrayBuffer")) {
		v = js.Global().Get("Uint8Array").New(v)
	}
	n := v.Get("length")
	if n.IsUndefined() {
		return nil
	}
	b := make([]byte, n.Int())
	if len(b) > 0 {
		js.CopyBytesToGo(b, v)
	}
	return b
}
