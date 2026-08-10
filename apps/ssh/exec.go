//go:build js && wasm

package main

import (
	"bytes"
	"fmt"
	"io"
	"regexp"
	"strings"
	"syscall/js"
	"time"

	"golang.org/x/crypto/ssh"
)

// Features that need a command rather than the SFTP subsystem.

// authorizedKeyPattern is the allowlist for anything interpolated into a
// remote shell command. Everything here ends up inside single quotes on the
// server, so the one character that must never appear is a single quote —
// but rather than escape, we refuse anything that isn't a well-formed key.
var authorizedKeyPattern = regexp.MustCompile(
	`^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521) [A-Za-z0-9+/]+={0,3}( [A-Za-z0-9@._\-]+)?$`)

// installKey appends a public key to the remote authorized_keys.
//
// This removes the worst step in onboarding: "copy this command and go run it
// somewhere else." The user connects once with a password, and weirdvault does
// the setup itself.
func installKey(client *ssh.Client, line string) (string, error) {
	line = strings.TrimSpace(line)
	if !authorizedKeyPattern.MatchString(line) {
		return "", fmt.Errorf("refusing to install a malformed public key")
	}

	// grep -qxF avoids duplicating the key when run twice, and the umask keeps
	// permissions right on a freshly created .ssh — sshd silently ignores
	// authorized_keys that is group- or world-writable, which is a maddening
	// failure to debug.
	script := fmt.Sprintf(`set -e
mkdir -p ~/.ssh
chmod 700 ~/.ssh
touch ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
if grep -qxF '%s' ~/.ssh/authorized_keys; then
  echo "already-present"
else
  echo '%s' >> ~/.ssh/authorized_keys
  echo "installed"
fi`, line, line)

	out, err := runCommand(client, script)
	if err != nil {
		return "", fmt.Errorf("install key: %w", err)
	}
	return strings.TrimSpace(out), nil
}

func runCommand(client *ssh.Client, cmd string) (string, error) {
	sess, err := client.NewSession()
	if err != nil {
		return "", err
	}
	defer sess.Close()

	var stdout, stderr bytes.Buffer
	sess.Stdout = &stdout
	sess.Stderr = &stderr
	if err := sess.Run(cmd); err != nil {
		return stdout.String(), fmt.Errorf("%w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}

// shellQuote wraps a value in single quotes, escaping any embedded ones.
// Used for paths, which we cannot pattern-match as strictly as a key.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// uploadTar streams a tar archive into `tar -x` on the remote side.
//
// Per-file SFTP costs a round trip per file, which dominates for directories of
// many small files — a node_modules tree can be thousands of times slower than
// the bytes justify. Piping one tar stream through a single exec channel turns
// that back into a bandwidth problem.
func uploadTar(client *ssh.Client, remoteDir string, src js.Value) (map[string]any, error) {
	sess, err := client.NewSession()
	if err != nil {
		return nil, err
	}
	defer sess.Close()

	stdin, err := sess.StdinPipe()
	if err != nil {
		return nil, err
	}
	var stderr bytes.Buffer
	sess.Stderr = &stderr

	cmd := fmt.Sprintf("mkdir -p %s && tar -xf - -C %s", shellQuote(remoteDir), shellQuote(remoteDir))
	if err := sess.Start(cmd); err != nil {
		return nil, fmt.Errorf("start tar: %w", err)
	}

	start := time.Now()
	n, copyErr := io.CopyBuffer(stdin, &jsPullReader{fn: src}, make([]byte, chunkSize))
	stdin.Close()

	if waitErr := sess.Wait(); waitErr != nil {
		return nil, fmt.Errorf("remote tar failed: %w: %s", waitErr, strings.TrimSpace(stderr.String()))
	}
	if copyErr != nil {
		return nil, fmt.Errorf("stream tar: %w", copyErr)
	}
	return transferResult(n, start), nil
}

// downloadTar streams `tar -c` of a remote directory out to a JS sink.
func downloadTar(client *ssh.Client, remotePath string, sink js.Value) (map[string]any, error) {
	sess, err := client.NewSession()
	if err != nil {
		return nil, err
	}
	defer sess.Close()

	stdout, err := sess.StdoutPipe()
	if err != nil {
		return nil, err
	}
	var stderr bytes.Buffer
	sess.Stderr = &stderr

	dir, base := splitRemotePath(remotePath)
	cmd := fmt.Sprintf("tar -cf - -C %s %s", shellQuote(dir), shellQuote(base))
	if err := sess.Start(cmd); err != nil {
		return nil, fmt.Errorf("start tar: %w", err)
	}

	start := time.Now()
	n, copyErr := io.CopyBuffer(&jsPushWriter{fn: sink}, stdout, make([]byte, chunkSize))
	if waitErr := sess.Wait(); waitErr != nil {
		return nil, fmt.Errorf("remote tar failed: %w: %s", waitErr, strings.TrimSpace(stderr.String()))
	}
	if copyErr != nil {
		return nil, fmt.Errorf("stream tar: %w", copyErr)
	}
	return transferResult(n, start), nil
}

func splitRemotePath(p string) (dir, base string) {
	p = strings.TrimRight(p, "/")
	i := strings.LastIndex(p, "/")
	switch {
	case i < 0:
		return ".", p
	case i == 0:
		return "/", p[1:]
	default:
		return p[:i], p[i+1:]
	}
}
