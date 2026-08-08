package main

import "testing"

func find(hosts []ConfigHost, alias string) *ConfigHost {
	for i := range hosts {
		if hosts[i].Alias == alias {
			return &hosts[i]
		}
	}
	return nil
}

func TestParseSSHConfigBasics(t *testing.T) {
	hosts, err := parseSSHConfig(`
# a comment
Host web
    HostName web.example.com
    User deploy
    Port 2222
    IdentityFile ~/.ssh/id_ed25519

Host db
    HostName 10.0.0.5
    ProxyJump bastion
`)
	if err != nil {
		t.Fatal(err)
	}
	if len(hosts) != 2 {
		t.Fatalf("got %d hosts, want 2", len(hosts))
	}

	web := find(hosts, "web")
	if web.HostName != "web.example.com" || web.User != "deploy" || web.Port != 2222 {
		t.Errorf("web parsed as %+v", *web)
	}

	db := find(hosts, "db")
	if db.ProxyJump != "bastion" {
		t.Errorf("db.ProxyJump = %q", db.ProxyJump)
	}
	if db.Port != 22 {
		t.Errorf("db.Port = %d, want the default 22", db.Port)
	}
}

func TestHostWithoutHostNameUsesAlias(t *testing.T) {
	// "Host example.com" with no HostName means connect to that literal name;
	// dropping it would silently lose a host.
	hosts, _ := parseSSHConfig("Host example.com\n  User me\n")
	if len(hosts) != 1 || hosts[0].HostName != "example.com" {
		t.Fatalf("got %+v", hosts)
	}
}

func TestWildcardHostSuppliesDefaults(t *testing.T) {
	hosts, _ := parseSSHConfig(`
Host *
    User defaultuser
    Port 2200

Host web
    HostName web.example.com

Host db
    HostName db.example.com
    User dbadmin
`)
	if len(hosts) != 2 {
		t.Fatalf("got %d hosts, want 2 — 'Host *' must not become a host", len(hosts))
	}
	web := find(hosts, "web")
	if web.User != "defaultuser" || web.Port != 2200 {
		t.Errorf("web should inherit defaults, got %+v", *web)
	}
	db := find(hosts, "db")
	if db.User != "dbadmin" {
		t.Errorf("an explicit value must beat the default, got %q", db.User)
	}
}

func TestPatternHostsAreSkipped(t *testing.T) {
	// A pattern cannot be turned into a concrete host, and guessing would
	// create entries that connect to nothing.
	hosts, _ := parseSSHConfig(`
Host *.internal
    User admin

Host !prod
    User nope

Host real
    HostName real.example.com
`)
	if len(hosts) != 1 || hosts[0].Alias != "real" {
		t.Fatalf("got %+v", hosts)
	}
}

func TestEqualsSyntaxAndQuotes(t *testing.T) {
	hosts, _ := parseSSHConfig("Host web\n  HostName=\"web.example.com\"\n  Port=2222\n")
	if hosts[0].HostName != "web.example.com" || hosts[0].Port != 2222 {
		t.Fatalf("got %+v", hosts[0])
	}
}

func TestMultipleAliasesTakeTheFirst(t *testing.T) {
	hosts, _ := parseSSHConfig("Host web web1 web-primary\n  HostName web.example.com\n")
	if len(hosts) != 1 || hosts[0].Alias != "web" {
		t.Fatalf("got %+v", hosts)
	}
}

func TestInvalidPortIsIgnoredRatherThanFatal(t *testing.T) {
	hosts, _ := parseSSHConfig("Host web\n  HostName w.example.com\n  Port banana\n")
	if hosts[0].Port != 22 {
		t.Errorf("Port = %d, want fallback to 22", hosts[0].Port)
	}
}

func TestEmptyConfig(t *testing.T) {
	hosts, err := parseSSHConfig("\n# just comments\n\n")
	if err != nil || len(hosts) != 0 {
		t.Fatalf("hosts=%v err=%v", hosts, err)
	}
}
