package main

import (
	"bufio"
	"strconv"
	"strings"
)

// A deliberately small ~/.ssh/config reader.
//
// Only the directives that map onto a weirdvault host are read. A full OpenSSH
// config parser would have to model Match blocks, Include, canonicalisation,
// and dozens of options we cannot honour anyway — and silently importing a
// config we only half understand is worse than importing the obvious parts and
// saying so.

type ConfigHost struct {
	Alias        string
	HostName     string
	User         string
	Port         int
	IdentityFile string
	ProxyJump    string
}

func parseSSHConfig(text string) ([]ConfigHost, error) {
	var hosts []ConfigHost
	var current *ConfigHost
	// Options before any Host block, and those under "Host *", apply as
	// defaults to everything that follows.
	defaults := ConfigHost{}

	flush := func() {
		if current == nil {
			return
		}
		if current.HostName == "" {
			// "Host web" with no HostName means connect to the literal name.
			current.HostName = current.Alias
		}
		if current.User == "" {
			current.User = defaults.User
		}
		if current.Port == 0 {
			current.Port = defaults.Port
		}
		if current.IdentityFile == "" {
			current.IdentityFile = defaults.IdentityFile
		}
		if current.Port == 0 {
			current.Port = 22
		}
		hosts = append(hosts, *current)
		current = nil
	}

	scanner := bufio.NewScanner(strings.NewReader(text))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		key, value := splitDirective(line)
		if key == "" {
			continue
		}

		if strings.EqualFold(key, "host") {
			flush()
			// Patterns and negations can't be turned into a concrete host, and
			// guessing would create entries that don't connect to anything.
			if strings.ContainsAny(value, "*?!") {
				if value == "*" {
					current = &ConfigHost{Alias: "*"}
				}
				continue
			}
			// "Host a b c" declares aliases for one target; the first is enough.
			current = &ConfigHost{Alias: strings.Fields(value)[0]}
			continue
		}

		target := current
		if target == nil || target.Alias == "*" {
			target = &defaults
		}

		switch strings.ToLower(key) {
		case "hostname":
			target.HostName = value
		case "user":
			target.User = value
		case "port":
			if n, err := strconv.Atoi(value); err == nil && n > 0 && n < 65536 {
				target.Port = n
			}
		case "identityfile":
			target.IdentityFile = value
		case "proxyjump":
			target.ProxyJump = value
		}

		// "Host *" contributes only to defaults, never as a host of its own.
		if current != nil && current.Alias == "*" {
			current = nil
		}
	}
	flush()

	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return hosts, nil
}

// splitDirective handles both "Key value" and "Key=value" forms.
func splitDirective(line string) (string, string) {
	if i := strings.IndexAny(line, " \t="); i > 0 {
		key := line[:i]
		value := strings.TrimSpace(strings.TrimLeft(line[i:], " \t="))
		return key, strings.Trim(value, `"`)
	}
	return "", ""
}
