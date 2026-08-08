package main

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/x509"
	"errors"
	"fmt"

	"golang.org/x/crypto/ssh"
)

// Parsing an existing SSH private key.
//
// Users arrive with keys they already have; refusing them makes the product
// unusable for anyone with an established setup. The awkward part is that
// importing necessarily means handling raw private key material, which
// generation avoids entirely.
//
// The contract is narrow and explicit: this returns PKCS#8 DER exactly once,
// the JS side immediately imports it into WebCrypto as NON-EXTRACTABLE and
// zeroes the buffer, and from that moment the key behaves exactly like a
// generated one. The plaintext window is a few milliseconds inside one
// function - not zero, and the UI should say so rather than imply otherwise.

type importedKey struct {
	KeyType     string // "ed25519" | "rsa" | "ecdsa-p256"
	PKCS8       []byte
	PublicRaw   []byte // raw form matching KeyType, for the signer
	SSHBlob     []byte // SSH wire-format public key
	Fingerprint string
	Bits        int
}

// importPrivateKey parses a PEM private key, optionally passphrase-protected.
func importPrivateKey(pemBytes []byte, passphrase string) (*importedKey, error) {
	var raw any
	var err error

	if passphrase == "" {
		raw, err = ssh.ParseRawPrivateKey(pemBytes)
		var needsPass *ssh.PassphraseMissingError
		if errors.As(err, &needsPass) {
			return nil, fmt.Errorf("this key is encrypted — a passphrase is required")
		}
	} else {
		raw, err = ssh.ParseRawPrivateKeyWithPassphrase(pemBytes, []byte(passphrase))
		if err != nil && errors.Is(err, x509.IncorrectPasswordError) {
			return nil, fmt.Errorf("wrong passphrase")
		}
	}
	if err != nil {
		return nil, fmt.Errorf("could not read this key: %w", err)
	}

	// The public half is derived from the PRIVATE key, never from the file's
	// public-key header. In openssh-key-v1 that header sits outside the
	// encrypted, authenticated section, so anyone can rewrite it — trusting it
	// would mean authorising a key the file's owner never held.
	switch key := raw.(type) {
	case *ed25519.PrivateKey:
		// ParseRawPrivateKey hands back a pointer, but MarshalPKCS8PrivateKey
		// only accepts the value type — pass it dereferenced.
		return buildImported("ed25519", *key, key.Public().(ed25519.PublicKey), 256)
	case ed25519.PrivateKey:
		return buildImported("ed25519", key, key.Public().(ed25519.PublicKey), 256)
	case *rsa.PrivateKey:
		if key.N.BitLen() < 2048 {
			return nil, fmt.Errorf("RSA keys under 2048 bits are not accepted (this one is %d)", key.N.BitLen())
		}
		return buildImported("rsa", key, key.Public(), key.N.BitLen())
	case *ecdsa.PrivateKey:
		if key.Curve != elliptic.P256() {
			return nil, fmt.Errorf(
				"only the P-256 curve is supported for ECDSA (this key uses %s); "+
					"WebCrypto cannot hold the others non-extractably here", key.Curve.Params().Name)
		}
		return buildImported("ecdsa-p256", key, key.Public(), 256)
	default:
		return nil, fmt.Errorf("unsupported key type %T", raw)
	}
}

func buildImported(keyType string, priv any, pub any, bits int) (*importedKey, error) {
	pkcs8, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return nil, fmt.Errorf("could not convert the key for the browser: %w", err)
	}

	sshPub, err := ssh.NewPublicKey(pub)
	if err != nil {
		return nil, fmt.Errorf("could not derive the public key: %w", err)
	}

	var publicRaw []byte
	switch p := pub.(type) {
	case ed25519.PublicKey:
		publicRaw = []byte(p)
	case *rsa.PublicKey:
		// WebCrypto imports RSA public keys as SPKI.
		publicRaw, err = x509.MarshalPKIXPublicKey(p)
		if err != nil {
			return nil, err
		}
	case *ecdsa.PublicKey:
		// Uncompressed point: 0x04 ‖ X ‖ Y, which is WebCrypto's "raw" format.
		publicRaw = append([]byte{4}, append(
			leftPad(p.X.Bytes(), 32), leftPad(p.Y.Bytes(), 32)...)...)
	default:
		return nil, fmt.Errorf("unsupported public key type %T", pub)
	}

	return &importedKey{
		KeyType:     keyType,
		PKCS8:       pkcs8,
		PublicRaw:   publicRaw,
		SSHBlob:     sshPub.Marshal(),
		Fingerprint: ssh.FingerprintSHA256(sshPub),
		Bits:        bits,
	}, nil
}

func leftPad(b []byte, size int) []byte {
	if len(b) >= size {
		return b[len(b)-size:]
	}
	out := make([]byte, size)
	copy(out[size-len(b):], b)
	return out
}
