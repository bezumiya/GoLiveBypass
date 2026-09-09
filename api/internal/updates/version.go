package updates

import (
	"regexp"
	"strings"
)

var releaseVersionPattern = regexp.MustCompile(`^v?([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$`)

type releaseVersion struct {
	base [3]string
	pre  []string
}

// CompareReleaseTags compara as tags no mesmo ordenamento SemVer usado pelo
// updater. O projeto historicamente publicou beta-N, entao esse formato e
// normalizado para beta.N antes da comparacao. O segundo retorno indica se as
// duas tags sao validas.
func CompareReleaseTags(a, b string) (int, bool) {
	va, ok := parseReleaseVersion(a)
	if !ok {
		return 0, false
	}
	vb, ok := parseReleaseVersion(b)
	if !ok {
		return 0, false
	}

	for i := range va.base {
		if cmp := compareNumericStrings(va.base[i], vb.base[i]); cmp != 0 {
			return cmp, true
		}
	}

	if len(va.pre) == 0 || len(vb.pre) == 0 {
		switch {
		case len(va.pre) == 0 && len(vb.pre) == 0:
			return 0, true
		case len(va.pre) == 0:
			return 1, true
		default:
			return -1, true
		}
	}

	limit := len(va.pre)
	if len(vb.pre) > limit {
		limit = len(vb.pre)
	}
	for i := 0; i < limit; i++ {
		if i >= len(va.pre) {
			return -1, true
		}
		if i >= len(vb.pre) {
			return 1, true
		}
		if cmp := comparePrereleaseIdentifier(va.pre[i], vb.pre[i]); cmp != 0 {
			return cmp, true
		}
	}
	return 0, true
}

func parseReleaseVersion(tag string) (releaseVersion, bool) {
	match := releaseVersionPattern.FindStringSubmatch(strings.TrimSpace(tag))
	if match == nil {
		return releaseVersion{}, false
	}

	version := releaseVersion{base: [3]string{match[1], match[2], match[3]}}
	if match[4] == "" {
		return version, true
	}

	pre := match[4]
	if betaNumber := strings.TrimPrefix(pre, "beta-"); betaNumber != pre && isDigits(betaNumber) {
		pre = "beta." + betaNumber
	}
	identifiers := strings.Split(pre, ".")
	for _, identifier := range identifiers {
		if identifier == "" {
			return releaseVersion{}, false
		}
		version.pre = append(version.pre, identifier)
	}
	return version, true
}

func compareNumericStrings(a, b string) int {
	a = strings.TrimLeft(a, "0")
	b = strings.TrimLeft(b, "0")
	if a == "" {
		a = "0"
	}
	if b == "" {
		b = "0"
	}
	if len(a) != len(b) {
		if len(a) < len(b) {
			return -1
		}
		return 1
	}
	if a < b {
		return -1
	}
	if a > b {
		return 1
	}
	return 0
}

func comparePrereleaseIdentifier(a, b string) int {
	aNumeric := isDigits(a)
	bNumeric := isDigits(b)
	switch {
	case aNumeric && bNumeric:
		return compareNumericStrings(a, b)
	case aNumeric:
		return -1
	case bNumeric:
		return 1
	case a < b:
		return -1
	case a > b:
		return 1
	default:
		return 0
	}
}

func isDigits(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
