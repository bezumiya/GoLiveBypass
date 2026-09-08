package updates

import "testing"

func TestCompareReleaseTags(t *testing.T) {
	cases := []struct {
		name  string
		a     string
		b     string
		want  int
		valid bool
	}{
		{name: "beta numerica", a: "v2.0.5-beta-10", b: "v2.0.5-beta-9", want: 1, valid: true},
		{name: "stable acima da prerelease", a: "v2.0.5", b: "v2.0.5-beta-12", want: 1, valid: true},
		{name: "triplo maior", a: "v2.0.6-beta-1", b: "v2.0.5", want: 1, valid: true},
		{name: "tag invalida", a: "release/latest", b: "v2.0.5", valid: false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, valid := CompareReleaseTags(tc.a, tc.b)
			if valid != tc.valid {
				t.Fatalf("valid = %v, want %v", valid, tc.valid)
			}
			if !valid {
				return
			}
			switch {
			case tc.want < 0 && got >= 0:
				t.Fatalf("compare = %d, want negative", got)
			case tc.want == 0 && got != 0:
				t.Fatalf("compare = %d, want zero", got)
			case tc.want > 0 && got <= 0:
				t.Fatalf("compare = %d, want positive", got)
			}
		})
	}
}
