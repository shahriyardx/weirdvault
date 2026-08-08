//go:build js && wasm

package main

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/x509"
	"fmt"
	"io"
	"math/big"
	"syscall/js"

	"golang.org/x/crypto/ssh"
)

// webCryptoSigner is the whole thesis of webxterm in one type.
//
// x/crypto/ssh needs something that can sign the authentication challenge. The
// obvious implementation holds the private key in memory — which means any
// XSS, any malicious extension, any supply-chain compromise of our own bundle
// can exfiltrate it.
//
// Instead this signer holds no key material at all. It holds a *reference* to
// a JS callback that asks WebCrypto to sign with a non-extractable CryptoKey.
// The key exists only inside the browser's crypto implementation; JS cannot
// read it, WASM cannot read it, and we cannot read it. All that ever crosses
// the boundary is the challenge in and a signature out.
type webCryptoSigner struct {
	pub    ssh.PublicKey
	signFn js.Value // (data: Uint8Array, algorithm: string) => Promise<Uint8Array>
}

var _ ssh.AlgorithmSigner = (*webCryptoSigner)(nil)

// newWebCryptoSigner builds a signer from a raw public key plus a JS signing
// callback. Only the public half ever enters WASM.
func newWebCryptoSigner(keyType string, rawPub []byte, signFn js.Value) (*webCryptoSigner, error) {
	if signFn.Type() != js.TypeFunction {
		return nil, fmt.Errorf("sign callback must be a function")
	}

	var pub ssh.PublicKey
	var err error

	switch keyType {
	case "ed25519":
		if len(rawPub) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("ed25519 public key must be %d bytes, got %d", ed25519.PublicKeySize, len(rawPub))
		}
		pub, err = ssh.NewPublicKey(ed25519.PublicKey(rawPub))

	case "ecdsa-p256":
		// WebCrypto exports "raw" as an uncompressed point: 0x04 ‖ X ‖ Y.
		if len(rawPub) != 65 || rawPub[0] != 4 {
			return nil, fmt.Errorf("expected a 65-byte uncompressed P-256 point, got %d bytes", len(rawPub))
		}
		pub, err = ssh.NewPublicKey(&ecdsa.PublicKey{
			Curve: elliptic.P256(),
			X:     new(big.Int).SetBytes(rawPub[1:33]),
			Y:     new(big.Int).SetBytes(rawPub[33:65]),
		})

	case "rsa":
		// rawPub is SPKI DER as exported by WebCrypto.
		pub, err = parseRSASPKI(rawPub)

	default:
		return nil, fmt.Errorf("unsupported key type %q", keyType)
	}
	if err != nil {
		return nil, err
	}

	return &webCryptoSigner{pub: pub, signFn: signFn}, nil
}

func (s *webCryptoSigner) PublicKey() ssh.PublicKey { return s.pub }

func (s *webCryptoSigner) Sign(rand io.Reader, data []byte) (*ssh.Signature, error) {
	return s.SignWithAlgorithm(rand, data, s.pub.Type())
}

// SignWithAlgorithm hands the challenge to WebCrypto and repacks the result
// into the wire format OpenSSH expects.
func (s *webCryptoSigner) SignWithAlgorithm(_ io.Reader, data []byte, algorithm string) (*ssh.Signature, error) {
	if algorithm == "" {
		algorithm = s.pub.Type()
	}

	// This is the boundary crossing: challenge out, signature back. The key
	// itself never appears on either side of it.
	raw, err := await(s.signFn.Invoke(toUint8Array(data), algorithm))
	if err != nil {
		return nil, fmt.Errorf("webcrypto sign (%s): %w", algorithm, err)
	}
	sig := toGoBytes(raw)
	if len(sig) == 0 {
		return nil, fmt.Errorf("webcrypto returned an empty signature")
	}

	switch algorithm {
	case ssh.KeyAlgoED25519:
		// WebCrypto Ed25519 emits the 64-byte signature SSH wants verbatim.
		if len(sig) != ed25519.SignatureSize {
			return nil, fmt.Errorf("ed25519 signature must be %d bytes, got %d", ed25519.SignatureSize, len(sig))
		}
		return &ssh.Signature{Format: ssh.KeyAlgoED25519, Blob: sig}, nil

	case ssh.KeyAlgoRSASHA256, ssh.KeyAlgoRSASHA512:
		// RSASSA-PKCS1-v1_5 output is also already in SSH blob form.
		return &ssh.Signature{Format: algorithm, Blob: sig}, nil

	case ssh.KeyAlgoECDSA256:
		// WebCrypto returns fixed-width r‖s; SSH wants two mpints in a struct.
		if len(sig)%2 != 0 {
			return nil, fmt.Errorf("ecdsa signature length %d is not even", len(sig))
		}
		half := len(sig) / 2
		blob := ssh.Marshal(struct{ R, S *big.Int }{
			R: new(big.Int).SetBytes(sig[:half]),
			S: new(big.Int).SetBytes(sig[half:]),
		})
		return &ssh.Signature{Format: algorithm, Blob: blob}, nil

	default:
		return nil, fmt.Errorf("unsupported signature algorithm %q", algorithm)
	}
}

func parseRSASPKI(der []byte) (ssh.PublicKey, error) {
	k, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, fmt.Errorf("parse SPKI: %w", err)
	}
	rsaPub, ok := k.(*rsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("SPKI key is %T, not RSA", k)
	}
	return ssh.NewPublicKey(rsaPub)
}
