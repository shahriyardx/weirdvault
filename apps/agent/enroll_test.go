package main

import "testing"

// The name an identity gets on disk, which is also what the dashboard prints on
// the card and what `stop <id>` takes.
//
// The dashboard derives it from the agent id independently — identityName in
// apps/web/src/app/dashboard/machines/page.tsx — so that a person looking at a
// card and a person looking at `weirdvault-agent list` are talking about the
// same thing. Two derivations, one rule, and this is where the rule is written
// down.
func TestShortAgentID(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		// A real agent id, dashes stripped, first eight characters.
		{"0c8682df-7131-4f2f-bb42-a470c9c9ce8c", "0c8682df"},
		{"e61987c0-dee3-42a3-a8a2-475cfe26b590", "e61987c0"},
		// Anything shorter is used whole rather than truncated to nothing.
		{"abc", "abc"},
		// And an empty id still produces a usable filename rather than ".json".
		{"", "agent"},
	}

	for _, tc := range cases {
		if got := shortAgentID(tc.in); got != tc.want {
			t.Errorf("shortAgentID(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
