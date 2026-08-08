//go:build js && wasm

package main

import (
	"syscall/js"

	"golang.org/x/crypto/ssh"
)

// importKeyJS is the exported entry point.
//
//	importKey(pem: string, passphrase?: string) -> Promise<{
//	  keyType, pkcs8: Uint8Array, publicKeyRaw: Uint8Array,
//	  authorizedKey: string, fingerprint: string, bits: number
//	}>
//
// The caller MUST import pkcs8 into WebCrypto non-extractably and zero it.
func importKeyJS(_ js.Value, args []js.Value) any {
	if len(args) < 1 || args[0].Type() != js.TypeString {
		return rejected("importKey(pem, passphrase?) requires the key text")
	}
	pemText := args[0].String()
	passphrase := ""
	if len(args) > 1 && args[1].Type() == js.TypeString {
		passphrase = args[1].String()
	}

	return newPromise(func(resolve, reject func(any)) {
		go func() {
			key, err := importPrivateKey([]byte(pemText), passphrase)
			if err != nil {
				reject(err.Error())
				return
			}
			pub, err := ssh.ParsePublicKey(key.SSHBlob)
			if err != nil {
				reject(err.Error())
				return
			}
			resolve(js.ValueOf(map[string]any{
				"keyType":       key.KeyType,
				"pkcs8":         toUint8Array(key.PKCS8),
				"publicKeyRaw":  toUint8Array(key.PublicRaw),
				"authorizedKey": string(ssh.MarshalAuthorizedKey(pub)),
				"fingerprint":   key.Fingerprint,
				"bits":          key.Bits,
			}))
		}()
	})
}

// parseSSHConfigJS exposes ssh_config parsing so hosts can be bulk-imported.
//
//	parseSSHConfig(text: string) -> Promise<Array<{alias, hostname, user, port, identityFile, proxyJump}>>
func parseSSHConfigJS(_ js.Value, args []js.Value) any {
	if len(args) < 1 || args[0].Type() != js.TypeString {
		return rejected("parseSSHConfig(text) requires the file contents")
	}
	text := args[0].String()

	return newPromise(func(resolve, reject func(any)) {
		go func() {
			hosts, err := parseSSHConfig(text)
			if err != nil {
				reject(err.Error())
				return
			}
			out := make([]any, 0, len(hosts))
			for _, h := range hosts {
				out = append(out, map[string]any{
					"alias":        h.Alias,
					"hostname":     h.HostName,
					"user":         h.User,
					"port":         h.Port,
					"identityFile": h.IdentityFile,
					"proxyJump":    h.ProxyJump,
				})
			}
			resolve(js.ValueOf(out))
		}()
	})
}
